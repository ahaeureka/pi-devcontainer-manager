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
import type { LifecycleLogFailure } from "./lifecycle-log.js";

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
  /**
   * The newest unreported lifecycle failure, when there is one.
   *
   * Lifecycle slash commands (`/devcontainer up|build|rebuild|stop|remove|setup`) render into the operator UI,
   * so the agent never sees their failure on its own. This fact is what lets the agent learn about it on the
   * next turn, and it is the reason the block must render even when there is NO target — a failed first `up`
   * leaves neither container nor mapping, which is precisely the case worth reporting.
   */
  readonly failure?: LifecycleLogFailure;
}

/**
 * Render the injection block, or `undefined` when there is nothing useful to
 * say (no selected target, no mapping, and no failure to report). Never
 * fabricates facts.
 */
export function renderExecutionContext(facts: ExecutionContextFacts): string | undefined {
  const hasTarget = facts.candidateId !== undefined || (facts.status !== undefined && facts.status !== "none");
  if (!hasTarget && facts.mapping === undefined && facts.failure === undefined) return undefined;
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
  lines.push("- `devcontainer_host_exec` → runs on the HOST (explicit, audited; a configuration can withhold it).");
  lines.push("");
  lines.push("Decision rules:");
  lines.push("- Result depends on the container toolchain, or on a container-only path → container surfaces.");
  lines.push(
    "- Manages the host itself (docker daemon, host services/daemons) or a host path outside the mount → `devcontainer_host_exec`.",
  );
  lines.push(
    "- Host-side file inspection/editing → the host file tools (read/write/edit); they see the same files via the bind mount.",
  );

  if (facts.failure !== undefined) {
    const failure = facts.failure;
    lines.push("");
    lines.push(`## DevContainer lifecycle failure (reported once)`);
    lines.push(`Last \`${failure.operation}\` FAILED (${failure.state}).`);
    if (failure.error !== undefined) lines.push(`Recorded error: ${failure.error}`);
    if (failure.path !== undefined) {
      lines.push(`Raw transcript (stdout/stderr): ${failure.path}`);
      lines.push(
        "Analyze it before retrying: read the tail and grep for error markers rather than reading the whole file.",
      );
    } else {
      lines.push("Raw transcript: unavailable for this run (the log could not be written).");
    }
  }

  return lines.join("\n");
}
