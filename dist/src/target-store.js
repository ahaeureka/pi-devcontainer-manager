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
        if (selection.status === "none") {
            throw new RuntimeError({
                kind: "no-candidate",
                message: "No DevContainer target is selected.",
                remedy: "Run /devcontainer list then /devcontainer use <workspace>.",
            });
        }
        if (selection.status === "refreshing") {
            throw new RuntimeError({
                kind: "target-stopped",
                message: "Target state is refreshing; retry the operation.",
                remedy: "Retry after the refresh completes.",
            });
        }
        if (selection.status === "selected-ambiguous") {
            throw new RuntimeError({
                kind: "ambiguous-candidate",
                message: `Ambiguous target for ${selection.workspaceKey ?? "workspace"} (multiple candidates).`,
                remedy: "Select an explicit candidate ID with /devcontainer use.",
            });
        }
        if (selection.status === "selected-missing") {
            throw new RuntimeError({
                kind: "target-stopped",
                message: `Selected target for ${selection.workspaceKey ?? "workspace"} no longer exists.`,
                remedy: "Run /devcontainer up to recreate it.",
            });
        }
        if (selection.status === "selected-stopped") {
            throw new RuntimeError({
                kind: "target-stopped",
                message: `Selected target for ${selection.workspaceKey ?? "workspace"} is stopped.`,
                remedy: "Run /devcontainer up to start it.",
            });
        }
        if (selection.status === "selected-policy-denied") {
            throw new RuntimeError({
                kind: "policy-denied",
                message: selection.detail ?? "Selected target was denied by policy.",
                remedy: "Review workspace-root and environment policy.",
            });
        }
        const candidate = selection.candidate;
        if (selection.status !== "selected-valid" || candidate === undefined) {
            throw new RuntimeError({
                kind: "unexpected",
                message: `TargetStore is in an invalid state: ${selection.status}`,
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
//# sourceMappingURL=target-store.js.map