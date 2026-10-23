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
}
export declare const name = "devcontainer";
export declare const Config: Schema<Config>;
export declare function apply(ctx: Context, config?: Config): void;
//# sourceMappingURL=index.d.ts.map