import { defineTool } from "@deepseek-ai/dsh-tools";
import { createCommandHandlers, } from "../../src/commands.js";
const VERBS = [
    "list",
    "status",
    "use",
    "off",
    "up",
    "rebuild",
    "build",
    "logs",
    "stop",
    "remove",
    "setup",
    "host-exec",
];
const DESCRIPTION = `Manage DevContainers for this workspace.
Verbs: ${VERBS.join(", ")}.
  list                      discover projects and containers
  status                    show the current target, container state and route mode
  use <workspace|container-id> [--config <name>]   bind shell commands to a container
  off                       clear the target
  up [<path>] [--config <name>]        start (or reuse) a container
  rebuild [<path>] [--no-cache]        recreate the container from the current configuration
  build [<path>] [--config <name>]     build the image only
  logs [<path>]             report the lifecycle transcript path
  stop <path> / remove <path>          destructive; asks for approval first
Shell commands run inside the bound container automatically once a target is selected.`;
const PARAMETERS = {
    verb: {
        type: "string",
        required: true,
        description: `One of: ${VERBS.join(", ")}`,
    },
    args: {
        type: "string",
        description: "The verb's arguments, exactly as the slash command would take them (optional).",
    },
};
/**
 * The canonical value is the rendered text itself: dsh's schema DSL has no `required` list for object
 * roots (a `{ text }` object would need one), and a string carries everything a caller needs.
 */
const OUTPUT = {
    schema: { type: "string" },
    render: (_args, value) => [{ type: "text", text: value }],
};
export function createDevcontainerTool(runtime, options) {
    const services = {
        config: runtime.config,
        targetStore: runtime.targetStore,
        execution: runtime.execution,
        registry: async () => runtime.registry(),
        refreshRegistry: async () => runtime.refresh(),
    };
    const handlers = createCommandHandlers(services);
    return defineTool({
        name: "devcontainer",
        description: DESCRIPTION,
        // dsh validates `verb` against the schema, so an unknown verb is a schema error rather than our
        // own; the handler's `[unknown-verb]` text still covers the case where a verb is known but its
        // arguments are not.
        parameters: PARAMETERS,
        output: OUTPUT,
        async execute(args, exec) {
            const verb = args.verb.trim().toLowerCase();
            const handler = handlers[verb];
            if (handler === undefined) {
                throw new Error(`[unknown-verb] Unknown devcontainer verb \`${verb}\`. Verbs: ${VERBS.join(", ")}`);
            }
            // Adopt the workspace's own container before the verb runs; `off` suspends adoption so the verb
            // stays authoritative (mirrors the command adapter and the Pi entry's L1-02 guard).
            if (verb !== "off") {
                try {
                    await runtime.autoSelect(options.workspace);
                }
                catch {
                    // Best-effort: the verb's own output is what the caller acts on.
                }
            }
            if (verb === "up" || verb === "use" || verb === "rebuild")
                runtime.setAutoSelection(true);
            const notices = [];
            const context = {
                cwd: options.workspace,
                // A confirmation is available (through approval), a picker is not: the refusal enumerates
                // container ids and the model re-issues `use <container-id>`.
                hasUI: true,
                signal: exec.signal,
                ui: {
                    select: async () => undefined,
                    confirm: async (title, message) => {
                        if (options.confirm === undefined)
                            return false;
                        return options.confirm({
                            agent: exec.agent,
                            reason: `${title}: ${message}`,
                            signal: exec.signal,
                        });
                    },
                    notify: (message, type) => {
                        notices.push(type === undefined || type === "info" ? message : `[${type}] ${message}`);
                    },
                },
            };
            if (verb === "off")
                runtime.setAutoSelection(false);
            let result;
            try {
                result = await handler(args.args ?? "", context);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(`[error] ${message}`);
            }
            const parts = [...notices, result.text].filter((part) => part.length > 0);
            const text = parts.join("\n");
            // A refusal is not a successful tool result: surface it as an error so the model does not
            // narrate a failed operation as done (the `[kind] …` prefix is this project's failure marker).
            if (/^\[[a-z][a-z0-9-]*\]/.test(result.text.trim()))
                throw new Error(text);
            return text;
        },
    });
}
//# sourceMappingURL=tools.js.map