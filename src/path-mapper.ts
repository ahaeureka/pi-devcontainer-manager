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
export function parseWorkspaceMount(mount: string | undefined): ParsedMount {
  if (mount === undefined || mount.trim().length === 0) return {};
  const parts: Record<string, string> = {};
  for (const part of mount.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    parts[key] = value;
  }
  const out: ParsedMount = {};
  if (typeof parts.source === "string") out.source = parts.source;
  if (typeof parts.target === "string") out.target = parts.target;
  if (typeof parts.type === "string") out.type = parts.type;
  return out;
}

/** Expand `${localWorkspaceFolder}` (and bare `$localWorkspaceFolder`) to the config host dir. */
export function expandLocalWorkspaceFolder(value: string | undefined, localWorkspaceFolder: string): string | undefined {
  if (value === undefined) return undefined;
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
export function buildPathMapping(
  configDir: string,
  workspaceFolder: string | undefined,
  workspaceMount: string | undefined,
): PathMapping | undefined {
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
export function hostToContainer(path: string, mapping: PathMapping | undefined): string | undefined {
  if (mapping === undefined) return undefined;
  const host = normalize(mapping.hostPath);
  const candidate = normalize(path);
  if (candidate === host) return mapping.containerPath;
  if (candidate.startsWith(`${host}/`)) {
    return `${mapping.containerPath}${candidate.slice(host.length)}`;
  }
  return undefined;
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
export function findContainerPath(argv: readonly string[], containerPath: string): string | undefined {
  const base = normalize(containerPath);
  if (base.length === 0) return undefined;
  for (const token of argv) {
    if (typeof token !== "string" || !token.startsWith("/")) continue;
    const candidate = normalize(token);
    if (candidate === base || candidate.startsWith(`${base}/`)) return token;
  }
  return undefined;
}

function normalize(p: string): string {
  // Paths here are already absolute; just trim a trailing slash for prefix math.
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}
