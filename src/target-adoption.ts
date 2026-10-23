import { selectionFor } from "./commands.js";
import { primaryCandidate } from "./registry-entry.js";
import { resolveTargetRepair } from "./target-repair.js";
import { canonicalWorkspaceKey, isAtOrUnder, isSamePath } from "./workspace-path.js";
import type { TargetSelection, TargetStoreSnapshot } from "./target-store.js";
import type { RegistryEntry } from "./types.js";

/**
 * Which target a command's workspace should adopt on its own.
 *
 * Both entry points need the same answer — "this command belongs to that DevContainer project" — and
 * the two rules they legitimately differ on are parameters, not separate implementations:
 *
 * - **scope** (`exact` vs `at-or-under`): Pi adopts only for its session cwd (a tool call may name any
 *   path, and a wrong adoption would reroute the whole session); dsh adopts for the project's own
 *   subtree (its shell provider is bound to one workspace and commands name subdirectories of it).
 * - **parked selection**: a selection parked by reality (stopped/missing) is re-derived through
 *   `resolveTargetRepair`, which adopts only a RUNNING candidate so `stop` stays authoritative.
 *
 * Nothing here starts a container, and nothing picks among ambiguous candidates by Docker's result
 * order: `selectionFor` reports `selected-ambiguous`, and the caller's remedy is an explicit id.
 */
export interface TargetAdoptionContext {
  /** The workspace the command is for (host path). */
  readonly requestWorkspace: string;
  /** Current selection; `none` means nothing has been chosen yet. */
  readonly snapshot: TargetStoreSnapshot;
  /** Discovered projects + their containers. */
  readonly entries: readonly RegistryEntry[];
  /** How the request must relate to the project: exactly, or anywhere inside it. Default `exact`. */
  readonly scope?: "exact" | "at-or-under";
}

export function resolveTargetAdoption(context: TargetAdoptionContext): TargetSelection | undefined {
  const { snapshot, entries, requestWorkspace } = context;
  if (snapshot.status === "selected-stopped" || snapshot.status === "selected-missing") {
    return resolveTargetRepair({ snapshot, requestWorkspace, entries });
  }
  if (snapshot.status !== "none") return undefined;

  const requested = canonicalWorkspaceKey(requestWorkspace);
  const inside = (entryKey: string): boolean =>
    context.scope === "at-or-under" ? isAtOrUnder(requested, entryKey) : isSamePath(entryKey, requested);
  const matches = entries.filter((entry) => inside(canonicalWorkspaceKey(entry.workspacePath)));
  if (matches.length === 0) return undefined;

  // Deepest project wins when a nested workspace is also discovered; `reduce` keeps discovery order
  // irrelevant for ties (equal depth cannot happen for `exact`, and for nested ones the deeper wins).
  const match = matches.reduce((deepest, entry) =>
    canonicalWorkspaceKey(entry.workspacePath).length > canonicalWorkspaceKey(deepest.workspacePath).length
      ? entry
      : deepest,
  );
  return selectionFor(match, match.ambiguous ? undefined : primaryCandidate(match)?.id);
}
