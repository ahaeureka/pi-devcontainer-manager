import { createCommandHandlers, } from "../../src/commands.js";
const VERBS = [
    "list",
    "status",
    "use",
    "off",
    "up",
    "rebuild",
    "build",
    "stop",
    "remove",
    "logs",
    "setup",
    "host-exec",
];
const USAGE = `Usage: devcontainer <verb> [args]
  list | status                      discover projects and show the current target
  use <workspace|container-id> [--config <name>]   bind the session's shell to a container
  off                                clear the target
  up [<path>] [--config <name>]      start (or reuse) the workspace's container
  rebuild [<path>] [--config <name>] [--no-cache]  replace the container from the current config
  build [<path>] [--config <name>]   build the image without starting anything
  stop | remove <path>               destructive: requires an interactive confirmation (unavailable here)
  logs [<path>]                      lifecycle transcript path
  host-exec <argv…>                  audited host escape hatch (policy-gated)
  setup                              install the Dev Containers CLI (needs a confirmation)`;
/**
 * Failure text uses this extension's `[kind] …` prefix convention for every refusal, typed error and
 * unexpected failure (`[policy-denied]`, `[confirmation-required]`, `[ambiguous-candidate]`, …), while
 * successful renderings are prose/tables. Mapping that prefix to dsh's `error` kind keeps the UI
 * honest without inventing a second classification.
 */
function isFailure(text) {
    return /^\[[a-z][a-z0-9-]*\]/.test(text.trim());
}
export function createDevcontainerCommand(runtime, options) {
    const pending = new Set(options.diagnostics ?? runtime.diagnostics);
    const report = (message) => {
        pending.add(message);
    };
    const services = {
        config: runtime.config,
        targetStore: runtime.targetStore,
        execution: runtime.execution,
        registry: async () => {
            const result = await runtime.registry();
            // Discovery problems are only useful if they reach someone: they are reported on the read that
            // produced them and never cached into silence.
            for (const message of result.diagnostics)
                report(message);
            return { entries: result.entries, diagnostics: result.diagnostics };
        },
        refreshRegistry: async () => {
            const result = await runtime.refresh();
            for (const message of result.diagnostics)
                report(message);
            return { entries: result.entries, diagnostics: result.diagnostics };
        },
    };
    const handlers = createCommandHandlers(services);
    return {
        name: "devcontainer",
        description: "Manage DevContainers and route this session's shell into one",
        input: { hint: VERBS.join("|") },
        handler: async (invocation) => {
            const raw = invocation.rawInput.trim();
            if (raw.length === 0)
                return { kind: "error", text: USAGE };
            const match = /^(\S+)\s*([\s\S]*)$/.exec(raw);
            const verb = (match?.[1] ?? "").toLowerCase();
            const args = match?.[2] ?? "";
            const handler = handlers[verb];
            if (handler === undefined) {
                return { kind: "error", text: `[unknown-verb] Unknown devcontainer verb \`${verb}\`.\n${USAGE}` };
            }
            const notices = [];
            const context = {
                cwd: options.cwd ?? options.workspace,
                // No confirm/select exists on this surface. Handlers treat this as "headless" and refuse
                // destructive verbs rather than assuming consent.
                hasUI: false,
                signal: invocation.signal,
                ui: {
                    select: async () => undefined,
                    confirm: async () => false,
                    notify: (message, type) => {
                        notices.push(type === undefined || type === "info" ? message : `[${type}] ${message}`);
                    },
                },
            };
            let result;
            try {
                result = await handler(args, context);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return { kind: "error", text: `[error] ${message}` };
            }
            const reported = [...pending];
            pending.clear();
            const parts = [
                ...reported.map((message) => `[config] ${message}`),
                ...notices,
                result.text,
            ];
            const text = parts.filter((part) => part.length > 0).join("\n");
            // Classify from the handler's own text: the prefixed diagnostic lines must not turn a
            // successful verb into an error (their `[config]` label matches the failure prefix).
            return { kind: isFailure(result.text) ? "error" : "success", text };
        },
    };
}
//# sourceMappingURL=command.js.map