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
import { errorKindOf } from "./errors.js";
import type { ExecutionService } from "./execution-service.js";
/** argv form accepted by `devcontainer_exec`. */
export declare const DEV_CONTAINER_EXEC_TOOL = "devcontainer_exec";
export declare const DEV_CONTAINER_STATUS_TOOL = "devcontainer_status";
export declare const DEV_CONTAINER_HOST_EXEC_TOOL = "devcontainer_host_exec";
export declare const devcontainerExecParams: Type.TObject<{
    argv: Type.TArray<Type.TString>;
    cwd: Type.TOptional<Type.TString>;
    timeoutSeconds: Type.TOptional<Type.TNumber>;
}>;
export type DevcontainerExecParams = Static<typeof devcontainerExecParams>;
export declare const devcontainerStatusParams: Type.TObject<{}>;
export declare const devcontainerHostExecParams: Type.TObject<{
    argv: Type.TArray<Type.TString>;
    timeoutSeconds: Type.TOptional<Type.TNumber>;
}>;
export type DevcontainerHostExecParams = Static<typeof devcontainerHostExecParams>;
export interface ToolExecContextLike {
    cwd: string;
}
export interface ToolResultLike {
    content: Array<{
        type: "text";
        text: string;
    }>;
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
    execute(toolCallId: string, params: TParams, signal: AbortSignal | undefined, onUpdate: ((partial: ToolResultLike) => void) | undefined, ctx: ToolExecContextLike): Promise<ToolResultLike>;
}
export interface ToolOptions {
    readonly execution: ExecutionService;
    /** Host session workspace; used when no `cwd` is supplied to the tool. */
    readonly sessionWorkspace: string;
    /** Runnable host command runner for the host escape hatch. */
    readonly hostRunner: {
        run(argv: readonly string[], options?: {
            timeoutMs?: number;
            signal?: AbortSignal;
        }): Promise<{
            exitCode: number | null;
            signal: string | null;
            stdout: string;
            stderr: string;
            truncated: boolean;
        }>;
    };
    /** Whether the host escape hatch is allowed by policy (`hostExecution.allow`). */
    readonly hostExecutionAllowed: boolean;
    /**
     * Report a host attempt that policy refused BEFORE the runner.
     *
     * The runner's ledger sees only attempts that reach it, so a withheld configuration would leave the
     * operator with "no host commands this session" while the agent kept trying (adversarial review of
     * the routing hardening).
     */
    readonly onWithheldHostAttempt?: (argv: readonly string[]) => void;
}
/** Build the `devcontainer_exec` tool definition. */
export declare function createDevcontainerExecTool(options: ToolOptions): ToolDefinitionLike<DevcontainerExecParams>;
/** Build the read-only `devcontainer_status` tool. */
export declare function createDevcontainerStatusTool(status: () => {
    summary: string;
    details: Record<string, unknown>;
}): ToolDefinitionLike<Record<string, never>>;
/**
 * Build the explicit host escape-hatch tool. Policy and audit are enforced by
 * the caller-supplied `hostRunner` (the extension wires a policy-gated,
 * audit-writing runner). This tool never touches the selected container.
 */
export declare function createDevcontainerHostExecTool(options: ToolOptions): ToolDefinitionLike<DevcontainerHostExecParams>;
/** Format a thrown error into a tool error text (typed kind surfaced). */
export declare function formatToolError(error: unknown): string;
export { errorKindOf };
//# sourceMappingURL=tools.d.ts.map