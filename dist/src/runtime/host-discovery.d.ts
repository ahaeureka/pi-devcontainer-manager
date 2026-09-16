import type { ContainerState, DevcontainerConfigKind, DiscoveredProject, DiscoveryConfig, RegistryEntry } from "../types.js";
import type { DockerContainer } from "./docker-adapter.js";
/**
 * Bounded host-side DevContainer configuration discovery and workspace
 * registry merge.
 *
 * Discovery is demand-driven and read-only: it scans only the allowed
 * workspace roots (always including the session cwd), never descends into
 * excluded directories, and stops at `discovery.maxDepth`. Results are
 * merged with Docker label candidates into a single workspace registry
 * keyed by the canonicalized host workspace path so both sources unify
 * without duplicates. Config-only projects (never started) are first-class
 * entries; docker-only candidates are retained for diagnostics.
 *
 * All filesystem access goes through the injectable {@link DirectoryTraversal}
 * seam so tests can run against an in-memory tree without touching the real
 * filesystem.
 */
/** Injected seam for the minimal filesystem surface host discovery needs. */
export interface DirectoryTraversal {
    readdir(path: string): readonly string[];
    stat(path: string): {
        isDirectory(): boolean;
        isFile(): boolean;
    };
    realpath(path: string): string;
}
export interface HostDiscoveryOptions {
    readonly sessionCwd: string;
    readonly allowedWorkspaceRoots: readonly string[];
    readonly discovery: Readonly<DiscoveryConfig>;
    readonly traversal?: DirectoryTraversal;
}
export interface DiscoveryInput {
    readonly options: HostDiscoveryOptions;
    readonly dockerCandidates: readonly DockerContainer[];
}
export interface RegistryResult {
    readonly entries: readonly RegistryEntry[];
    /**
     * Everything the scan could not do (unreadable directory, symlink escape, `maxDepth`
     * pruning, a Docker candidate without its `devcontainer.local_folder` label). Consumers must
     * surface these; a field nothing reads is not a diagnostic.
     */
    readonly diagnostics: readonly string[];
}
export interface HostDiscoveryResult {
    readonly projects: readonly DiscoveredProject[];
    readonly diagnostics: readonly string[];
}
/** Production traversal backed by the synchronous `node:fs` surface. */
export declare function nodeTraversal(): DirectoryTraversal;
/**
 * Normalize a Docker container state string into the locked {@link ContainerState}.
 * Known states map directly; unknown or transient states (`restarting`, `dead`,
 * …) collapse to `"unknown"`; an empty/absent state maps to `undefined` so the
 * caller can omit the optional field entirely (compatible with
 * `exactOptionalPropertyTypes`).
 */
export declare function mapContainerState(state: string | undefined): ContainerState | undefined;
/**
 * Cheap, cwd-anchored probe used by the activation decision: does this workspace
 * itself own a DevContainer configuration? Unlike {@link discoverHostConfigs} it
 * never scans a tree and never touches Docker — it only looks at the forms a
 * workspace can declare at its own root.
 */
export declare function workspaceHasConfig(workspace: string, traversal?: DirectoryTraversal): boolean;
/** Classify a discovered configuration file path into its locked kind. */
export declare function kindFor(configPath: string): DevcontainerConfigKind;
/**
 * The workspace identity of a configuration file: `.devcontainer/devcontainer.json`
 * belongs to the parent of the `.devcontainer` directory; the other two forms
 * belong to their own directory.
 */
export declare function workspacePathFor(configPath: string): string;
/**
 * Roots to scan: the session cwd is always included, then allowed roots.
 * Every root is realpath-normalized before deduplication so symlinked roots
 * collapse into the same real path used by Docker label discovery.
 */
export declare function workspaceRootsFor(sessionCwd: string, allowedWorkspaceRoots: readonly string[], realpath?: (path: string) => string): string[];
/**
 * Scan every allowed workspace root for the three canonical DevContainer
 * configuration forms. Root is depth 0; directories are visited down to
 * `discovery.maxDepth` inclusive. Excluded and hidden directories are never
 * entered (`.devcontainer` is preserved), and each directory is enumerated in
 * sorted order for deterministic output.
 */
export declare function discoverHostConfigs(options: HostDiscoveryOptions): HostDiscoveryResult;
/**
 * Merge host configuration discoveries with Docker label candidates into a
 * single workspace registry keyed by the canonicalized real workspace path.
 *
 * Each entry's variant (`kind`) says what was found — `"config"` when the host owns a configuration
 * (with or without a labelled container), `"container-only"` when the workspace is known only through
 * a labelled container. `discoveredFrom` records HOW it was found and is informational: it carries no
 * state that `kind` does not already determine (review finding L4-04).
 *
 * - host + docker on the same key -> `kind: "config"`, `discoveredFrom: "both"`
 * - host only -> `kind: "config"`, `discoveredFrom: "host-config"`
 * - docker only -> `kind: "container-only"`, `discoveredFrom: "docker-label"` — no configuration path
 *   and no placeholder kind, because there is no configuration
 * - a candidate without a `devcontainer.local_folder` label has no workspace
 *   identity and is never registered; a diagnostic is emitted instead
 */
export declare function buildWorkspaceRegistry(input: DiscoveryInput): RegistryResult;
//# sourceMappingURL=host-discovery.d.ts.map