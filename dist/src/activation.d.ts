import type { ActivationMode } from "./types.js";
/**
 * Per-session activation decision (AC-3).
 *
 * The extension is loaded globally, so whether it takes over the execution
 * surfaces has to be decided from evidence about the CURRENT workspace, in this
 * order:
 *
 *   `never` > `always` > a persisted opt-out > workspace owns a configuration > a
 *   running container is labelled for the workspace > an explicit selection exists >
 *   dormant
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
    /**
     * The persisted intent says the operator turned the extension OFF for this session.
     *
     * An opt-out outranks the workspace evidence, and only an explicit "always" configuration (or a
     * later `/devcontainer use`) overrides it — otherwise `/devcontainer off` would be undone by the
     * next reload in any DevContainer workspace (review finding L1-02).
     */
    readonly optedOut?: boolean;
}
export type ActivationDecision = {
    readonly active: true;
    readonly reason: "config-always" | "workspace-config" | "running-container" | "explicit-selection";
} | {
    readonly active: false;
    readonly reason: "config-never" | "opted-out" | "no-evidence";
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
/**
 * Whether the execution service may AUTO-SELECT a target.
 *
 * Only an engaged session may: an opt-out has to hold for the rest of the session too, not just
 * across the reload that restored it. After `/devcontainer off` the container tools stay registered
 * for the session (Pi cannot unregister them), so an auto-selecting `devcontainer_exec` would
 * resurrect the target the operator just turned off (review finding L1-02).
 */
export declare function allowsAutoSelection(decision: ActivationDecision): boolean;
export declare function decideActivation(input: ActivationInput): ActivationDecision;
//# sourceMappingURL=activation.d.ts.map