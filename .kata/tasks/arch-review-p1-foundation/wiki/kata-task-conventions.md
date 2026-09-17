# Kata task conventions in this repository

Learned by running a full Kata cycle (`arch-review-p1-foundation`) and by archiving the earlier
`activation-and-config-mechanism` task. Follow these when opening or sealing a task here.

## 1. Where the artifacts live

- Design: `openspec/changes/<task-id>/design.md`. The CLI also reads
  `.kata/tasks/<task-id>/design.md`; this repository uses `openspec/`, and the acceptance matrix
  is section 4 of that document.
- Machine-readable acceptance: `requirements.json` next to the design, in the shape
  `{ "requirements": [ { "id", "statement", "source" } ] }` that
  `kata-cli open --requirements-file <path>` consumes.
- Everything under `.kata/**`, `.rpiv/artifacts/**` and `.llmwiki/**` is tracked in git and
  committed to `main` (only `.rpiv/tmp/` is ignored).

## 2. Seed acceptance at open time

`open` is the only command that writes acceptance, and `build --seal` refuses to run outside
`plan`/`implement`/`hardVerify`/`review`/`judge` — so the placeholder `AC-1: "Implement the
change successfully."` can never be corrected after archive. Pass `--requirements-file` and give
every criterion a stable `AC-<n>` id and a verifiable statement.

## 3. Declare owned paths, then extend them at seal

`kata-cli open --owned-path <p>` records the task's ownership; `build --seal --owned-path <p>`
unions more paths in. Declare every path the change touches — this task needed `docs/` (the
error-kind guide) and `openspec/` (the design that authorizes the change) in addition to
`src, extensions, tests, dist, CHANGELOG.md`. Anything left out lands outside the sealed
revision scope (`workspaceDrift`), which is exactly the lesson the archived task recorded.

Note the asymmetry: a handoff packet's `permissions.allowedWrites` is a **role constant**
(implementer → `src/`, `tests/`, `docs/`) that ignores `ownedPaths`. If the two disagree, the
task's `ownedPaths` is the authoritative record — surface the conflict to the owner rather than
writing outside ownership or silently narrowing the task.

## 4. Commit before every handoff acknowledgement

A handoff receipt anchors the repository head; any commit afterwards invalidates it, and the
next workflow command fails with `Workflow mutation requires a current acknowledged handoff
receipt for <role>`. The dependable order at every phase is:

```bash
# finish and COMMIT the work first, then:
kata-cli orient --change <task> --role <role> --platform pi --task-kind <read|implementation|security>
kata-cli handoff verify     --task <task> --id <id>
kata-cli handoff acknowledge --task <task> --id <id> --platform pi --role <role>
kata-cli <phase> --change <task>
```

## 5. Phase → role for `hooks activate`

`intake`/`plan` → `designer`; `implement` → `implementer`; `hardVerify`/`review` → `reviewer`;
`judge` → `judge`; `archive` → `approver`. Activating a role that does not match the current
phase is refused (`Hook role X does not match current phase Y; expected Z`), and the archive
phase wants `approver` even though the work is distillation.

## 6. Gates need both a recorded choice and the CLI's own confirmation signal

- `kata-cli gate approve --task <task> --boundary <implementation_gate|review_gate|judge_gate|archive_gate> --choice <continue_current|switched|delegated>`
  records the owner's decision. The CLI's `--confirm-host-model` flag is derived from which
  boundary the command is at, not typed by hand.
- `kata-cli archive` is a no-op once `current-state.phase === "archive"`: the boundary resolver
  returns `null`, so the command always answers "Archive requires explicit user confirmation at
  the archive trust boundary" even after a recorded choice. Check `phase` first.

## 7. Evidence semantics

`build --seal` runs the quality gate itself (typecheck, then the test suite) and writes the
evidence envelopes. `verify` then binds every acceptance criterion to that same global evidence
envelope, so the per-AC mapping exists only in the design's matrix — keep it accurate and check
it by hand at review time. `missingAcceptanceMatrix` stays true unless the profile is `strict`
or uses `strictClosure`, which security review mode does not require.

