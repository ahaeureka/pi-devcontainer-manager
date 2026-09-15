# Design — arch-review-p3-selection-integrity

`task: arch-review-p3-selection-integrity` · `role: designer` · `phase: plan`
`branch: feature/arch-review-p3-selection-integrity` · `base: main@b13bb6c`
`profile: git_flow / tdd / security`
`source: .rpiv/artifacts/architecture-reviews/2026-09-15_08-46-53_pi-devcontainer-manager.md` (§ Phase 3)
`matrix: .rpiv/artifacts/architecture-reviews/2026-09-15_08-46-53_pi-devcontainer-manager-phase3-requirements.json`

Owner-facing messages stay Chinese per the Kata skill; this artifact keeps the technical contract in
English so it can be read alongside the code.

## 1. Problem

Phase 3 of the review holds the eight findings whose shared property is that **the session's
selection is not one contract**: what was selected (including *not* selecting) does not survive
restore intact, and reconciliation trusts identities that are allowed to go stale.

| # | Finding | Severity | Blast radius | What breaks today |
|---|---|---|---|---|
| 1 | `L0-02` JSONC parsing is not string-safe | High | internal | A `//` inside a string value truncates the document, the mapping becomes `undefined`, and the host container-path guard silently stops evaluating (fail-open) |
| 2 | `L1-02` `/devcontainer off` is not persisted | Med | **on-disk** | `off` clears memory only; the append-only record still restores the target, so the opt-out dies at `/reload` |
| 3 | `L1-03` restored candidate identity is unvalidated | High | internal | A persisted container ID is trusted without checking it against the fresh registry, so a rebuilt container's old ID is reselected |
| 4 | `L1-04` selected configuration is dropped by persistence | High | **on-disk** | A named config survives in memory but the record has no `configPath`, and per-turn context/guard reads the registry primary instead of the selected one |
| 5 | `L1-05` container-only mounts are never populated | Med | cross-module | The execution-context vocabulary and renderer advertise container-only mounts; the sole composition site never supplies them |
| 6 | `L1-06` surfaces engage regardless of the command outcome | High | cross-module | `/devcontainer use` engages the container tools and replaces `bash` even when it found nothing or the operator cancelled |
| 7 | `L2-01` `up` reconciles against a pre-`up` registry | High | cross-module | A successful start does not refresh the registry, so selection stays `selected-missing` and the execution surface is unusable |
| 8 | `L3-05` auto-selection can clobber an explicit selection | Med | internal | The emptiness test and the auto-select write are separated by an `await`; a `/devcontainer use` committed in that window is overwritten |

## 2. Scope

These eight findings plus their documentation residue and the acceptance matrix. Phases 4 and 5 are
out of scope. The four open notes from Phase 2 are out of scope except where a slice touches the
same file (the dispatch seams and the `acceptanceMatrix` field are addressed by §5 slice 8).

## 3. Technical design

### 3.1 `L0-02` — one string-safe JSONC reader

Today `readWorkspaceMapping` (`extensions/index.ts:462`) preprocesses with three regex passes, the
second of which (`(^|[^:"'\\])\/\/.*$`) decides that a `//` whose preceding character is not
`:`/`"`/`'`/`\` starts a comment. For `"postCreateCommand": "bash // install"` or
`"remoteEnv": { "URL": "https://example.com//x" }` that eats the rest of the line, `JSON.parse`
throws, the function returns `undefined`, and the caller's guard
(`findContainerPath(argv, guardMapping.containerPath)`) simply does not run — the exact fail-open
shape this phase is about.

**Change — new module `src/jsonc.ts` (pure, dependency-free):**

```ts
/** Parse a DevContainer config that may contain comments and trailing commas. */
export function parseJsonc(text: string): unknown;
/** The scanner behind it, exported for focused tests. */
export function stripJsonc(text: string): string;
```

A single left-to-right scan tracks string state (`"` … `"` with `\` escapes) so comment markers
inside strings stay literal, removes `//` and `/* */` comments outside strings, and drops a comma
that is followed only by whitespace and `}`/`]`. `readWorkspaceMapping` becomes
`parseJsonc(raw)` (keeping the "absent/unreadable/invalid → `undefined`" contract).

**Guard visibility (included, because otherwise the failure stays silent):** when a workspace has a
config that cannot be parsed, the composition feeds one line into the existing discovery diagnostic
sink (`runtime.discoveryDiagnostics`) — the mechanism Phase 2 built — so the operator learns the
host container-path guard is inactive for that workspace instead of trusting a guard that is not
running. This directly supports AC-1's second half ("the guard still evaluates") by making the
opposite state visible.

