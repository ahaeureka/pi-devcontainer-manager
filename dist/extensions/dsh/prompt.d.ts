import type { Context } from "@deepseek-ai/cordis";
import type { DshRuntime } from "./runtime.js";
/**
 * The model-facing facts about this plugin, contributed to dsh's system prompt.
 *
 * Without this section the agent has no idea a container is involved: it sees a `devcontainer` tool it
 * has no reason to call, and the first thing it learns about the environment is a refusal
 * (`No DevContainer target is selected.`). The Pi entry injects the same facts per turn
 * (`src/execution-context.ts`); this is the dsh equivalent through dsh's own `systemPrompt` seam.
 *
 * The text is DYNAMIC (evaluated at each assembly) so it reports the CURRENT target and mapping rather
 * than a snapshot from plugin load.
 */
export declare const SECTION_NAME = "devcontainer:execution-context";
/**
 * Where the section sits: after the harness's own tool sections (which end at 3100 for MCP and 5000
 * for the tools SDK) but far before the deliverable/structured-output trailers, so it reads as part of
 * "how this environment works" rather than as an output contract.
 */
export declare const SECTION_ORDER = 6000;
export interface PromptSectionOptions {
    readonly workspace: string;
}
export declare function devcontainerPromptText(runtime: DshRuntime, options: PromptSectionOptions): string;
/**
 * Register the section through dsh's `systemPrompt` service.
 *
 * `ctx.inject` (not a plain `ctx.get`) so a composition that mounts the prompt registry later still
 * gets the section — the same load-order trap that silently dropped command registration.
 */
export declare function registerPromptSection(ctx: Context, runtime: DshRuntime, options: PromptSectionOptions): void;
//# sourceMappingURL=prompt.d.ts.map