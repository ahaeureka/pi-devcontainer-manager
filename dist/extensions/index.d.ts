import type { ExtensionAPI, BashOperations, UserBashEventResult } from "@earendil-works/pi-coding-agent";
import { type DiagnosticSink } from "../src/discovery-diagnostics.js";
import { type ActivationDecision } from "../src/activation.js";
import { TargetStore } from "../src/target-store.js";
import { ExecutionService } from "../src/execution-service.js";
import { type BashOperationsLike } from "../src/bash-router.js";
import { type ToolDefinitionLike } from "../src/tools.js";
import { createCommandHandlers, type CommandServices } from "../src/commands.js";
import type { EffectiveConfig } from "../src/types.js";
/** Runtime composed once per session; re-composed on session reload. */
interface Runtime {
    /** Mutable per-session activation state (see ../src/activation.ts). */
    readonly activation: ActivationState;
    /** Host + Docker discovery; activation chain step 4 reads it for the container signal. */
    readonly registry: CommandServices["registry"];
    readonly config: EffectiveConfig;
    readonly targetStore: TargetStore;
    readonly execution: ExecutionService;
    readonly bashOperations: BashOperationsLike;
    readonly hostRunner: NonNullable<CommandServices["hostRunner"]>;
    readonly tools: {
        readonly exec: ToolDefinitionLike<unknown>;
        readonly status: ToolDefinitionLike<unknown>;
        readonly hostExec: ToolDefinitionLike<unknown>;
    };
    readonly commandHandlers: ReturnType<typeof createCommandHandlers>;
    /**
     * Render the per-turn DevContainer execution-context block (host<->container
     * mapping + surface guidance) appended to the system prompt, or undefined
     * when there is no selected target/mapping to describe.
     */
    readonly executionContext: () => Promise<string | undefined>;
    /**
     * Re-resolve a persisted selection hint against the current registry and
     * commit the result (used on session restore).
     */
    readonly reconcileSelection: (hint: {
        workspaceKey: string;
        candidateId?: string;
    }) => Promise<void>;
    /**
     * Discovery diagnostics queued since the last drain. The /devcontainer dispatch surfaces
     * them after each command; nothing else reports them, and the activation probe only adds.
     */
    readonly discoveryDiagnostics: DiagnosticSink;
}
/**
 * Mutable holder for the session's activation decision: `/devcontainer use|up`
 * engages the container surfaces, `/devcontainer off` hands them back to the host.
 */
interface ActivationState {
    decision: ActivationDecision;
}
export default function (pi: ExtensionAPI): void;
/**
 * Decide the `user_bash` (`!`/`!!`) interception result.
 *
 * Receives the full `UserBashEvent` (per pi's extension convention) so callers
 * can branch on `event.command`, `event.cwd`, and `event.excludeFromContext`
 * (`!!` — output excluded from the LLM context).
 *

 * Fail-closed contract: when the DevContainer runtime is not initialized
 * (session_start not yet run, or the reload window), returning `undefined`
 * would let Pi fall back to executing `!`/`!!` on the HOST's local bash — the
 * exact silent host fallback this extension forbids. Throwing from the handler
 * is also unsafe: Pi's emitUserBash catches handler errors, logs them, and
 * still falls through to local bash. The only hard stop is a full
 * `{ result }` replacement, which Pi consumes directly and never routes to
 * the host.
 */
export declare function resolveUserBash(rt: Runtime | undefined, event?: {
    command: string;
    cwd: string;
    excludeFromContext: boolean;
} | undefined): UserBashEventResult | undefined;
/**
 * Lazy BashOperations wrapper resolving the current runtime at exec time.
 *
 * While engaged it delegates to the container-routed operations. While dormant it
 * delegates to Pi's OWN local bash operations, so the surface is exactly the built-in
 * one (shell resolution, environment, truncation, timeout) instead of a reimplementation
 * — the previous hand-rolled `spawn` diverged from the built-in in shell choice and
 * output accounting (review finding on revision-8e6c0670). `localBash` is injectable so
 * the delegation itself is unit-tested.
 */
export declare function lazyBashOperations(getRuntime: () => Runtime | undefined, localBash?: BashOperations): BashOperations;
export {};
//# sourceMappingURL=index.d.ts.map