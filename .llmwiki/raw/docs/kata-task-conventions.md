---
source_path: .kata/tasks/arch-review-p1-foundation/wiki/kata-task-conventions.md
ingested: 2026-09-15T05:37:19.517Z
sha256: e7e408cc3cce7df0f7d54abe62f86e15b9b79fbafa2e47737580106aa779dab3
---
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
