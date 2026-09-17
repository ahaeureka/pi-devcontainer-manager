/**
 * Host <-> container path mapping derived from a DevContainer configuration.
 *
 * A workspace's `.devcontainer.json` may declare where the host folder is
 * mounted inside the container:
 *
 *   "workspaceFolder": "/app",
 *   "workspaceMount": "source=${localWorkspaceFolder},target=/app,type=bind"
 *
 * `workspaceMount` is authoritative when present: its `source` (after
 * `${localWorkspaceFolder}` expansion to the config's host directory) maps to
 * its `target`. Otherwise we fall back to `workspaceFolder` with the host side
 * assumed to be the config's own directory. When neither is declared there is
 * no reliable mapping (the Dev Containers CLI default is not guessed) and the
 * mapper reports none, so callers keep host paths unchanged.
 *
 * The CLI always receives HOST paths for `--workspace-folder` (it resolves the
 * config on the host and maps internally); this mapper only changes how paths
 * are *presented* to the agent (tool summaries, workspace keys) so the agent
 * sees one consistent in-container view.
 */
import { isAbsolute } from "node:path";
import { isAtOrUnder } from "./workspace-path.js";
import { parseJsonc } from "./jsonc.js";
/** Parse a devcontainer `workspaceMount` string ("source=...,target=...,type=bind"). */
export function parseWorkspaceMount(mount) {
    if (mount === undefined || mount.trim().length === 0)
        return {};
    const parts = {};
    for (const part of mount.split(",")) {
        const eq = part.indexOf("=");
        if (eq === -1)
            continue;
        const key = part.slice(0, eq);
        const value = part.slice(eq + 1);
        parts[key] = value;
    }
    const out = {};
    if (typeof parts.source === "string")
        out.source = parts.source;
    if (typeof parts.target === "string")
        out.target = parts.target;
    if (typeof parts.type === "string")
        out.type = parts.type;
    return out;
}
/** Expand `${localWorkspaceFolder}` (and bare `$localWorkspaceFolder`) to the config host dir. */
export function expandLocalWorkspaceFolder(value, localWorkspaceFolder) {
    if (value === undefined)
        return undefined;
    return value
        .replaceAll("${localWorkspaceFolder}", localWorkspaceFolder)
        .replaceAll("$localWorkspaceFolder", localWorkspaceFolder);
}
/**
 * Build a host<->container mapping from a devcontainer config location.
 *
 * @param configDir host directory that contains the devcontainer config (for
 *   `.devcontainer/devcontainer.json` this is the parent of `.devcontainer`;
 *   for `devcontainer.json`/`.devcontainer.json` it is their own directory)
 * @param workspaceFolder the config's `workspaceFolder` (container side)
 * @param workspaceMount the config's `workspaceMount` string, if any
 * @returns a mapping when both sides are absolute and resolvable, else undefined
 */
export function buildPathMapping(configDir, workspaceFolder, workspaceMount) {
    // workspaceMount is authoritative when it names a bind source+target.
    const mount = parseWorkspaceMount(workspaceMount);
    if (mount.source !== undefined && mount.target !== undefined && mount.type === "bind") {
        const host = expandLocalWorkspaceFolder(mount.source, configDir);
        const container = mount.target;
        if (host !== undefined && isAbsolute(host) && isAbsolute(container)) {
            return { hostPath: host, containerPath: container };
        }
    }
    // Fallback: workspaceFolder with host side = config dir.
    if (workspaceFolder !== undefined && isAbsolute(workspaceFolder) && isAbsolute(configDir)) {
        return { hostPath: configDir, containerPath: workspaceFolder };
    }
    return undefined;
}
/** Map a host path to its container equivalent under a mapping, if it falls under hostPath. */
export function hostToContainer(path, mapping) {
    if (mapping === undefined)
        return undefined;
    const host = normalize(mapping.hostPath);
    const candidate = normalize(path);
    if (!isAtOrUnder(candidate, host))
        return undefined;
    if (candidate === host)
        return mapping.containerPath;
    return `${mapping.containerPath}${candidate.slice(host.length)}`;
}
/**
 * Return the first argv element that refers to a CONTAINER-only path (the
 * workspace's container path or a path beneath it), or undefined.
 *
 * Used as a structured guard on the explicit HOST surface: host execution of
 * literal argv involves no shell parsing, so this check is reliable — unlike
 * any classifier over shell text. It catches the common mis-route of running a
 * container path on the host (where it does not exist).
 */
