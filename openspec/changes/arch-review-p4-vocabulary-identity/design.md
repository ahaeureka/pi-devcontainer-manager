# Design — arch-review-p4-vocabulary-identity

`task: arch-review-p4-vocabulary-identity` · `role: designer` · `phase: plan`
`branch: feature/arch-review-p4-vocabulary-identity` · `base: main@d39656e`
`profile: git_flow / tdd / security`
`source: .rpiv/artifacts/architecture-reviews/2026-09-15_08-46-53_pi-devcontainer-manager.md` (§ Phase 4)
`matrix: .rpiv/artifacts/architecture-reviews/2026-09-15_08-46-53_pi-devcontainer-manager-phase4-requirements.json`

Owner-facing messages stay Chinese per the Kata skill; this artifact keeps the technical contract in
English so it can be read alongside the code.

## 1. Problem

Phase 4 is the review's "give identity one owner and one shape" phase. Its four findings are all the
same disease at different layers — a value that used to be simple is represented in more than one
place, so consumers have to reconstruct state and the copies can disagree.

| # | Finding | Severity | Blast radius | What breaks today |
|---|---|---|---|---|
| 1 | `L5-01` containment has three owners | Med | cross-module | `policy.ts:54` resolves `realpath` and compares with `relative`, `workspace-path.ts:24` compares canonicalized string prefixes, and `execution-service.ts:163` compares keys inline — with *different* fallbacks for a path that does not exist (and a win32 case fold in only one of them), so a symlinked or case-differing workspace can pass one check and fail another |
| 2 | `L3-09` the status→error mapping is a repeated chain | Low | internal | `TargetStore.bind()` builds the same `RuntimeError` seven times and ends with a branch that cannot be reached, so a newly added `SelectionStatus` produces no compiler signal — it falls through to `unexpected` |
| 3 | `L4-04` registry state is encoded in field combinations | Med | cross-module | `RegistryEntry` requires `configPath: ""` as a sentinel, carries four optional fields, and names `discoveredFrom` "the authoritative discriminator" precisely because the shape is not self-describing; the primary `containerId` may disagree with `containerCandidates` |
| 4 | `L3-07` container identity is caller-supplied on three of four operations | Med | cross-module | `exec` re-resolves the target, refuses a mismatched workspace and always sends the bound workspace; `logs`/`stop`/`remove` trust `request.containerId`, never call `bind()`, and record that caller value as the audit `targetId` |

## 2. Scope

These four findings and the consumers they touch. Phase 5 (`L0-04`, `L2-04`, `L5-03`) is out of scope.

The review's risk flag governs the ordering: **`L4-04` must not be split mid-conversion**, so the new
shape and every consumer of it land in one slice. The two foundation findings are independent and land
first, because they shrink the surface the conversion has to touch.

## 3. Technical design

### 3.1 One owner for workspace identity and containment (`L5-01`, `AC-5`)

`src/workspace-path.ts` becomes the only module that answers "are these two paths the same workspace?"
and "is this path inside that root?":

```ts
/** Canonical comparison key for a workspace path (realpath when it resolves, else resolved). */
export function canonicalWorkspaceKey(path: string, platform?: NodeJS.Platform): string;

/** True when `candidate` is `root` or lies beneath it, comparing canonical identities. */
export function isWithinWorkspace(root: string, candidate: string, platform?: NodeJS.Platform): boolean;
```

- `canonicalWorkspaceKey` keeps today's behaviour (realpath-aware, case-folded on win32) — it is what
  the registry, the store and the CLI argv already agree on, so making it the single answer is a
  consolidation rather than a change.
- `isWithinWorkspace` replaces `isPathBelow`'s lexical prefix logic and `policy.ts`'s
  `relative`-based check: it canonicalizes both sides through `canonicalWorkspaceKey` and compares
  segment-wise, so a prefix that is not a path boundary (`/repo/app` vs `/repo/application`) is
  rejected without relying on string prefixes.
