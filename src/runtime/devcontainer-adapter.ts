/**
 * Workspace-aware Dev Containers CLI adapter.
 *
 * Owns the pinned Dev Containers CLI (0.88.0) `up`, `build`, and `exec`
 * surface. Every invocation is fixed argv through the injected
 * {@link ProcessRunner} (no shell), a sanitized environment, and bounded
 * stream accounting. The CLI is never asked for `--log-format json` on
 * `exec` because that mode hides command stdout; `up`/`build` always emit a
 * single JSON document on stdout regardless of log format, which we parse.
 *
 * Verified against @devcontainers/cli 0.88.0 bundled source:
 * - `up`   -> `devcontainer up --workspace-folder <ws> [--docker-path <d>] [--config <p>]`
 *   stdout JSON `{outcome, containerId, composeProjectName, remoteUser,
 *   remoteWorkspaceFolder}`; error outcome exits 1.
 * - `build`-> `devcontainer build [--workspace-folder <ws>] [--docker-path <d>] [--config <p>]`
 *   stdout JSON `{outcome, imageName}`; error outcome exits 1.
 * - `exec` -> `devcontainer exec --workspace-folder <ws> --container-id <id>
 *   [--config <p>] [--remote-env N=V]... -- <cmd> [args...]`; exit code is the container-side
 *   command's exit code; `--remote-env` may be repeated (yargs accumulates
 *   duplicates into an array; the CLI normalizes a single value to a
 *   one-element array), so EVERY allowlisted variable is forwarded.
 */
import { DEFAULT_MAX_OUTPUT_BYTES, runBounded, type ProcessRunner, type ProcessResult } from "./process-runner.js";
import { devcontainerSpawnErrorSpec } from "./spawn-error.js";
import type { DevcontainerConfigKind } from "../types.js";
import { RuntimeError } from "../errors.js";

import type { LifecycleLogRun } from "../lifecycle-log.js";
/**
 * Forms the pinned CLI resolves on its own, in this order:
 * `.devcontainer/devcontainer.json`, then `.devcontainer.json` — verified with
 * `devcontainer read-configuration --workspace-folder <dir>` on 0.88.0. Every
 * other discovered form (a named `.devcontainer/<name>/devcontainer.json`, or the
 * legacy root `devcontainer.json`) is invisible to that lookup and must be handed
 * over with `--config`.
 */
const CLI_DEFAULT_CONFIG_KINDS: ReadonlySet<DevcontainerConfigKind> = new Set([
  ".devcontainer/devcontainer.json",
  "root/.devcontainer.json",
]);

/** Whether a discovered configuration has to be passed to the CLI explicitly. */
export function needsExplicitConfig(kind: DevcontainerConfigKind): boolean {
  return !CLI_DEFAULT_CONFIG_KINDS.has(kind);
}

/** Success payload of `devcontainer up` (0.88.0), minus dispose/functions. */
export interface UpResult {
  readonly containerId: string;
  readonly composeProjectName?: string;
  readonly remoteUser?: string;
  readonly remoteWorkspaceFolder?: string;
}

/** Success payload of `devcontainer build` (0.88.0). */
export interface BuildResult {
  readonly imageName?: string;
}

export interface ExecOptions {
  readonly dockerPath?: string;
  /** Named configuration to resolve: `.devcontainer/<name>/devcontainer.json`. */
  readonly configPath?: string;
  readonly remoteEnv?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}
export interface LifecycleCliOptions {
  readonly dockerPath?: string;
  readonly configPath?: string;
  readonly noCache?: boolean;
  readonly signal?: AbortSignal;
  /** Raw process transcript owned by the lifecycle diagnostic logger. */
  readonly lifecycleLog?: LifecycleLogRun;
}


export interface DevcontainerAdapter {
  /**
   * `devcontainer up --workspace-folder <workspace> [--remove-existing-container] [--build-no-cache]`.
   *
   * `up` REUSES a container the CLI already finds — `--remove-existing-container` is what makes it
   * delete and recreate one instead, so a changed configuration has no effect until that flag is
   * passed (the CLI never compares the existing container against the configuration).
   */
  up(
    workspace: string,
    options?: {
      dockerPath?: string;
      configPath?: string;
      /** Delete the existing container first, so it is recreated from the current configuration. */
      removeExistingContainer?: boolean;
      /** `--build-no-cache`: rebuild the image without layer cache. */
      noCache?: boolean;
      signal?: AbortSignal;
      /** Raw process transcript owned by the lifecycle diagnostic logger. */
      lifecycleLog?: LifecycleLogRun;
    },
  ): Promise<UpResult>;

