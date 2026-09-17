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
    // A container path NESTED under the host path is the container's own workspace (mounting a subdirectory
    // elsewhere), so a request for it is legitimate. The reverse — the workspace mounted at an ANCESTOR of
    // the host path — makes every host-path request a different file inside the container, so it must be
    // refused (adversarial review of the routing hardening: the blanket container-space exemption swallowed
    // exactly that case).
    const containerSpaceIsNestedUnderHost = container.length > host.length && under(container, host);
    for (const element of argv) {
        const candidate = normalize(element);
        if (!under(candidate, host))
            continue;
        if (containerSpaceIsNestedUnderHost)
            continue;
        if (isSameFileOnBothSides(candidate))
            continue;
        return element;
    }
    return undefined;
}
//# sourceMappingURL=routing-guard.js.map