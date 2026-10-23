import type { Context } from "@deepseek-ai/cordis";
import type { ShellExecutor } from "@deepseek-ai/dsh-shell";
import Schema from "@deepseek-ai/schemastery";
import { DevcontainerShellExecutor } from "./executor.js";
import { DEFAULT_HOST_EXECUTOR_MODULE, mountHostExecutor } from "./host-executor.js";
import type { DshRuntimeService } from "./runtime.js";

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

export const ShellProviderSchema: Schema<ShellProviderConfig> = Schema.object({
  timeoutMs: Schema.number().description("Default shell command deadline in milliseconds."),
  maxTimeoutMs: Schema.number().description("Upper bound for any caller-supplied deadline."),
  activation: Schema.union(["workspace-config", "always"] as const)
    .default("workspace-config")
    .description("Take over workspaces that declare a devcontainer config (default), or the whole profile."),
  hostFallback: Schema.union(["delegate", "refuse"] as const)
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

  public constructor(ctx: Context, config: ShellProviderConfig = {}) {
    const runtime = ctx.devcontainerRuntime as DshRuntimeService;
    const hostFallback = config.hostFallback ?? "delegate";
    // Workspaces without a devcontainer config keep the harness's own host executor; anything else
    // would make this plugin a profile-wide hijack of `ctx.shell` (see `docs/dsh.md`).
    const hostExecutor =
      hostFallback === "delegate"
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
      ensureTarget: (workspace: string) => runtime.autoSelect(workspace),
      ...(hostExecutor !== undefined ? { hostExecutor } : {}),
      ...(config.activation === "always" ? { isManaged: () => true } : {}),
    });
  }
}

export type { ShellExecutor };
