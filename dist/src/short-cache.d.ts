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
export declare function createShortCache<T>(options?: {
    ttlMs?: number;
    limit?: number;
}): ShortCache<T>;
//# sourceMappingURL=short-cache.d.ts.map