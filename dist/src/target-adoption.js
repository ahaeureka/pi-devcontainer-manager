import { selectionFor } from "./commands.js";
import { primaryCandidate } from "./registry-entry.js";
import { resolveTargetRepair } from "./target-repair.js";
import { canonicalWorkspaceKey, isAtOrUnder, isSamePath } from "./workspace-path.js";
export function resolveTargetAdoption(context) {
    const { snapshot, entries, requestWorkspace } = context;
    if (snapshot.status === "selected-stopped" || snapshot.status === "selected-missing") {
        return resolveTargetRepair({ snapshot, requestWorkspace, entries });
    }
    if (snapshot.status !== "none")
        return undefined;
    const requested = canonicalWorkspaceKey(requestWorkspace);
    const inside = (entryKey) => context.scope === "at-or-under" ? isAtOrUnder(requested, entryKey) : isSamePath(entryKey, requested);
    const matches = entries.filter((entry) => inside(canonicalWorkspaceKey(entry.workspacePath)));
    if (matches.length === 0)
        return undefined;
    // Deepest project wins when a nested workspace is also discovered; `reduce` keeps discovery order
    // irrelevant for ties (equal depth cannot happen for `exact`, and for nested ones the deeper wins).
    const match = matches.reduce((deepest, entry) => canonicalWorkspaceKey(entry.workspacePath).length > canonicalWorkspaceKey(deepest.workspacePath).length
        ? entry
        : deepest);
    return selectionFor(match, match.ambiguous ? undefined : primaryCandidate(match)?.id);
}
//# sourceMappingURL=target-adoption.js.map