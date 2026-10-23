import { resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { createDevcontainerCommand, type DevcontainerCommandDefinition } from "./command.js";
import { DevcontainerShellExecutor } from "./executor.js";
import { composeDshRuntime } from "./runtime.js";

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
});

export function apply(ctx: Context, config: Config = {}): void {
  const workspace = resolve(config.workspace ?? process.cwd());
  const runtime = composeDshRuntime({
    workspace,
    ...(config.globalConfigPath !== undefined ? { globalConfigPath: config.globalConfigPath } : {}),
    ...(config.projectConfigPath !== undefined ? { projectConfigPath: config.projectConfigPath } : {}),
    projectTrusted: config.projectTrusted ?? false,
  });

  // The provider registers itself on this plugin's fiber, so unloading the bundle removes it and dsh
  // reports the missing capability to its consumers instead of leaving a dead service behind.
  new DevcontainerShellExecutor(ctx, {
    execution: runtime.execution,
    workspace,
    timeoutMs: config.timeoutMs ?? 120_000,
    maxTimeoutMs: config.maxTimeoutMs ?? runtime.config.maxTimeoutSeconds * 1000,
    maxOutputBytes: runtime.config.maxOutputBytes,
  });

  // `commands` is optional: a headless composition may not mount it, and a missing command surface
  // must not hold the shell provider hostage (injecting it would keep this plugin PENDING forever).
  const commands = ctx.get("commands", false) as
    | { register(definition: CommandDefinitionLike): () => void }
    | undefined;
  if (commands === undefined) return;

  const definition: DevcontainerCommandDefinition = createDevcontainerCommand(runtime, { workspace });
  commands.register(definition as unknown as CommandDefinitionLike);
}

/**
 * Structural view of `@deepseek-ai/dsh-commands`' `CommandDefinition`.
 *
 * Declared locally so this entry does not need the commands package at build time: the service is
 * optional, and a compile-time import of a package a headless deployment may not install would make
 * the whole bundle unloadable there.
 */
interface CommandDefinitionLike {
  readonly name: string;
  readonly description: string;
  readonly input?: { readonly hint: string };
  readonly handler: (invocation: unknown) => unknown;
}
