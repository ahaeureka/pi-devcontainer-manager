import type { ActivationMode } from "./types.js";
/**
 * Per-session activation decision (AC-3).
 *
 * The extension is loaded globally, so whether it takes over the execution
 * surfaces has to be decided from evidence about the CURRENT workspace, in this
 * order:
 *
 *   `never` > `always` > workspace owns a configuration > a running container is
 *   labelled for the workspace > an explicit selection exists > dormant
 *
 * Dormant is a first-class outcome: `bash` stays the host shell and no container
 * surface is registered.
 */
export interface ActivationInput {
    /** Effective `activation` from configuration (project wins over global). */
    readonly activation: ActivationMode;
    /** The session workspace owns a DevContainer configuration (cheap, cwd-anchored). */
    readonly workspaceHasConfig: boolean;
    /** A running container carries this workspace's `devcontainer.local_folder`. */
    readonly workspaceHasRunningContainer: boolean;
    /** This session selected a target, or restored a persisted selection. */
    readonly hasExplicitSelection: boolean;
}
export type ActivationDecision = {
    readonly active: true;
    readonly reason: "config-always" | "workspace-config" | "running-container" | "explicit-selection";
} | {
    readonly active: false;
    readonly reason: "config-never" | "no-evidence";
};
/**
 * Which execution surfaces a session registers. Dormant sessions register NOTHING —
 * Pi's built-in `bash`, `!`/`!!`, and the host file tools stay exactly as shipped —
 * while the `/devcontainer` command surface keeps working so the operator can still
 * engage a target (AC-4). The entrypoint consults this single function so the
 * dormancy contract cannot drift between surfaces.
 */
export interface SurfaceRegistration {
    /** The three container tools (exec / status / host-exec). */
    readonly containerTools: boolean;
    /** The same-name `bash` replacement, which routes the LLM tool and `!`/`!!`. */
    readonly bashReplacement: boolean;
    /** The per-turn execution-context block appended to the system prompt. */
    readonly executionContext: boolean;
    /** `/devcontainer list|use|up` stay available in every state. */
    readonly commandSurface: true;
}
export declare function surfacesFor(decision: ActivationDecision): SurfaceRegistration;
export declare function decideActivation(input: ActivationInput): ActivationDecision;
//# sourceMappingURL=activation.d.ts.map