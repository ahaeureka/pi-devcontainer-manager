# Failure observability (Phase 2 build notes)

Captured while implementing `arch-review-p2-failure-observability` (Phase 2 / Failure observability
of the architecture review). The phase's five findings all had the same shape — the code computed a
failure and then dropped it — so the durable output is a rule about where failures must land, plus
one host-environment trap this work made diagnosable. Both are worth knowing before the next phase.

## 1. Every computed failure needs a channel someone actually reads

The review's principle M2, made concrete by five fixes:

| Failure | Where it must land |
|---|---|
| A refused operation before the audited region (no target, ambiguous/stopped target, store mid-refresh, failing auto-select) | An audit record with the target-state failure in `errorSummary`, `policyAuthorized: true`, and the typed error rethrown unchanged (`src/execution-service.ts`, the `autoSelect` + `bind()` try/catch) |
| A refused host install (npm missing, timeout, abort) | One `setup` audit record (`exitCode: null` + `errorSummary`) **and** a structured `{ installed: false, error }` (`src/setup-cli.ts`) |
| stderr alongside stdout | Both streams presented, stderr labelled `--- stderr ---`, in the displayed text, the truncation tail and the persisted copy (`combineCommandOutput`, `src/tool-output.ts`) |
| A public parameter's contract | The tool schema (`Type.Number({ exclusiveMinimum: 0 })` in `src/tools.ts`), never a downstream abort |
| Diagnostics nothing consumes | Either surfaced through a channel with an audience, or deleted (`src/discovery-diagnostics.ts`; `configOnly`/`orphanDockerCandidates` deleted because nothing read them) |

Two rules follow from this and apply to any later phase:

1. **A field nothing reads is not a diagnostic.** Before adding a "diagnostics" collection, name the
   consumer; if there is none, the value is dead weight and should be removed instead.
2. **Where a failure is reported must have an audience that is not the model.** Audit records and
   `ctx.ui.notify` reach the operator; the model context should not be used as a logging sink.
   Deduplicate anything a re-read can repeat (the sink reports each distinct line once per session,
   because the registry is re-read on every command and on the activation probe).

## 2. Testing "something must be visible" needs a RED that shows absence

For observability fixes the honest test is not "the happy path still works" but "the channel is
empty without the fix". Both were produced by stashing only the source change:

- `git stash push src/execution-service.ts` → the two refusal tests fail with an empty audit trail
  (`mock.calls[0]` is undefined), which *is* the finding.
- `git stash push src/runtime/host-discovery.ts extensions/index.ts` → the registry-shape test fails
  showing four fields instead of two.

Corollary: the probe path (`probeRunningContainer`, activation chain step 4) must stay silent — it
has no UI guarantee and must fail toward dormancy — so it contributes to the sink but never drains
it. Any future surface that reads the registry must decide explicitly whether it may notify.

## 3. Host trap: a stale Orca AppImage mount makes every bare-name exec fail with ENOTCONN

Observed during this build, and it looked exactly like a bug in this extension: the container was
up and running, yet `devcontainer_exec` and the routed `bash` both answered
`Failed to spawn: devcontainer`, while unrelated extensions reported `spawn ENOTCONN`.

- Orca is a Linux AppImage that exports `/tmp/.mount_orca-<random>` (and its `usr/sbin`) into `PATH`
  at launch. After an unclean exit or a restart the old mount is left half-dead, while the stale
  `PATH` entry stays in every long-lived process that inherited it (including Pi).
- glibc `execvp` **aborts** the `PATH` search with `ENOTCONN` when it reaches such an entry, so every
  bare-name exec fails for that process tree — `devcontainer` and `npm` (shebang
  `#!/usr/bin/env node`), `git`, `rtk`, `kata-cli` — while absolute-path invocations still work and
  shells tolerate the bad entry (so `which devcontainer` looks fine and execution still fails).
- One-line repair, no root needed, and it fixes **already running** processes because the leftover
  mountpoint becomes an ordinary empty directory:

  ```bash
  for d in /tmp/.mount_orca-*; do [ -d "$d" ] && ! ls "$d" >/dev/null 2>&1 && fusermount3 -u "$d"; done
  ```

- Triage: `env node --version` failing with `传输端点尚未连接` is this trap; a missing binary gives a
  different error. `devcontainer --version` is the other half of the check (0.89.0 on this host).

The lesson for this extension: the message `Failed to spawn: <file>` currently drops `cause.code`
(`src/runtime/process-runner.ts` maps only `ENOENT`/`EACCES`/`EPERM` and falls through to
`unexpected`), which is why this trap was misread as "the CLI is not installed". The errno is now
named in every branch and `ENOTCONN` carries its own remedy; the trap is documented for operators in
`docs/troubleshooting.md` under "The host cannot start any executable (ENOTCONN)".

## 4. Kata process notes

- `kata-cli build --seal` refuses with `Workflow mutation requires a current acknowledged handoff
  receipt for implementer` unless an implementer handoff was oriented, verified and acknowledged
  against the **current** commit. Commit first, then re-orient/ack, then seal.
- A `verify` run that returns `success: false` with `acceptanceResults` all `PASS`,
  `implementationReady: true`, `governanceReady: false` and `reason: resolve_wiki_closure` is **not**
  an implementation failure: it is the deferred wiki-closure gate, resolved by recording a closure
  decision (`captured` with a registered candidate, or `not_applicable`) and re-running verify.

## 5. What the archive-time state adds

The phase was reviewed twice. The first review (revision-078eb341) passed with thirteen non-blocking
findings; fixing them changed owned paths, which invalidated that approval — see §8 of
`kata-task-conventions` for the mechanics — and the work was re-sealed as revision-99abdc7f, where
verify and judge both pass.

- **The two majors were real, and one was the phase's own blind spot.** `Failed to spawn` without an
  errno (the misdiagnosis above) and the L2-02 stderr class surviving on three other surfaces:
  `/devcontainer host-exec` (the command, not the tool), `docker logs` (whose `onStderr` count was
  literally `0`, so half of every log read was discarded) and `stop`/`remove` (exit code only).
  Lesson for later phases: when a defect class is found, sweep for *all* of its occurrences before
  declaring it fixed — the independent adversarial pass is what caught these.
- **A fourteenth defect turned up while fixing the thirteen**: `/devcontainer <verb>` produced no
  output at all, because Pi's command dispatcher ignores a handler's return value
  (`_tryExecuteExtensionCommand` is `return await command.handler(args, ctx), true`). Any extension
  that returns `{ text }` from a command handler must deliver it itself through `ctx.ui`. Worth
  checking the same way in any other command surface added later.
- **Two seams no unit test can reach, stated rather than claimed covered**: the delivery of a
  handler's rendered result and the drain of discovery diagnostics both live in the extension's
  command dispatch, for which this repository has no unit harness. Their policy halves are tested
  (`displayCommandResult`, `reportDiscoveryDiagnostics`) and the wiring rests on the packed smoke run.
- **`missingAcceptanceMatrix` stays true** for this task: the six criteria exist in `task.json` and
  are evaluated, but the machine-readable `acceptanceMatrix` field was never populated — the real
  matrix lives in the change's `design.md` §4. Populate it at design time in the next phase instead
  of leaving the judge to reconcile the two.
