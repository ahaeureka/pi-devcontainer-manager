/**
 * Render the injection block, or `undefined` when there is nothing useful to
 * say (no selected target and no mapping). Never fabricates facts.
 */
export function renderExecutionContext(facts) {
    const hasTarget = facts.candidateId !== undefined || (facts.status !== undefined && facts.status !== "none");
    if (!hasTarget && facts.mapping === undefined)
        return undefined;
    const lines = ["## DevContainer execution context", ""];
    if (facts.candidateId !== undefined || facts.status !== undefined) {
        const identity = [
            facts.candidateName ?? "target",
            facts.candidateId !== undefined ? `(${facts.candidateId.slice(0, 12)})` : undefined,
        ]
            .filter((part) => part !== undefined)
            .join(" ");
        lines.push(`Target: ${identity}${facts.status !== undefined ? ` — ${facts.status}` : ""}`);
    }
    if (facts.mapping !== undefined) {
        lines.push(`Workspace mapping: host \`${facts.mapping.hostPath}\` ↔ container \`${facts.mapping.containerPath}\` (bind mount)`);
    }
    if (facts.containerOnlyMounts !== undefined && facts.containerOnlyMounts.length > 0) {
        lines.push(`Container-only mounts (not visible to host tools): ${facts.containerOnlyMounts.join(", ")}`);
    }
    lines.push("");
    lines.push("Execution surfaces (choose by WHAT the command operates on, not by its name):");
    lines.push("- `bash`, `!`, `!!`, `devcontainer_exec` → run INSIDE the container (default).");
    lines.push("- `devcontainer_host_exec` → runs on the HOST (explicit, audited; a configuration can withhold it).");
    lines.push("");
    lines.push("Decision rules:");
    lines.push("- Result depends on the container toolchain, or on a container-only path → container surfaces.");
    lines.push("- Manages the host itself (docker daemon, host services/daemons) or a host path outside the mount → `devcontainer_host_exec`.");
    lines.push("- Host-side file inspection/editing → the host file tools (read/write/edit); they see the same files via the bind mount.");
    return lines.join("\n");
}
//# sourceMappingURL=execution-context.js.map