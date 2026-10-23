import type { Context } from "@deepseek-ai/cordis";
import type { ShellExecutor } from "@deepseek-ai/dsh-shell";
import Schema from "@deepseek-ai/schemastery";
import { DevcontainerShellExecutor } from "./executor.js";
/**
 * The `ctx.shell` PROVIDER, as a dsh plugin.
 *
 * Per dsh's capability-role design, a provider is its own plugin: it extends the service definition
 * (`ShellExecutor` from `@deepseek-ai/dsh-shell`), declares what it needs with `inject`, and takes its
 * own `Config`. Constructing it inside a larger `apply()` would work but would hide it from the loader:
 * no separate row, no independent unload, and config that the schema never validates.
 *
 * Everything it needs from this package comes from `ctx.devcontainerRuntime` — the runtime is a service
 * (see `runtime.ts`) precisely so sibling plugins can inject it instead of being wired by closures.
 */
export interface ShellProviderConfig {
    /** Default per-command deadline in milliseconds. */
    readonly timeoutMs?: number;
    /** Hard cap for a caller-supplied deadline in milliseconds. Defaults to `maxTimeoutSeconds`. */
    readonly maxTimeoutMs?: number;
    /**
     * Which workspaces this provider takes over.
     *
     * `workspace-config` (default) activates on a workspace that declares its own devcontainer
     * configuration, exactly like the Pi extension; every other workspace keeps the host executor.
     * `always` takes over the whole profile and refuses when no target is bound.
     */
    readonly activation?: "workspace-config" | "always";
    /** What an unmanaged workspace gets: `delegate` (default) or `refuse`. */
    readonly hostFallback?: "delegate" | "refuse";
    /** Module that exports the host executor (default `@deepseek-ai/dsh-bash-sandbox`). */
    readonly hostExecutorModule?: string;
    /** That executor's own config, forwarded verbatim (no keys are invented here). */
    readonly hostExecutorConfig?: Record<string, unknown>;
}
export declare const ShellProviderSchema: Schema<ShellProviderConfig>;
/**
 * The provider plugin class.
 *
 * Extends `DevcontainerShellExecutor`, which extends dsh's `ShellExecutor`: the base constructor is what
 * registers the `shell` capability, so the class form gives the loader an unloadable unit.
 */
export declare class DevcontainerShellProvider extends DevcontainerShellExecutor {
    static inject: string[];
    static Config: Schema<ShellProviderConfig>;
    constructor(ctx: Context, config?: ShellProviderConfig);
}
export type { ShellExecutor };
//# sourceMappingURL=shell.d.ts.map