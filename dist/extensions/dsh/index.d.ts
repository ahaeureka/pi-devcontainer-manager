import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
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
export declare const name = "devcontainer";
export declare const Config: Schema<Config>;
export declare function apply(ctx: Context, config?: Config): Promise<unknown>;
//# sourceMappingURL=index.d.ts.map