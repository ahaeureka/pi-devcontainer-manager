export interface PathMapping {
    /** Host-side directory (absolute, real). */
    readonly hostPath: string;
    /** Container-side directory (absolute). */
    readonly containerPath: string;
}
export interface ParsedMount {
    source?: string;
    target?: string;
    type?: string;
}
/** Parse a devcontainer `workspaceMount` string ("source=...,target=...,type=bind"). */
export declare function parseWorkspaceMount(mount: string | undefined): ParsedMount;
/** Expand `${localWorkspaceFolder}` (and bare `$localWorkspaceFolder`) to the config host dir. */
export declare function expandLocalWorkspaceFolder(value: string | undefined, localWorkspaceFolder: string): string | undefined;
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
export declare function buildPathMapping(configDir: string, workspaceFolder: string | undefined, workspaceMount: string | undefined): PathMapping | undefined;
/** Map a host path to its container equivalent under a mapping, if it falls under hostPath. */
export declare function hostToContainer(path: string, mapping: PathMapping | undefined): string | undefined;
/**
 * Return the first argv element that refers to a CONTAINER-only path (the
 * workspace's container path or a path beneath it), or undefined.
 *
 * Used as a structured guard on the explicit HOST surface: host execution of
 * literal argv involves no shell parsing, so this check is reliable — unlike
 * any classifier over shell text. It catches the common mis-route of running a
 * container path on the host (where it does not exist).
 */
export declare function findContainerPath(argv: readonly string[], containerPath: string): string | undefined;
/** Facts a DevContainer configuration contributes to the agent's view of the environment. */
export interface ConfigFacts {
    /** Host <-> container workspace mapping, when the config declares a usable one. */
    readonly mapping?: PathMapping;
    /** Absolute container paths mounted into the container that the host cannot see. */
    readonly containerOnlyMounts?: readonly string[];
    /**
     * Mounts whose source and target are the SAME path: the path is the same file on both sides, so a
     * host path used inside the container for one of these is not a mis-route. This is the exemption the
     * reverse routing guard needs — `containerOnlyMounts` keys on the TARGET only and would wrongly
     * excuse a mount whose target shadows the host path while its source is elsewhere.
     */
    readonly samePathMounts?: readonly string[];
}
/** Outcome of reading a configuration's TEXT. */
export type ConfigRead = {
    readonly kind: "ok";
    readonly facts: ConfigFacts;
}
/** The config could not be parsed at all — callers must surface this, not treat it as "empty". */
 | {
    readonly kind: "unparsable";
    readonly detail: string;
};
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
export declare function readConfigFacts(configDir: string, text: string): ConfigRead;
/**
 * Absolute container paths this config mounts that the workspace bind mount does not cover — i.e.
 * paths the agent must not expect the host file tools to see (review finding L1-05).
 *
 * Targets under the workspace mapping are excluded because the host reaches them through the bind
 * mount, malformed entries and relative targets are skipped, and the order of first appearance is
 * preserved with duplicates removed.
 */
export declare function containerOnlyMounts(mounts: readonly string[], workspaceMount: string | undefined, mapping: PathMapping | undefined): readonly string[] | undefined;
/**
 * The `mounts` entries that put the SAME path on both sides (`source` === `target`).
 *
 * A devcontainer mount is a `source=<host>,target=<container>[,type=...]` triple; when the two paths
 * are identical the file is genuinely the same on both sides, which is the only case the reverse
 * routing guard may excuse. Keying on the target alone would excuse a mount whose source is somewhere
 * else entirely (adversarial review of the routing hardening).
 */
export declare function samePathMounts(mounts: readonly string[], workspaceFolder?: string): readonly string[] | undefined;
//# sourceMappingURL=path-mapper.d.ts.map