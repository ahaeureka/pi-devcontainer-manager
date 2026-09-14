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
//# sourceMappingURL=path-mapper.d.ts.map