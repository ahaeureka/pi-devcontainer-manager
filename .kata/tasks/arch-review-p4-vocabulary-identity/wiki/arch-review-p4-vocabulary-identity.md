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
