# Defect report — a container that appears mid-session is never adopted

`task: stale-target-self-heal` · `role: reporter` · `phase: report`
`reported: 2026-09-28` · `base: main@4d4e59d`
`reporting session: /data/work/ahaeureka/zenmpai (external project)`
`status: candidate directions only — NOT an approved design, no AC matrix, no branch`
`reviewed: 2026-09-28` · `base: main@0becb88` · `review result: every §3 code claim re-checked against the code;`
`§3 gained the gates a fix must ALSO pass, §8 was corrected, §9 states the decision and proposed ACs`
`decision: ADOPT externally started containers (operator, 2026-09-28) — direction B implemented`
`implemented: src/target-repair.ts (the rule) · src/execution-service.ts (the trigger) · extensions/index.ts (the hook)`
`verified: tests/unit/target-repair.test.ts · tests/unit/execution-service.test.ts · tests/integration/… (real Docker)`

This artifact is a defect report, not a design contract. It is deliberately written in English so it
can be read alongside the code; the operator-facing summary lives in the reporting session.

## 1. Summary

A long-lived session resolves its target **once**, at a moment when the workspace has no running
container. The store then commits `selected-stopped`, and nothing in the live session ever re-derives
that selection. If the container is started afterwards — by VS Code, by a host shell, or by a sibling
Pi session — the session keeps failing closed with `target-stopped` even though Docker reports a
running container carrying **its own workspace's** `devcontainer.local_folder` label.

Recovery exists only outside the live path: a new session / `/reload` (the `session_start` restore
path re-resolves against the live registry) or `/devcontainer off` (which returns the store to
`none`, the only state that re-enables auto-selection). `/devcontainer list`, which the extension
itself tells operators to run "to refresh", cannot repair it.

The remedy the extension prints in this situation — `Run /devcontainer up before executing.` — is
wrong for the case (the container *is* running) and expensive (`up` rebuilds; this project's own
CHANGELOG notes that `up` never compares a container against its configuration).

## 2. Observed sequence (single session, 2026-09-28)

| Time (CST) | Event |
|---|---|
| 13:58 | `devcontainer_status` → `selected-stopped`, detail `Target /data/work/ahaeureka/zenmpai is not running; run /devcontainer up.` No container existed — the answer was correct. |
| 14:20–15:20 | Container started **out-of-band**: `devcontainer up --workspace-folder /data/work/ahaeureka/zenmpai` run from a host shell → `{"outcome":"success","containerId":"3a6363…"}`; container `frosty_raman`, image `vsc-zenmpai-28bbe3b3…-uid`; `postCreateCommand` and `postStartCommand` completed. |
| 15:29 | Same session: `devcontainer_status` → **still `selected-stopped`**; `bash` (the routed replacement) still fails closed `target-stopped`, while `docker ps --filter label=devcontainer.local_folder=/data/work/ahaeureka/zenmpai` reports the container `Up 14 minutes`. |

Every container-side check in that session had to be executed through `docker exec` from the host,
because the extension's own surfaces stayed refused.

## 3. Code facts (line numbers on `main@4d4e59d`)

- **Auto-selection is reachable only from the empty state.** `src/execution-service.ts:222` —
  `if (this.options.targetStore.snapshot().status === "none") { await this.options.autoSelect?.(request.workspace); }`
  then `this.options.targetStore.bind()` at `:225` throws the *stored* refusal for every other status
  (`src/target-store.ts:209` `selected-stopped`, `:151` the running-state guard inside `bind()`).
- **The store already separates intent from reality, but only reality can change silently.**
  `src/target-store.ts` class doc: *"Serialized session-scoped target state machine … Selection intent
  is stored separately from volatile container reality."* A selection invalidated by volatile reality
  ("no container yet") is never re-derived, while an operator-stopped one correctly must not be.
- **`status` refreshes the registry but never re-derives the selection.** `src/commands.ts:471-473`
  calls `services.registry()` and only then renders `targetStore.snapshot()`; `devcontainer_status` is
  documented as a "read-only summary of the current DevContainer selection and workspace registry"
  (`src/tools.ts:188-190`). So `status` CAN list the running container while its verdict line still says
  `selected-stopped` — which is what makes the symptom "silently absent" rather than obviously wrong.
- **`list` repairs only one status.** `src/commands.ts:464` — `if (stale.status === "selected-missing" && …) reconcileSelection(…)`.
  Its own comment calls `list` "the command the extension tells operators to run to refresh";
  `selected-stopped` is not covered.
- **`autoSelect` parks, by design.** `extensions/index.ts:271-289` — "a config-only/stopped project is
  selected in `selected-stopped` so `exec` fails closed with `target-stopped` and prompts
  `/devcontainer up` (never auto-starts)", and `selectIfNone` refuses to overwrite a non-empty store.
