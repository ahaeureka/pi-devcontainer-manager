import type { Context } from "@deepseek-ai/cordis";
import {
  ShellExecutor,
  type CollectedOutput,
  type ShellExecRequest,
  type ShellExecSpec,
  type ShellExecution,
  type ShellProcessRead,
  type ShellRunResult,
} from "@deepseek-ai/dsh-shell";
import { executeWithTimeout } from "../../src/bash-router.js";
import { RuntimeError } from "../../src/errors.js";
import { shellForm, type ExecOutcome, type ExecRequest, type ExecutionService } from "../../src/execution-service.js";
import { workspaceHasConfig } from "../../src/runtime/host-discovery.js";
import { canonicalWorkspaceKey } from "../../src/workspace-path.js";

/**
 * The `ctx.shell` provider that runs every dsh shell command inside the selected DevContainer.
 *
 * This is the whole point of the dsh port: dsh routes ALL shell work through one capability seam
 * (`ctx.shell`), so providing it here means the bash tool, hook bridges and any other plugin using
 * `ctx.shell` follow the operator's `devcontainer use` selection without knowing about containers.
 * Registering two tools instead would leave every other consumer on the host.
 *
 * Execution itself delegates to {@link ExecutionService}, the same gate Pi uses: target binding,
 * policy, the reverse routing guard, environment delivery, audit, bounded output, cancellation and
 * timeout. Nothing about that is re-implemented here.
 *
 * ## Deliberate limitations (fail loud, never fake)
 *
 * - **Foreground only.** `execute()` settles before it returns, because `ExecutionService.exec` is a
 *   batch API (it resolves with the collected outcome). dsh's `run_in_background` therefore cannot be
 *   honoured: the composition disables it (`tool-bash.enableRunInBackground: false`). A handle that
 *   claimed to be live while the command was actually finished would be worse than refusing.
 * - **`kill()` is a no-op** for the same reason: by the time a caller holds the handle the command has
 *   already settled, so there is nothing left to kill.
 * - **`stdin` is rejected.** No execution path in this project writes a command's stdin, and silently
 *   dropping bytes would corrupt the caller's protocol.
 *
 * ## Per-workspace activation, with a host delegate
 *
 * Replacing `ctx.shell` is process-wide, but DevContainer management is per WORKSPACE (the Pi side
 * activates from the project's own `.devcontainer/…`). A provider that hijacked every workspace
 * would break every non-DevContainer project in the same profile — every shell command refused with
 * `no target is selected`. So this provider ACTIVATES the way the Pi extension does: when the
 * workspace has its own devcontainer configuration, commands run in the container (and fail closed
 * when no target is bound); otherwise the request is handed to a delegate executor — the harness's
 * own host executor, with its sandbox semantics intact. Delegation is not a fallback that weakens a
 * gate: a managed workspace never reaches it.
 */
export interface DevcontainerShellOptions {
  /** The shared, governed execution service. */
  readonly execution: ExecutionService;
  /** Host workspace used when a request names no workdir, and for the policy-scoped workspace. */
  readonly workspace: string;
  /** Default per-command deadline (dsh's `ShellExecRequest.timeoutMs` overrides it). */
  readonly timeoutMs?: number;
  /** Hard cap on any caller-supplied deadline. */
  readonly maxTimeoutMs?: number;
  /** Per-stream capture cap for the collected output. */
  readonly maxOutputBytes?: number;
  /**
   * Host executor for workspaces that are NOT DevContainer-managed.
   *
   * Resolved lazily because the delegate registers itself on an isolated child scope and may not
   * exist yet when this provider is constructed. Returning `undefined` means the deployment has no
   * host executor: an unmanaged workspace then refuses with a typed error rather than silently
   * running somewhere unexpected.
   */
  readonly hostExecutor?: () => ShellExecutor | undefined;
  /** Whether a workspace is DevContainer-managed. Defaults to "has its own devcontainer config". */
  readonly isManaged?: (workspace: string) => boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TIMEOUT_MS = 900_000;
const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024;

export class DevcontainerShellExecutor extends ShellExecutor {
  public constructor(
    ctx: Context,
    private readonly options: DevcontainerShellOptions,
  ) {
    super(ctx);
  }

  /**
   * Resolve through the delegate when this workspace is not DevContainer-managed.
   *
   * Both `resolve` and `execute` consult {@link isManaged} so a spec never mixes the two paths: dsh
   * calls `resolve` then `execute`, and the workspace does not change in between.
   */
  public resolve(request: ShellExecRequest): ShellExecSpec {
    const delegate = this.delegateFor(request.workdir);
    if (delegate !== undefined) return delegate.resolve(request);
    const maxTimeoutMs = this.options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
    const requested = request.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.max(1, Math.min(Math.round(requested), maxTimeoutMs));
    const maxOutputBytes = this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const stdoutMaxBytes = Math.max(1, Math.min(request.stdoutMaxBytes ?? maxOutputBytes, maxOutputBytes));
    const workdir = this.hostWorkdir(request.workdir);
    return {
      command: request.command,
      workdir,
      timeoutMs,
      onExpiry: request.onExpiry ?? "kill",
      stdoutMaxBytes,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.env !== undefined ? { env: request.env } : {}),
      ...(request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {}),
      sandboxPolicy: request.sandboxPolicy,
    };
  }

  public async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const delegate = this.delegateFor(spec.workdir);
    if (delegate !== undefined) return delegate.execute(spec);
    const shell = shellForm(spec.command);
    const explicitEnvironment = collectEnvironment(spec);
    const request: Omit<ExecRequest, "signal"> = {
      operation: "routed-bash",
      initiator: "routed-bash",
      workspace: spec.workdir,
      cmd: shell.cmd,
      args: [...shell.args],
      ...(explicitEnvironment !== undefined ? { explicitEnvironment } : {}),
    };

