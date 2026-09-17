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
/**
 * The offending argv element, when one names the host workspace path on a container surface.
 *
 * Returns `undefined` when nothing matches — the caller refuses only on a hit, so a false negative
 * costs nothing beyond the status quo and a false positive cannot happen for a path that merely
 * shares a textual prefix.
 */
export declare function detectHostPathOnContainerSurface(argv: readonly string[], mapping: HostToContainerMapping | undefined): string | undefined;
//# sourceMappingURL=routing-guard.d.ts.map