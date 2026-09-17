---
source_path: .kata/tasks/arch-review-p4-vocabulary-identity/wiki/arch-review-p4-vocabulary-identity.md
ingested: 2026-09-17T07:24:57.415Z
sha256: 728d3ae5556149b655add7a2c06576528acd16a5f5f13ae0e7136e75559b6da2
---
# Vocabulary and identity shapes (Phase 4 build notes)

Captured while implementing `arch-review-p4-vocabulary-identity`. The phase's four findings were one
disease at four layers: a value that used to be simple is represented in more than one place, so
consumers reconstruct state and the copies disagree. The durable output is the shape rules that
removed the copies, plus the two conversion mechanics that made the widest change in the review
survivable.

## 1. A sentinel is a claim nobody enforces

`RegistryEntry` required `configPath: ""` to mean "no configuration exists", carried a placeholder
`configKind` purely to satisfy that requirement, and exposed `containerId` alongside
`containerCandidates` — two fields that could disagree about which container the workspace's target
was. The doc comment even named a different field "the authoritative discriminator", which is the
tell: when a shape has to tell you which of its fields to believe, the shape is wrong.

The union fixed all three at once:

```ts
export type RegistryEntry = RegistryConfigEntry | RegistryContainerOnlyEntry;   // kind: "config" | "container-only"
```

Rules worth reusing:

- **A state that cannot be represented is better than a state you have to check for.** "No
  configuration" is a variant, not an empty string, so there is nothing to forget to check.
- **One collection per identity, with the collection's order carrying the meaning.** Candidate
  identity lives only in `containerCandidates` (ordered by preference), so no second field can
  disagree with it. If you need "the primary", document that the first element is it and expose an
  accessor (`primaryCandidate`) instead of duplicating the value.
- **Give consumers accessors, not fields.** `configCandidatesOf` / `primaryConfigOf` / `configPathOf`
  answer the two questions the sentinels used to encode, so a future variant cannot reintroduce
  hand-rolled checks. A container-only entry answering `[]`/`undefined` is the whole contract.
- **A boolean beats an optional boolean for a flag.** `ambiguous?: boolean` became `ambiguous: boolean`;
  "not ambiguous" is now stated instead of implied by absence, and two tests that asserted
  `undefined` changed meaning rather than shape — call that out in the test comment when it happens.

## 2. Converting a widely-consumed type: let the compiler drive, and land it whole

The review's risk flag said not to split this conversion, and the mechanics that made that affordable:

1. **Change the type first and read the error list as the work list.** `typecheck` produced 35 errors,
   every one a place that reconstructed state by hand — which is the finding, enumerated by the
   compiler rather than by grep.
2. **Convert the producer next**, then the consumers by file, re-running `typecheck` after each.
3. **Add a test fixture factory per variant BEFORE touching the tests**
   (`tests/unit/fixtures/registry-entry.ts`). Otherwise every test edit is a literal with eight fields,
   and the next field addition repeats the whole exercise.
4. **Expect tests that fail for a *semantic* reason and read them as information.** Four of them did:
   a fixture that relied on the deleted `containerId`, a `ui.select` label that changed with the shape
   of the state, and two assertions that meant "field absent". Each was a real statement about the old
   shape that had to be re-made deliberately.
5. **The gate runs the WHOLE suite.** `npm run test:unit` was green while `vitest run` (what the seal
   executes) failed on `tests/integration`: one test read `entry.configKind`, another passed a
   made-up container id to reach the confirmation gate. Run the full suite before sealing, and read
   the seal's evidence files rather than guessing which check failed.

## 3. Adding a refusal has an order, and the order is part of the contract

`logs`/`stop`/`remove` now bind the container identity before anything else, which moved where a
caller-supplied id is rejected relative to the adapter's confirmation gate. Both are pre-Docker
refusals, so either order is safe — but the choice is observable: a probe that used to reach
"confirmation-required" now gets the identity refusal first. When a phase adds a gate, state where it
sits in the existing order (the design listed the refusal before the adapter call for exactly this
reason) and expect the integration suite to notice.

