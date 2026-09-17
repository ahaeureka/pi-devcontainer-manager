import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
/**
 * Safe host workspace identity comparison.
 *
 * Registry entries and selections are keyed by a canonicalized workspace
 * path so that Docker labels and host configuration discovery unify without
 * duplicates. Canonicalization uses `realpath` only where the path exists;
 * missing paths keep their resolved form so distinct values are never
 * collapsed into one key.
 */
export function canonicalWorkspaceKey(path, platform = process.platform) {
    const resolved = resolve(path);
    if (platform === "win32") {
        // Windows is an explicit capability boundary: normalize separators and
        // case so a single canonical form is compared, without WSL translation.
        return resolved.replace(/\\/g, "/").toLowerCase();
    }
    return resolved;
}
/**
 * Realpath-aware canonical form: `realpath` when the path resolves, else the lexical key.
 *
 * This is the form containment compares. A path that does not exist yet (a workspace the operator
 * has configured but not created) keeps its lexical key so configuration and selection flows keep
 * working; anything that DOES resolve is compared as the filesystem sees it, so a symlink cannot
 * smuggle a workspace past a root check.
 */
export function resolveRealPath(path) {
    try {
        return canonicalWorkspaceKey(realpathSync(path));
    }
    catch {
        return canonicalWorkspaceKey(path);
    }
}
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
export function isWithinWorkspace(root, candidate, platform = process.platform) {
    if (!isAbsolute(root) || !isAbsolute(candidate))
        return false;
    const base = canonicalWorkspaceKey(resolveRealPathFor(root), platform);
    const target = canonicalWorkspaceKey(resolveRealPathFor(candidate), platform);
    return isAtOrUnder(target, base);
}
/**
 * The SEGMENT test: is `candidate` the same path as `base`, or beneath it?
 *
 * One implementation for every place that asks this question, because six separate adversarial findings
 * were the same defect — a fix applied to one surface and not its mirror. A bare `startsWith(base + "/")`
 * is wrong for a base of `/` (it builds `//` and matches nothing), and raw comparison is wrong for two
 * spellings that differ only in a trailing slash, so both cases live here once.
 */
export function isAtOrUnder(candidate, base) {
    // Equivalent spellings are the same path: resolve `.` and `..` segments and collapse repeated separators
    // first, so `//host/proj/x` and `/host/././proj/x` match `/host/proj`, while `/host/proj/..` does not
    // (adversarial review: the previous single-pass collapse missed both directions).
    base = normalizeSegments(base);
    candidate = normalizeSegments(candidate);
    const trimmedBase = base.length > 1 ? base.replace(/\/+$/, "") : base;
    const trimmedCandidate = candidate.length > 1 ? candidate.replace(/\/+$/, "") : candidate;
    if (trimmedCandidate === trimmedBase)
        return true;
    if (trimmedBase === "/")
        return trimmedCandidate.startsWith("/");
    return trimmedCandidate.startsWith(`${trimmedBase}/`);
}
/**
 * Resolve `.` and `..` segments and collapse repeated separators, purely textually (no filesystem access).
 *
 * The guards compare LITERAL argv elements, so this must be a string operation; it is also the shared
 * normalization every consumer uses, so a spelling cannot be "the same path" for one caller and not another.
 */
export function normalizeSegments(path) {
    const absolute = path.startsWith("/");
    const out = [];
    for (const segment of path.split("/")) {
        if (segment === "" || segment === ".")
            continue;
        if (segment === "..") {
            if (out.length > 0 && out[out.length - 1] !== "..")
                out.pop();
            else if (!absolute)
                out.push("..");
            continue;
        }
        out.push(segment);
    }
    const joined = `${absolute ? "/" : ""}${out.join("/")}`;
    return joined.length > 0 ? joined : absolute ? "/" : ".";
}
/** Two spellings of the same path (trailing slashes and a lone root). */
export function isSamePath(left, right) {
    const trim = (value) => (value.length > 1 ? value.replace(/\/+$/, "") : value);
    return trim(left) === trim(right);
}
/** `realpath` when it resolves, else the path unchanged (the platform fold happens in the key). */
function resolveRealPathFor(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return path;
    }
}
export function uniqueWorkspaceKeys(paths) {
    const seen = new Set();
    const result = [];
    for (const path of paths) {
        const key = canonicalWorkspaceKey(path);
        if (!seen.has(key)) {
            seen.add(key);
            result.push(path);
        }
    }
    return result;
}
//# sourceMappingURL=workspace-path.js.map