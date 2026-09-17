/**
 * `BashOperations` translation to the shared execution service.
 *
 * Pi's `bash` tool and the `!`/`!!` `user_bash` route both delegate through
 * Pi's `BashOperations` interface. This module implements that interface
 * against {@link ExecutionService.exec} so shell text receives the identical
 * gates as the structured `devcontainer_exec` tool: target validation, policy
 * snapshot, environment filtering, audit, output accounting, cancellation,
 * and timeout. Pi passes raw shell command text, so we wrap it with
 * `shellForm()` (`/bin/sh -lc`).
 *
 * The execution service captures stdout/stderr into `ExecOutcome` (bounded by
 * `maxOutputBytes`, `truncated` flag set). After the command settles, this
 * router replays the captured output through Pi's single `onData` callback —
 * the contract Pi's bash tool uses to render its result — and returns the
 * container-side exit code.
 *
 * There is intentionally NO silent host fallback here. When no target is
 * selected, the target is ambiguous/stale/stopped, or policy denies the
 * operation, the underlying typed error propagates to the caller. The only
 * host escape hatch is the explicit, policy-gated, audited
 * `devcontainer_host_exec` surface (see tools/commands).
 *
 * This module is deliberately free of Pi package imports: `src/` is unit
 * tested without the Pi dependency. The structural shape below matches Pi's
 * `BashOperations`, and `extensions/index.ts` casts it when wiring.
 */
import { type ExecutionService, type ExecRequest, type ExecOutcome } from "./execution-service.js";
/** The two initiators that route shell text into the container. */
export type BashRoute = "routed-bash" | "user-bash";
export interface RoutedBashOptions {
    /** Shared execution service; the bash tool and `!`/`!!` use the same one. */
    readonly execution: ExecutionService;
    /**
     * Host session workspace (Pi's cwd). Used as the policy-scoped workspace
     * when Pi reports a non-absolute cwd.
     */
    readonly sessionWorkspace: string;
    /** Which initiator this router instance represents. */
    readonly initiator: BashRoute;
    /** Allowlisted environment variable names that may reach the container. */
    readonly environmentAllowlist: readonly string[];
}
/**
 * Structural match for Pi's `BashOperations` (`@earendil-works/pi-coding-agent`,
 * `dist/core/tools/bash.d.ts`). Declared locally so `src/` stays dependency-free.
 */
export interface BashOperationsLike {
    exec(command: string, cwd: string, options: {
        onData: (data: Buffer) => void;
        signal?: AbortSignal;
        timeout?: number;
        env?: NodeJS.ProcessEnv;
    }): Promise<{
        exitCode: number | null;
        truncated?: boolean;
    }>;
}
/**
 * Build a `BashOperations` implementation that routes every command into the
 * currently selected container through the execution service.
 *
 * The returned object is suitable for BOTH `createBashToolDefinition(cwd,
 * { operations })` and the `user_bash` handler's `{ operations }` result, so
 * LLM bash and `!`/`!!` cannot drift. Pi's `timeout` is in seconds; the
 * router enforces it in the operations layer via `executeWithTimeout` (the
 * locked service does not forward per-request timeouts).
 */
export declare function createRoutedBashOperations(options: RoutedBashOptions): BashOperationsLike;
/**
 * Run `exec(request)` with a caller-visible timeout.
 *
 * The locked `ExecutionService.exec` forwards only `remoteEnv` + `signal` to
 * the devcontainer adapter (the adapter applies its own bounded CLI timeout),
 * so a per-request `timeoutMs` would be a silent no-op there. Pi's own bash
 * tool contract puts timeout enforcement in the operations layer, so this
 * wrapper owns it: a linked `AbortController` is aborted when the timer
 * fires, killing the child via the runner's abort path, and a typed
 * `timeout` error is raised. The caller's own `signal` is linked to the
 * controller so both surfaces behave identically.
 */
/**
 * Convert a caller-supplied timeout in SECONDS into the enforced millisecond budget.
 *
 * Rounding alone is not enough: `Math.round(0.0004 * 1000)` is 0, and `setTimeout(…, 0)` aborts
 * the command immediately and reports it as a timeout — the exact failure a caller passing a
 * positive value is trying to avoid, and one the tool schema's `exclusiveMinimum: 0` cannot
 * express because the schema has no millisecond floor. Flooring at 1 ms keeps "as soon as
 * possible" meaning "as soon as possible" rather than "abort now".
 */
export declare function resolveTimeoutMs(seconds: number | undefined): number | undefined;
export declare function executeWithTimeout(request: Omit<ExecRequest, "signal">, timeoutMs: number | undefined, signal: AbortSignal | undefined, exec: (request: ExecRequest) => Promise<ExecOutcome>): Promise<ExecOutcome>;
//# sourceMappingURL=bash-router.d.ts.map