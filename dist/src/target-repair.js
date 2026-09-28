/**
 * Self-healing a target the session parked before a container existed.
 *
 * The defect (`openspec/changes/stale-target-self-heal/design.md`): a live session resolves its target once,
 * at a moment when nothing was running, and commits `selected-stopped`; if the container is started afterwards
 * — by VS Code, a host shell, or a sibling Pi session — every container surface keeps refusing
 * `target-stopped` until `/reload`, even though Docker reports a running container carrying this workspace's
 * own `devcontainer.local_folder` label.
 *
 * This module is the single owner of the decision "may this parked selection be re-derived from the live
 * registry?", so the rule is testable without Docker and cannot drift between call sites. Its contract:
 *
 *  - it repairs ONLY a reality-derived status (`selected-stopped` / `selected-missing`);
 *  - it adopts only a container that is actually RUNNING, which is what keeps the §5 invariant "an operator
 *    who stopped the target is not resurrected": `/devcontainer stop` leaves an `exited` candidate, so there
 *    is nothing to adopt and the refusal stands;
 *  - it refuses to let Docker's listing order decide (`ambiguous`, or two running candidates → no repair);
 *  - it carries the operator's selected configuration across, exactly as the restore path does;
 *  - it never widens the request: the parked workspace must contain the requested one.
 */
import { selectionFor } from "./commands.js";
import { canonicalWorkspaceKey, isWithinWorkspace } from "./workspace-path.js";
/** Statuses a repair may overwrite: both are derived from volatile reality, never from intent. */
const REPAIRABLE = ["selected-stopped", "selected-missing"];
/**
 * Resolve the repair for a parked selection, or `undefined` when nothing may be repaired.
 *
 * Returning a `TargetSelection` means "commit this"; `undefined` means "leave the store exactly as it is",
 * so a caller cannot accidentally turn a refusal into a different refusal.
 */
export function resolveTargetRepair(context) {
    const { snapshot } = context;
    if (!REPAIRABLE.includes(snapshot.status))
        return undefined;
    const parkedKey = snapshot.workspaceKey;
    if (parkedKey === undefined)
        return undefined;
    // Never retarget something the caller is not asking about: a request for another workspace must keep the
    // selection it has (and the fail-closed path it takes).
    if (!isWithinWorkspace(parkedKey, context.requestWorkspace))
        return undefined;
    const entry = context.entries.find((candidate) => canonicalWorkspaceKey(candidate.workspacePath) === canonicalWorkspaceKey(parkedKey));
    if (entry === undefined)
        return undefined;
    // Two running containers for one workspace: Docker's listing order must never pick the target (P4). The
    // parked refusal was already the fail-closed answer, and the operator already has `/devcontainer use`.
    if (entry.ambiguous === true)
        return undefined;
    const running = entry.containerCandidates.filter((candidate) => candidate.state === "running");
    if (running.length !== 1)
        return undefined;
    const adopted = running[0];
    // `selectionFor` is the single owner of how a selection is derived from an entry: it reads the chosen
    // container's OWN state (not the workspace primary's) and validates the carried configuration against the
    // discovered candidates, so a renamed or removed configuration cannot travel into the CLI's argv.
    return selectionFor(entry, adopted.id, snapshot.configPath);
}
//# sourceMappingURL=target-repair.js.map