## 8. Repair cycles: an approval is bound to a revision id

Learned by repairing `arch-review-p2-failure-observability` after its review had already passed.
Every rule below was hit for real during that cycle.

- **Editing a task-owned path after a seal invalidates the seal.** The next `verify` reports each
  acceptance criterion `FAIL` with `repairScope: "revision_superseded"` — the documented "an owned
  file changed, build the next revision" signal, *not* an acceptance failure — and `status` then
  routes to `/kata-build` with reason `rebuild_superseded_revision`. Drift outside the owned paths
  (for example under `.kata/`) is harmless.
- **`build` picks its repair entry from `current-state.json.phase`, and the entries are strict.**
  From `review` it calls `reenterImplementForReviewRepair`, which requires a **blocking** finding in
  `review.json` (or a `major` one when the profile's review mode is `strict`); from `hardVerify` it
  reads `verify.json`'s repairable scopes; from `judge` it needs a repairable judge `FAIL`. So a
  superseded revision discovered *after* review can only be repaired by recording the supersession
  as a blocking review finding, which lets `build` transition `review → implement` and seal N+1.
- **`review --approve --review-evidence <summary>` is what concludes a review.** Without `--approve`
  the task still enters `review`, but the `judge_gate` choice file is never created and `judge`
  refuses with `judge_gate requires an explicit user choice before continuing` — while `gate approve
  --boundary judge_gate` then fails with `ENOENT` because the file it updates does not exist.
- **`review --approve` refuses any finding whose severity is `blocking` or `major`.** Fixed findings
  therefore belong in `reviewEvidence` (the convention the Phase 1 record already used — "blocking
  finding verified fixed: …"), and `findings` should hold only what is genuinely open. Downgrading a
  live defect to `note` to satisfy the guard would be recording a false state; moving a *verified
  fix* out of `findings` is not.
- **Gate choice files are single-use** (`consumeUserChoiceGate`) and are created by the phase command
  that *offers* the next boundary: `design` → `implementation_gate`, `verify` → `review_gate`,
  `review --approve` → `judge_gate`, `judge` → `archive_gate`. Re-running the offering command with
  a fresh handoff receipt recreates a consumed gate when the flow needs it again.
- **Pass long CLI arguments as an argv array, never through a shell string.** The evidence text
  contains double quotes and backticks; a `--review-evidence "$VAR"` attempt was mangled into
  `review: command not found`. `python3 -c` with `subprocess.run([...])` is the reliable driver.
- **`kata-cli` itself is a `#!/usr/bin/env node` script**, so the host `ENOTCONN` trap (§3 of the
  Phase 2 notes) takes the whole workflow down with it — every kata command fails before it starts.

## 9. Sealing and the acceptance matrix

- **Rebuild and commit `dist/` before every seal.** The seal hashes the owned paths and then runs
  its quality gate, which rebuilds `dist/` when the project compiles into it — so a stale `dist/`
  makes the revision supersede *itself* the moment it is written, `verify` reports
  `revision_superseded` for every criterion, and a whole re-seal cycle is spent on a FAIL that is
  not an acceptance failure.
- **Populate `task.json`'s `acceptanceMatrix` at design time.** Both earlier phases left it empty and
  `verify` reported `missingAcceptanceMatrix: true` every time — the judge then has to reconcile the
  design document with an empty field. Per criterion it wants `implementationPaths`, `testPaths`,
  `evidence` (`{kind: test|typecheck|integration|lint|entrypoint, command}`) and `verificationLevel`.
- **The seal validates the matrix:** only vitest/pytest/uv-run-pytest commands (or a template with a
  `{{selector}}` placeholder) may carry a `testSelector`, so a packed-smoke evidence entry cannot —
  the seal refuses with "command … does not support selectors".
- **Re-sealing after a repair takes one command from `hardVerify`** once `verify` has recorded a
  repairable scope: `build --seal` re-enters `implement` and writes the new revision in the same run.
  From `review` it needs a blocking finding, from `judge` a repairable judge FAIL (see §8).
- **`review --approve` requires the phase to be `review`**: run `kata-cli review` first (it moves
  `hardVerify → review`), then `review --confirm-host-model --approve --review-evidence <summary>`,
  which is also what creates the `judge_gate` choice file the judge demands.

## 10. Evidence rules the seal enforces (and one it does not)

- **Evidence commands run as argv, not through a shell.** `grep -rn 'key' README.md docs` becomes a
  single literal argument, matches nothing and exits 1, failing the seal's gate while the code is
  green. Keep matrix evidence quote-free and single-purpose (`grep -rn key README.md`).
- **The matrix must be covered by the declared owned paths** (or waived), and only vitest/pytest-style
  commands may carry a `testSelector`.
- **The seal does NOT check that an acceptance criterion is actually verified.** A criterion whose
  properties live inline in the facade can pass every gate while nothing would fail if they broke —
  that is what the independent review caught on `host-exec-default`. Before sealing, ask of each
  criterion: *if this behaviour disappeared, which test would fail?* If the answer is "none", extract
  the behaviour into an injectable module (see `src/setup-cli.ts`, `src/host-runner.ts`) and pin it.

## 11. The toolchain moves under you — validate artifacts against the CURRENT bundle

Learned the hard way on `arch-review-p4-vocabulary-identity`: `verify` passed, then 20 minutes later
`verify` and `judge` reported `missing_test_evidence` for every criterion. The kata CLI bundle had been
rebuilt in between and its schemas had tightened (requirement ids `REQ-N`, evidence `kind` without
`integration`/`entrypoint`, an evidence `name` pattern its own seal violates for multi-word commands,
review severities ending in `nit` not `note`). A single schema-invalid evidence envelope makes the
reader throw for the whole directory, so the gates disagree with each other about the same tree.

- **Check `ls -la <kata>/dist/cli.js`** before believing a gate that contradicts an earlier gate —
  and before re-running a workflow "to fix" something.
- The schemas are embedded in the bundle as `kata-asset:/app/kata/schemas/*.json`; read them and
  validate the task's artifacts (task.json, evidence envelopes, review.json) against them by hand.
- Repair by making the artifacts conform, changing no facts: relabel `name`, re-declare a matrix row's
  evidence kind, rename requirement ids or severities, then re-seal so envelopes are regenerated.
- **A failing judge persists per-criterion blocking obligations** that then make `verify` fail with
  `unresolved_repair_obligation`; only a successful `build --seal` resolves them. Two different
  failures with two different causes — do not treat the second as a new defect.
- Re-running `kata-cli review` (without `--approve`) RESETS `review.json` (findings and evidence
  dropped); the `--approve --review-evidence` run is the one that writes the record, and it only binds
  a revisionId when the evidence is readable.

## 12. Repairing after a PASS: the route, and its receipts

`hardVerify` cannot re-enter implement on its own — the repair entry there needs a repairable verify
FAIL, which a PASS never provides. The working route:

1. `kata-cli review --change <id> --confirm-host-model` moves the task into `review` (this RESETS
   `review.json`; `status` is `pending` or `approved` only — `changes-requested` is rejected).
2. Write a **blocking** finding into `review.json` describing the repair. When the work is a review
   fix-up rather than a defect, say so in the message: the severity is what routes the repair, and the
   record should not read as a defect report.
3. `build --seal` now enters `implement` and **does not seal** (its own diagnostics say so). Run
   `build --seal` a second time to create the new revision.
4. Every mutation needs a current acknowledged receipt for the role matching the CURRENT phase, and
   the phase only advances when the command succeeds — so re-orient/ack after each phase change
   (reviewer to unblock `review`, implementer to unblock the seal).
5. **Validate the new evidence envelopes immediately after sealing** (name pattern, kind enum,
   required fields). The seal writes `name: ${acceptanceId}-${kind}-${command}`, which violates the
   current `^[A-Za-z0-9_.-]+$` pattern for any multi-word command, and ONE bad envelope makes the
   directory unreadable so every criterion reads `missing_test_evidence`.
