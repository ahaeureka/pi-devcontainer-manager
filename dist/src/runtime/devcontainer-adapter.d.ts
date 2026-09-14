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
import type { ProcessRunner } from "./process-runner.js";
import type { DevcontainerConfigKind } from "../types.js";
/** Whether a discovered configuration has to be passed to the CLI explicitly. */
export declare function needsExplicitConfig(kind: DevcontainerConfigKind): boolean;
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
export interface DevcontainerAdapter {
    /** `devcontainer up --workspace-folder <workspace>`. Reuses an existing container by default. */
    up(workspace: string, options?: {
        dockerPath?: string;
        configPath?: string;
        signal?: AbortSignal;
    }): Promise<UpResult>;
    /** `devcontainer build [--workspace-folder <workspace>] [--no-cache]`. */
    build(workspace: string, options?: {
        dockerPath?: string;
        configPath?: string;
        noCache?: boolean;
        imageName?: string;
        signal?: AbortSignal;
    }): Promise<BuildResult>;
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
export declare class NodeDevcontainerAdapter implements DevcontainerAdapter {
    private readonly runner;
    private readonly options;
    constructor(runner: ProcessRunner, options: {
        readonly devcontainerPath: string;
        readonly env: Readonly<Record<string, string>>;
        readonly cwd: string;
        readonly limits?: AdapterLimits;
    });
    up(workspace: string, options?: {
        dockerPath?: string;
        configPath?: string;
        signal?: AbortSignal;
    }): Promise<UpResult>;
    build(workspace: string, options?: {
        dockerPath?: string;
        configPath?: string;
        noCache?: boolean;
        imageName?: string;
        signal?: AbortSignal;
    }): Promise<BuildResult>;
    exec(workspace: string, containerId: string, cmd: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult>;
    /** Shared argv runner for up/build/exec with error mapping. */
    private runCli;
    private rethrowMappedSpawnError;
    private parseUp;
    private parseBuild;
    /** Structured failure: prefer the CLI's own `message`/`description` when present. */
    private cliFailure;
    /** Parse the single JSON document the CLI writes to stdout (with trailing space). */
    private parseJsonOutcome;
    /** Best-effort parse for the nonzero-exit path; undefined when stdout is not JSON. */
    private tryParseJsonOutcome;
    private failureFromStderr;
    /** Exec: throw typed structural failures; carry command exits in the result. */
    private rejectStructuralFailure;
}
//# sourceMappingURL=devcontainer-adapter.d.ts.map