- The one genuinely divergent behaviour — a path that does not exist — is pinned by a test and
  documented in the function: canonicalization falls back to the resolved path, so a workspace that
  has not been created yet is compared lexically, and `realpath` is only trusted when it resolves.
- `policy.isWorkspaceAllowed`, `workspace-path.isPathBelow` (deleted) and `execution-service`'s inline
  comparison in `exec` all call `isWithinWorkspace`.
- Tests: symlinked root and workspace (resolve to the same canonical key), a sibling-prefix pair
  (`/repo/app` vs `/repo/application`), a non-existent path, a trailing slash, and a case-differing
  pair with `platform: "win32"` (folded) vs `"linux"` (not).

### 3.2 An exhaustive status→error dispatch (`L3-09`, `AC-4`)

`TargetStore.bind()` keeps its observable behaviour exactly (same kinds, same messages, same remedies)
and stops repeating the construction:

```ts
/** The typed refusal for a selection that cannot be bound, or undefined when it can. */
function refusalFor(selection: TargetSelection): RuntimeError | undefined {
  switch (selection.status) {
    case "none":        return new RuntimeError({ kind: "no-candidate", ... });
    case "refreshing":  return new RuntimeError({ kind: "target-refreshing", ... });
    case "selected-ambiguous": ...
    case "selected-missing":   ...
    case "selected-stopped":   ...
    case "selected-policy-denied": ...
    case "selected-valid":     return undefined;
    default: {
      const unknown: never = selection.status;   // a new status is a compile error
      throw new Error(`Unhandled selection status: ${String(unknown)}`);
    }
  }
}
```

The unreachable "`selected-valid` with no candidate" branch becomes an `unexpected` refusal that is
only reachable if a caller constructs that state by hand — it is kept as a guard but no longer
pretends to be part of the status mapping. Tests keep the existing shape (one case per status) and add
a compile-level note: the `never` guard is the test.

### 3.3 The registry entry states its own state (`L4-04`, `AC-1`, `AC-2`)

```ts
/** One container discovered for a workspace; the FIRST element is the primary. */
export interface RegistryCandidate {
  readonly id: string;
  readonly state: ContainerState;
}

interface RegistryEntryBase {
  readonly workspacePath: string;
  /** Every container discovered, most-preferred first — `containerCandidates[0]` is the target. */
  readonly containerCandidates: readonly RegistryCandidate[];
  /** True when more than one RUNNING container matches, so Docker order must never decide. */
  readonly ambiguous: boolean;
}

/** A configuration was discovered on the host (with or without a labelled container). */
export interface RegistryConfigEntry extends RegistryEntryBase {
  readonly kind: "config";
  readonly discoveredFrom: "host-config" | "both";
  /** EVERY configuration discovered (never collapsed away), highest priority first. */
  readonly configCandidates: readonly ConfigCandidate[];
  /** The configuration discovery selected; always a member of `configCandidates`. */
  readonly primaryConfig: ConfigCandidate;
}

/** No configuration exists: the workspace is known only through a labelled container. */
export interface RegistryContainerOnlyEntry extends RegistryEntryBase {
  readonly kind: "container-only";
  readonly discoveredFrom: "docker-label";
}

export type RegistryEntry = RegistryConfigEntry | RegistryContainerOnlyEntry;
```

Three sentinels disappear: `configPath: ""` (no configuration ⇒ a different variant, so there is no
path to invent), `configKind`'s placeholder (`"container-only"` needs none) *and* the
`containerId`/`containerCandidates` pair that could disagree — identity now lives in exactly one
collection whose order IS the priority, documented on the field and pinned by a test.

Two helpers replace the sentinel checks so no consumer hand-rolls one:

```ts
/** The primary container candidate, or undefined when none was discovered. */
export function primaryCandidate(entry: RegistryEntry): RegistryCandidate | undefined;

/** The workspace's configurations (`[]` for a container-only entry). */
export function configCandidatesOf(entry: RegistryEntry): readonly ConfigCandidate[];
```