- **A widened trigger must also pass `allowsAutoSelection`.** `extensions/index.ts:275` —
  `if (!allowsAutoSelection(activation.decision)) return;`, and `src/activation.ts:83-84` makes that
  `decision.active`. For the reported case the decision IS active via `workspace-config` (the workspace
  declares a `.devcontainer.json`), so the gate is satisfiable here; a session that is active only through
  `explicit-selection`, or that carries `opted-out`, is deliberately excluded (review finding L1-02).
- **The hook matches only the session cwd.** `extensions/index.ts:276-277` —
  `if (canonicalWorkspaceKey(workspace) !== cwdKey) return;`. Repair for another workspace is out of scope
  by construction; the reported case is the session cwd.
- **`selectIfNone` cannot repair a non-empty store.** The hook commits through `selectIfNone`, which refuses
  when the store already holds a selection, so an explicit `use` landing mid-discovery wins (L3-05). Any fix
  therefore needs a store operation allowed to *re-derive* a reality-derived status, not just a wider trigger.
- **`off` is already distinguishable; `stop`/`remove` are not.** `off` calls `targetStore.clear()` and
  persists a `state: "cleared"` tombstone (`src/commands.ts:483-487`), which surfaces as
  `activation.optedOut` (`extensions/index.ts:634`) — so the §5 invariant is already enforced for `off`.
  By contrast the `stop`/`remove` handlers never touch the store (they only read a snapshot,
  `src/commands.ts:867`), so after `/devcontainer stop` the store reports exactly the same
  `selected-stopped` as the "nothing was running when the session resolved" case. **That collision is what a
  fix has to break**, and it is why direction B needs an intent marker rather than a wider trigger.
- **The restore path does re-resolve.** `extensions/index.ts:666-682` — on `session_start`, a persisted
  selection is reconciled against the live registry "instead of parking the selection in
  `selected-missing` forever: a still-running target becomes usable again without a manual re-`use`".
  The live path has no equivalent, which is exactly why `/reload` recovers and the running session does not.
- **Activation and selection disagree.** `src/activation.ts:83-89` treats a running labelled container as
  first-class activation evidence (`reason: "running-container"`), so the extension can consider itself
  active for a workspace while its selection for that same workspace stays `stopped`.

## 4. Reproduction

1. Workspace with a `.devcontainer.json`; no labelled container running for it.
2. Session A: any container-routed call (`devcontainer_status` is enough) → the store commits `selected-stopped`.
3. Start the container out-of-band (`devcontainer up` from a shell, VS Code, or another Pi session).
   Assert `docker ps --filter label=devcontainer.local_folder=<workspace>` lists it as running.
4. Session A again: `devcontainer_status` → still `selected-stopped`; `devcontainer_exec` / `bash` → `target-stopped`.
5. Recovery: a **new** session or `/reload` (restore path), or `/devcontainer off` (empty state).
   `/devcontainer list` does **not** recover it.

Steps 2 and 4 are already reproducible in the deterministic unit layer (no Docker): drive the store to
`selected-stopped`, then change only what discovery returns and assert the session's second call still
refuses. Step 3's Docker half belongs in `tests/integration`.

## 5. Impact

- Operator-visible: an engaged session silently keeps a host/target mismatch, with a remedy that is
  both inaccurate and costly for the most common trigger (a container started after Pi was opened).
- The failure is "silently absent" rather than loud: `status` keeps reporting a stale verdict, and the
  only correct advice (`/reload` or `off`) is not the advice printed.
- Any fix must keep the deliberate invariant "an operator who stopped the target is not resurrected"
  (`stop` / `remove` / `off` are intent, not volatile reality). The existing unit tests pin
  `selected-stopped` as terminal, so they encode that tension and must be revisited deliberately.

## 6. Candidate fix directions (options — none selected here)

- **A. `list` parity (narrow, no intent change).** Let `list` repair `selected-stopped` exactly the way
  it repairs `selected-missing` (`src/commands.ts:464`). Cheapest, no hot-path cost — but it only helps
  operators who already know to run `list`.
- **B. Live re-probe at execution.** Widen the auto-select trigger in `ExecutionService.exec`
  (`src/execution-service.ts:222`) from `status === "none"` to `none | selected-stopped | selected-missing`,
  keeping `selected-ambiguous` / `selected-policy-denied` / `refreshing` fail-closed. This requires
  distinguishing *intent* stopped ("the operator ran `stop`/`remove`") from *reality* stopped
  ("nothing was running when the session resolved"), e.g. a stored intent flag or a distinct status that
  only the reality case may be auto-recovered from. The store's own doc says the two are separate
  concerns, so this is the direction that matches the stated model. **Three requirements the §3 gates add**
  (a wider trigger alone is not enough): (i) the trigger still has to satisfy the activation gate, which for
  this case holds (`workspace-config`); (ii) the hook only matches the session cwd, so the repair is scoped
  to the reported situation; (iii) the commit must pass through a store operation allowed to re-derive a
  reality-derived status, because `selectIfNone` refuses a non-empty store.