  /** `devcontainer build [--workspace-folder <workspace>] [--no-cache]`. */
  build(
    workspace: string,
    options?: {
      dockerPath?: string;
      configPath?: string;
      noCache?: boolean;
      imageName?: string;
      signal?: AbortSignal;
      lifecycleLog?: LifecycleLogRun;
    },
  ): Promise<BuildResult>;

  /**
   * `devcontainer exec --workspace-folder <ws> --container-id <id>
   * [--remote-env N=V] -- <cmd> [args...]`.
   *
   * A nonzero exit is the container-side command's own exit code, carried in
   * {@link ExecResult.exitCode} — never thrown. Structural failures (container
   * missing, Docker daemon unreachable) are detected from stderr markers and
   * thrown as typed `RuntimeError`s.
   */
  exec(workspace: string, containerId: string, cmd: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult>;
}

export interface ExecResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** Bounded output / timeout defaults for a single CLI invocation. */
export interface AdapterLimits {
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
}

const CLI_TIMEOUT_MS = 300_000;

/** stderr markers the pinned CLI emits for structural (non-command) failures. */
const CONTAINER_NOT_FOUND = /Dev container not found\./;
const DAEMON_UNREACHABLE = /Cannot connect to the Docker daemon|docker: error during connect|Error response from daemon/i;
const CONTAINER_STOPPED = /is not running|not running/i;

export class NodeDevcontainerAdapter implements DevcontainerAdapter {
  public constructor(
    private readonly runner: ProcessRunner,
    private readonly options: {
      readonly devcontainerPath: string;
      readonly env: Readonly<Record<string, string>>;
      readonly cwd: string;
      readonly limits?: AdapterLimits;
    },
  ) {}

  public async up(
    workspace: string,
    options: LifecycleCliOptions & { readonly removeExistingContainer?: boolean } = {},
  ): Promise<UpResult> {
    const args: string[] = ["up", "--workspace-folder", workspace];
    if (options.dockerPath !== undefined) args.push("--docker-path", options.dockerPath);
    if (options.configPath !== undefined) args.push("--config", options.configPath);
    if (options.removeExistingContainer === true) args.push("--remove-existing-container");
    if (options.noCache === true) args.push("--build-no-cache");
    let result: ProcessResult | undefined;
    try {
      const run = await this.runCli(args, options.signal, options.lifecycleLog);
      result = run.result;
      const parsed = this.parseUp(run.result, run.stdout, run.stderr);
      this.finishLifecycleLog(options.lifecycleLog, result);
      return parsed;
    } catch (error) {
      this.finishLifecycleLog(options.lifecycleLog, result, error);
      throw error;
    }
  }

  public async build(
    workspace: string,
    options: LifecycleCliOptions & { readonly imageName?: string } = {},
  ): Promise<BuildResult> {
    const args: string[] = ["build", "--workspace-folder", workspace];
    if (options.dockerPath !== undefined) args.push("--docker-path", options.dockerPath);
    if (options.noCache === true) args.push("--no-cache");
    if (options.imageName !== undefined) args.push("--image-name", options.imageName);
    if (options.configPath !== undefined) args.push("--config", options.configPath);
    let result: ProcessResult | undefined;
    try {
      const run = await this.runCli(args, options.signal, options.lifecycleLog);
      result = run.result;
      const parsed = this.parseBuild(run.result, run.stdout, run.stderr);
      this.finishLifecycleLog(options.lifecycleLog, result);
      return parsed;
    } catch (error) {
      this.finishLifecycleLog(options.lifecycleLog, result, error);
      throw error;
    }
  }

