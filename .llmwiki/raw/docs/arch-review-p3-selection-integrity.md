---
source_path: .kata/tasks/arch-review-p3-selection-integrity/wiki/arch-review-p3-selection-integrity.md
ingested: 2026-09-16T03:30:45.450Z
sha256: ac12dc506d7e6ea5d10707df433186d6f26f819faa7fb1c28e52b0a819c9ecf2
---
# Selection integrity (Phase 3 build notes)

Captured while implementing `arch-review-p3-selection-integrity` (Phase 3 / Selection integrity of the
architecture review). The phase's eight findings all had the same shape — the session's selection was
not one contract — so the durable output is the contract itself plus the migration pattern that made
its on-disk change free.

## 1. The selection contract

One append-only lineage answers "what is selected right now, including *not* selecting":

- **An opt-out is an intent, not an absence.** `/devcontainer off` used to clear memory only, so the
  older record still in the log was restored on the next reload. It now appends a `state: "cleared"`
  tombstone, and the activation decision takes an `optedOut` evidence input that sits *below* an
  explicit `activation: "always"` and *above* the workspace/container evidence — otherwise the
  opt-out is silently undone in exactly the workspaces where it matters.
- **A persisted identity is a hint, never authority.** Container ids are ephemeral across rebuilds
  (the record's own comment said so). A restored id is honoured only while the fresh registry still
  offers it; otherwise the workspace's *current* candidate is resolved. Ambiguous workspaces still
  fail closed — Docker result order never decides.
- **The operator's configuration choice belongs to the selection, not to the registry.** Once a
  configuration is selected it must drive *every* derived view — the exec-path presentation, the
  per-turn prompt mapping and the host container-path guard — or the two disagree and the guard is
  built from a configuration nobody chose.
- **Engagement is a typed outcome.** Replacing `bash` with the container-routed tool is an
  operator-visible state change, so it is driven by "this command established a target" (plus the
  store's own status), never by the verb name: a failed, ambiguous or cancelled `use` leaves the
  session exactly as it was.

## 2. Versioned session entries: how to change the payload for free

The phase changed the persisted selection record (payload v1 → v2). The pattern that made it
migration-free, and the reason to reuse it:

1. **Keep reading every version you have ever written.** v2 readers normalise v1 records into the
   v2 shape (`state: "selected"`, no `configPath`), so old logs restore unchanged.
2. **Let an older reader degrade to its OWN previous behaviour.** A v1 reader ignores a v2 payload
   (unknown version) and therefore restores the older v1 record — precisely what the extension did
   before the change. This is the property the review's risk flag demanded, and it comes for free
   from "ignore unknown versions" + "last parseable entry wins".
3. **Add an intent dimension without a second entry kind.** `state: "selected" | "cleared"` inside
   the same payload keeps one lineage, so "latest wins" stays positional instead of having to merge
   timestamps across two entry kinds.
4. **Keep the old accessor as a wrapper** when existing callers only want one half of the new shape
   (`recoverLatestSelection` still returns a selection, reporting `undefined` for a tombstone).
5. **Test the compatibility, not just the feature:** a v1-only entry list must still yield a usable
   selection.

## 3. A preprocessing heuristic can silently disable a safety check (L0-02)

The config reader stripped comments with a regex that decided `//` starts a comment whenever the
previous character was not `:`/`"`/`'`/`\`. A `//` inside an ordinary string value (`"https://x//y"`,
`"bash // note"`) therefore truncated the document; the config stopped parsing, the derived mapping
disappeared, and the host container-path guard — which only runs when a mapping exists — stopped
evaluating. Nothing reported it, because "no mapping" and "unreadable config" were the same answer.

Two transferable rules:

- **Never parse a structured format with regexes when strings can contain the delimiters.** A single
  left-to-right scanner that tracks string state is ~60 lines and testable; test it with URLs,
  comment markers inside strings, escaped quotes and a trailing comma that has a comment between the
  comma and the bracket.
- **When a derivation that a safety check depends on fails, say so.** `readConfigFacts` returns
  `unparsable` (with the parser's message) separately from `ok`-with-no-mapping, and the caller feeds
  it into the diagnostic sink that Phase 2 built. A silent `undefined` in a fail-closed path is a
  fail-open in practice.

## 4. Check-then-write across an `await` is a race, whatever the store promises

`ExecutionService` read the selection snapshot, awaited auto-discovery, and let the hook write — so an
explicit `/devcontainer use` committed in that window was overwritten. The fix is the general one:
move the emptiness test *inside* the store's serialization queue (`TargetStore.selectIfNone`) and let
the caller's cheap pre-check stay a pre-check. Any "if nothing then set" whose two halves are
separated by an `await` needs the same treatment.

## 5. Phase-specific notes for the next phase

- `RegistryEntry`'s `containerCandidates` carry `{id, state}` only, so a selection's display name is
  still the id. Phase 4's `L4-04`/`L3-09` rewrite those identity shapes; re-check `selectionFor`'s
  naming when it lands.
- The two dispatch seams with no unit harness in this repository (command-result delivery and the
  discovery-drain) are now joined by the engagement gate; all three are policy-tested and
  smoke-covered. A future change to the command dispatch must be smoke-checked.
- `task.json`'s `acceptanceMatrix` is populated for this task (Phase 1 and Phase 2 left it empty and
  `verify` kept reporting `missingAcceptanceMatrix: true`). Do it at design time next phase: the seal
  validates it, and only vitest/pytest-style evidence entries may carry a `testSelector`.

## 6. What the review cycle added (read this before re-deriving an entity)

The independent adversarial pass blocked the first sealed revision and the fix produced two rules
that generalise well beyond this phase:

- **A re-derivation must carry the same inputs as the entity it re-derives, or it silently
  downgrades it.** `reconcileSelection` re-resolves a selection from the registry; when called
  without the configuration (which is exactly how `/devcontainer up` and the `list` repair called
  it), it fell back to the workspace's primary configuration and re-persisted that — reverting the
  operator's choice, and with it the mapping, the prompt context and the host-path guard. Any
  function that "recomputes" something the user chose must either take that choice as an input or
  carry it over from the current state.
- **Test the re-derivation the way production calls it, not only with the happy hint.** The AC-4
  tests all passed a `configPath` into the reconciliation, so they could never see the regression;
  the reviewer found it in one direct call. A parameter that is optional in the signature should
  have a test that omits it.
- **Clearing state is not disabling the machinery that repopulates it.** `/devcontainer off` cleared
  the store, but Pi cannot unregister the container tools, so the next `exec` auto-selected and
  resurrected the target. Pair every "clear" with a guard on the producer (`allowsAutoSelection`)
  when the producer's trigger stays registered.

## 7. Release hygiene lesson: rebuild `dist/` BEFORE sealing

The repair changed `src/` without rebuilding `dist/`. The seal's own quality gate then rebuilt
`dist/` *after* hashing the owned paths, so the revision superseded itself immediately and `verify`
reported `revision_superseded` for every criterion — a full re-seal cycle (and a confusing FAIL that
was not an acceptance failure). Rule: whenever anything under `src/` or `extensions/` changes,
`npm run build`, commit `dist/`, and only then seal.
