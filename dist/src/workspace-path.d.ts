/**
 * Safe host workspace identity comparison.
 *
 * Registry entries and selections are keyed by a canonicalized workspace
 * path so that Docker labels and host configuration discovery unify without
 * duplicates. Canonicalization uses `realpath` only where the path exists;
 * missing paths keep their resolved form so distinct values are never
 * collapsed into one key.
 */
export declare function canonicalWorkspaceKey(path: string, platform?: NodeJS.Platform): string;
export declare function resolveRealPath(path: string): string;
export declare function isPathBelow(workspace: string, root: string, platform?: NodeJS.Platform): boolean;
export declare function uniqueWorkspaceKeys(paths: readonly string[]): string[];
//# sourceMappingURL=workspace-path.d.ts.map