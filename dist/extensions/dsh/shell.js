import Schema from "@deepseek-ai/schemastery";
import { DevcontainerShellExecutor } from "./executor.js";
import { DEFAULT_HOST_EXECUTOR_MODULE, mountHostExecutor } from "./host-executor.js";
export const ShellProviderSchema = Schema.object({
    timeoutMs: Schema.number().description("Default shell command deadline in milliseconds."),
    maxTimeoutMs: Schema.number().description("Upper bound for any caller-supplied deadline."),
    activation: Schema.union(["workspace-config", "always"])
        .default("workspace-config")
        .description("Take over workspaces that declare a devcontainer config (default), or the whole profile."),
    hostFallback: Schema.union(["delegate", "refuse"])
        .default("delegate")
        .description("For unmanaged workspaces: delegate to the host executor, or refuse (container-only)."),
    hostExecutorModule: Schema.string().description("Module exporting the host executor to delegate to."),
    hostExecutorConfig: Schema.any().description("Config forwarded verbatim to that executor."),
});
/**
 * The provider plugin class.
 *
 * Extends `DevcontainerShellExecutor`, which extends dsh's `ShellExecutor`: the base constructor is what
 * registers the `shell` capability, so the class form gives the loader an unloadable unit.
 */
export class DevcontainerShellProvider extends DevcontainerShellExecutor {
    static inject = ["devcontainerRuntime"];
    static Config = ShellProviderSchema;
    constructor(ctx, config = {}) {
        const runtime = ctx.devcontainerRuntime;
        const hostFallback = config.hostFallback ?? "delegate";
        // Workspaces without a devcontainer config keep the harness's own host executor; anything else
        // would make this plugin a profile-wide hijack of `ctx.shell` (see `docs/dsh.md`).
        const hostExecutor = hostFallback === "delegate"
            ? mountHostExecutor(ctx, {
                module: config.hostExecutorModule ?? DEFAULT_HOST_EXECUTOR_MODULE,
                ...(config.hostExecutorConfig !== undefined ? { config: config.hostExecutorConfig } : {}),
            })
            : undefined;
        super(ctx, {
            execution: runtime.execution,
            workspace: runtime.workspace,
            timeoutMs: config.timeoutMs ?? 120_000,
            maxTimeoutMs: config.maxTimeoutMs ?? runtime.config.maxTimeoutSeconds * 1000,
            maxOutputBytes: runtime.config.maxOutputBytes,
            // Bound through an arrow: `autoSelect` is a service METHOD, and passing the unbound reference
            // detaches it from the instance (the class form makes this an easy mistake — the closure form
            // never could).
            ensureTarget: (workspace) => runtime.autoSelect(workspace),
            ...(hostExecutor !== undefined ? { hostExecutor } : {}),
            ...(config.activation === "always" ? { isManaged: () => true } : {}),
        });
    }
}
//# sourceMappingURL=shell.js.map