- **C. Truthful `status`.** Have `status` re-probe the selected candidate and re-commit the result.
  Makes the reported state honest, but `status` is documented as read-only presentation and a probe per
  call reintroduces the cost the short cache was added to avoid.
- **D. Documentation half (compatible with A/B/C).** Add the situation to `docs/troubleshooting.md`
  (CONTRIBUTING: "a new error kind or failure mode → `docs/troubleshooting.md`") and change the
  `target-stopped` remedy so it names the cheap recovery. The remedy today is a single string
  ("Run `/devcontainer up` before executing.") that is correct for a never-started target and wrong for
  a container that appeared later.

## 7. Open questions

- Should an **externally** started container be adopted automatically at all? The label already *is* the
  workspace identity and candidates go through the same policy containment, but confirm nothing in the
  policy/audit path assumes "this extension started that container".
- Is a re-probe per `exec` acceptable on the hot path, or should the trigger live in the presentation
  hook plus `list`?
- Should a `stopped` config be auto-selected at all, or should the store stay `none` until a runnable
  candidate exists? The current park-then-refuse behavior is deliberate; the defect is only that reality
  can change after the park.
- Does `selected-ambiguous` deserve the same treatment once the ambiguity resolves (one container left)?

## 8. Scope of this artifact

Written from outside the project while diagnosing the reporting workspace's DevContainer rebuild. Only
this new file was added; `src/`, `extensions/`, `tests/`, `docs/`, `CHANGELOG.md`, `README*.md` and
`dist/` are untouched, no AC matrix (`requirements.json`) was authored, and nothing was staged or
committed.

**Correction (added at review).** The report described the working tree's `M extensions/index.ts` as
"unrelated … from another session". It was neither: it is the *source half* of commit `4d4e59d`, whose
`dist/extensions/index.js` was committed while `extensions/index.ts` was left unstaged. The committed
artifact therefore could not be reproduced from the committed source, and CI's freshness gate
(`ci.yml:46-47`, `git diff --exit-code -- dist` after a build) would have failed. Fixed in `0becb88`,
which commits the source; re-verified with a clean tree. **Lesson for this report's own recommendations:**
"committed `dist` matches a fresh build" proves nothing when the tree is dirty — a build of a dirty tree
reproduces the dirty `dist`.

## 9. Decision, acceptance criteria, and implementation record

### 9.0 Decision taken (2026-09-28)

The operator answered **yes**: a container this extension did not start IS adopted by a live session, provided it
is **running** and labelled for the workspace. Direction **B** is therefore the implemented one, with **D**'s
documentation half rolled in. Recorded here so the choice is not re-litigated from behaviour.

### 9.1 The decision as it was put

The report leaves one genuinely operator-level question, and it is not a technical choice: **should a container
this extension did not start be adopted automatically by a live session?**

- **Yes (recommended).** The `devcontainer.local_folder` label already *is* the workspace identity, containers are
  discovered and driven through the same registry the rest of the extension uses, and `activation` already treats a
  running labelled container as first-class evidence (`src/activation.ts:84`). Adopting it makes the live path
  agree with the restore path, which already behaves this way.
- **No.** Then the only admissible fix is the documentation half (D) plus `list` parity (A), and the session keeps
  refusing until the operator runs `use` / `off` / `/reload`.

Answering "no" is a legitimate outcome — but it has to be answered explicitly, because today's behaviour is
precisely what the report is complaining about.

### 9.2 Proposed acceptance criteria (shaped for `requirements.json`, not authored)

| id | statement |
|---|---|
| AC-1 | With the store at `selected-stopped` and the registry reporting one **running** container labelled for the session workspace, a container-routed call in the SAME session succeeds without `/reload`, `/devcontainer up`, `use` or `off`. |
| AC-2 | An operator-stopped target is NOT resurrected: after `/devcontainer stop` (or `remove`), a later call still fails closed with `target-stopped` even though the container is `exited`, not running. |
| AC-3 | `/devcontainer off` keeps being respected: a running labelled container is not adopted while the session is `opted-out` (existing L1-02 behaviour, re-pinned). |
| AC-4 | A repaired selection is committed with the identity the registry reports (candidate id + workspace key), and the operation's audit record names that target. |
| AC-5 | The remedy text differs by cause: the reality-stopped case names the cheap recovery; the intent-stopped case keeps today's text. One string cannot be right for both. |
| AC-6 | The situation is documented in `docs/troubleshooting.md`, restating the §5 invariant. |
| AC-7 | No regression: the existing "`selected-stopped` is terminal" unit tests are revisited deliberately (their intent narrows to "intent-stopped is terminal"), and the full suite plus `git diff --exit-code -- dist` are green. |