export function findContainerPath(argv, containerPath) {
    const base = normalize(containerPath);
    if (base.length === 0)
        return undefined;
    for (const token of argv) {
        if (typeof token !== "string" || !token.startsWith("/"))
            continue;
        const candidate = normalize(token);
        // The shared segment test: a base of `/` matches everything absolute (the local `${base}/` prefix built
        // `//` and made this guard silently inert for a container workspace path of `/`).
        if (isAtOrUnder(candidate, base))
            return token;
    }
    return undefined;
}
function normalize(p) {
    // Paths here are already absolute; just trim a trailing slash for prefix math.
    return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}
/**
 * Read the facts a DevContainer configuration's text contributes (JSONC).
 *
 * Split out from the file IO so the parsing, the mapping derivation and the failure classification
 * are testable. A config that cannot be parsed is reported as `unparsable` rather than as an empty
 * one: the host container-path guard only runs when a mapping exists, so a config the extension
 * cannot read silently switches that guard off and the operator has to be told (finding L0-02).
 *
 * @param configDir host directory that contains the configuration (see `buildPathMapping`)
 */
export function readConfigFacts(configDir, text) {
    let parsed;
    try {
        parsed = parseJsonc(text);
    }
    catch (error) {
        return { kind: "unparsable", detail: error instanceof Error ? error.message : String(error) };
    }
    if (typeof parsed !== "object" || parsed === null)
        return { kind: "ok", facts: {} };
    const config = parsed;
    const workspaceFolder = typeof config.workspaceFolder === "string" ? config.workspaceFolder : undefined;
    const workspaceMount = typeof config.workspaceMount === "string" ? config.workspaceMount : undefined;
    const mapping = buildPathMapping(configDir, workspaceFolder, workspaceMount);
    const mounts = Array.isArray(config.mounts)
        ? config.mounts.filter((entry) => typeof entry === "string")
        : [];
    const containerOnly = containerOnlyMounts(mounts, workspaceMount, mapping);
    const samePath = samePathMounts(mounts, configDir);
    return {
        kind: "ok",
        facts: {
            ...(mapping !== undefined ? { mapping } : {}),
            ...(containerOnly !== undefined ? { containerOnlyMounts: containerOnly } : {}),
            ...(samePath !== undefined ? { samePathMounts: samePath } : {}),
        },
    };
}
/**
 * Absolute container paths this config mounts that the workspace bind mount does not cover — i.e.
 * paths the agent must not expect the host file tools to see (review finding L1-05).
 *
 * Targets under the workspace mapping are excluded because the host reaches them through the bind
 * mount, malformed entries and relative targets are skipped, and the order of first appearance is
 * preserved with duplicates removed.
 */
export function containerOnlyMounts(mounts, workspaceMount, mapping) {
    const workspaceTarget = mapping?.containerPath;
    const candidates = [...mounts, ...(workspaceMount !== undefined ? [workspaceMount] : [])];
    const seen = new Set();
    for (const entry of candidates) {
        const target = parseWorkspaceMount(entry).target;
        if (target === undefined || !isAbsolute(target))
            continue;
        if (workspaceTarget !== undefined && isAtOrUnder(normalize(target), normalize(workspaceTarget))) {
            continue;
        }
        seen.add(target);
    }
    return seen.size === 0 ? undefined : [...seen];
}
/**
 * The `mounts` entries that put the SAME path on both sides (`source` === `target`).
 *
 * A devcontainer mount is a `source=<host>,target=<container>[,type=...]` triple; when the two paths
 * are identical the file is genuinely the same on both sides, which is the only case the reverse
 * routing guard may excuse. Keying on the target alone would excuse a mount whose source is somewhere
 * else entirely (adversarial review of the routing hardening).
 */
export function samePathMounts(mounts, workspaceFolder) {
    const paths = [];
    for (const mount of mounts) {
        const parts = mount.split(",");
        const expand = (value) => value?.replaceAll("${localWorkspaceFolder}", workspaceFolder ?? "${localWorkspaceFolder}");
        const source = expand(parts.find((part) => part.trim().startsWith("source="))?.trim().slice("source=".length));
        const target = expand(parts.find((part) => part.trim().startsWith("target="))?.trim().slice("target=".length));
        // Both sides are expanded first: `source=${localWorkspaceFolder},target=<the host path>` is a mirror
        // mount too (adversarial review of the routing hardening), and comparing raw strings missed it.
        if (source !== undefined && target !== undefined && source.length > 0 && source === target)
            paths.push(target);
    }
    return paths.length > 0 ? paths : undefined;
}
//# sourceMappingURL=path-mapper.js.map