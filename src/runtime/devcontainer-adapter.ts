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
 * - `up`   -> `devcontainer up --workspace-folder <ws> [--docker-path <d>]`
 *   stdout JSON `{outcome, containerId, composeProjectName, remoteUser,
 *   remoteWorkspaceFolder}`; error outcome exits 1.
 * - `build`-> `devcontainer build [--workspace-folder <ws>] [--docker-path <d>]`
 *   stdout JSON `{outcome, imageName}`; error outcome exits 1.
 * - `exec` -> `devcontainer exec --workspace-folder <ws> --container-id <id>
 *   [--remote-env N=V]... -- <cmd> [args...]`; exit code is the container-side
 *   command's exit code; `--remote-env` may be repeated (yargs accumulates
 *   duplicates into an array; the CLI normalizes a single value to a
 *   one-element array), so EVERY allowlisted variable is forwarded.
 */
import type { ProcessRunner, ProcessResult } from "./process-runner.js";
import { RuntimeError } from "../errors.js";

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
  readonly remoteEnv?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface DevcontainerAdapter {
  /** `devcontainer up --workspace-folder <workspace>`. Reuses an existing container by default. */
  up(workspace: string, options?: { dockerPath?: string; signal?: AbortSignal }): Promise<UpResult>;

  /** `devcontainer build [--workspace-folder <workspace>] [--no-cache]`. */
  build(
    workspace: string,
    options?: { dockerPath?: string; noCache?: boolean; imageName?: string; signal?: AbortSignal },
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

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
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
    options: { dockerPath?: string; signal?: AbortSignal } = {},
  ): Promise<UpResult> {
    const args: string[] = ["up", "--workspace-folder", workspace];
    if (options.dockerPath !== undefined) args.push("--docker-path", options.dockerPath);
    const { result, stdout, stderr } = await this.runCli(args, options.signal);
    return this.parseUp(result, stdout, stderr);
  }

  public async build(
    workspace: string,
    options: { dockerPath?: string; noCache?: boolean; imageName?: string; signal?: AbortSignal } = {},
  ): Promise<BuildResult> {
    const args: string[] = ["build", "--workspace-folder", workspace];
    if (options.dockerPath !== undefined) args.push("--docker-path", options.dockerPath);
    if (options.noCache === true) args.push("--no-cache");
    if (options.imageName !== undefined) args.push("--image-name", options.imageName);
    const { result, stdout, stderr } = await this.runCli(args, options.signal);
    return this.parseBuild(result, stdout, stderr);
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
    const remoteEnv = options.remoteEnv ?? {};
    // CLI 0.88.0 accepts repeated `--remote-env name=value` flags: yargs
    // accumulates duplicate flags into an array and the CLI normalizes a single
    // value to a one-element array. Forward EVERY allowlisted variable; never
    // silently drop all but the first.
    for (const [name, value] of Object.entries(remoteEnv)) {
      argv.push("--remote-env", `${name}=${value}`);
    }
    argv.push("--", cmd, ...args);

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    try {
      const result = await this.runner.exec(this.options.devcontainerPath, argv, {
        cwd: this.options.cwd,
        env: { ...this.options.env },
        maxOutputBytes: this.options.limits?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        timeoutMs: this.options.limits?.timeoutMs ?? CLI_TIMEOUT_MS,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        onData: (chunk) => chunks.push(chunk),
        onStderr: (chunk) => errChunks.push(chunk),
      });
      const stdout = Buffer.concat(chunks).toString("utf8");
      const stderr = Buffer.concat(errChunks).toString("utf8");
      this.rejectStructuralFailure(result, stdout, stderr);
      return {
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs,
        truncated: result.truncated,
        stdout,
        stderr,
      };
    } catch (error) {
      this.rethrowMappedSpawnError(error);
    }
    throw new RuntimeError({ kind: "unexpected", message: "unreachable exec path" });
  }

  /** Shared argv runner for up/build/exec with error mapping. */
  private async runCli(
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<{ result: ProcessResult; stdout: Buffer; stderr: Buffer }> {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    try {
      const result = await this.runner.exec(this.options.devcontainerPath, [...args], {
        cwd: this.options.cwd,
        env: { ...this.options.env },
        maxOutputBytes: this.options.limits?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        timeoutMs: this.options.limits?.timeoutMs ?? CLI_TIMEOUT_MS,
        ...(signal !== undefined ? { signal } : {}),
        onData: (chunk) => chunks.push(chunk),
        onStderr: (chunk) => errChunks.push(chunk),
      });
      return { result, stdout: Buffer.concat(chunks), stderr: Buffer.concat(errChunks) };
    } catch (error) {
      this.rethrowMappedSpawnError(error);
    }
    throw new RuntimeError({ kind: "unexpected", message: "unreachable runCli path" });
  }

  private rethrowMappedSpawnError(error: unknown): never {
    if (error instanceof RuntimeError && error.kind === "executable-missing") {
      throw new RuntimeError({
        kind: "devcontainer-cli-failure",
        message: `Dev Containers CLI '${this.options.devcontainerPath}' is unavailable.`,
        cause: error,
        remedy: "Install @devcontainers/cli or set devcontainerPath in configuration.",
      });
    }
    if (error instanceof RuntimeError && error.kind === "spawn-permission-denied") {
      throw new RuntimeError({
        kind: "authorization-denied",
        message: `Dev Containers CLI spawn was denied for '${this.options.devcontainerPath}'.`,
        cause: error,
        remedy: "Check operator privileges for the Dev Containers executable.",
      });
    }
    throw error;
  }

  private parseUp(result: ProcessResult, stdout: Buffer, stderr: Buffer): UpResult {
    if (result.exitCode !== 0) {
      // Prefer the CLI's structured JSON when it was emitted, else stderr markers.
      const parsed = this.tryParseJsonOutcome(stdout);
      if (parsed !== undefined) {
        if (parsed.outcome !== "success") throw this.cliFailure(parsed, result, "devcontainer up");
      } else {
        throw this.failureFromStderr(result, stderr, "devcontainer up");
      }
    } else {
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
    throw new RuntimeError({ kind: "unexpected", message: "unreachable parseUp path" });
  }

  private parseBuild(result: ProcessResult, stdout: Buffer, stderr: Buffer): BuildResult {
    if (result.exitCode !== 0) {
      const parsed = this.tryParseJsonOutcome(stdout);
      if (parsed !== undefined) {
        if (parsed.outcome !== "success") throw this.cliFailure(parsed, result, "devcontainer build");
      } else {
        throw this.failureFromStderr(result, stderr, "devcontainer build");
      }
    } else {
      const parsed = this.parseJsonOutcome(stdout, "devcontainer build");
      if (parsed.outcome !== "success") throw this.cliFailure(parsed, result, "devcontainer build");
      return {
        ...(typeof parsed.imageName === "string" ? { imageName: parsed.imageName } : {}),
      };
    }
    throw new RuntimeError({ kind: "unexpected", message: "unreachable parseBuild path" });
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
