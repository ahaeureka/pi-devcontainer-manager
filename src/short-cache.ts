/**
 * A tiny, bounded, short-lived cache.
 *
 * The routing guards and the presentation hook both resolve a workspace's devcontainer configuration, and each
 * resolution runs a full discovery (`docker ps --all` plus a host traversal). For ONE command that is work done
 * twice, so the extension wraps the discovery in this cache: entries expire after a few hundred milliseconds (far
 * below the timescale at which containers appear or disappear), the cache keeps at most a handful of keys, and it
 * is explicitly clearable.
 *
 * Deliberately NOT a general memo: no invalidation protocol, no unbounded growth, and nothing that could make a
 * stale target authoritative — a later call after the TTL re-reads the world.
 */
export interface ShortCache<T> {
  /** Return the cached value for `key`, loading it with `load` when absent or expired. */
  get(key: string, load: () => Promise<T>): Promise<T>;
  /** Drop every entry (a mutation of the world that must be seen immediately). */
  clear(): void;
}

export function createShortCache<T>(options: { ttlMs?: number; limit?: number } = {}): ShortCache<T> {
  const ttlMs = Math.max(0, options.ttlMs ?? 500);
  const limit = Math.max(1, options.limit ?? 8);
  const entries = new Map<string, { value: Promise<T>; at: number }>();

  return {
    get: (key, load) => {
      const now = Date.now();
      const hit = entries.get(key);
      if (hit !== undefined && now - hit.at < ttlMs) {
        // Refresh the recency so a burst of calls keeps the entry alive within its window.
        entries.delete(key);
        entries.set(key, hit);
        return hit.value;
      }
      const value = load();
      entries.delete(key);
      entries.set(key, { value, at: now });
      // A failed load is NOT cached: a transient discovery failure must not be replayed to the next caller.
      value.catch(() => {
        if (entries.get(key)?.value === value) entries.delete(key);
      });
      while (entries.size > limit) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
      return value;
    },
    clear: () => entries.clear(),
  };
}
