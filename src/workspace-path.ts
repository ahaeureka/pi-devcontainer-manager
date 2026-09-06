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

export function canonicalWorkspaceKey(path: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = resolve(path);
  if (platform === "win32") {
    // Windows is an explicit capability boundary: normalize separators and
    // case so a single canonical form is compared, without WSL translation.
    return resolved.replace(/\\/g, "/").toLowerCase();
  }
  return resolved;
}

export function resolveRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return canonicalWorkspaceKey(path);
  }
}

export function isPathBelow(workspace: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!isAbsolute(workspace) || !isAbsolute(root)) return false;
  const candidate = canonicalWorkspaceKey(workspace, platform);
  const base = canonicalWorkspaceKey(root, platform);
  if (candidate === base) return true;
  // Canonical keys use forward slashes on every platform.
  return candidate.startsWith(`${base}/`);
}

export function uniqueWorkspaceKeys(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const key = canonicalWorkspaceKey(path);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(path);
    }
  }
  return result;
}
