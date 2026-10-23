import { resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { commandPlugin } from "./command.js";
import { promptPlugin } from "./prompt.js";
import { DshRuntimeService } from "./runtime.js";
import { DevcontainerShellProvider } from "./shell.js";
import { toolPlugin } from "./tools.js";

/**
 * DeepSeek Harness entry point: DevContainer management plus a `ctx.shell` provider that runs every
 * dsh shell command inside the selected container.
 *
 * This file is the dsh mirror of `extensions/index.ts`. Both are thin: all behaviour lives in `src/`,
 * which imports neither Pi nor dsh, so policy, audit, discovery, path mapping and the execution gate
 * are shared rather than duplicated.
 *
 * Loading it takes over `ctx.shell`. dsh composes exactly one provider per context and a second
 * registration throws — that is why the bundle patch replaces the `bash-sandbox` row instead of
 * inserting a parallel one.
 */

/** Plugin configuration, validated by Cordis before `apply` runs. */
export interface Config {
  /** Host workspace this plugin manages. Defaults to the dsh process's working directory. */
  workspace?: string;
  /** This extension's configuration file. Defaults to the Pi-compatible global location. */
  globalConfigPath?: string;
  /** Project configuration file. Defaults to `<workspace>/.pi/pi-devcontainer-manager.json`. */
  projectConfigPath?: string;
  /** Honour the project configuration file. Defaults to false (fail closed). */
  projectTrusted?: boolean;
  /** Default per-command deadline in milliseconds. */
  timeoutMs?: number;
  /** Hard cap on a caller-supplied deadline in milliseconds. */
  maxTimeoutMs?: number;
  /**
   * Which workspaces this provider takes over.
   *
   * `workspace-config` (default) activates on a workspace that declares its own devcontainer
   * configuration, exactly like the Pi extension; every other workspace keeps the host executor.
   * `always` takes over the whole profile and refuses when no target is bound.
   */
  activation?: "workspace-config" | "always";
  /**
   * What an unmanaged workspace gets: `delegate` (default) hands the command to the host executor
   * below, `refuse` keeps the container path and therefore fails closed everywhere.
   */
  hostFallback?: "delegate" | "refuse";
  /** Module that exports the host executor (default `@deepseek-ai/dsh-bash-sandbox`). */
  hostExecutorModule?: string;
  /** That executor's own config, forwarded verbatim (no keys are invented here). */
  hostExecutorConfig?: Record<string, unknown>;
}

export const name = "devcontainer";

export const Config: Schema<Config> = Schema.object({
  workspace: Schema.string().description("Host workspace to manage (default: process.cwd())."),
  globalConfigPath: Schema.string().description("Override this extension's global configuration file."),
  projectConfigPath: Schema.string().description("Override the project configuration file."),
  projectTrusted: Schema.boolean()
    .default(false)
    .description("Read the project configuration file (it can grant capabilities, so this is opt-in)."),
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

export function apply(ctx: Context, config: Config = {}): Promise<unknown> {
  // One row, five plugins. Each contribution is registered with `ctx.plugin` so it gets its own fiber,
  // its own `inject` and its own config — dsh's composition model — instead of living inside this
  // `apply` as a closure. That is what lets a profile compose only what it can use (the web app has no
  // bash tool; ACP has no command surface) without losing the rest.
  // The fibers are returned so a host (and the tests) can await a settled composition instead of
  // guessing with timers: dsh activates plugins asynchronously.
  const runtime = ctx.plugin(DshRuntimeService, {
    ...(config.workspace !== undefined ? { workspace: config.workspace } : {}),
    ...(config.globalConfigPath !== undefined ? { globalConfigPath: config.globalConfigPath } : {}),
    ...(config.projectConfigPath !== undefined ? { projectConfigPath: config.projectConfigPath } : {}),
    projectTrusted: config.projectTrusted ?? false,
  });

  // The shell PROVIDER. dsh composes exactly one provider per context, which is why the bundle patch
  // disables the base row instead of adding a parallel one.
  const shell = ctx.plugin(DevcontainerShellProvider, {
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.maxTimeoutMs !== undefined ? { maxTimeoutMs: config.maxTimeoutMs } : {}),
    ...(config.activation !== undefined ? { activation: config.activation } : {}),
    ...(config.hostFallback !== undefined ? { hostFallback: config.hostFallback } : {}),
    ...(config.hostExecutorModule !== undefined ? { hostExecutorModule: config.hostExecutorModule } : {}),
    ...(config.hostExecutorConfig !== undefined ? { hostExecutorConfig: config.hostExecutorConfig } : {}),
  });

  const prompt = ctx.plugin(promptPlugin);
  const tool = ctx.plugin(toolPlugin);
  const command = ctx.plugin(commandPlugin);
  return Promise.all([runtime, shell, prompt, tool, command]);
}

