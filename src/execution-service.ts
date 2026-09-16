/**
 * Shared execution orchestration for every command pathway.
 *
 * `devcontainer_exec`, routed Pi `bash`, `!`/`!!`, `up`, `build`, `stop`,
 * `remove`, and `logs` all delegate here so target validation, policy,
 * environment filtering, audit, output accounting, cancellation, timeout,
 * and error behavior cannot drift. The service:
 *
 * 1. Freezes an {@link OperationPolicySnapshot} for the requested operation
 *    and workspace before touching any target state.
 * 2. Binds an immutable {@link ExecutionContext} from the serialized
 *    {@link TargetStore} (re-resolves the selected target; a concurrent
 *    selection switch cannot redirect a bound operation).
 * 3. Builds a minimal child environment via `buildChildEnvironment` against
 *    the effective allowlist (never an arbitrary inherited Pi environment).
 * 4. Runs the command through the Dev Containers CLI `exec` or Docker
 *    lifecycle adapter, streaming bounded output.
 * 5. Emits one audit record (fingerprint by default) and returns a
 *    structured result with no environment values.
 *
 * Nonzero target exits are carried in the result, never thrown.
 */
import { commandIdentity as commandIdentityFor, evaluatePolicy, buildChildEnvironment } from "./policy.js";
import { workspaceHasConfig } from "./runtime/host-discovery.js";
import { canonicalWorkspaceKey } from "./workspace-path.js";
import { RuntimeError } from "./errors.js";
import type { AuditWriter } from "./audit.js";
import type { AuditRecord, EffectiveConfig, Initiator, OperationKind, OperationPolicySnapshot, PolicyInput } from "./types.js";
import type { ExecutionContext, TargetStore } from "./target-store.js";
import type { DevcontainerAdapter, ExecResult } from "./runtime/devcontainer-adapter.js";
import type { DockerLifecycleAdapter, LifecycleConfirmation, LifecycleResult } from "./runtime/docker-lifecycle.js";
import type { DockerContainer } from "./runtime/docker-adapter.js";
import { isWithinWorkspace } from "./workspace-path.js";

export interface ExecRequest {
  readonly operation: "container-exec" | "routed-bash" | "user-bash";
  readonly initiator: Initiator;
  /** Host workspace path of the selected target (policy-scoped). */
  readonly workspace: string;
  /** argv form for `container-exec`; a shell `-lc` string for routed bash. */
  readonly cmd: string;
  readonly args: readonly string[];
  /** Approved environment variables already filtered by the caller. */
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onData?: (chunk: Buffer) => void;
  readonly onStderr?: (chunk: Buffer) => void;
}

export interface ExecOutcome {
  readonly operation: OperationKind;
  readonly workspaceKey: string;
  readonly candidateId: string;
  readonly candidateName: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly policyAuthorized: boolean;
  /** Bounded captured stdout from the container-side command. */
  readonly stdout: string;
  /** Bounded captured stderr from the container-side command. */
  readonly stderr: string;
}

export interface LifecycleRequest {
  readonly operation: "stop" | "remove";
  readonly initiator: Initiator;
  readonly workspace: string;
  readonly container: DockerContainer;
  readonly confirmation: LifecycleConfirmation | undefined;
}

export type LifecycleServiceResult = LifecycleResult;

export interface UpBuildRequest {
  readonly operation: "up" | "build";
  readonly initiator: Initiator;
  readonly workspace: string;
  readonly dockerPath?: string;
  /** Named configuration to start/build (`--config`); absent uses the CLI default. */
  readonly configPath?: string;
  readonly noCache?: boolean;
  readonly imageName?: string;
  readonly signal?: AbortSignal;
}

export interface UpBuildOutcome {
  readonly operation: "up" | "build";
  readonly workspaceKey: string;
  readonly candidateId?: string;
  readonly remoteUser?: string;
  readonly remoteWorkspaceFolder?: string;
  readonly imageName?: string;
  readonly policyAuthorized: boolean;
}

