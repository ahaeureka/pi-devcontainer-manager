export function createShortCache(options = {}) {
    const ttlMs = Math.max(0, options.ttlMs ?? 500);
    const limit = Math.max(1, options.limit ?? 8);
    const entries = new Map();
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
                if (entries.get(key)?.value === value)
                    entries.delete(key);
            });
            while (entries.size > limit) {
                const oldest = entries.keys().next();
                if (oldest.done === true)
                    break;
                entries.delete(oldest.value);
            }
            return value;
        },
        clear: () => entries.clear(),
    };
}
//# sourceMappingURL=short-cache.js.map