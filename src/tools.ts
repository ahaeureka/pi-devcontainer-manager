/**
 * Pi tool definitions and presentation for the DevContainer manager.
 *
 * Three tools are registered (see `extensions/index.ts`):
 *
 * - `devcontainer_exec` — the structured, argv-based execution tool. Accepts
 *   literal `argv` (never shell text) and routes through the shared
 *   `ExecutionService`, so policy, environment filtering, audit, output
 *   accounting, cancellation, and timeout match every other path.
 * - `devcontainer_status` — read-only snapshot of the current selection and
 *   registry for the LLM (list-style summary).
 * - `devcontainer_host_exec` — the ONLY host escape hatch. It is explicitly
 *   named so the LLM cannot confuse it with container execution, requires a
 *   separate `hostExecution.allow` policy grant, and emits its own audit
 *   record (`operation: "host-exec"`, `initiator: "host-escape"`).
 *
 * Tool parameters use TypeBox (`Type.Object`) exactly like Pi's own tool
 * definitions. The module stays free of Pi package imports so `src/` unit
 * tests run without the Pi dependency; the structural `ToolDefinitionLike`
 * shape matches Pi's `ToolDefinition`.
 */
import { Type, type Static } from "typebox";
import { RuntimeError, errorKindOf } from "./errors.js";
import type { ExecutionService, ExecRequest } from "./execution-service.js";
import { executeWithTimeout, resolveTimeoutMs } from "./bash-router.js";
import { combineCommandOutput, formatToolOutput } from "./tool-output.js";
/** argv form accepted by `devcontainer_exec`. */
export const DEV_CONTAINER_EXEC_TOOL = "devcontainer_exec";
export const DEV_CONTAINER_STATUS_TOOL = "devcontainer_status";
export const DEV_CONTAINER_HOST_EXEC_TOOL = "devcontainer_host_exec";

export const devcontainerExecParams = Type.Object({
  argv: Type.Array(Type.String(), { minItems: 1 }),
  cwd: Type.Optional(Type.String()),
  timeoutSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
});

export type DevcontainerExecParams = Static<typeof devcontainerExecParams>;

export const devcontainerStatusParams = Type.Object({});

export const devcontainerHostExecParams = Type.Object({
  argv: Type.Array(Type.String(), { minItems: 1 }),
  timeoutSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
});

export type DevcontainerHostExecParams = Static<typeof devcontainerHostExecParams>;

export interface ToolExecContextLike {
  cwd: string;
}

export interface ToolResultLike {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

/** Structural match for Pi's `ToolDefinition.execute` result shape. */
export interface ToolDefinitionLike<TParams> {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  executionMode?: "sequential" | "parallel";
  execute(
    toolCallId: string,
    params: TParams,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: ToolResultLike) => void) | undefined,
    ctx: ToolExecContextLike,
  ): Promise<ToolResultLike>;
}

export interface ToolOptions {
  readonly execution: ExecutionService;
  /** Host session workspace; used when no `cwd` is supplied to the tool. */
  readonly sessionWorkspace: string;
  /** Runnable host command runner for the host escape hatch. */
  readonly hostRunner: {
    run(argv: readonly string[], options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<{
      exitCode: number | null;
      signal: string | null;
      stdout: string;
      stderr: string;
      truncated: boolean;
    }>;
  };
  /** Whether the host escape hatch is allowed by policy (`hostExecution.allow`). */
  readonly hostExecutionAllowed: boolean;
}

/** Build the `devcontainer_exec` tool definition. */
export function createDevcontainerExecTool(options: ToolOptions): ToolDefinitionLike<DevcontainerExecParams> {
  return {
    name: DEV_CONTAINER_EXEC_TOOL,
    label: "Dev Container Exec",
    description:
      "Execute an argv command inside the currently selected DevContainer target. " +
      "Literal argv only; use the bash tool for shell pipelines inside the container. " +
      "Returns the container-side exit code and captured stdout/stderr. Output is truncated to the last 2000 lines or 50KB (whichever first); if truncated, the full output is saved to a temp file whose path is reported so it can be read in full.",
    promptSnippet: "Execute an argv command in the selected DevContainer",
    promptGuidelines: [
      `Use ${DEV_CONTAINER_EXEC_TOOL} when the user asks to run a command in their selected DevContainer: builds, tests, language toolchains (npm/pip/cargo/...), dev servers, or anything whose behavior depends on the container environment.`,
      `Prefer literal argv (["npm","test"]) over shell syntax; use the routed bash tool for pipelines.`,
      `Container is NOT the host: run container-environment work here, never host administration (systemctl, host services, docker itself).`,
      `If no target is selected or it is stopped, ${DEV_CONTAINER_EXEC_TOOL} fails closed (target-stopped) — run /devcontainer up first instead of trying the host.`,
    ],
    parameters: devcontainerExecParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      const workspace = params.cwd !== undefined && params.cwd.length > 0 ? params.cwd : options.sessionWorkspace;
      const request: ExecRequest = {
        operation: "container-exec",
        initiator: "tool",
        workspace,
        cmd: params.argv[0]!,
        args: params.argv.slice(1),
      };
      const outcome = await executeWithTimeout(
        request,
        resolveTimeoutMs(params.timeoutSeconds),
        signal,
        (r) => options.execution.exec(r),
      );
      const shortId = outcome.candidateId.slice(0, 12);
      const summary = `${outcome.workspaceKey} · ${shortId} · exit ${outcome.exitCode}`;
      // Nonzero container-side exit is surfaced like Pi's bash tool: throw
      // with the captured output appended so the failure is visible.
      if (outcome.exitCode !== 0 && outcome.exitCode !== null) {
        const combined = combineCommandOutput(outcome.stdout, outcome.stderr);
        const output = combined.length > 0 ? combined : "(no output)";
        const errFormatted = formatToolOutput(output === "(no output)" ? "" : output);
        const errText = output === "(no output)"
          ? `Command exited with code ${outcome.exitCode}: ${summary}`.trimEnd()
          : `Command exited with code ${outcome.exitCode}: ${summary}\n${errFormatted.text}`.trimEnd();
        const err = new RuntimeError({
          kind: "unexpected",
          message: errText,
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          remedy: "The container-side command failed; inspect its output above.",
        });
        void errFormatted.fullOutputPath; // the path is already embedded in errText's truncation notice
        throw err;
      }
      const captured = combineCommandOutput(outcome.stdout, outcome.stderr);
      // Present output the way Pi's bash tool does: keep the tail within
      // 50KB / 2000 lines, persist the full output to a temp file when
      // truncated, and tell the LLM where the full copy lives so it never
      // reasons from a silently partial view.
      const formatted = formatToolOutput(captured, { prefix: summary });
      return {
        content: [{ type: "text", text: formatted.text }],
        details: {
          operation: outcome.operation,
          workspaceKey: outcome.workspaceKey,
          candidateId: outcome.candidateId,
          candidateName: outcome.candidateName,
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          durationMs: outcome.durationMs,
          truncated: outcome.truncated || formatted.truncated,
          ...(formatted.fullOutputPath !== undefined ? { fullOutputPath: formatted.fullOutputPath } : {}),
          policyAuthorized: outcome.policyAuthorized,
        },
      };
    },
  };
}