**Consumer conversion (the slice lands whole):**

| Consumer | Today | After |
|---|---|---|
| `src/runtime/host-discovery.ts` (producer) | builds `configPath: ""`/placeholder `configKind` for docker-only entries, spreads `containerId`/`containerState` | builds the two variants; the docker-only branch emits `kind: "container-only"`, the merged branch promotes its first candidate to `configCandidates[0]` ordering |
| `src/commands.ts` | `entry.configPath.length === 0`, `entry.containerId`, `entry.containerState`, `entry.configKind`, `entry.ambiguous`, `candidatesOf(entry)` reconstructing from `configPath` | `entry.kind`, `primaryCandidate(entry)`, `configCandidatesOf(entry)`, `entry.primaryConfig` (narrowed), `entry.ambiguous` (now always present) |
| `src/execution-service.ts` | reads the entry's config/candidate fields for `up`/`build`/`exec` | same reads through the helpers |
| `extensions/index.ts` | `entry.configPath.length > 0 ? readWorkspaceConfig(...) : undefined`, `effectiveConfigPath(entry.workspacePath, entry.configPath)` | narrow on `kind`, use `entry.primaryConfig.configPath` |
| prompt/selection rendering | `entry.containerState ?? "config-only"` | `primaryCandidate(entry)?.state ?? "config-only"` |
| tests | build entries with the sentinel shape | build them through a small factory per variant (`tests/unit/fixtures/registry-entry.ts`) so a future field addition is one edit, and assert the discriminant where the behaviour depends on it |

### 3.4 Container identity is bound, not accepted (`L3-07`, `AC-3`)

`exec` already enforces the discipline the review wants everywhere: re-resolve the target, refuse a
request whose workspace differs from the bound target, and send the bound workspace to the adapter.
`logs`, `stop` and `remove` become the same:

```ts
/** Resolve the container a lifecycle/logs request may act on, or refuse before Docker runs. */
private bindContainer(request: { containerId: string; workspace?: string }): ExecutionContext {
  const context = this.options.targetStore.bind();          // throws the typed refusal
  const known = this.options.targetStore.candidatesFor(context);   // the bound target's candidates
  if (!known.some((candidate) => candidate.id === request.containerId)) {
    throw new RuntimeError({
      kind: "policy-denied",
      message: `Container ${request.containerId} is not the bound target (${context.candidateName}).`,
      remedy: "Re-select the target with /devcontainer use before operating on it.",
    });
  }
  return context;
}
```

- The registry is the source of the candidate list: `reconcileSelection`/the store already resolve
  them, so the service verifies against what the *selection* was bound to, not against a fresh Docker
  read (that would add a scan per operation and could disagree with the binding).
- The audit `targetId` is taken from the bound context (`context.candidateId`), never from the
  request, so the trail cannot record an identity the service did not authorize.
- `stop`/`remove` keep both gates: the policy grant and the fresh per-action confirmation are
  untouched; the new check is an *additional* refusal before the adapter call.
- A container id that IS the bound target passes unchanged, so the operator-facing commands keep
  working exactly as before (`/devcontainer logs` resolves the target, then verifies it).
- Tests: a request naming the bound container proceeds; one naming a *sibling* container of the same
  workspace is refused before the adapter is called and writes no audit record with that id; one
  naming an unknown container is refused; and the stop/remove confirmation gate still refuses without
  a fresh token.

### 3.5 Slices

1. **Foundations** — `L5-01` (`isWithinWorkspace` + `canonicalWorkspaceKey` as the single owner,
   callers converted) and `L3-09` (exhaustive switch with the `never` guard). Independent of the
   union, and they shrink the conversion surface.
2. **The registry union, landed whole** — `L4-04`: `src/types.ts`, the producer in
   `src/runtime/host-discovery.ts`, the consumer conversion table above, and the test fixture
   factory. This is the phase's widest slice; it ends green as a unit.
