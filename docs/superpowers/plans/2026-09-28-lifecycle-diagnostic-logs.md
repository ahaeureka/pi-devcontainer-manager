# Lifecycle Diagnostic Logs Implementation Plan

> **For agentic workers:** Implement inline in the current session; do not dispatch workflow agents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist raw, protected diagnostic transcripts for DevContainer lifecycle operations without changing audit semantics or exposing output to model context.

**Architecture:** Add a standalone lifecycle-log writer and non-owning process-stream taps. Wire one log run through lifecycle service/adapters for `up`, `build`, `rebuild`, `setup`, `stop`, and `remove`; retain existing bounded `ProcessResult` capture for CLI JSON parsing. Surface only last-log metadata/path in status.

**Tech Stack:** TypeScript, Node `fs`, Vitest, Dev Containers CLI 0.89.0.

**Spec:** `docs/superpowers/specs/2026-09-28-lifecycle-diagnostic-logs-design.md`

## Global Constraints

- Raw diagnostic logs are separate from audit JSONL and never enter model-facing command output.
- Included verbs: `up`, `build`, `rebuild`, `setup`, `stop`, `remove`; exclude exec/bash/host-exec/container logs.
- Log directory `0700`, files `0600`; opaque filenames; 10 MiB per-file cap; 14-day retention.
- Logging failure must not alter operation outcome.
- Do not use undocumented Dev Containers CLI log-file flags; use public `--log-level debug` for up/build/rebuild.
- All tests remain typechecked by `tsconfig.tests.json`; build emits no tests into `dist/`.

---

### Task 1: Process taps and protected lifecycle-log writer

**Files:**
- Create: `src/lifecycle-log.ts`
- Modify: `src/runtime/process-runner.ts`
- Test: `tests/unit/lifecycle-log.test.ts`
- Test: `tests/unit/process-runner.test.ts`

**Interfaces:**
- Produces `defaultLifecycleLogDirectory()`, `Jsonl`-independent `LifecycleLogWriter`, and a per-attempt `LifecycleLogRun` with `stdout(chunk)`, `stderr(chunk)`, `finish(outcome)`, and `path` metadata.
- Produces `ProcessRunnerOptions.onStdoutTap` / `onStderrTap`, and matching `BoundedRunOptions` fields; taps observe complete stream chunks without disabling final bounded `stdout`/`stderr` capture.

- [ ] **Step 1: Write failing lifecycle-log tests**

```ts
const run = writer.start({ operation: "up", workspace: "/ws", argv: ["devcontainer", "up"] });
run.stderr(Buffer.from("build failed\n"));
run.finish({ exitCode: 1, durationMs: 4, truncated: false });
expect(readFileSync(run.path, "utf8")).toContain("--- stderr ---\nbuild failed");
expect(statSync(run.path).mode & 0o777).toBe(0o600);
```

Add cases for opaque names, 10 MiB cap plus a single marker, pruning only expired `.log` files, and a write error that is returned as diagnostic metadata rather than thrown.

- [ ] **Step 2: Run tests red**

Run: `npx vitest run tests/unit/lifecycle-log.test.ts`

Expected: FAIL because `src/lifecycle-log.ts` does not exist.

- [ ] **Step 3: Write failing process-tap tests**

```ts
const result = await runner.exec("node", ["-e", "process.stdout.write('out'); process.stderr.write('err')"], {
  cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" },
  onStdoutTap: chunk => taps.out.push(chunk), onStderrTap: chunk => taps.err.push(chunk),
});
expect(result.stdout).toBe("out");
expect(result.stderr).toBe("err");
expect(Buffer.concat(taps.out).toString()).toBe("out");
```

- [ ] **Step 4: Implement writer and taps**

