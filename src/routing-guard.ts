/**
 * The REVERSE routing guard: a container-surface request that names the HOST workspace path.
 *
 * The forward direction has been guarded since the first review phase: a host surface refuses an argv
 * that reaches for a container-only path. The other direction had nothing, so a command that meant
 * "operate on the host's copy of this file" could be handed to the container, where the same path
 * either does not exist or — worse — exists for a different reason (a container-only mount, `/tmp`,
 * `/etc`) and the command silently operates on the wrong file.
 *
 * Deliberately narrow, for the reason the Phase-5 review established: a heuristic over shell TEXT
 * cannot be made safe, so this checks LITERAL argv elements for PATH IDENTITY with the host workspace
 * path — an exact match, or a match with a real path-segment boundary. It does not inspect routed
 * shell text at all, and it says nothing when there is no mapping to consult or when the mapping
 * mounts the host path at the same path (there the host path is the container path).
 */
export interface HostToContainerMapping {
  readonly hostPath: string;
  readonly containerPath: string;
  /**
   * Paths the configuration makes visible inside the container at their own path (a `mounts` entry
   * with `source == target`). A hit covered by one of these is NOT a mis-route: the same path is
   * genuinely the same file on both sides (adversarial review of this change).
   */
  readonly containerVisiblePaths?: readonly string[];
}

/** Normalize a path for comparison: strip trailing slashes (except a bare root). */
function normalize(path: string): string {
  if (path.length > 1 && path.endsWith("/")) return path.replace(/\/+$/, "");
  return path;
}

/**
 * The offending argv element, when one names the host workspace path on a container surface.
 *
 * Returns `undefined` when nothing matches — the caller refuses only on a hit, so a false negative
 * costs nothing beyond the status quo and a false positive cannot happen for a path that merely
 * shares a textual prefix.
 */
export function detectHostPathOnContainerSurface(
  argv: readonly string[],
  mapping: HostToContainerMapping | undefined,
): string | undefined {
  if (mapping === undefined) return undefined;
  const host = normalize(mapping.hostPath);
  const container = normalize(mapping.containerPath);
  // Same path on both sides: the argument is correct as written.
  if (host === container) return undefined;
  if (host.length === 0) return undefined;
  // The container's own path space is never a mis-route — including when the configured container path
  // happens to sit BENEATH the host path (then the guard's own remedy would otherwise be refused).
  const containerSpace = container.length > 0 ? [container] : [];
  const visible = [...containerSpace, ...(mapping.containerVisiblePaths ?? []).map(normalize)];
  const isVisibleInContainer = (candidate: string): boolean =>
    visible.some((path) => candidate === path || candidate.startsWith(`${path}/`));
  for (const element of argv) {
    const candidate = normalize(element);
    if (isVisibleInContainer(candidate)) continue;
    if (candidate === host) return element;
    if (candidate.startsWith(`${host}/`)) return element;
  }
  return undefined;
}
