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
/**
 * Realpath-aware canonical form: `realpath` when the path resolves, else the lexical key.
 *
 * This is the form containment compares. A path that does not exist yet (a workspace the operator
 * has configured but not created) keeps its lexical key so configuration and selection flows keep
 * working; anything that DOES resolve is compared as the filesystem sees it, so a symlink cannot
 * smuggle a workspace past a root check.
 */
export declare function resolveRealPath(path: string): string;
/**
 * The one containment test: is `candidate` the `root` workspace or beneath it?
 *
 * Review finding L5-01: this question used to be answered three ways — `policy` resolved `realpath`
 * and compared with `relative`, a lexical prefix check lived here, and the execution service
 * compared canonical keys inline — with different fallbacks for a path that does not exist and a
 * win32 case fold in only one of them. All three now call this function.
 *
 * The comparison is segment-wise on canonical keys (which use `/` on every platform), so a sibling
 * whose name merely starts with the root's name (`/repo/app` vs `/repo/application`) is not
 * "inside" it.
 */
export declare function isWithinWorkspace(root: string, candidate: string, platform?: NodeJS.Platform): boolean;
/**
 * The SEGMENT test: is `candidate` the same path as `base`, or beneath it?
 *
 * One implementation for every place that asks this question, because six separate adversarial findings
 * were the same defect — a fix applied to one surface and not its mirror. A bare `startsWith(base + "/")`
 * is wrong for a base of `/` (it builds `//` and matches nothing), and raw comparison is wrong for two
 * spellings that differ only in a trailing slash, so both cases live here once.
 */
export declare function isAtOrUnder(candidate: string, base: string): boolean;
/** Two spellings of the same path (trailing slashes and a lone root). */
export declare function isSamePath(left: string, right: string): boolean;
export declare function uniqueWorkspaceKeys(paths: readonly string[]): string[];
//# sourceMappingURL=workspace-path.d.ts.map