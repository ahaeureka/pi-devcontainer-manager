/**
 * Serialized session-scoped target state machine.
 *
 * Selection intent is stored separately from volatile container reality.
 * Every mutating operation is serialized through an internal promise queue;
 * read-only refresh may run concurrently. An operation binds one immutable
 * `ExecutionContext` before spawning so a concurrent A→B selection switch
 * cannot redirect an in-flight command.
 */
export type SelectionStatus = "none" | "selected-valid" | "selected-ambiguous" | "selected-missing" | "selected-stopped" | "selected-policy-denied" | "refreshing";
export interface TargetCandidate {
    readonly id: string;
    readonly name: string;
    readonly workspaceKey: string;
    readonly state: string;
    readonly status: string;
    /** Configuration the operator selected for this workspace, when named. */
    readonly configPath?: string;
    /** Original labelled path retained for diagnostics. */
    readonly localFolder?: string;
}
export interface TargetSelection {
    readonly status: SelectionStatus;
    /** Present when a candidate was resolved (valid/ambiguous/stopped/policy-denied). */
    readonly candidate?: TargetCandidate;
    /** Workspace key the selection was made for, when known. */
    readonly workspaceKey?: string;
    /** Reason for policy-denied / missing states. */
    readonly detail?: string;
}
export interface ExecutionContext {
    readonly workspaceKey: string;
    readonly candidateId: string;
    readonly candidateName: string;
    /** Selected configuration (`--config`); absent means the CLI default lookup. */
    readonly configPath?: string;
    /** Frozen at bind time; a later selection switch cannot change it. */
    readonly boundAt: string;
}
export interface TargetStoreSnapshot {
    readonly status: SelectionStatus;
    readonly workspaceKey: string | undefined;
    readonly candidateId: string | undefined;
    /** Configuration carried by the current selection, when it has one. */
    readonly configPath?: string;
    readonly detail: string | undefined;
}
export declare class TargetStore {
    private readonly options;
    private selection;
    private queue;
    constructor(options: {
        clock?: () => string;
    });
    snapshot(): TargetStoreSnapshot;
    current(): TargetSelection;
    /**
     * Serialized selection update. Concurrent calls resolve in call order; the
     * last committed write wins atomically.
     */
    select(target: TargetSelection): Promise<void>;
    /**
     * Commit `target` only if nothing is selected, reporting whether it committed.
     *
     * The emptiness check and the write are one queued operation, so an explicit
     * `/devcontainer use` that lands between a caller's snapshot read and this call wins instead of
     * being overwritten by a later-enqueued auto-selection (review finding L3-05).
     */
    selectIfNone(target: TargetSelection): Promise<boolean>;
    clear(): Promise<void>;
    beginRefresh(): Promise<void>;
    endRefresh(next: TargetSelection): Promise<void>;
    /**
     * Bind an immutable execution context from the current selection. Throws a
     * typed error when the target is not resolvable to exactly one running
     * candidate, so no operation ever silently falls back to the host.
     */
    bind(): ExecutionContext;
    private enqueue;
}
//# sourceMappingURL=target-store.d.ts.map