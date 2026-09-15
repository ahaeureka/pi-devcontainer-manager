export function surfacesFor(decision) {
    return {
        containerTools: decision.active,
        bashReplacement: decision.active,
        executionContext: decision.active,
        commandSurface: true,
    };
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