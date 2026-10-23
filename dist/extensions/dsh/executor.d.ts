import type { Context } from "@deepseek-ai/cordis";
import { ShellExecutor, type ShellExecRequest, type ShellExecSpec, type ShellExecution } from "@deepseek-ai/dsh-shell";
import { type ExecutionService } from "../../src/execution-service.js";
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
}
export declare class DevcontainerShellExecutor extends ShellExecutor {
    private readonly options;
    constructor(ctx: Context, options: DevcontainerShellOptions);
    /** Fill the request's defaults and caps. Only `kill` deadlines are enforced; `none` arms nothing. */
    resolve(request: ShellExecRequest): ShellExecSpec;
    execute(spec: ShellExecSpec): Promise<ShellExecution>;
    /**
     * The HOST working directory. `devcontainer exec` runs on the host and receives
     * `--workspace-folder <host path>`; the CLI maps the path itself, so a container path here would
     * name a directory that does not exist on this side.
     */
    private hostWorkdir;
}
//# sourceMappingURL=executor.d.ts.map