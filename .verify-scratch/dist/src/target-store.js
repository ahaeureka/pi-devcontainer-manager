import { RuntimeError } from "./errors.js";
export class TargetStore {
    options;
    selection = { status: "none" };
    queue = Promise.resolve();
    constructor(options) {
        this.options = options;
    }
    snapshot() {
        return {
            status: this.selection.status,
            workspaceKey: this.selection.workspaceKey,
            candidateId: this.selection.candidate?.id,
            detail: this.selection.detail,
            ...(this.selection.candidate?.configPath !== undefined ? { configPath: this.selection.candidate.configPath } : {}),
        };
    }
    current() {
        return this.selection;
    }
    /**
     * Serialized selection update. Concurrent calls resolve in call order; the
     * last committed write wins atomically.
     */
    select(target) {
        return this.enqueue(() => {
            this.selection = target;
        });
    }
    /**
     * Commit `target` only if nothing is selected, reporting whether it committed.
     *
     * The emptiness check and the write are one queued operation, so an explicit
     * `/devcontainer use` that lands between a caller's snapshot read and this call wins instead of
     * being overwritten by a later-enqueued auto-selection (review finding L3-05).
     */
    selectIfNone(target) {
        return this.enqueue(() => {
            if (this.selection.status !== "none")
                return false;
            this.selection = target;
            return true;
        });
    }
    clear() {
        return this.enqueue(() => {
            this.selection = { status: "none" };
        });
    }
    async beginRefresh() {
        await this.enqueue(() => {
            if (this.selection.status !== "none") {
                this.selection = { ...this.selection, status: "refreshing" };
            }
        });
    }
    async endRefresh(next) {
        await this.enqueue(() => {
            this.selection = next;
        });
    }
    /**
     * Bind an immutable execution context from the current selection. Throws a
     * typed error when the target is not resolvable to exactly one running
     * candidate, so no operation ever silently falls back to the host.
     */
    bind() {
        const selection = this.selection;
        const refusal = refusalFor(selection);
        if (refusal !== undefined)
            throw refusal;
        const candidate = selection.candidate;
        if (candidate === undefined) {
            // Unreachable through this store's own transitions: `selected-valid` is only ever committed
            // with a candidate. Kept as a guard for a hand-built state rather than as part of the status
            // mapping (which is exhaustive below).
            throw new RuntimeError({
                kind: "unexpected",
                message: `TargetStore is in an invalid state: ${selection.status} carries no candidate`,
            });
        }
        if (candidate.state !== "running") {
            throw new RuntimeError({
                kind: "target-stopped",
                message: `Selected target ${candidate.name} is not running (state ${candidate.state}).`,
                remedy: "Run /devcontainer up before executing.",
            });
        }
        return {
            workspaceKey: selection.workspaceKey ?? candidate.workspaceKey,
            candidateId: candidate.id,
            candidateName: candidate.name,
            ...(candidate.configPath !== undefined ? { configPath: candidate.configPath } : {}),
            boundAt: this.options.clock?.() ?? new Date().toISOString(),
        };
    }
    enqueue(work) {
        const next = this.queue.then(() => work());
        // Keep the queue alive even when a prior operation rejects.
        this.queue = next.catch(() => undefined);
        return next;
    }
}
/**
 * The typed refusal for a selection that cannot be bound, or `undefined` when it can.
 *
 * One dispatch, one place (review finding L3-09): this used to be seven repeated `RuntimeError`
 * constructions inside `bind()`, so adding a `SelectionStatus` produced no compiler signal — the new
 * status silently fell through to `unexpected`. The `never` guard below turns that into a build
 * failure, and the refusals keep their kinds, messages and remedies exactly.
 */
function refusalFor(selection) {
    switch (selection.status) {
        case "none":
            return new RuntimeError({
                kind: "no-candidate",
                message: "No DevContainer target is selected.",
                remedy: "Run /devcontainer list then /devcontainer use <workspace>.",
            });
        case "refreshing":
            return new RuntimeError({
                kind: "target-refreshing",
                message: "Target state is refreshing; retry the operation.",
                remedy: "Retry after the refresh completes.",
            });
        case "selected-ambiguous":
            return new RuntimeError({
                kind: "ambiguous-candidate",
                message: `Ambiguous target for ${selection.workspaceKey ?? "workspace"} (multiple candidates).`,
                remedy: "Select an explicit candidate ID with /devcontainer use.",
            });
        case "selected-missing":
            return new RuntimeError({
                kind: "target-stopped",
                message: `Selected target for ${selection.workspaceKey ?? "workspace"} no longer exists.`,
                remedy: "Run /devcontainer up to recreate it.",
            });
        case "selected-stopped":
            return new RuntimeError({
                kind: "target-stopped",
                message: `Selected target for ${selection.workspaceKey ?? "workspace"} is stopped.`,
                remedy: "Run /devcontainer up to start it.",
            });
        case "selected-policy-denied":
            return new RuntimeError({
                kind: "policy-denied",
                message: selection.detail ?? "Selected target was denied by policy.",
                remedy: "Review workspace-root and environment policy.",
            });
        case "selected-valid":
            return undefined;
        default: {
            const unhandled = selection.status;
            throw new Error(`Unhandled selection status: ${String(unhandled)}`);
        }
    }
}
//# sourceMappingURL=target-store.js.map