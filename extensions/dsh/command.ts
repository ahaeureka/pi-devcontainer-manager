import {
  createCommandHandlers,
  type CommandContextLike,
  type CommandResult,
  type CommandServices,
} from "../../src/commands.js";
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
  readonly input: { readonly hint: string };
  handler(invocation: { readonly rawInput: string; readonly signal: AbortSignal }): Promise<
    { readonly kind: "success"; readonly text: string } | { readonly kind: "error"; readonly text: string }
  >;
}

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
] as const;

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
function isFailure(text: string): boolean {
  return /^\[[a-z][a-z0-9-]*\]/.test(text.trim());
}

export function createDevcontainerCommand(
  runtime: DshRuntime,
  options: {
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
  },
): DevcontainerCommandDefinition {
  const pending = new Set<string>(options.diagnostics ?? runtime.diagnostics);
  const report = (message: string): void => {
    pending.add(message);
  };
  const services: CommandServices = {
    config: runtime.config,
    targetStore: runtime.targetStore,
    execution: runtime.execution,
    registry: async () => {
      const result = await runtime.registry();
      // Discovery problems are only useful if they reach someone: they are reported on the read that
      // produced them and never cached into silence.
      for (const message of result.diagnostics) report(message);
      return { entries: result.entries, diagnostics: result.diagnostics };
    },
    refreshRegistry: async () => {
      const result = await runtime.refresh();
      for (const message of result.diagnostics) report(message);
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
      if (raw.length === 0) return { kind: "error", text: USAGE };
      const match = /^(\S+)\s*([\s\S]*)$/.exec(raw);
      const verb = (match?.[1] ?? "").toLowerCase();
      const args = match?.[2] ?? "";
      const handler = handlers[verb];
      if (handler === undefined) {
        return { kind: "error", text: `[unknown-verb] Unknown devcontainer verb \`${verb}\`.\n${USAGE}` };
      }

      const notices: string[] = [];
      const context: CommandContextLike = {
        cwd: options.cwd ?? options.workspace,
        // No confirm/select exists on this surface. Handlers treat this as "headless" and refuse
        // destructive verbs rather than assuming consent.
        hasUI: false,
        signal: invocation.signal,
        ui: {
          select: async () => undefined,
          confirm: async () => false,
          notify: (message: string, type?: "info" | "warning" | "error") => {
            notices.push(type === undefined || type === "info" ? message : `[${type}] ${message}`);
          },
        },
      };

      // Adopt the workspace's own container before the verb runs, so `status` reports the real target
      // and `up`/`logs` need no prior `use`. `off` clears and SUSPENDS adoption (below), which is what
      // keeps the verb authoritative instead of letting the next command resurrect the target.
      if (verb !== "off") {
        try {
          await runtime.autoSelect(context.cwd);
        } catch {
          // Adoption is best-effort: the verb's own diagnostics are what the operator acts on.
        }
      }
      if (verb === "up" || verb === "use" || verb === "rebuild") runtime.setAutoSelection(true);

      let result: CommandResult;
      try {
        result = await handler(args, context);
      } catch (error) {
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
      if (verb === "off") runtime.setAutoSelection(false);
      // Classify from the handler's own text: the prefixed diagnostic lines must not turn a
      // successful verb into an error (their `[config]` label matches the failure prefix).
      return { kind: isFailure(result.text) ? "error" : "success", text };
    },
  };
}