### 9.3 Cost of each direction, stated once

| direction | touches | hot-path cost | helps whom |
|---|---|---|---|
| A (`list` parity) | `src/commands.ts:464` | none | an operator who already runs `list` |
| B (re-probe at exec) | `src/execution-service.ts:222`, `src/target-store.ts` (intent marker), `extensions/index.ts` (hook) | one registry read per refused-status call | every caller, automatically |
| C (truthful `status`) | `src/commands.ts:471` | a probe per `status` | the operator, at the moment they look |
| D (docs + remedy) | `docs/troubleshooting.md`, `src/target-store.ts:155` | none | everyone, read-only |

A and D are compatible with B or C and are cheap; **B is the only one that fixes the reported session without the
operator having to know a workaround.**

## 10. Implementation record (what landed, and what did not)

**The rule** — `src/target-repair.ts` exports `resolveTargetRepair({ snapshot, requestWorkspace, entries })` and is
the single owner of "may this parked selection be re-derived?". It repairs only `selected-stopped` /
`selected-missing`, only when the parked workspace contains the requested one, only when the entry is not
`ambiguous`, and only when **exactly one** candidate is `running`; it then builds the selection through
`selectionFor`, so the operator's configuration is carried across and a removed/renamed one is dropped rather
than travelling into the CLI's argv.

**The trigger** — `src/execution-service.ts` now invokes the `autoSelect` hook for `none`, `selected-stopped` and
`selected-missing`. `selected-ambiguous`, `selected-policy-denied` and `refreshing` are never passed: those are
decisions, not stale facts.

**The hook** — `extensions/index.ts` re-derives via the **cached** registry read (`registryForRead`, 500 ms) and
commits with `targetStore.select`. It stays behind `allowsAutoSelection(activation.decision)`, so `/devcontainer
off` keeps holding.

### 10.1 Acceptance coverage

| id | status | evidence |
|---|---|---|
| AC-1 | met | `tests/unit/execution-service.test.ts` (the same call succeeds once the hook adopts) and `tests/integration/devcontainer-manager.integration.test.ts` with **real Docker**: a store parked before the container existed serves the call afterwards — and the same call without the hook still refuses, which is the defect reproduced. |
| AC-2 | met | `target-repair.test.ts`: an `exited` candidate yields no repair. This is why no intent flag was needed — `/devcontainer stop` and `remove` leave an exited container, and only a running one is ever adopted. |
| AC-3 | met | The repair sits after the activation gate; the L1-02 (`off`) suite still passes unchanged. |
| AC-4 | met | The integration test asserts the adopted `candidateId` equals the container id the registry reported; `selectionFor` is the single owner of the identity shape. (The audit record for the *repaired* call is the ordinary bound-target record; no separate assertion was added for it — noted rather than claimed.) |
| AC-5 | **NOT met, deliberately** | The remedy strings were left alone. With the self-heal in place the misleading case ("run `/devcontainer up` while a container is running") no longer arises on the live path, and splitting the string would mean threading a cause through `refusalFor` for a case that no longer occurs. `docs/troubleshooting.md` states the cause-specific recovery instead. Stated here rather than dropped silently. |
| AC-6 | met | `docs/troubleshooting.md` gained "I started the container outside Pi and `bash` still says `target-stopped`", including what the heal deliberately does not do. |
| AC-7 | met | No existing test needed revisiting: `bind()` still refuses a parked store, and the repair happens *before* it, only for a running candidate — so the "parked is terminal" tests still describe the intent case. Full suite green, and the `dist` freshness gate is checked on a clean tree (§8). |

### 10.2 Known limits (deliberate, and worth a follow-up if they bite)

- A repair attempt costs one registry read per **refused** call (cached for 500 ms). Accepted: the alternative is
  a stale verdict, which is the defect.
- A repair is not persisted to the session record, so it is re-derived after `/reload` rather than restored.
  Consistent with the existing empty-store adoption, which also does not persist.
- The heal does not retry `ambiguous` after the ambiguity resolves on its own (one container left). The next
  refused call repairs it, because the status is then `selected-stopped`/`selected-missing` — but a session that
  was parked in `selected-ambiguous` while one container kept running is not covered by AC-1's wording.
