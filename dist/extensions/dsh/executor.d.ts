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
    /**
     * Establish a target before a container-side command runs (adopt the workspace's own container when
     * nothing is selected). Called only on the container path — an unmanaged workspace never pays for a
     * registry read, and a refused adoption surfaces as the execution gate's own typed error.
     */
    readonly ensureTarget?: (workspace: string) => Promise<void>;
}
export declare class DevcontainerShellExecutor extends ShellExecutor {
    private readonly options;
    constructor(ctx: Context, options: DevcontainerShellOptions);
    /**
     * Resolve through the delegate when this workspace is not DevContainer-managed.
     *
     * Both `resolve` and `execute` consult {@link isManaged} so a spec never mixes the two paths: dsh
     * calls `resolve` then `execute`, and the workspace does not change in between.
     */
    resolve(request: ShellExecRequest): ShellExecSpec;
    execute(spec: ShellExecSpec): Promise<ShellExecution>;
    /** The host executor that owns this workspace, or `undefined` when the container path applies. */
    private delegateFor;
    /**
     * The HOST working directory. `devcontainer exec` runs on the host and receives
     * `--workspace-folder <host path>`; the CLI maps the path itself, so a container path here would
     * name a directory that does not exist on this side.
     */
    private hostWorkdir;
}
//# sourceMappingURL=executor.d.ts.map