  public async exec(
    workspace: string,
    containerId: string,
    cmd: string,
    args: readonly string[],
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    if (cmd.length === 0) {
      throw new RuntimeError({
        kind: "parse-failure",
        message: "devcontainer exec requires a non-empty command.",
      });
    }
    const argv: string[] = ["exec", "--workspace-folder", workspace, "--container-id", containerId];
    if (options.dockerPath !== undefined) argv.push("--docker-path", options.dockerPath);
    if (options.configPath !== undefined) argv.push("--config", options.configPath);
    const remoteEnv = options.remoteEnv ?? {};
    // CLI 0.88.0 accepts repeated `--remote-env name=value` flags: yargs
    // accumulates duplicate flags into an array and the CLI normalizes a single
    // value to a one-element array. Forward EVERY allowlisted variable; never
    // silently drop all but the first.
    for (const [name, value] of Object.entries(remoteEnv)) {
      argv.push("--remote-env", `${name}=${value}`);
    }
    argv.push("--", cmd, ...args);

    const result = await runBounded(this.runner, this.options.devcontainerPath, argv, {
      cwd: this.options.cwd,
      env: this.options.env,
      maxOutputBytes: this.options.limits?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      timeoutMs: this.options.limits?.timeoutMs ?? CLI_TIMEOUT_MS,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      spawnError: devcontainerSpawnErrorSpec(this.options.devcontainerPath),
    });
    // The process boundary carries its bounded streams now (L5-03); no callback collection here.
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    this.rejectStructuralFailure(result, stdout, stderr);
    return {
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      truncated: result.truncated,
      stdout,
      stderr,
    };
  }

  /** Shared argv runner for up/build/exec with error mapping. */
  private async runCli(
    args: readonly string[],
    signal?: AbortSignal,
    lifecycleLog?: LifecycleLogRun,
  ): Promise<{ result: ProcessResult; stdout: Buffer; stderr: Buffer }> {
    // `--log-level debug` is public CLI syntax. Apply it only to lifecycle operations; exec remains
    // unchanged and its potentially sensitive command output is deliberately not logged here.
    const invocation = lifecycleLog === undefined ? args : [...args, "--log-level", "debug"];
    lifecycleLog?.setCommand([this.options.devcontainerPath, ...invocation]);
    const result = await runBounded(this.runner, this.options.devcontainerPath, invocation, {
      cwd: this.options.cwd,
      env: this.options.env,
      maxOutputBytes: this.options.limits?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      timeoutMs: this.options.limits?.timeoutMs ?? CLI_TIMEOUT_MS,
      ...(signal !== undefined ? { signal } : {}),
      ...(lifecycleLog !== undefined ? { observeStdout: (chunk: Buffer) => lifecycleLog.stdout(chunk) } : {}),
      ...(lifecycleLog !== undefined ? { observeStderr: (chunk: Buffer) => lifecycleLog.stderr(chunk) } : {}),
      spawnError: devcontainerSpawnErrorSpec(this.options.devcontainerPath),
    });
    return {
      result,
      stdout: Buffer.from(result.stdout ?? "", "utf8"),
      stderr: Buffer.from(result.stderr ?? "", "utf8"),
    };
  }

  private finishLifecycleLog(
    log: LifecycleLogRun | undefined,
    result: ProcessResult | undefined,
    error?: unknown,
  ): void {
    if (log === undefined) return;
    const message = error instanceof Error ? error.message : error === undefined ? undefined : String(error);
    log.finish({
      state: error === undefined ? "completed" : error instanceof RuntimeError && error.kind === "cancelled" ? "cancelled" : "failed",
      exitCode: result?.exitCode ?? null,
      ...(result !== undefined ? { durationMs: result.durationMs, outputTruncated: result.truncated } : {}),
      ...(message !== undefined ? { error: message } : {}),
    });
  }

  private parseUp(result: ProcessResult, stdout: Buffer, stderr: Buffer): UpResult {
    if (result.exitCode !== 0) {
      // Prefer the CLI's structured JSON when it was emitted, else stderr markers.
      const parsed = this.tryParseJsonOutcome(stdout);
      if (parsed !== undefined && parsed.outcome !== "success") {
        throw this.cliFailure(parsed, result, "devcontainer up");
      }
      // A nonzero exit with no failure payload (or one that claims success) is still
      // a failed `up`; report it from the stderr markers instead of falling through to
      // a compile-time-only sentinel.
      throw this.failureFromStderr(result, stderr, "devcontainer up");
    }
    const parsed = this.parseJsonOutcome(stdout, "devcontainer up");
    if (parsed.outcome !== "success") throw this.cliFailure(parsed, result, "devcontainer up");
    if (typeof parsed.containerId !== "string" || parsed.containerId.length === 0) {
      throw new RuntimeError({
        kind: "parse-failure",
        message: "devcontainer up succeeded without a containerId.",
      });
    }
    return {
      containerId: parsed.containerId,
      ...(typeof parsed.composeProjectName === "string" ? { composeProjectName: parsed.composeProjectName } : {}),
      ...(typeof parsed.remoteUser === "string" ? { remoteUser: parsed.remoteUser } : {}),
      ...(typeof parsed.remoteWorkspaceFolder === "string" ? { remoteWorkspaceFolder: parsed.remoteWorkspaceFolder } : {}),
    };
  }