Create the writer using `mkdirSync(..., { mode: 0o700 })`, `openSync`/`appendFileSync` plus `chmodSync(0o600)`, a per-run byte counter, and an idempotent finalizer. Add observer taps after child data arrives and before bounded capture chooses its retained bytes. Forward taps through `runBounded`.

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run tests/unit/lifecycle-log.test.ts tests/unit/process-runner.test.ts`

Expected: PASS.

Commit: `feat(logging): add protected lifecycle log writer`

### Task 2: Lifecycle service and adapter wiring

**Files:**
- Modify: `src/runtime/devcontainer-adapter.ts`
- Modify: `src/runtime/docker-lifecycle.ts`
- Modify: `src/setup-cli.ts`
- Modify: `src/execution-service.ts`
- Modify: `src/commands.ts`
- Modify: `extensions/index.ts`
- Test: `tests/unit/devcontainer-adapter.test.ts`
- Test: `tests/unit/docker-lifecycle.test.ts`
- Test: `tests/unit/setup-cli.test.ts`
- Test: `tests/unit/execution-service.test.ts`
- Test: `tests/unit/commands.test.ts`

**Interfaces:**
- Consumes `LifecycleLogWriter` / `LifecycleLogRun` from Task 1.
- Adds an optional lifecycle log run to Dev Containers and Docker lifecycle adapter call options without changing exec interfaces.
- Produces `latest()` metadata for `renderStatus()` and a log-path-only result suffix.

- [ ] **Step 1: Write failing adapter/service tests**

Assert `up`, `build`, and rebuild append `--log-level debug`, forward both taps to `runBounded`, and preserve parsed JSON stdout. Assert stop/remove/setup forward their lifecycle sink. Assert policy denial and confirmation-required paths finalize one no-child record.

- [ ] **Step 2: Run focused tests red**

Run: `npx vitest run tests/unit/devcontainer-adapter.test.ts tests/unit/docker-lifecycle.test.ts tests/unit/setup-cli.test.ts tests/unit/execution-service.test.ts`

Expected: FAIL because lifecycle log options/metadata are absent.

- [ ] **Step 3: Implement one log owner per lifecycle attempt**

Create the run in `ExecutionService` after request parsing and before authorization. Use `try`/`catch`/`finally` so success, typed rejection, confirmation-required, spawn failure, cancellation, and parse failure finish exactly once. Pass taps to adapters. Keep audit writes unchanged. Keep raw stream content out of all `RuntimeError`, `AuditRecord`, and `CommandResult` text.

- [ ] **Step 4: Wire session composition and command presentation**

Create/prune the writer at session composition in `extensions/index.ts`, pass it into `ExecutionService` and setup. Extend status data with only last log operation/time/outcome/path. Include only a path reference in lifecycle command results.

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run tests/unit/devcontainer-adapter.test.ts tests/unit/docker-lifecycle.test.ts tests/unit/setup-cli.test.ts tests/unit/execution-service.test.ts tests/unit/commands.test.ts`

Expected: PASS.

Commit: `feat(logging): capture lifecycle process transcripts`

### Task 3: Documentation, package verification, and real qunapai rebuild

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/configuration.md`
- Modify: `docs/security.md`
- Modify: `CHANGELOG.md`
- Test: `tests/unit/docs-consistency.test.ts`
- Test: `tests/integration/devcontainer-manager.integration.test.ts` as needed

**Interfaces:**
- Documents location, raw-content risk, file permissions, scope, retention/cap, and the status path-only contract.
- Validates the installed package from `/data/work/ahaeureka/qunapai` without adding qunapai files to this repository.

- [ ] **Step 1: Write failing docs/status tests**

Assert both READMEs describe lifecycle-only raw logs, exclude exec/host-exec output, state `0600`, and do not promise redaction. Assert `renderStatus` includes the log path but not a known raw sentinel.

- [ ] **Step 2: Run tests red**

Run: `npx vitest run tests/unit/docs-consistency.test.ts tests/unit/commands.test.ts`

Expected: FAIL until docs and status contract are implemented.

- [ ] **Step 3: Update user documentation**

Add the exact directories, 14-day/10-MiB limits, raw-secret warning, included/excluded surface list, and inspection instructions. Record the feature in CHANGELOG.

- [ ] **Step 4: Run repository gates and package checks**

Run:

```bash
npm run typecheck
npm run test:unit
npx vitest run
npm run build
git diff --exit-code -- dist
npm run pack:check
npm run install:local -- --check
```

Expected: all pass; `dist/` matches the build and package has no `dist/tests/**`.

- [ ] **Step 5: Validate with the real qunapai project**

After `npm run install:local`, use `/data/work/ahaeureka/qunapai` as the session/project cwd. Run `/devcontainer rebuild` interactively, accept the required remove confirmation, then inspect `.pi/devcontainer-manager/lifecycle-logs/*.log` through a host-side operator tool. Verify the file is mode `0600`, includes the rebuild/devcontainer process transcript and terminal outcome, and its content does not appear in slash-command text or audit JSONL. If real-project behavior exposes a plugin defect, add a regression test here before adjusting source.

- [ ] **Step 6: Commit and final verification**

Commit: `docs(logging): document lifecycle diagnostic logs`

Run the Task 3 gates once more after the commit. Record the actual qunapai rebuild outcome, log path, and any corrective commit in the final report.