## 4. One owner for containment

Three implementations of "is this path inside that root?" disagreed in three ways: the fallback for a
path that does not exist, a win32 case fold present in only one, and a lexical prefix check that
called `/repo/application` "inside" `/repo/app`. Consolidating into one realpath-aware function made
containment *tighter* in one place (the sibling prefix) and *more correct* in another (a symlinked
spelling of the bound workspace is now the same workspace rather than "outside"), and the tests state
both — including the deliberate distinction between the LEXICAL key used for registry identity and CLI
argv and the REALPATH question used for containment.

## 5. What the review cycle added: an over-refusal is a regression

The independent pass blocked this phase twice-kind-of: once for a defect the change *introduced*
(AC-6 falsified) and once for a toolchain change it uncovered. Both are worth keeping.

**Adding a gate is adding a failure mode.** `logs`/`stop`/`remove` gained an identity check, and the
check routed through `TargetStore.bind()` — which refuses a STOPPED target. The three operations whose
entire purpose is an exited container therefore started failing, after working on `main`. The rule:
for every new refusal, ask **what legitimate case does this also refuse?** — and write the test for
that case first (logging and removing a stopped target), not only for the case the gate was designed
for (a mismatched id). The reviewer's mechanical hint is the general form: when a phase adds a gate,
check the *inverse* of its stated contract, because the contract is usually written about the threat,
not about the workflows it must keep working.

**A double must be able to express the real state machine.** Every test of the new check ran against a
fake store whose `bind()` always succeeded and whose `snapshot()` reported no candidate — so the fake
could not represent *any* of the states the check depends on, and the over-refusal was invisible. When
a test double is simpler than the thing it replaces, the difference is where the bugs live. The repair
added four tests against the real `TargetStore`; that, not the fake, is what pins the behaviour.

## 6. The toolchain can move under you mid-task (kata CLI schemas)

Mid-phase, `verify` and `judge` both reported `missing_test_evidence` for every criterion while
`verify` had passed minutes earlier — and `kata-cli status` showed six "unresolved repair obligations"
that the first failing judge run had *itself* written, which then blocked every later gate. The cause
was none of that: the kata CLI bundle had been rebuilt (its mtime moved), and the new bundle's JSON
schemas rejected the artifacts the *previous* bundle had produced:

| Change | Symptom |
|---|---|
| `requirements[].id` must match `^REQ-[0-9]+$` (was `AC-N`) | `build --seal` fails with a task-schema error |
| evidence `kind` enum lost `integration`/`entrypoint` (the task matrix still allows them) | the envelope the seal writes is invalid |
| evidence `name` now requires `^[A-Za-z0-9_.-]+$` while the seal writes `${acceptanceId}-${kind}-${command}` | **one** invalid envelope makes `readRecordedEvidence` throw for the whole directory, so every gate sees ZERO evidence |
| review finding severity is `blocking|major|minor|nit` (was `…|note`) | `archive` refuses: "does not match its schema" |

How to diagnose and repair:

1. **Check the bundle's mtime first** (`ls -la <kata>/dist/cli.js`); a gate that suddenly contradicts
   an earlier gate is usually a schema move, not a code change.
2. **Validate the task's artifacts against the CURRENT schema** by hand (the schemas are embedded in
   the bundle as `kata-asset:/app/kata/schemas/*.json`): list `.kata/evidence/<task>-*.json`, check
   each envelope's required fields, its `kind` enum membership and its `name` pattern.
3. **Repair mechanically, keeping facts identical:** relabel `name` (spaces/slashes → `-`), re-declare
   a matrix row's evidence as `kind: "test"` when it was `integration`, rename requirement ids, rename
   `note` severities to `nit`. Then re-seal so the envelopes are regenerated under the new schemas.
4. **Beware the obligation loop:** a failing judge persists blocking obligations per criterion, which
   then make `verify` fail with `unresolved_repair_obligation`; only a successful `build --seal`
   resolves them (it resolves obligations whose AC ids and matrix evidence now pass). Do not read that
   second failure as a second defect.
