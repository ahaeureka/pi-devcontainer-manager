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
    // The container's own path space is never a mis-route — including when the configured container path
    // happens to sit BENEATH the host path (then the guard's own remedy would otherwise be refused).
    const containerSpace = container.length > 0 ? [container] : [];
    const visible = [...containerSpace, ...(mapping.containerVisiblePaths ?? []).map(normalize)];
    const isVisibleInContainer = (candidate) => visible.some((path) => candidate === path || candidate.startsWith(`${path}/`));
    for (const element of argv) {
        const candidate = normalize(element);
        if (isVisibleInContainer(candidate))
            continue;
        if (candidate === host)
            return element;
        if (candidate.startsWith(`${host}/`))
            return element;
    }
    return undefined;
}
//# sourceMappingURL=routing-guard.js.map