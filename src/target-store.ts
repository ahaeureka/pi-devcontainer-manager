import { RuntimeError } from "./errors.js";

/**
 * Serialized session-scoped target state machine.
 *
 * Selection intent is stored separately from volatile container reality.
 * Every mutating operation is serialized through an internal promise queue;
 * read-only refresh may run concurrently. An operation binds one immutable
 * `ExecutionContext` before spawning so a concurrent A→B selection switch
 * cannot redirect an in-flight command.
 */

export type SelectionStatus =
  | "none"
  | "selected-valid"
  | "selected-ambiguous"
  | "selected-missing"
  | "selected-stopped"
  | "selected-policy-denied"
  | "refreshing";

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

export class TargetStore {
  private selection: TargetSelection = { status: "none" };
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly options: {
    clock?: () => string;
  }) {}

  public snapshot(): TargetStoreSnapshot {
    return {
      status: this.selection.status,
      workspaceKey: this.selection.workspaceKey,
      candidateId: this.selection.candidate?.id,
      detail: this.selection.detail,
      ...(this.selection.candidate?.configPath !== undefined ? { configPath: this.selection.candidate.configPath } : {}),
    };
  }

  public current(): TargetSelection {
    return this.selection;
  }

  /**
   * Serialized selection update. Concurrent calls resolve in call order; the
   * last committed write wins atomically.
   */
  public select(target: TargetSelection): Promise<void> {
    return this.enqueue(() => {
      this.selection = target;
    });
  }

  public clear(): Promise<void> {
    return this.enqueue(() => {
      this.selection = { status: "none" };
    });
  }

  public async beginRefresh(): Promise<void> {
    await this.enqueue(() => {
      if (this.selection.status !== "none") {
        this.selection = { ...this.selection, status: "refreshing" };
      }
    });
  }

  public async endRefresh(next: TargetSelection): Promise<void> {
    await this.enqueue(() => {
      this.selection = next;
    });
  }

  /**
   * Bind an immutable execution context from the current selection. Throws a
   * typed error when the target is not resolvable to exactly one running
   * candidate, so no operation ever silently falls back to the host.
   */
  public bind(): ExecutionContext {
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

  private enqueue<T>(work: () => T): Promise<T> {
    const next = this.queue.then(() => work());
    // Keep the queue alive even when a prior operation rejects.
    this.queue = next.catch(() => undefined);
    return next;
  }
}
