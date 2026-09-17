/** Expand the devcontainer variable a `mounts` entry may use for the host workspace. */
function expandVariables(path, hostPath) {
    return hostPath === undefined ? path : path.replaceAll("${localWorkspaceFolder}", hostPath);
}
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
    const visible = (mapping.containerVisiblePaths ?? []).map((path) => normalize(expandVariables(path, mapping.hostPath)));
    const under = (candidate, base) => candidate === base || candidate.startsWith(`${base}/`);
    const isSameFileOnBothSides = (candidate) => visible.some((path) => under(candidate, path));
    /**
     * When the container path is an ANCESTOR of the host path the workspace is mounted at a shallower
     * container path, so nothing under the host path is container space — every host-path request names a
     * different file inside the container and must be refused.
     */
    const containerIsAncestorOfHost = container.length > 0 && host.length > container.length && under(host, container);
    for (const element of argv) {
        const candidate = normalize(element);
        if (!under(candidate, host))
            continue;
        // The container's OWN workspace is legitimate (it may be nested inside the host path), but only that
        // space — exempting everything under the host path whenever the container path was nested let a host
        // file that is not the workspace slip through (adversarial review of the routing hardening).
        if (!containerIsAncestorOfHost && container.length > 0 && under(candidate, container))
            continue;
        if (isSameFileOnBothSides(candidate))
            continue;
        return element;
    }
    return undefined;
}
//# sourceMappingURL=routing-guard.js.map