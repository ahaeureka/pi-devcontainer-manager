import { resolve } from "node:path";
import Schema from "@deepseek-ai/schemastery";
import { createDevcontainerCommand } from "./command.js";
import { DevcontainerShellExecutor } from "./executor.js";
import { composeDshRuntime } from "./runtime.js";
export const name = "devcontainer";
export const Config = Schema.object({
    workspace: Schema.string().description("Host workspace to manage (default: process.cwd())."),
    globalConfigPath: Schema.string().description("Override this extension's global configuration file."),
    projectConfigPath: Schema.string().description("Override the project configuration file."),
    projectTrusted: Schema.boolean()
        .default(false)
        .description("Read the project configuration file (it can grant capabilities, so this is opt-in)."),
    timeoutMs: Schema.number().description("Default shell command deadline in milliseconds."),
    maxTimeoutMs: Schema.number().description("Upper bound for any caller-supplied deadline."),
});
export function apply(ctx, config = {}) {
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
    const commands = ctx.get("commands", false);
    if (commands === undefined)
        return;
    const definition = createDevcontainerCommand(runtime, { workspace });
    commands.register(definition);
}
//# sourceMappingURL=index.js.map