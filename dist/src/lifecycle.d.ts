/**
 * Monotonic session-lifecycle generations.
 *
 * `session_start` in the facade is asynchronous — it probes for a running container, reconciles a
 * restored selection and discovers the registry — and every one of those awaits is a window in which
 * a reload, a second start or a shutdown can supersede the start that is still running. Without
 * ownership, the superseded start assigns the shared runtime anyway and registers surfaces from an
 * activation decision that no longer describes the session, so its callbacks can dereference a
 * runtime that is already gone (review finding L0-04).
 *
 * This is the ownership rule, kept out of the facade so it is testable: a start opens a generation
 * BEFORE its first await and re-checks after each one; whoever is not current mutates nothing.
 *
 * The guard is deliberately not sticky: `invalidate()` on shutdown bumps the generation, and the next
 * start is current again — otherwise a reload could never re-engage the extension.
 */
export interface LifecycleGuard {
    /** Open a new generation and return its id; everything older is superseded. */
    begin(): number;
    /** True while the given generation still owns the session surface. */
    isCurrent(generation: number): boolean;
    /** Invalidate whatever is in flight (shutdown), without blocking the next start. */
    invalidate(): void;
    /** The generation that currently owns the surface (0 before the first start). */
    current(): number;
    /**
     * Run `apply` only while `generation` still owns the surface.
     *
     * This is the mutation point the facade uses for everything that changes the session surface
     * (assigning the runtime, registering tools, replacing `bash`), so a superseded start applies
     * nothing. Reports whether it ran, which lets a caller stop a multi-step flow early.
     */
    ifCurrent(generation: number, apply: () => void): boolean;
}
export declare function createLifecycleGuard(): LifecycleGuard;
//# sourceMappingURL=lifecycle.d.ts.map