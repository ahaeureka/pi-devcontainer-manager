import type { Context } from "@deepseek-ai/cordis";
import type { DshRuntime } from "./runtime.js";
/**
 * The dsh `devcontainer` command: the management half of the port.
 *
 * dsh's command surface is a UI dispatch, not a model tool (`CommandInvocation` carries the exact text
 * after the name and a signal, and returns text the dispatching surface renders), which is the same
 * shape as this extension's `/devcontainer <verb> <args>` grammar. Rather than reimplement the verbs,
 * this adapter reuses `createCommandHandlers` — so `use`, `up`, `rebuild`, `status`, `logs`, `stop`
 * and `remove` keep their policy gates, audit and rendering in one place.
 *
 * ## No interactive UI, therefore destructive verbs refuse
 *
 * dsh commands have no confirm/select dialog. The context is built with `hasUI: false`, which is
 * exactly the condition under which this extension's handlers REFUSE destructive verbs
 * (`[confirmation-required] … not available in this mode`) instead of silently proceeding. That is the
 * intended outcome: a gate is never weakened to make a port convenient. Ambiguous container selection
 * is likewise not a picker — the refusal enumerates full container ids, and
 * `devcontainer use <container-id>` is the headless way to choose.
 */
export interface DevcontainerCommandDefinition {
    readonly name: string;
    readonly description: string;
    readonly input: {
        readonly hint: string;
    };
    handler(invocation: {
        readonly rawInput: string;
        readonly signal: AbortSignal;
    }): Promise<{
        readonly kind: "success";
        readonly text: string;
    } | {
        readonly kind: "error";
        readonly text: string;
    }>;
}
export declare function createDevcontainerCommand(runtime: DshRuntime, options: {
    readonly workspace: string;
    readonly cwd?: string;
    /**
     * Configuration/discovery problems to report alongside the next command's output.
     *
     * dsh has no `ctx.ui.notify`, and a diagnostic nothing reads is not a diagnostic (the same rule the
     * Pi entry follows): the operator's `list`/`status` output is where they look, so the collected
     * lines are appended there, deduplicated, until they are shown.
     */
    readonly diagnostics?: readonly string[];
}): DevcontainerCommandDefinition;
/**
 * The command as a dsh plugin (object form).
 *
 * `inject` is REQUIRED here — a command consumer without a command registry has nothing to do, so
 * dsh keeping it PENDING is the correct outcome (and it costs nothing else: the shell provider, the
 * tool and the prompt section are separate plugins with their own inject).
 */
export declare const commandPlugin: {
    name: string;
    inject: string[];
    apply(ctx: Context): void;
};
//# sourceMappingURL=command.d.ts.map