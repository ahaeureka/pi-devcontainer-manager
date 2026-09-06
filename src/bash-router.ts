/**
 * `BashOperations` translation to the shared execution service.
 *
 * Pi's `bash` tool and the `!`/`!!` `user_bash` route both delegate through
 * Pi's `BashOperations` interface. This module implements that interface
 * against {@link ExecutionService.exec} so shell text receives the identical
 * gates as the structured `devcontainer_exec` tool: target validation, policy
 * snapshot, environment filtering, audit, output accounting, cancellation,
 * and timeout. Pi passes raw shell command text, so we wrap it with
 * `shellForm()` (`/bin/sh -lc`).
 *
 * The execution service captures stdout/stderr into `ExecOutcome` (bounded by
 * `maxOutputBytes`, `truncated` flag set). After the command settles, this
 * router replays the captured output through Pi's single `onData` callback —
 * the contract Pi's bash tool uses to render its result — and returns the
 * container-side exit code.
 *
 * There is intentionally NO silent host fallback here. When no target is
 * selected, the target is ambiguous/stale/stopped, or policy denies the
 * operation, the underlying typed error propagates to the caller. The only
 * host escape hatch is the explicit, policy-gated, audited
 * `devcontainer_host_exec` surface (see tools/commands).
 *
 * This module is deliberately free of Pi package imports: `src/` is unit
 * tested without the Pi dependency. The structural shape below matches Pi's
 * `BashOperations`, and `extensions/index.ts` casts it when wiring.
 */
import { shellForm, type ExecutionService, type ExecRequest, type ExecOutcome } from "./execution-service.js";
import { canonicalWorkspaceKey } from "./workspace-path.js";
import { isAbsolute } from "node:path";
import { RuntimeError } from "./errors.js";
/** The two initiators that route shell text into the container. */
export type BashRoute = "routed-bash" | "user-bash";

export interface RoutedBashOptions {
  /** Shared execution service; the bash tool and `!`/`!!` use the same one. */
  readonly execution: ExecutionService;
  /**
   * Host session workspace (Pi's cwd). Used as the policy-scoped workspace
   * when Pi reports a non-absolute cwd.
   */
  readonly sessionWorkspace: string;
  /** Which initiator this router instance represents. */
  readonly initiator: BashRoute;
  /** Allowlisted environment variable names that may reach the container. */
  readonly environmentAllowlist: readonly string[];
}

/**
 * Structural match for Pi's `BashOperations` (`@earendil-works/pi-coding-agent`,
 * `dist/core/tools/bash.d.ts`). Declared locally so `src/` stays dependency-free.
 */
export interface BashOperationsLike {
  exec(
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<{ exitCode: number | null; truncated?: boolean }>;
}
/**
 * Build a `BashOperations` implementation that routes every command into the
 * currently selected container through the execution service.
 *
 * The returned object is suitable for BOTH `createBashToolDefinition(cwd,
 * { operations })` and the `user_bash` handler's `{ operations }` result, so
 * LLM bash and `!`/`!!` cannot drift. Pi's `timeout` is in seconds; the
 * router enforces it in the operations layer via `executeWithTimeout` (the
 * locked service does not forward per-request timeouts).
 */
export function createRoutedBashOperations(options: RoutedBashOptions): BashOperationsLike {
  return {
    exec: (command, cwd, execOptions) =>
      new RoutedBashRouter(options).exec(command, cwd, execOptions),
  };
}

/**
 * Run `exec(request)` with a caller-visible timeout.
 *
 * The locked `ExecutionService.exec` forwards only `remoteEnv` + `signal` to
 * the devcontainer adapter (the adapter applies its own bounded CLI timeout),
 * so a per-request `timeoutMs` would be a silent no-op there. Pi's own bash
 * tool contract puts timeout enforcement in the operations layer, so this
 * wrapper owns it: a linked `AbortController` is aborted when the timer
 * fires, killing the child via the runner's abort path, and a typed
 * `timeout` error is raised. The caller's own `signal` is linked to the
 * controller so both surfaces behave identically.
 */
export async function executeWithTimeout(
  request: Omit<ExecRequest, "signal">,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  exec: (request: ExecRequest) => Promise<ExecOutcome>,
): Promise<ExecOutcome> {
  if (timeoutMs === undefined) {
    return exec({ ...request, ...(signal !== undefined ? { signal } : {}) });
  }
  const controller = new AbortController();
  const link = () => controller.abort();
  if (signal !== undefined) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", link, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<ExecOutcome>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", link);
      fn();
    };
    timer = setTimeout(() => {
      controller.abort();
      done(() => reject(new RuntimeError({
        kind: "timeout",
        message: `Command timed out after ${Math.round(timeoutMs / 1000)}s`,
      })));
    }, timeoutMs);
    exec({ ...request, signal: controller.signal }).then(
      (outcome) => done(() => resolve(outcome)),
      (error) => done(() => reject(error)),
    );
  });
}

class RoutedBashRouter {
  public constructor(private readonly options: RoutedBashOptions) {}

  public async exec(
    command: string,
    cwd: string,
    execOptions: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<{ exitCode: number | null; truncated?: boolean }> {
    const shell = shellForm(command);
    const workspace = this.resolveWorkspace(cwd);
    const environment = this.sanitizeEnvironment(execOptions.env);

    const outcome = await executeWithTimeout(
      {
        operation: this.options.initiator,
        initiator: this.options.initiator,
        workspace,
        cmd: shell.cmd,
        args: [...shell.args],
        ...(environment !== undefined ? { environment } : {}),
      },
      execOptions.timeout !== undefined ? Math.round(execOptions.timeout * 1000) : undefined,
      execOptions.signal,
      (request) => this.options.execution.exec(request),
    );

    // Replay captured output through Pi's onData contract (stdout then stderr).
    if (outcome.stdout.length > 0) execOptions.onData(Buffer.from(outcome.stdout, "utf8"));
    if (outcome.stderr.length > 0) execOptions.onData(Buffer.from(outcome.stderr, "utf8"));

    return { exitCode: outcome.exitCode, truncated: outcome.truncated };
  }

  /**
   * Pi reports the host cwd it runs relative to; that IS the policy-scoped
   * session workspace. We canonicalize it and fall back to the configured
   * session workspace only when Pi reports nothing absolute.
   */
  private resolveWorkspace(reportedCwd: string): string {
    if (!isAbsolute(reportedCwd)) return this.options.sessionWorkspace;
    const key = canonicalWorkspaceKey(reportedCwd);
    return key.length > 0 ? key : this.options.sessionWorkspace;
  }

  /**
   * Pi passes the full inherited host environment. Only explicitly
   * allowlisted variables survive here — everything else (including all
   * `PI_*` and secret-looking names) is dropped, never requested, so the
   * execution service's `buildChildEnvironment` cannot reject the request.
   * Returns `undefined` when nothing survives so no empty object is sent.
   */
  private sanitizeEnvironment(env: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
    if (env === undefined) return undefined;
    const allowlist = this.options.environmentAllowlist;
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) {
      if (typeof value === "string" && allowlist.includes(name)) result[name] = value;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }
}
