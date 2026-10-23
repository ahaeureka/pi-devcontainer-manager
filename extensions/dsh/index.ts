import { resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { createDevcontainerCommand, type DevcontainerCommandDefinition } from "./command.js";
import { DevcontainerShellExecutor } from "./executor.js";
import { DEFAULT_HOST_EXECUTOR_MODULE, mountHostExecutor } from "./host-executor.js";
import { composeDshRuntime } from "./runtime.js";
import { createDevcontainerTool } from "./tools.js";

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

export function apply(ctx: Context, config: Config = {}): void {
  const workspace = resolve(config.workspace ?? process.cwd());
  const runtime = composeDshRuntime({
    workspace,
    ...(config.globalConfigPath !== undefined ? { globalConfigPath: config.globalConfigPath } : {}),
    ...(config.projectConfigPath !== undefined ? { projectConfigPath: config.projectConfigPath } : {}),
    projectTrusted: config.projectTrusted ?? false,
  });

  // Workspaces without a devcontainer config keep the harness's own host executor; anything else
  // would make this plugin a profile-wide hijack of `ctx.shell` (see `docs/dsh.md`).
  const hostFallback = config.hostFallback ?? "delegate";
  const hostExecutor =
    hostFallback === "delegate"
      ? mountHostExecutor(ctx, {
          module: config.hostExecutorModule ?? DEFAULT_HOST_EXECUTOR_MODULE,
          ...(config.hostExecutorConfig !== undefined
            ? { config: config.hostExecutorConfig as Record<string, unknown> }
            : {}),
        })
      : undefined;

  // The provider registers itself on this plugin's fiber, so unloading the bundle removes it and dsh
  // reports the missing capability to its consumers instead of leaving a dead service behind.
  new DevcontainerShellExecutor(ctx, {
    execution: runtime.execution,
    workspace,
    timeoutMs: config.timeoutMs ?? 120_000,
    maxTimeoutMs: config.maxTimeoutMs ?? runtime.config.maxTimeoutSeconds * 1000,
    maxOutputBytes: runtime.config.maxOutputBytes,
    ...(hostExecutor !== undefined ? { hostExecutor } : {}),
    ...(config.activation === "always" ? { isManaged: () => true } : {}),
  });

  // `commands` is DEFERRED, not merely optional: a plain `ctx.get("commands")` during `apply()` can
  // run before the registry is mounted (load order is not guaranteed), which silently loses the
  // command surface — observed in the web app, where `/devcontainer …` then did nothing at all.
  // `ctx.inject` waits for the service on a child fiber, so this plugin stays ACTIVE with the shell
  // provider regardless (a required `inject: ['commands']` would park the whole plugin PENDING in a
  // composition that has no command UI, losing the primary capability).
  // The TOOL is the surface every dsh app can use (ACP composes no command consumer at all), and the
  // only one that can ask for approval — a tool runs inside a turn, a command does not.
  ctx.inject(["tools"], (scoped) => {
    const tools = (scoped as unknown as { tools: ToolRegistryLike }).tools;
    const definition = createDevcontainerTool(runtime, {
      workspace,
      confirm: async (request) => {
        if (request.agent === undefined) return false;
        const approval = ctx.get("approval", false) as ApprovalServiceLike | undefined;
        if (approval === undefined) return false;
        try {
          const outcome = await approval.request({
            agent: request.agent,
            toolName: "devcontainer",
            reason: request.reason,
            signal: request.signal,
          });
          // Only an explicit one-time grant proceeds; everything else (`rejected`, `cancelled`,
          // `unavailable`) is a refusal, which is the service's fail-closed contract.
          return outcome === "allowed-once";
        } catch {
          // `request()` throws without an open turn and rejects on an uncommitted audit pair; both
          // mean "no decision", never "yes".
          return false;
        }
      },
    });
    tools.register(definition);
  });

  ctx.inject(["commands"], (scoped) => {
    const commands = (scoped as unknown as { commands: CommandRegistryLike }).commands;
    const definition: DevcontainerCommandDefinition = createDevcontainerCommand(runtime, { workspace });
    commands.register(definition as unknown as CommandDefinitionLike);
  });
}

/**
 * Structural view of `@deepseek-ai/dsh-commands`' `CommandDefinition`.
 *
 * Declared locally so this entry does not need the commands package at build time: the service is
 * optional, and a compile-time import of a package a headless deployment may not install would make
 * the whole bundle unloadable there.
 */
interface ToolRegistryLike {
  register(definition: unknown): () => void;
}

/** Structural view of `@deepseek-ai/dsh-user-approval`'s service (optional, fail closed). */
interface ApprovalServiceLike {
  request(request: {
    readonly agent: unknown;
    readonly toolName: string;
    readonly reason: string;
    readonly signal: AbortSignal;
  }): Promise<string>;
}

interface CommandRegistryLike {
  register(definition: CommandDefinitionLike): () => void;
}

interface CommandDefinitionLike {
  readonly name: string;
  readonly description: string;
  readonly input?: { readonly hint: string };
  readonly handler: (invocation: unknown) => unknown;
}
