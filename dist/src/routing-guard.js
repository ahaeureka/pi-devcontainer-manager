/** Normalize a path for comparison: strip trailing slashes (except a bare root). */
function normalize(path) {
    if (path.length > 1 && path.endsWith("/"))
        return path.replace(/\/+$/, "");
    return path;
}
/**
 * The offending argv element, when one names the host workspace path on a container surface.
 *
 * Returns `undefined` when nothing matches — the caller refuses only on a hit, so a false negative
 * costs nothing beyond the status quo and a false positive cannot happen for a path that merely
 * shares a textual prefix.
 */
export function detectHostPathOnContainerSurface(argv, mapping) {
    if (mapping === undefined)
        return undefined;
    const host = normalize(mapping.hostPath);
    const container = normalize(mapping.containerPath);
    // Same path on both sides: the argument is correct as written.
    if (host === container)
        return undefined;
    if (host.length === 0)
        return undefined;
    for (const element of argv) {
        const candidate = normalize(element);
        if (candidate === host)
            return element;
        if (candidate.startsWith(`${host}/`))
            return element;
    }
    return undefined;
}
//# sourceMappingURL=routing-guard.js.map