3. **Bound container identity** — `L3-07`: `bindContainer` in `src/execution-service.ts` for
   `logs`/`stop`/`remove`, the audit id from the binding, tests for the accepted and refused cases.
4. **Hygiene** — docs/CHANGELOG if anything operator-visible changed (the registry shape is internal,
   the refusals are new: the CHANGELOG needs a line only if a *reachable* refusal is new), the
   acceptance matrix in `task.json`, `npm run build` **and commit `dist/`** (the Phase 3 rule), the
   full gate set.

## 4. Acceptance matrix

| AC | Implementation | Tests | Evidence |
|---|---|---|---|
| AC-1 | `src/types.ts`, `src/runtime/host-discovery.ts` | `tests/unit/host-discovery.test.ts` (variant per discovery path, no `""` config path, primary ordering), `tests/unit/registry-entry.test.ts` (new: helpers) | `npm run test:unit`, `npm run typecheck` |
| AC-2 | every consumer in §3.3's table | the existing suites (`commands`, `command-config-selection`, `execution-service`, `host-discovery`, `container-*`) rewritten to the discriminant | `npm run test:unit` |
| AC-3 | `src/execution-service.ts` | `tests/unit/execution-service.test.ts` (bound id accepted, sibling refused pre-adapter, unknown refused, audit id from the binding, confirmation gate intact) | `npm run test:unit` |
| AC-4 | `src/target-store.ts` | `tests/unit/target-store.test.ts` (one case per status keeps its kind/message/remedy) | `npm run test:unit`, `npm run typecheck` |
| AC-5 | `src/workspace-path.ts`, `src/policy.ts`, `src/execution-service.ts`, `src/runtime/host-discovery.ts` | `tests/unit/workspace-path.test.ts` (symlink, sibling prefix, non-existent, trailing slash, win32 case fold), `tests/unit/policy.test.ts`, `tests/unit/execution-routing.test.ts` | `npm run test:unit` |
| AC-6 | `dist`, `task.json` | full suite | `npm run typecheck`, `npm run test:unit`, `node scripts/verify-package.mjs --unit-tests`, `git diff --exit-code -- dist`, `node scripts/smoke-pi-package.mjs --no-model`, `npm run install:local -- --check` |

## 5. Risks, invariants and notes

- **The union conversion is the phase's widest change** and the review says not to split it: slice 2
  converts the type, the producer and every consumer together, ending green, with the test fixture
  factory removing the "edit forty literals" problem for future field changes.
- **Behaviour that must not move:** the CLI still receives the HOST workspace path for
  `up`/`build`/`exec` (constraint 1) and only `exec` presents the container path to the agent; the
  argv contract (constraint 2) is untouched — no slice here changes an argv; discovery stays lazy,
  read-only and bounded (constraint 3) — the union changes the *shape* of its result, not when it
  runs; `stop`/`remove` keep both gates (constraint 4) and this phase only *adds* a refusal; the child
  environment stays composed (constraint 5); host execution stays withheld-able and audited
  (constraint 6); the win32 branches survive (constraint 7) — `L5-01` consolidates the platform
  handling into one place instead of removing it; targets are never auto-started (constraint 8);
  `/devcontainer setup` is untouched (constraint 9); the audit trail keeps its shape and
  `0600`/fingerprint defaults (constraint 10) — the only audit change is that `targetId` now comes
  from the binding for `logs`/`stop`/`remove`.
- **A new typed refusal is operator-visible:** a lifecycle or `logs` request for a container that is
  not the bound target used to be attempted and now fails with `policy-denied` before Docker. That is
  the point of `L3-07`, but it belongs in the CHANGELOG, and the refusal must name the bound target so
  the operator can act on it.
- **`selectionFor`'s display name** still uses the container id (noted in Phase 3's knowledge capture);
  slice 3 touches the same area, so it is worth a look — but it is not an acceptance criterion here
  and will not be widened into one.
- **No consumer outside this repository**: `RegistryEntry` is internal (the package's public surface is
  the extension's tools and commands), so the union is a source-level change with no compatibility
  story to design.
