import type { Agent } from "@deepseek-ai/dsh-agent";
import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import {
  createCommandHandlers,
  type CommandContextLike,
  type CommandResult,
  type CommandServices,
} from "../../src/commands.js";
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
] as const;

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
    type: "string" as const,
    required: true as const,
    description: `One of: ${VERBS.join(", ")}`,
  },
  args: {
    type: "string" as const,
    description: "The verb's arguments, exactly as the slash command would take them (optional).",
  },
};

/**
 * The canonical value is the rendered text itself: dsh's schema DSL has no `required` list for object
 * roots (a `{ text }` object would need one), and a string carries everything a caller needs.
 */
const OUTPUT = {
  schema: { type: "string" as const },
  render: (_args: { verb: string; args?: string }, value: string) => [{ type: "text" as const, text: value }],
};

export function createDevcontainerTool(runtime: DshRuntime, options: DevcontainerToolOptions): ToolDefinition {
  const services: CommandServices = {
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
    async execute(args: { verb: string; args?: string }, exec: { signal: AbortSignal; agent?: Agent }) {
      const verb = args.verb.trim().toLowerCase();
      const handler = handlers[verb];
      if (handler === undefined) {
        throw new Error(`[unknown-verb] Unknown devcontainer verb \`${verb}\`. Verbs: ${VERBS.join(", ")}`);
      }

      const notices: string[] = [];
      const context: CommandContextLike = {
        cwd: options.workspace,
        // A confirmation is available (through approval), a picker is not: the refusal enumerates
        // container ids and the model re-issues `use <container-id>`.
        hasUI: true,
        signal: exec.signal,
        ui: {
          select: async () => undefined,
          confirm: async (title: string, message: string) => {
            if (options.confirm === undefined) return false;
            return options.confirm({
              agent: exec.agent,
              reason: `${title}: ${message}`,
              signal: exec.signal,
            });
          },
          notify: (message: string, type?: "info" | "warning" | "error") => {
            notices.push(type === undefined || type === "info" ? message : `[${type}] ${message}`);
          },
        },
      };

      let result: CommandResult;
      try {
        result = await handler(args.args ?? "", context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`[error] ${message}`);
      }

      const parts = [...notices, result.text].filter((part) => part.length > 0);
      const text = parts.join("\n");
      // A refusal is not a successful tool result: surface it as an error so the model does not
      // narrate a failed operation as done (the `[kind] …` prefix is this project's failure marker).
      if (/^\[[a-z][a-z0-9-]*\]/.test(result.text.trim())) throw new Error(text);
      return text;
    },
  });
}