    let outcome: ExecOutcome | undefined;
    let timedOut = false;
    let abortedFirst = false;
    try {
      outcome =
        spec.onExpiry === "none"
          ? await this.options.execution.exec({ ...request, ...(spec.signal !== undefined ? { signal: spec.signal } : {}) })
          : await executeWithTimeout(
              request,
              spec.timeoutMs,
              spec.signal,
              (execRequest) => this.options.execution.exec(execRequest),
            );
    } catch (error) {
      if (error instanceof RuntimeError && error.kind === "timeout") {
        timedOut = true;
      } else if (spec.signal?.aborted === true) {
        // A cancellation is not an infrastructure failure: dsh expects a settled, classified result.
        abortedFirst = true;
      } else {
        // Policy denials, a missing/ambiguous target, an unusable CLI — all preparation failures.
        // dsh's contract lets `execute()` throw for these, and pretending otherwise would hide the
        // refusal inside a tool result.
        throw error;
      }
    }

    const stdout: CollectedOutput = { text: outcome?.stdout ?? "", truncated: outcome?.truncated ?? false };
    const stderr: CollectedOutput = { text: outcome?.stderr ?? "", truncated: outcome?.truncated ?? false };
    const runResult: ShellRunResult = {
      exitCode: outcome?.exitCode ?? null,
      signal: (outcome?.signal ?? null) as NodeJS.Signals | null,
      timedOut,
      aborted: abortedFirst && !timedOut,
      timeoutMs: spec.timeoutMs,
      stdout,
      stderr,
    };
    const killed = timedOut || abortedFirst || runResult.exitCode === null;
    return settledHandle(runResult, killed ? "killed" : "completed");
  }

  /** The host executor that owns this workspace, or `undefined` when the container path applies. */
  private delegateFor(workdir: string | undefined): ShellExecutor | undefined {
    const managed = this.options.isManaged ?? defaultIsManaged;
    const workspace = workdir === undefined || !isAbsolutePath(workdir) ? this.options.workspace : workdir;
    if (managed(workspace)) return undefined;
    return this.options.hostExecutor?.();
  }

  /**
   * The HOST working directory. `devcontainer exec` runs on the host and receives
   * `--workspace-folder <host path>`; the CLI maps the path itself, so a container path here would
   * name a directory that does not exist on this side.
   */
  private hostWorkdir(workdir: string | undefined): string {
    const candidate = workdir ?? this.options.workspace;
    if (!isAbsolutePath(candidate)) return this.options.workspace;
    const key = canonicalWorkspaceKey(candidate);
    return key.length > 0 ? key : this.options.workspace;
  }
}

/**
 * Default activation rule: the workspace declares its own devcontainer configuration.
 *
 * Same rule the Pi extension uses (`workspaceHasConfig`), so "is this project a DevContainer project?"
 * has one answer in both harnesses.
 */
function defaultIsManaged(workspace: string): boolean {
  try {
    return workspaceHasConfig(workspace);
  } catch {
    // An unreadable workspace must not silently become a HOST one: treat it as managed so the
    // container path's own diagnostics (missing target, policy denial) are what the caller sees.
    return true;
  }
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/");
}

/**
 * Deliver the caller's declared environment verbatim.
 *
 * dsh's `env` carries entries a trusted in-process caller set for THIS command (hook bridges set
 * `CLAUDE_PROJECT_DIR`) and `dshEnv` carries harness-owned `DSH_*` facts. `buildChildEnvironment`'s
 * allowlist governs inherited ambient state, not these, so they travel on `explicitEnvironment`.
 */
function collectEnvironment(spec: ShellExecSpec): Record<string, string> | undefined {
  const merged: Record<string, string> = { ...(spec.env ?? {}), ...(spec.dshEnv ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * A handle for an execution that has already settled.
 *
 * `readOutput()` delivers the collected output exactly once (the contract is "output since the
 * previous read"), and the offset readers expose the same text without consuming it.
 */
function settledHandle(result: ShellRunResult, status: "completed" | "killed"): ShellExecution {
  let drained = false;
  const delta = result.stderr.text.length > 0
    ? `${result.stdout.text}\n[stderr]\n${result.stderr.text}`
    : result.stdout.text;
  return {
    status,
    exitCode: result.exitCode,
    signal: result.signal,
    done: Promise.resolve(),
    readOutput(): ShellProcessRead {
      if (drained) return { delta: "", lossy: false };
      drained = true;
      if (!result.stdout.truncated && !result.stderr.truncated) return { delta, lossy: false };
      return {
        delta,
        lossy: true,
        ...(result.stdout.spillPath !== undefined ? { stdoutSpillPath: result.stdout.spillPath } : {}),
        ...(result.stderr.spillPath !== undefined ? { stderrSpillPath: result.stderr.spillPath } : {}),
      };
    },
    observed: {
      stdout: offsetReader(result.stdout.text),
      stderr: offsetReader(result.stderr.text),
    },
    kill: () => false,
    result: async () => result,
  };
}

/** A byte-offset reader over an already-collected stream. */
function offsetReader(text: string): { readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean } } {
  const bytes = Buffer.from(text, "utf8");
  return {
    readFrom(fromByte: number) {
      const from = Number.isFinite(fromByte) ? Math.max(0, Math.min(Math.trunc(fromByte), bytes.length)) : 0;
      return { text: bytes.subarray(from).toString("utf8"), nextOffset: bytes.length, lossy: false };
    },
  };
}