  private parseBuild(result: ProcessResult, stdout: Buffer, stderr: Buffer): BuildResult {
    if (result.exitCode !== 0) {
      const parsed = this.tryParseJsonOutcome(stdout);
      if (parsed !== undefined && parsed.outcome !== "success") {
        throw this.cliFailure(parsed, result, "devcontainer build");
      }
      throw this.failureFromStderr(result, stderr, "devcontainer build");
    }
    const parsed = this.parseJsonOutcome(stdout, "devcontainer build");
    if (parsed.outcome !== "success") throw this.cliFailure(parsed, result, "devcontainer build");
    return {
      ...(typeof parsed.imageName === "string" ? { imageName: parsed.imageName } : {}),
    };
  }

  /** Structured failure: prefer the CLI's own `message`/`description` when present. */
  private cliFailure(parsed: Record<string, unknown>, result: ProcessResult, source: string): RuntimeError {
    const message = typeof parsed.message === "string" && parsed.message.length > 0 ? parsed.message : "unknown error";
    const description = typeof parsed.description === "string" && parsed.description.length > 0 ? `: ${parsed.description}` : "";
    return new RuntimeError({
      kind: "devcontainer-cli-failure",
      message: `${source} failed: ${message}${description}`,
      exitCode: result.exitCode,
      remedy: "Check the DevContainer configuration and Docker daemon state.",
    });
  }

  /** Parse the single JSON document the CLI writes to stdout (with trailing space). */
  private parseJsonOutcome(stdout: Buffer, source: string): Record<string, unknown> {
    const text = stdout.toString("utf8").trim();
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      return parsed;
    } catch (error) {
      throw new RuntimeError({
        kind: "parse-failure",
        message: `Unparseable ${source} stdout: ${text.slice(0, 120)}`,
        cause: error,
      });
    }
  }

  /** Best-effort parse for the nonzero-exit path; undefined when stdout is not JSON. */
  private tryParseJsonOutcome(stdout: Buffer): Record<string, unknown> | undefined {
    const text = stdout.toString("utf8").trim();
    if (text.length === 0) return undefined;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private failureFromStderr(result: ProcessResult, stderr: Buffer, source: string): RuntimeError {
    const text = stderr.toString("utf8");
    if (CONTAINER_NOT_FOUND.test(text)) {
      return new RuntimeError({
        kind: "target-stopped",
        message: `${source} reported the dev container was not found.`,
        exitCode: result.exitCode,
        remedy: "Run devcontainer up to create the container first.",
      });
    }
    if (DAEMON_UNREACHABLE.test(text)) {
      return new RuntimeError({
        kind: "daemon-unavailable",
        message: `${source} could not reach the Docker daemon.`,
        exitCode: result.exitCode,
        remedy: "Check Docker daemon reachability.",
      });
    }
    return new RuntimeError({
      kind: "devcontainer-cli-failure",
      message: `${source} failed with exit ${result.exitCode}: ${text.slice(0, 200)}`,
      exitCode: result.exitCode,
      remedy: "Inspect the Dev Containers CLI output above.",
    });
  }

  /** Exec: throw typed structural failures; carry command exits in the result. */
  private rejectStructuralFailure(result: ProcessResult, stdout: string, stderr: string): void {
    if (result.exitCode === 0) return;
    if (CONTAINER_NOT_FOUND.test(stderr)) {
      throw new RuntimeError({
        kind: "target-stopped",
        message: "devcontainer exec reported the dev container was not found.",
        exitCode: result.exitCode,
        remedy: "Run devcontainer up to create the container first.",
      });
    }
    if (DAEMON_UNREACHABLE.test(stderr)) {
      throw new RuntimeError({
        kind: "daemon-unavailable",
        message: "devcontainer exec could not reach the Docker daemon.",
        exitCode: result.exitCode,
        remedy: "Check Docker daemon reachability.",
      });
    }
    if (CONTAINER_STOPPED.test(stderr)) {
      throw new RuntimeError({
        kind: "target-stopped",
        message: "devcontainer exec target container is not running.",
        exitCode: result.exitCode,
        remedy: "Run devcontainer up to start the container.",
      });
    }
    // Any other nonzero exit is the container-side command's own exit code.
    void stdout;
  }
}
