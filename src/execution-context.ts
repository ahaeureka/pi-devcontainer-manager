/**
 * Renders the DevContainer execution-context block injected into the agent's
 * system prompt before each turn (`before_agent_start`).
 *
 * Design intent (see `.rpiv/artifacts/designs/`): the extension does NOT guess
 * which command belongs in the container vs the host from command text — that
 * is unreliable (shell operators defeat any name/head-based classifier). Instead
 * the LLM decides, using two explicit, enforced surfaces, and this module gives
 * it the FACTS it needs to decide correctly:
 *
 *   - `bash`, `!`, `!!`, `devcontainer_exec`  -> always the container
 *   - `devcontainer_host_exec`                -> the host (explicit, policy-gated)
 *   - the workspace mapping (host path <-> container path) and container-only
 *     mounts, so the LLM can tell which environment a path belongs to.
 *
 * This module is Pi-free and pure so it is unit-testable without the Pi
 * dependency; `extensions/index.ts` renders it and appends it to the system
 * prompt.
 */
import type { PathMapping } from "./path-mapper.js";

export interface ExecutionContextFacts {
  /** Selected target's candidate id (container id), when known. */
  readonly candidateId?: string;
  /** Selected target's display name, when known. */
  readonly candidateName?: string;
  /** Selection status (e.g. "selected-valid", "selected-stopped"). */
  readonly status?: string;
  /** Host <-> container workspace mapping derived from devcontainer.json. */
  readonly mapping?: PathMapping;
  /**
   * Container-only locations (extra mounts / volumes) that host file tools and
   * host commands cannot see. Rendered path-style; empty/absent when none.
   */
  readonly containerOnlyMounts?: readonly string[];
}

/**
 * Render the injection block, or `undefined` when there is nothing useful to
 * say (no selected target and no mapping). Never fabricates facts.
 */
export function renderExecutionContext(facts: ExecutionContextFacts): string | undefined {
  const hasTarget = facts.candidateId !== undefined || (facts.status !== undefined && facts.status !== "none");
  if (!hasTarget && facts.mapping === undefined) return undefined;
  const lines: string[] = ["## DevContainer execution context", ""];

  if (facts.candidateId !== undefined || facts.status !== undefined) {
    const identity = [
      facts.candidateName ?? "target",
      facts.candidateId !== undefined ? `(${facts.candidateId.slice(0, 12)})` : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join(" ");
    lines.push(`Target: ${identity}${facts.status !== undefined ? ` — ${facts.status}` : ""}`);
  }
  if (facts.mapping !== undefined) {
    lines.push(
      `Workspace mapping: host \`${facts.mapping.hostPath}\` ↔ container \`${facts.mapping.containerPath}\` (bind mount)`,
    );
  }
  if (facts.containerOnlyMounts !== undefined && facts.containerOnlyMounts.length > 0) {
    lines.push(`Container-only mounts (not visible to host tools): ${facts.containerOnlyMounts.join(", ")}`);
  }

  lines.push("");
  lines.push("Execution surfaces (choose by WHAT the command operates on, not by its name):");
  lines.push("- `bash`, `!`, `!!`, `devcontainer_exec` → run INSIDE the container (default).");
  lines.push("- `devcontainer_host_exec` → runs on the HOST (explicit; requires hostExecution.allow).");
  lines.push("");
  lines.push("Decision rules:");
  lines.push("- Result depends on the container toolchain, or on a container-only path → container surfaces.");
  lines.push(
    "- Manages the host itself (docker daemon, host services/daemons) or a host path outside the mount → `devcontainer_host_exec`.",
  );
  lines.push(
    "- Host-side file inspection/editing → the host file tools (read/write/edit); they see the same files via the bind mount.",
  );

  return lines.join("\n");
}
