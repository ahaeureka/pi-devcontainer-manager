---
source_path: .kata/tasks/activation-and-config-mechanism/wiki/activation-and-config-mechanism.md
ingested: 2026-09-15T02:28:33.063Z
sha256: 13ddd97e6bf1dcccbc3b5ff173325c04f750fb9d3c1fffd39c548ea320e0efa8
---
# Activation, config alignment, and dormancy — distilled task knowledge

Distilled from `openspec/changes/activation-and-config-mechanism/design.md` (task
`activation-and-config-mechanism`, archived 2026-09-14 with verify PASS, review approved
with 0 blocking, judge PASS) plus that document's §7 follow-up dispositions and the archive
run of 2026-09-15. This page is a governed wiki candidate, not an authoritative record: the
task store under `.kata/tasks/activation-and-config-mechanism/` holds the verdicts, and
`openspec/changes/activation-and-config-mechanism/design.md` holds the contract.

## What the change fixed

One root cause behind four defects: the extension's notion of "a DevContainer project"
disagreed with the Dev Containers CLI's, and there was no activation gate.

- **D1** Discovery accepted three config forms while CLI 0.88.0 resolves only two — a root
  `devcontainer.json` was discovered but the adapter never passed `--config`, so `up` could
  never succeed for that form.
- **D2** Named configurations (`.devcontainer/<name>/devcontainer.json`) were invisible: the
  walker only checked the unnamed path, so such a project reported as having no DevContainer.
- **D3** The extension loaded globally and unconditionally replaced `bash`, so a workspace
  with no DevContainer got a broken shell instead of a normal one.
- **D4** Two silent configuration failures: an untrusted project file was ignored entirely,
  and project values that widened a ceiling were clamped with no diagnostic.

## Contract now in force

- **Config forms.** `.devcontainer/devcontainer.json` (authoritative) and `.devcontainer.json`
  (fallback) are the CLI's own lookup. Named configurations are discovered as multiple
  candidates of the same workspace (workspace = the parent of `.devcontainer/`). A root
  `devcontainer.json` is a valid target **only** as an explicit `--config` path, and status
  must say so. The adapter carries an optional `--config <path>` for `up`/`build`/`exec`; no
  selection keeps the zero-flag argv.
- **Activation priority.** `activation: "never"` → dormant; `"always"` → engaged; session cwd
  is a DevContainer workspace → engaged; cwd has a running container labelled
  `devcontainer.local_folder = cwd` → engaged (probed only when the previous step misses); an
  explicit `/devcontainer use|up` this session, or a restored persisted selection for this
  workspace → engaged; otherwise **dormant**.
- **Dormancy means no execution surfaces taken over, not "not loaded".** `bash` stays Pi's
  built-in host shell, `!`/`!!` run locally, the three container tools are absent from the
  active set, and no execution context is injected — while `session_start` still composes the
  runtime so `/devcontainer list|use|up` keep working and `/devcontainer off` returns to dormant.
- **Merge precedence.** Project-first (`project ?? global ?? default`) for `dockerPath`,
  `devcontainerPath`, `routeMode`, `discovery.*`, `audit.*`, `destructive.*`,
  `hostExecution.allow`, `activation`. Narrowing-only for `allowedWorkspaceRoots` (intersect),
  `environmentAllowlist` (intersect), `maxTimeoutSeconds` (min), `maxOutputBytes` (min).
  `audit.directory` stays global-only.
- **Diagnostics replace silence.** An untrusted project file reports its path and reason in
  status and once at session start; a clamped ceiling reports key, requested value, effective
  value, and which file provided the ceiling.
- **Routing invariant.** The workspace actually executed must equal the bound target
  workspace, and the audit record additionally names the requested cwd. A request whose cwd is
  itself another DevContainer project is still refused with `policy-denied`.

## Task-shape conventions learned (apply to later kata tasks in this repository)

- Pass `openspec/` as an owned path at seal time, or the artifact authorizing the change lands
  outside the sealed revision (`workspaceDrift`) and cannot be re-sealed from `archive`.
- Seed acceptance from a machine-readable matrix (`requirements.json` in the shape
  `kata-cli open --requirements-file` consumes). `open` is the only command that writes
  acceptance and `build --seal` refuses to run after `archive`, so the placeholder
  `AC-1: "Implement the change successfully."` cannot be corrected retroactively — the
  recorded verdicts would then look like they evaluated ten criteria when they did not.
- `kata-cli archive` is a no-op once `current-state.phase === "archive"`:
  `boundaryForCommand("archive", "archive")` returns `null`, so `confirmHostModel` is never
  set and the command always answers "Archive requires explicit user confirmation at the
  archive trust boundary." Check `phase` first; that message is not a gate failure.
- Archiving does not write wiki content. Distillation is the agent's job, and the archive
  handoff's allowed write path is `.kata/tasks/<taskId>/wiki/` (this page).

## Environment gaps recorded by the task, and their status

- `.llmwiki/` did not exist, so five of seven `requiredReads` were missing, `wiki ingest`
  could not run, and closure was recorded `not_applicable` rather than fabricated.
  **Resolved 2026-09-15:** `kata-cli wiki init --from docs` created the store and `wiki lint`
  reports `ok: true`.
- `.kata/` was untracked, and committing the governed task store was an owner decision.
  **Resolved:** `.kata/**` and `.rpiv/artifacts/**` are tracked and committed to `main`.
- This repository has no DevContainer of its own, so the extension's own `bash` stays dormant
  — the dogfood case for D3.

## CI facts that came out of landing the packed smoke probe

- The probe asserted that the packed JS text contained `createBashToolDefinition`/`registerTool`
  instead of asserting real registration; the real probe now extracts the tarball, imports the
  packed `dist/extensions/index.js`, drives its factory with a stub Pi API, and needs no
  Docker, model, or `pi` CLI.
- Ordering matters: the probe failed on both workflows when pushed to `main` first, because
  the dormancy assertions need the `activation` feature and an unknown `activation` key on
  `main` meant unconditional registration (the `bash` override still at factory scope). It was
  reverted on `main` and carried on the feature branch.
- The integration workflow never built `dist/`, so the packed tarball had no entry point and
  the smoke failed its own packaging check.
- The real-Pi e2e case gated on `command -v pi`, which is true on a runner without
  credentials; it now detects the missing provider at runtime and skips with the reason.