export interface ExecutionServiceOptions {
  readonly config: EffectiveConfig;
  readonly targetStore: TargetStore;
  readonly devcontainer: DevcontainerAdapter;
  readonly dockerLifecycle: DockerLifecycleAdapter;
  readonly audit: AuditWriter;
  /** ISO-8601 string clock for audit timestamps. */
  readonly clock?: () => string;
  /**
   * Optional hook to auto-select a default target when none is selected yet.
   * Called with the policy-scoped request workspace BEFORE `bind()` only when
   * the target store is in `none`. Wired by the extension to select the
   * session-cwd workspace when its realpath exactly matches a discovered
   * config-only/stopped/running project; a no-op elsewhere preserves the
   * fail-closed `no-candidate` behavior.
   */
  readonly autoSelect?: (workspace: string) => Promise<void>;
  /**
   * Optional resolver that maps a HOST workspace path to its in-container
   * path (from the workspace's devcontainer.json workspaceFolder/workspaceMount).
   * Used ONLY for presentation (the workspaceKey the agent sees); the Dev
   * Containers CLI still receives the host path, which it maps itself.
   * Returns undefined when no mapping exists (host path is shown unchanged).
   */
  readonly resolveContainerWorkspace?: (hostWorkspace: string) => Promise<string | undefined>;
  /**
   * Optional probe deciding whether a workspace is itself a DevContainer project.
   * Injected by tests; defaults to the filesystem probe. It only decides whether a
   * request from outside the bound target is allowed (AC-8).
   */
  readonly workspaceHasConfig?: (workspace: string) => boolean;
}

export class ExecutionService {
  private readonly clock: () => string;