/** Build the read-only `devcontainer_status` tool. */
export function createDevcontainerStatusTool(
  status: () => { summary: string; details: Record<string, unknown> },
): ToolDefinitionLike<Record<string, never>> {
  return {
    name: DEV_CONTAINER_STATUS_TOOL,
    label: "Dev Container Status",
    description:
      "Read-only summary of the current DevContainer selection and workspace registry. " +
      "Use before executing when the target is unknown or may have changed.",
    promptSnippet: "Show current DevContainer selection and registry",
    parameters: devcontainerStatusParams,
    executionMode: "parallel",
    execute: async () => {
      const current = status();
      return {
        content: [{ type: "text", text: current.summary }],
        details: current.details,
      };
    },
  };
}

/**
 * Build the explicit host escape-hatch tool. Policy and audit are enforced by
 * the caller-supplied `hostRunner` (the extension wires a policy-gated,
 * audit-writing runner). This tool never touches the selected container.
 */
export function createDevcontainerHostExecTool(options: ToolOptions): ToolDefinitionLike<DevcontainerHostExecParams> {
  return {
    name: DEV_CONTAINER_HOST_EXEC_TOOL,
    label: "Dev Container Host Exec (escape hatch)",
    description:
      "EXPLICIT HOST ESCAPE HATCH: execute an argv command on the HOST machine, NOT inside any DevContainer. " +
      "Requires hostExecution.allow policy. Prefer devcontainer_exec or the routed bash tool for container work. Output is truncated to the last 2000 lines or 50KB (whichever first); if truncated, the full output is saved to a temp file whose path is reported so it can be read in full.",
    promptSnippet: "Execute an argv command on the HOST (escape hatch)",
    promptGuidelines: [
      `${DEV_CONTAINER_HOST_EXEC_TOOL} runs on the HOST, not in the container. Use it ONLY for host administration the container must not do: managing docker itself, host services/daemons, or files outside the mounted workspace.`,
      `Do NOT route project work here: builds/tests/toolchains belong in the container (${DEV_CONTAINER_EXEC_TOOL} or the routed bash tool); editing workspace files belongs to the host file tools (read/write/edit), which see the same files as the container via the bind mount.`,
      `Requires hostExecution.allow policy; a policy-denied error means host execution is disabled, not that you should retry in the container.`,
    ],
    parameters: devcontainerHostExecParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      if (!options.hostExecutionAllowed) {
        throw new RuntimeError({
          kind: "policy-denied",
          message: "Host execution is disabled by policy.",
          remedy: "Set hostExecution.allow=true in the global configuration to enable devcontainer_host_exec.",
        });
      }
      const result = await options.hostRunner.run(params.argv, {
        ...(params.timeoutSeconds !== undefined ? { timeoutMs: Math.round(params.timeoutSeconds * 1000) } : {}),
        ...(signal !== undefined ? { signal } : {}),
      });
      const combined = combineCommandOutput(result.stdout, result.stderr);
      const rawText = combined.length > 0 ? combined : `(no output, exit ${result.exitCode})`;
      // Same presentation as devcontainer_exec / Pi's bash tool: tail within
      // 50KB/2000 lines, full output persisted to a temp file when truncated.
      const formatted = formatToolOutput(rawText === `(no output, exit ${result.exitCode})` ? "" : rawText);
      const text = rawText === `(no output, exit ${result.exitCode})` ? rawText : formatted.text;
      return {
        content: [{ type: "text", text }],
        details: {
          exitCode: result.exitCode,
          signal: result.signal,
          truncated: result.truncated || formatted.truncated,
          ...(formatted.fullOutputPath !== undefined ? { fullOutputPath: formatted.fullOutputPath } : {}),
          host: true,
        },
      };
    },
  };
}

/** Format a thrown error into a tool error text (typed kind surfaced). */
export function formatToolError(error: unknown): string {
  if (error instanceof RuntimeError) {
    const remedy = error.remedy !== undefined ? `\n${error.remedy}` : "";
    return `[${error.kind}] ${error.message}${remedy}`;
  }
  return `[unexpected] ${error instanceof Error ? error.message : String(error)}`;
}

export { errorKindOf };