### 3.2 `L1-02` + `L1-04` — one record-format change (the phase's on-disk risk)

Both findings change the persisted selection record, so they are designed together; splitting them
would version-bump twice.

**Record (new payload version 2, `src/selection-state.ts`):**

```ts
export const SELECTION_PAYLOAD_VERSION = 2;

export interface SelectionRecordV2 {
  readonly version: 2;
  /** `cleared` is the opt-out tombstone; `selected` carries an intent. */
  readonly state: "selected" | "cleared";
  /** Absent on a tombstone: nothing is selected. */
  readonly workspaceKey?: string;
  readonly displayName?: string;
  /** Candidate discriminator (name preferred, else ID prefix) — a hint, never trusted blindly. */
  readonly candidateId?: string;
  /** The configuration the operator selected, validated against discovery at write time. */
  readonly configPath?: string;
  readonly selectedAt: string;
}

export type SelectionIntent =
  | { readonly kind: "selected"; readonly record: SelectionRecordV2 }
  | { readonly kind: "cleared"; readonly record: SelectionRecordV2 };

/** Latest intent from append-only entries; a v1 record reads as `selected` (unchanged behaviour). */
export function recoverSelectionIntent(entries): SelectionIntent | undefined;
```

`recoverSelectionIntent` keeps today's "last parseable entry wins" rule, now across both versions:
v1 records normalise into `{state: "selected"}` with no `configPath`. `recoverLatestSelection` stays
as a thin wrapper so existing callers/tests keep working.

**Writers:**

- `applySelection` (`src/commands.ts:141`) persists `state: "selected"` plus `configPath` when the
  snapshot carries one.