  public constructor(private readonly options: ExecutionServiceOptions) {
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  public async exec(request: ExecRequest): Promise<ExecOutcome> {
    const startedAt = Date.now();
    const snapshot = this.authorize({
      operation: request.operation,
      initiator: request.initiator,
      workspace: request.workspace,
      ...(request.environment !== undefined ? { requestedEnvironment: request.environment } : {}),
    });
    // Auto-select a default target when none is selected yet (empty-selection
    // only; an explicit prior /devcontainer use always wins). The hook is a
    // no-op for workspaces that do not exactly match the session cwd, so the
    // fail-closed no-candidate behavior is preserved elsewhere.
    // A refusal that happens BEFORE the audited region below (no target at all, an ambiguous
    // or stopped target, a mid-refresh store, or a failing auto-select) used to leave no
    // trace, while policy denials are recorded precisely so refusals are not "silently
    // absent". Bind inside an audit boundary: the record says policy allowed the operation
    // and the target state refused it, and the typed error is rethrown unchanged.
    let ctx: ExecutionContext;
    try {
      if (this.options.targetStore.snapshot().status === "none") {
        await this.options.autoSelect?.(request.workspace);
      }
      ctx = this.options.targetStore.bind();
    } catch (error) {
      this.audit(
        snapshot,
        undefined,
        { operation: request.operation, initiator: request.initiator, workspace: request.workspace },
        { outputTruncated: false, errorSummary: this.asAuditError(error).message },
      );
      throw error;
    }
    // Target/workspace integrity: the Dev Containers CLI would receive
    // `--workspace-folder <request.workspace>` while the container id comes from
    // the bound target. If those disagree, policy was evaluated for one
    // workspace while execution targets another's container. Require the request
    // workspace to be the bound target workspace (or a path below it), and always
    // send the TARGET workspace to the CLI so authorization scope, target, and
    // audit agree.
    const requestKey = canonicalWorkspaceKey(request.workspace);
    const targetKey = canonicalWorkspaceKey(ctx.workspaceKey);
    // Containment is the single owner's question (L5-01): a symlinked spelling of the bound
    // workspace resolves to it, while a sibling whose name merely starts the same does not.
    const withinTarget = isWithinWorkspace(targetKey, requestKey);
    // A request from outside the bound target is allowed ONLY when it comes from a
    // workspace that is not itself a DevContainer project. That is the
    // explicit-selection workflow (stand in a plain repository and drive a selected
    // target); a request from another project's workspace would silently act on the
    // wrong repository, so it stays refused. Either way the CLI receives the TARGET
    // workspace, so authorization scope, execution, and audit cannot disagree (AC-8).
    if (!withinTarget && this.projectProbe(request.workspace)) {
      this.audit(snapshot, undefined, request, {
        exitCode: null,
        outputTruncated: false,
        errorSummary: "request-workspace-mismatch",
      });
      throw new RuntimeError({
        kind: "policy-denied",
        message: `Requested workspace ${request.workspace} is not the selected target workspace ${ctx.workspaceKey}.`,
        remedy: "Run /devcontainer use for the target, or run the command from the target workspace.",
      });
    }
    const environment = buildChildEnvironment(
      request.environment,
      snapshot.effectiveConfig.environmentAllowlist,
    );
    const remoteEnv = Object.keys(environment).length > 0 ? environment : undefined;

    let result: ExecResult;
    try {
      result = await this.options.devcontainer.exec(
        ctx.workspaceKey,
        ctx.candidateId,
        request.cmd,
        request.args,
        {
          ...(ctx.configPath !== undefined ? { configPath: ctx.configPath } : {}),
          ...(remoteEnv !== undefined ? { remoteEnv } : {}),
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        },
      );
    } catch (error) {
      const failure = this.asAuditError(error);
      this.audit(snapshot, ctx, request, {
        durationMs: Date.now() - startedAt,
        exitCode: null,
        outputTruncated: false,
        errorSummary: failure.message,
      });
      throw error;
    }

    // Present the workspace to the agent in container terms when a mapping
    // exists (host path otherwise). CLI calls above used the host path.
    const presentedWorkspace =
      this.options.resolveContainerWorkspace !== undefined
        ? (await this.options.resolveContainerWorkspace(ctx.workspaceKey)) ?? ctx.workspaceKey
        : ctx.workspaceKey;
    const outcome: ExecOutcome = {
      operation: request.operation,
      workspaceKey: presentedWorkspace,
      candidateId: ctx.candidateId,
      candidateName: ctx.candidateName,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      truncated: result.truncated,
      policyAuthorized: snapshot.authorized,
      stdout: result.stdout,
      stderr: result.stderr,
    };
    this.audit(snapshot, ctx, request, {
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      outputTruncated: result.truncated,
    });
    return outcome;
  }

  public async up(request: UpBuildRequest): Promise<UpBuildOutcome> {
    const startedAt = Date.now();
    const snapshot = this.authorize({
      operation: "up",
      initiator: request.initiator,
      workspace: request.workspace,
    });
    let result: Awaited<ReturnType<DevcontainerAdapter["up"]>>;
    try {
      result = await this.options.devcontainer.up(request.workspace, {
        ...(request.dockerPath !== undefined ? { dockerPath: request.dockerPath } : {}),
        ...(request.configPath !== undefined ? { configPath: request.configPath } : {}),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      });
    } catch (error) {
      this.audit(snapshot, undefined, request, {
        durationMs: Date.now() - startedAt,
        exitCode: null,
        outputTruncated: false,
        errorSummary: this.asAuditError(error).message,
      });
      throw error;
    }
    this.audit(snapshot, undefined, request, { durationMs: Date.now() - startedAt, exitCode: 0, outputTruncated: false }, result.containerId);
    return {
      operation: "up",
      workspaceKey: canonicalWorkspaceKey(request.workspace),
      candidateId: result.containerId,
      ...(result.remoteUser !== undefined ? { remoteUser: result.remoteUser } : {}),
      ...(result.remoteWorkspaceFolder !== undefined ? { remoteWorkspaceFolder: result.remoteWorkspaceFolder } : {}),
      policyAuthorized: snapshot.authorized,
    };
  }

  public async build(request: UpBuildRequest): Promise<UpBuildOutcome> {
    const startedAt = Date.now();
    const snapshot = this.authorize({
      operation: "build",
      initiator: request.initiator,
      workspace: request.workspace,
    });
    let result: Awaited<ReturnType<DevcontainerAdapter["build"]>>;
    try {
      result = await this.options.devcontainer.build(request.workspace, {
        ...(request.dockerPath !== undefined ? { dockerPath: request.dockerPath } : {}),
        ...(request.configPath !== undefined ? { configPath: request.configPath } : {}),
        ...(request.noCache === true ? { noCache: true } : {}),
        ...(request.imageName !== undefined ? { imageName: request.imageName } : {}),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      });
    } catch (error) {
      this.audit(snapshot, undefined, request, {
        durationMs: Date.now() - startedAt,
        exitCode: null,
        outputTruncated: false,
        errorSummary: this.asAuditError(error).message,
      });
      throw error;
    }
    this.audit(snapshot, undefined, request, { durationMs: Date.now() - startedAt, exitCode: 0, outputTruncated: false });
    return {
      operation: "build",
      workspaceKey: canonicalWorkspaceKey(request.workspace),
      ...(result.imageName !== undefined ? { imageName: result.imageName } : {}),
      policyAuthorized: snapshot.authorized,
    };
  }

  public async lifecycle(request: LifecycleRequest): Promise<LifecycleServiceResult> {
    const snapshot = this.authorize({
      operation: request.operation,
      initiator: request.initiator,
      workspace: request.workspace,
    });
    const startedAt = Date.now();
    let result: LifecycleServiceResult;
    try {
      result = await this.options.dockerLifecycle[request.operation](
        request.container,
        request.confirmation,
      );
    } catch (error) {
      this.audit(snapshot, undefined, request, {
        durationMs: Date.now() - startedAt,
        exitCode: null,
        outputTruncated: false,
        errorSummary: this.asAuditError(error).message,
      }, request.container.id);
      throw error;
    }
    if (result.status === "done") {
      this.audit(snapshot, undefined, request, { durationMs: Date.now() - startedAt, exitCode: 0, outputTruncated: false }, request.container.id);
    } else {
      this.audit(snapshot, undefined, request, {
        durationMs: Date.now() - startedAt,
        exitCode: null,
        outputTruncated: false,
        errorSummary: "confirmation required",
      }, request.container.id);
    }
    return result;
  }

  /**
   * Bounded container logs, routed through the shared service so the read is
   * policy-checked and audited like every other operation (it previously
   * bypassed both).
   */
  public async logs(request: {
    initiator: Initiator;
    workspace: string;
    containerId: string;
    tail?: number;
    signal?: AbortSignal;
  }): Promise<{ exitCode: number | null; output: string; truncated: boolean }> {
    const snapshot = this.authorize({
      operation: "logs",
      initiator: request.initiator,
      workspace: request.workspace,
    });
    const startedAt = Date.now();
    let result: Awaited<ReturnType<DockerLifecycleAdapter["logs"]>>;
    try {
      result = await this.options.dockerLifecycle.logs(request.containerId, {
        ...(request.tail !== undefined ? { tail: request.tail } : {}),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      });
    } catch (error) {
      this.audit(snapshot, undefined, { operation: "logs", initiator: request.initiator, workspace: request.workspace }, {
        durationMs: Date.now() - startedAt,
        exitCode: null,
        outputTruncated: false,
        errorSummary: this.asAuditError(error).message,
      }, request.containerId);
      throw error;
    }
    this.audit(snapshot, undefined, { operation: "logs", initiator: request.initiator, workspace: request.workspace }, {
      durationMs: Date.now() - startedAt,
      exitCode: result.exitCode,
      outputTruncated: result.truncated,
    }, request.containerId);
    return result;
  }

  /**
   * Frozen policy gate before target resolution or spawn.
   *
   * A DENIED attempt is itself an auditable event: policy probes (workspace,
   * environment, destructive, host-exec) are recorded before the typed error is
   * thrown, so denials are visible in the audit trail instead of silently
   * absent. Denied environment VALUES are never recorded.
   */
  private authorize(input: PolicyInput): OperationPolicySnapshot {
    const now = () => new Date(this.clock());
    const snapshot = evaluatePolicy(this.options.config, input, now);
    if (!snapshot.authorized) {
      this.audit(
        snapshot,
        undefined,
        {
          operation: input.operation,
          initiator: input.initiator,
          ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
        },
        { outputTruncated: false },
      );
      throw new RuntimeError({
        kind: "policy-denied",
        message: `Operation '${input.operation}' was denied: ${snapshot.denialReason ?? "policy"}.`,
        remedy: "Review workspace-root, environment, destructive, and host-execution policy.",
      });
    }
    return snapshot;
  }

  private audit(
    snapshot: OperationPolicySnapshot,
    ctx: ExecutionContext | undefined,
    request: { operation: OperationKind; initiator: Initiator; cmd?: string; args?: readonly string[]; workspace?: string },
    extra: { durationMs?: number; exitCode?: number | null; outputTruncated?: boolean; errorSummary?: string },
    targetIdOverride?: string,
  ): void {
    const targetId = targetIdOverride ?? ctx?.candidateId;
    const record: AuditRecord = {
      version: 1,
      at: this.clock(),
      operation: request.operation,
      initiator: request.initiator,
      ...this.workspaceIdentity(ctx, request),
      ...(targetId !== undefined ? { targetId } : {}),
      policyAuthorized: snapshot.authorized,
      ...(snapshot.denialReason !== undefined ? { policyDenialReason: snapshot.denialReason } : {}),
      ...(extra.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
      ...(extra.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
      outputTruncated: extra.outputTruncated ?? false,
      commandCapture: snapshot.effectiveConfig.audit.commandCapture,
      ...this.commandIdentity(request),
      ...(extra.errorSummary !== undefined ? { errorSummary: extra.errorSummary } : {}),
    };
    this.options.audit.write(record);
  }

  /** Is this workspace itself a DevContainer project? (injectable for tests) */
  private projectProbe(workspace: string): boolean {
    return (this.options.workspaceHasConfig ?? workspaceHasConfig)(workspace);
  }

  /**
   * What the record says about *where* the operation happened: the executed workspace
   * is the bound target, and the request's cwd is recorded alongside it when the caller
   * stood somewhere else. Without a bound context (pre-bind denials) the request's
   * workspace is all there is.
   */
  private workspaceIdentity(
    ctx: ExecutionContext | undefined,
    request: { workspace?: string },
  ): { workspace?: string; requestedCwd?: string } {
    if (ctx === undefined) {
      return request.workspace !== undefined ? { workspace: request.workspace } : {};
    }
    if (request.workspace === undefined || canonicalWorkspaceKey(request.workspace) === canonicalWorkspaceKey(ctx.workspaceKey)) {
      return { workspace: ctx.workspaceKey };
    }
    return { workspace: ctx.workspaceKey, requestedCwd: request.workspace };
  }

  private commandIdentity(request: {
    operation: OperationKind;
    cmd?: string;
    args?: readonly string[];
  }): { commandFingerprint?: string; commandText?: string } {
    return commandIdentityFor([request.cmd ?? "", ...(request.args ?? [])], this.options.config.audit.commandCapture);
  }

  private asAuditError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** Convenience for building the shell form of a routed bash command. */
export function shellForm(cmd: string): { cmd: string; args: readonly string[] } {
  return { cmd: "/bin/sh", args: ["-lc", cmd] };
}
