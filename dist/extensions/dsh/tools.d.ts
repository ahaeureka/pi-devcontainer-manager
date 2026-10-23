import type { Agent } from "@deepseek-ai/dsh-agent";
import { type ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { DshRuntime } from "./runtime.js";
/**
 * The model-facing `devcontainer` tool: management verbs for surfaces that have no command UI.
 *
 * ACP (`@deepseek-ai/dsh-acp`) composes an agent, an llm, sessions and the shell — and **no command
 * registry consumer at all**: nothing in it dispatches `ctx.commands`. So on ACP a human cannot type
 * `/devcontainer use …`, and the only way to select a target, start a container or read the target
 * state is a TOOL the model can call. The same tool is what makes web usable for the verbs that need
 * a decision: a command handler runs between turns and therefore cannot ask for approval
 * (`ctx.approval.request` throws outside an open turn), while a tool runs INSIDE the turn and can.
 *
 * Behaviour is not re-implemented: the verb grammar is `createCommandHandlers`, i.e. the same code
 * path as the Pi slash command and the dsh `devcontainer` command. Two differences, both deliberate:
 *
 * - `hasUI: true`, with `confirm` backed by {@link approval} — a destructive verb asks the composed
 *   approval service (web renders a dialog, ACP a permission request) instead of refusing outright.
 * - `select` always answers `undefined`, so an ambiguous workspace is not a picker but the existing
 *   refusal that enumerates container ids; the model then calls `use <container-id>`.
 */
export interface DevcontainerToolOptions {
    /** Ask the harness's approval service; resolves true only for an explicit grant. */
    readonly confirm?: (request: {
        readonly agent: Agent | undefined;
        readonly reason: string;
        readonly signal: AbortSignal;
    }) => Promise<boolean>;
    /** The plugin's workspace, used as the command layer's cwd. */
    readonly workspace: string;
}
export declare function createDevcontainerTool(runtime: DshRuntime, options: DevcontainerToolOptions): ToolDefinition;
//# sourceMappingURL=tools.d.ts.map