- `reconcileSelection` (`:206`) validates and persists the same way; a restored `configPath` is
  accepted **only** if `resolveConfigCandidate(entry, path)` still finds it, so a renamed or removed
  configuration silently drops back to the discovered primary (today's behaviour) instead of handing
  the CLI a path it cannot resolve.
- `/devcontainer off` (`:324`) appends a `cleared` tombstone in addition to `targetStore.clear()`.

**Readers:**

- The session-start restore path (`extensions/index.ts` `restoreSelection`) consumes the intent: on
  `cleared` it does not reconcile anything, and it records the opt-out so the selection-derived
  activation evidence stays empty — the same shape as "no prior selection". `activation: "always"`
  still engages (the operator's config outranks session evidence) and a later `/devcontainer
  use`/`up` supersedes the tombstone by being the later entry.
- The per-turn execution context and the host container-path guard read
  `targetStore.snapshot().configPath` **first** and fall back to `entry.configPath`, which is what
  makes L1-04's "drives mapping, prompt context and host-path protection" true.

**Compatibility (the risk flag):** a v1 reader (an older runtime) ignores a v2 payload and therefore
restores the *older* `selected` record — i.e. exactly today's behaviour, which is why the mutation
"degrades to the current behaviour" as required. No migration and no rewrite of existing session
logs; a session written before this change restores unchanged.

### 3.3 `L1-03` — validate a restored candidate identity before trusting it

Today `reconcileSelection` computes
`usableId = hint.candidateId !== undefined && entry.ambiguous !== true ? hint.candidateId : undefined`
and hands it to `selectionFor`, which uses it as the candidate id **and** its display name — with no
membership test, even though the record's own comment calls container IDs ephemeral.

**Change:** accept the persisted id only when the entry still offers it:

```ts
const persisted = hint.candidateId;
const known = persisted !== undefined && (entry.containerCandidates ?? []).some((c) => c.id === persisted);
const usableId = known && entry.ambiguous !== true ? persisted : undefined;
```

An unknown id falls through to the workspace-level resolution that already exists (single running
candidate → that one; ambiguous → `selected-ambiguous`; config-only → `selected-stopped`), and the
record written afterwards carries the *resolved* id, never the stale one. `selectionFor` also stops
inventing a display name from an unvalidated id: when the id is not in the entry's candidate list
its name falls back to the workspace key.

### 3.4 `L1-05` — populate container-only mount facts

`containerOnlyMounts` is declared in `ExecutionContextFacts` and rendered
(`src/execution-context.ts`), but the only composition site passes `candidateId`, `status` and
`mapping` and nothing else.

**Change — extend `src/path-mapper.ts`** with a pure helper beside `buildPathMapping`:

```ts
/** Absolute container paths mounted into the container that the workspace mapping does not cover. */
export function containerOnlyMounts(
  configDir: string,
  config: { readonly mounts?: readonly string[]; readonly workspaceMount?: string },
  mapping: PathMapping | undefined,
): readonly string[] | undefined;
```

It parses each `mounts` entry with the existing `parseWorkspaceMount`, expands
`${localWorkspaceFolder}`, keeps absolute targets that are not the mapping's `containerPath`, and
returns them deduplicated (undefined when there are none). The runtime composes the mapping and the
mount list from the same `parseJsonc` result, so the prompt cannot advertise mounts it did not read.

### 3.5 `L1-06` — engage only on a successful target establishment

`/devcontainer use` returns text in every case — a selection, `[no-candidate]`, `[ambiguous-candidate]`,
or `Selection cancelled.` — while the dispatcher engages on the verb alone:

```ts
if (verb === "use" || verb === "up") engageDevcontainerSurfaces(pi, rt!, () => runtime);
```

**Change:** `CommandResult` gains a typed outcome:

```ts
export interface CommandResult {
  readonly text: string;
  /** Present only when the command established a usable target. */
  readonly target?: { readonly workspaceKey: string; readonly candidateId?: string };
}
```

`applySelection` returns that metadata for the handlers to forward; the failure and cancellation
paths omit it. The dispatcher engages only when `result.target !== undefined` **and** the store
snapshot is not `none`/`selected-missing` (defence in depth: the store is the authority on what a
subsequent `bind()` would do). A command that fails or is cancelled therefore leaves the session's
surfaces exactly as they were — the behaviour AC-6 asks for.

### 3.6 `L2-01` — reconcile `up` against a refreshed registry

`handlers["up"]` resolves its target from the registry *before* starting, then reconciles with those
same entries:

```ts
const target = await resolveUpBuildTarget(args, ctx);          // pre-up entries
const selection = await reconcileSelection(services, ctx, { workspaceKey: workspace }, target.entries);
```

**Change:** after a successful `services.execution.up(...)`, call `services.refreshRegistry()` and
reconcile against the refreshed entries (they now contain the container that was just created or
started). A failed `up` does not refresh. `build` keeps using the pre-build entries — it produces an
image and has no container to discover.

### 3.7 `L3-05` — an atomic `selectIfNone` in the store's queue

`TargetStore` serialises every mutation through `enqueue`, but the service's auto-select path reads
the snapshot, `await`s the hook, and lets the hook write — so an explicit selection committed in
that window is overwritten by the later-enqueued auto-select.

**Change:**

```ts
/** Commit `target` only if nothing is selected; returns whether it committed. */
public selectIfNone(target: TargetSelection): Promise<boolean>;
```

The emptiness test moves inside `enqueue`, so the check and the write are one queued operation. The
auto-select hook (`applySelection` with an `ifNone` mode) uses it, and when it loses the race it
neither selects nor persists anything. `ExecutionService`'s existing snapshot fast-path stays as a
cheap pre-check — it is no longer load-bearing.

## 4. Acceptance matrix

| AC | Implementation | Tests | Evidence |
|---|---|---|---|
| AC-1 (`L0-02`) | `src/jsonc.ts` (new), `readWorkspaceMapping`, diagnostic wiring | `tests/unit/jsonc.test.ts` (new): comments, URLs, `//` inside strings, escaped quotes, trailing commas, invalid input; `tests/unit/path-mapper.test.ts` guard case | `npm run test:unit` |
| AC-2 + AC-4 (`L1-02`, `L1-04`) | `src/selection-state.ts`, `src/commands.ts`, `extensions/index.ts` | `tests/unit/selection-state.test.ts` (v1 read, v2 selected/cleared, latest-wins), `tests/unit/commands.test.ts` (off tombstone, persisted configPath, stale config dropped) | `npm run test:unit` |
| AC-3 (`L1-03`) | `src/commands.ts` `reconcileSelection` | `tests/unit/commands.test.ts`: rebuilt id → resolved id, replaced+ambiguous → ambiguous, gone+config-only → stopped | `npm run test:unit` |
| AC-5 (`L1-05`) | `src/path-mapper.ts`, `extensions/index.ts` | `tests/unit/path-mapper.test.ts` (extra mounts, workspace target excluded, expansion, malformed skipped), `tests/unit/execution-context.test.ts` (rendered when supplied) | `npm run test:unit` |
| AC-6 (`L1-06`) | `src/commands.ts` (`CommandResult.target`), `extensions/index.ts` dispatch | `tests/unit/commands.test.ts`: success carries `target`, no-candidate/ambiguous/cancelled omit it | `npm run test:unit` |
| AC-7 (`L2-01`) | `src/commands.ts` `up` handler | `tests/unit/commands.test.ts`: refresh called once after success and reconcile uses the refreshed entries; failed `up` does not refresh | `npm run test:unit` |
| AC-8 (`L3-05`) | `src/target-store.ts`, `src/commands.ts`, `src/execution-service.ts` | `tests/unit/target-store.test.ts` (`selectIfNone` losing/winning), `tests/unit/execution-service.test.ts` (explicit selection during auto-select survives) | `npm run test:unit` |
| AC-9 (no regression) | `dist/`, `CHANGELOG.md`, docs, `task.json` `acceptanceMatrix` | full suite | `npm run typecheck`, `npm run test:unit`, `node scripts/verify-package.mjs --unit-tests`, `git diff --exit-code -- dist`, `node scripts/smoke-pi-package.mjs --no-model`, `npm run install:local -- --check` |

## 5. Build order (TDD, eight slices)

1. **JSONC reader** (`L0-02`) — `src/jsonc.ts`, wire `readWorkspaceMapping`, diagnostic on unparsable configs.
2. **Atomic auto-select** (`L3-05`) — `selectIfNone` + hook/store/service wiring.
3. **Restored identity validation** (`L1-03`) — membership check + display-name fallback.
4. **Record v2: opt-out and selected config** (`L1-02` + `L1-04`) — one version bump, writers, readers, restore/activation wiring, snapshot-driven mapping.
5. **Engagement gate** (`L1-06`) — `CommandResult.target` + dispatcher check.
6. **Refresh after `up`** (`L2-01`) — refresh then reconcile, failure path unchanged.
7. **Container-only mounts** (`L1-05`) — helper + composition.
8. **Release hygiene** — `CHANGELOG.md`, README/docs for the persisted opt-out, `acceptanceMatrix` written into `task.json` (the Phase 2 note: `missingAcceptanceMatrix` must not stay true), `npm run build`, full gate set.

Dependencies from the review are respected: `L1-03` precedes `L1-04`/`L1-06`/`L2-01`, and `L0-02`
precedes `L1-05`. Each slice ends green (`npm run typecheck` + `npm run test:unit`) before the next.

## 6. Out of scope

- Phase 4 and Phase 5 findings (`L3-07`, `L3-09`, `L4-04`, `L5-01`, `L0-04`, `L2-04`, `L5-03`).
- The two Phase 2 dispatch seams that no unit test can reach (unchanged limitation, recorded again).
- The rejected (`L1-01`, `L3-08`) and withdrawn (`L3-10`) findings.

## 7. Risks, invariants and notes

- **On-disk compatibility (the phase's stated risk):** v2 records must degrade to today's behaviour
  when read by an older runtime, and existing session logs must restore without migration. Both are
  designed for explicitly (§3.2) and tested with a v1-only entry list.
- **Phase-3 invariants from the review that a slice could break:**
  - *Targets are never auto-started* — the opt-out and the `up` refresh change selection, never
    container lifecycle. `up` remains the only start path and it is always explicit.
  - *Fail closed* — `selected-missing`/`selected-ambiguous`/`selected-stopped` keep their typed
    refusals; engagement now happens *less* often, never more.
  - *Host and container path vocabularies stay distinct* — the config-driven mapping only changes
    what is presented to the agent; the CLI always receives host paths.
  - *Discovery stays lazy, read-only and bounded* — `L2-01` adds one more refresh **after** an
    explicit `up`, which is on the operator's command path, not on startup or per turn.
  - *The audit and policy surfaces are untouched* — no new audit fields, no policy relaxation, no
    change to `stop`/`remove`'s two gates.
- **Behaviour change worth flagging to the reviewer:** `/devcontainer use` that fails or is
  cancelled no longer takes over `bash`. That is the point of `L1-06`, but it is operator-visible, so
  it belongs in the CHANGELOG and in the review evidence rather than being discovered later.
- **`acceptanceMatrix`:** Phase 1 and Phase 2 both left `task.json`'s structured matrix empty and
  `verify` reported `missingAcceptanceMatrix: true` both times. Slice 8 writes the matrix (the rows
  in §4) into the task store so the next verify reports it, and so the judge reads the same mapping
  the design states.
