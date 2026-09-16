export function surfacesFor(decision) {
    return {
        containerTools: decision.active,
        bashReplacement: decision.active,
        executionContext: decision.active,
        commandSurface: true,
    };
}
/**
 * Whether the execution service may AUTO-SELECT a target.
 *
 * Only an engaged session may: an opt-out has to hold for the rest of the session too, not just
 * across the reload that restored it. After `/devcontainer off` the container tools stay registered
 * for the session (Pi cannot unregister them), so an auto-selecting `devcontainer_exec` would
 * resurrect the target the operator just turned off (review finding L1-02).
 */
export function allowsAutoSelection(decision) {
    return decision.active;
}
export function decideActivation(input) {
    if (input.activation === "never")
        return { active: false, reason: "config-never" };
    if (input.activation === "always")
        return { active: true, reason: "config-always" };
    if (input.optedOut === true)
        return { active: false, reason: "opted-out" };
    if (input.workspaceHasConfig)
        return { active: true, reason: "workspace-config" };
    if (input.workspaceHasRunningContainer)
        return { active: true, reason: "running-container" };
    if (input.hasExplicitSelection)
        return { active: true, reason: "explicit-selection" };
    return { active: false, reason: "no-evidence" };
}
//# sourceMappingURL=activation.js.map