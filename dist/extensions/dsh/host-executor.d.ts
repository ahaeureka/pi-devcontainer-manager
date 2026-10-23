import type { Context } from "@deepseek-ai/cordis";
import type { ShellExecutor } from "@deepseek-ai/dsh-shell";
/**
 * The host executor used for workspaces this plugin does not manage.
 *
 * `ctx.shell` is a single, process-wide seam, so a plugin that replaces it is replacing the host
 * executor for EVERY workspace in the profile. This plugin's capability is per workspace (that is how
 * the Pi extension activates), so the replacement keeps the real host executor alive and delegates to
 * it whenever the workspace has no devcontainer configuration — same sandbox mode, same environment,
 * same semantics. A managed workspace never reaches it, which is what keeps the container path's
 * fail-closed behaviour intact.
 *
 * The delegate is mounted on an ISOLATED child scope (`ctx.isolate('shell')`): one provider per
 * context is a hard rule, so the host executor must live in its own scope to coexist with ours.
 */
export interface HostExecutorOptions {
    /** Module exporting the executor (default or named `default`), placed in the bundle patch. */
    readonly module: string;
    /** Its constructor config, forwarded verbatim (the base row's own keys, e.g. `timeoutMs`). */
    readonly config?: Record<string, unknown>;
}
export declare const DEFAULT_HOST_EXECUTOR_MODULE = "@deepseek-ai/dsh-bash-sandbox";
export declare function loadExecutorModule(specifier: string): Promise<Record<string, unknown>>;
/**
 * Mount the host executor on an isolated scope and return a lazy accessor.
 *
 * Lazy because mounting is a plugin load (a fiber that activates asynchronously): the DevContainer
 * provider is constructed with the accessor and only reads it when an unmanaged workspace actually
 * asks for a command.
 */
export declare function mountHostExecutor(ctx: Context, options: HostExecutorOptions): () => ShellExecutor | undefined;
//# sourceMappingURL=host-executor.d.ts.map