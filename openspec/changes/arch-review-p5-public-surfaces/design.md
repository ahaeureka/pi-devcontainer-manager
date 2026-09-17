# Design — arch-review-p5-public-surfaces

`task: arch-review-p5-public-surfaces` · `role: designer` · `phase: plan`
`branch: feature/arch-review-p5-public-surfaces` · `base: main@2cb8bc1`
`profile: git_flow / tdd / security`
`source: .rpiv/artifacts/architecture-reviews/2026-09-15_08-46-53_pi-devcontainer-manager.md` (§ Phase 5)
`matrix: .rpiv/artifacts/architecture-reviews/2026-09-15_08-46-53_pi-devcontainer-manager-phase5-requirements.json`

Owner-facing messages stay Chinese per the Kata skill; this artifact keeps the technical contract in
English so it can be read alongside the code.

## 1. Problem

The review's last phase closes the loop on the two user-facing surfaces and the process contract they
stand on. Its three findings are unrelated in mechanism but share a shape: an interface that is
narrower than the thing behind it, so the difference leaks as a defect.

| # | Finding | Severity | Blast radius | What breaks today |
|---|---|---|---|---|
| 1 | `L0-04` asynchronous lifecycle has no generation | High | internal | `session_start` awaits (`probeRunningContainer`, `reconcileSelection`, `docker.listDevContainers`) and then assigns `runtime` and registers surfaces; a start that resumes after a reload/second start/shutdown overwrites a newer runtime and registers from a stale activation decision, and its callbacks can dereference a runtime that is already gone |
| 2 | `L2-04` the host escape hatch parses shell-like free text | Med | **public-API** | `/devcontainer host-exec` runs a three-alternative regex splitter, so escaped quotes, concatenated segments (`a"b"c`) and empty arguments are reinterpreted — on the one surface that then executes the result on the host |
| 3 | `L5-03` the process result carries no output | Med | cross-module | `ProcessResult` has `exitCode/signal/durationMs/truncated` and nothing else; bytes exist only through `onData`/`onStderr` callbacks, so every consumer re-implements chunk collection and a caller that forgets them gets a clean exit code with silently discarded output (the host runner's own comment records this) |

## 2. Scope

These three findings and the consumers they touch. This is the last phase of the review; nothing from
earlier phases is reopened except where a slice touches the same file.

## 3. Technical design

### 3.1 One lifecycle owner for the session surface (`L0-04`, `AC-1`)

The facade keeps a monotonic generation counter and refuses to mutate anything it no longer owns:

```ts
/** Monotonic generation; incremented on every start and shutdown. */
let lifecycle = 0;

pi.on("session_start", async (_event, ctx) => {
  const generation = ++lifecycle;                  // this start owns the surface
  const stale = (): boolean => generation !== lifecycle;
  ...
  const rt = composeRuntime(...);                  // sync, no await yet
  if (stale()) return;                             // superseded while composing
  runtime = rt;                                    // the assignment is guarded
  ...
  evidence.workspaceHasRunningContainer = await probeRunningContainer(rt, ctx.cwd);
  if (stale()) return;                             // the await above lost the race
  ...
  if (surfaces.containerTools) registerDevcontainerTools(pi, () => runtime);
  if (surfaces.bashReplacement) registerBashReplacement(pi, () => runtime);
  ...
  await runtime.reconcileSelection({...});
  if (stale()) return;                             // do not notify for a dead session
  ctx.ui.notify(...);
});

pi.on("session_shutdown", async () => {
  lifecycle += 1;                                  // invalidate whatever is in flight
  runtime = undefined;
});
```

- `generation` is captured **before the first await** and re-checked after each one; a superseded start
  returns without assigning `runtime`, without registering, and without notifying.
- The registered closures keep reading the module-level `runtime` (so a later start's runtime is what
  they see) — the guard is about *who may write* it, not about freezing it.
- The guard is testable without Pi: extract the ownership rule into `src/lifecycle.ts`
  (`createLifecycleGuard()` with `begin()`, `isCurrent(generation)`, `invalidate()`), so the facade
  calls a tested object rather than carrying the counter itself. Tests cover: a start that finishes
  before any other is current; a second start supersedes the first, and the first's post-await checks
  all report stale; a shutdown invalidates an in-flight start.
- `probeRunningContainer` and `reconcileSelection` keep their current behaviour; only the decision to
  *use* their results changes.

### 3.2 Structured argv for the host escape hatch (`L2-04`, `AC-2`, `AC-3`)

Today: `handlers["host-exec"]` runs `parseArgv(args)` (a regex splitter) and hands the result to the
audited host runner. The finding is not that splitting is wrong in principle but that **shell-like
text is an ambiguous interface on a surface that executes the result on the host**, and the splitter
implements only a narrow subset of the syntax it appears to accept.

**New grammar — argv, one argument per flag:**

```
/devcontainer host-exec [--argv <value>]...            # explicit, repeatable
/devcontainer host-exec --argv hostname
/devcontainer host-exec --argv printf --argv '%s' --argv 'a b'
/devcontainer host-exec --argv '' --argv 'with space'
```

- `--argv` may be repeated; each occurrence contributes **exactly one** argument, taken verbatim
  (no quote processing at all — quotes belong to the caller's shell, which already removed them, or to
  the literal value if they typed them inside the value). Empty values are legal and meaningful.
- A bare word after the verb (the old form) is **refused** with a typed `policy-denied`-style
  explanation and the migration (the review's `public-API` flag makes this the honest choice, and the
  refusal names the new form). `--argv` with no value is refused too.
- `parseArgv` (the splitter) is deleted, so no path can reintroduce shell-like semantics.
- The command's help/usage line and the `description` show the new form; `README`, `README.zh-CN`,
  `docs/security.md`'s surface table and `CHANGELOG` record the breaking change with a migration
  example.
- The audit record keeps capturing the **resolved argv** (its fingerprint in the default mode), and the
  container-path guard keeps evaluating the same array — both already operate on `argv`, so the
  invariants hold by construction; the tests assert them for the new grammar (empty argument, argument
  containing spaces, argument that is a container path → guard refusal, audit fingerprint matches the
  argv that ran).

The tool surface (`devcontainer_host_exec`) is already structured (`argv` string array) and is
untouched — which is the argument for making the command match it rather than the other way round.

### 3.3 The process result carries its bounded output (`L5-03`, `AC-4`, `AC-5`)

```ts
export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly truncated: boolean;
  /**
   * Bounded stdout/stderr captured when the caller supplied no streaming callback for that stream.
   *
   * Present for a caller that just wants the output; absent when the caller is streaming (the bytes
   * already went to its callback) — so no consumer has to re-implement chunk collection, and a
   * forgotten callback can no longer discard output silently.
   */
  readonly stdout?: string;
  readonly stderr?: string;
}
```

- `NodeProcessRunner.exec` collects a stream **only when that stream has no callback** and returns the
  bounded text (`maxOutputBytes` cap, same truncation accounting as today: a stream that hits the cap
  sets `truncated` ✓ and keeps the existing "truncation tail" semantics used by `formatToolOutput`).
- When a callback IS supplied, the field is omitted (the caller is streaming; duplicating the bytes in
  the result would double the memory for the largest outputs ✓ — the review explicitly says callbacks
  stay for streaming ✓).
- Consumers migrate: `docker-adapter`'s `safeRun`, `devcontainer-adapter`'s `exec`/`runCli`,
  `capabilities`' `probeExecutable`, the docker lifecycle's `logs`/`destructive` and
  `src/host-runner.ts` all collect only to read the text afterwards, so each drops its `chunks.push`
  block and reads `result.stdout` / `result.stderr` instead. The lifecycle's `logs` is the one
  interesting case: it must keep its stderr LABELLING (`--- stderr ---`), which it now produces from
  `result.stdout` + `result.stderr` — no callback needed, and the labelling test still decides it.
  Truncation accounting is unchanged everywhere.
- Tests: a caller with no callbacks receives both streams; a caller with callbacks receives them and
  no duplicate fields; the cap still truncates and still sets `truncated`; a zero-length stream is an
  empty string (present, not missing) so "no output" and "not captured" stay distinguishable.

### 3.4 Slices

1. **Lifecycle guard** (`L0-04`): `src/lifecycle.ts` + the facade's checks + tests.
2. **Structured argv** (`L2-04`): the new grammar, the refusal of the old form, `parseArgv` deleted,
   the docs/CHANGELOG breaking change, and the invariant tests (guard, audit, empty/space values).
3. **Process result output** (`L5-03`): the `ProcessResult` fields, the runner's collection rule, and
   the adapter migrations with their tests.
4. **Hygiene**: the acceptance matrix in `task.json`, `npm run build` **and commit `dist/`** before
   sealing, the full gate set.

## 4. Acceptance matrix

| AC | Implementation | Tests | Evidence |
|---|---|---|---|
| AC-1 | `src/lifecycle.ts` (new), `extensions/index.ts` | `tests/unit/lifecycle.test.ts` (new: current/superseded/shutdown), plus the facade wiring described as smoke-covered | `npm run test:unit`, `npm run typecheck` |
| AC-2 | `src/commands.ts` (the `host-exec` handler, `parseArgv` removed) | `tests/unit/commands.test.ts`: repeated `--argv`, empty value, value with spaces, old free-text form refused, `--argv` without a value refused | `npm run test:unit` |
| AC-3 | `src/host-runner.ts`, `src/commands.ts` | `tests/unit/host-runner.test.ts` (literal argv for the new grammar), `tests/unit/commands.test.ts` (the guard sees the resolved argv, the audit fingerprint matches) | `npm run test:unit` |
| AC-4 | `src/runtime/process-runner.ts` + the adapters | `tests/unit/process-runner.test.ts` (no callbacks → fields present and exact; callbacks → fields omitted), adapter suites re-driven through the fields | `npm run test:unit` |
| AC-5 | `src/runtime/process-runner.ts`, `src/tool-output.ts` | `tests/unit/process-runner.test.ts` (cap + `truncated`), `tests/unit/tool-output.test.ts` (labelling and the persisted full output) | `npm run test:unit` |
| AC-6 | `dist`, `CHANGELOG.md`, `README*.md` | full suite | `npm run typecheck`, `npx vitest run`, `node scripts/verify-package.mjs --unit-tests`, `git diff --exit-code -- dist`, `node scripts/smoke-pi-package.mjs --no-model`, `npm run install:local -- --check` |

## 5. Risks, invariants and notes

- **`L2-04` is a public-API change** (the review's risk flag): the old form stops working. That is the
  finding's intent, but it must be a *documented* break with a migration example in the CHANGELOG and
  both READMEs, and the refusal must tell the operator the new form rather than just failing.
- **`L0-04` is the only change in this review that can affect `/reload` behaviour** (the review says
  so explicitly): a stale start must not register surfaces, but a *current* start must register them
  exactly as before, so the guard must not turn into "never engage". The tests cover both directions.
- **Behaviour that must not move:** the CLI still receives HOST paths (constraint 1) and no argv shape
  changes (constraint 2); discovery stays lazy/read-only/bounded (constraint 3) — the lifecycle guard
  only decides *whether to use* a discovery result ✓; `stop`/`remove` keep both gates (constraint 4);
  the child environment stays composed (constraint 5); host execution stays withheld-able and audited
  with the same operation/initiator/capture (constraint 6) — the grammar change alters how the
  argument list is built, never how it is transported or recorded; the platform boundary and win32
  branches survive (constraint 7); targets are never auto-started (constraint 8); `/devcontainer
  setup` is untouched (constraint 9); the audit trail keeps its shape, `0600` modes and fingerprint
  default (constraint 10).
- **The process-result fields are additive**: `stdout`/`stderr` are optional, so an adapter that
  supplies callbacks keeps working unchanged, and no consumer is forced to migrate in this phase
  beyond the ones that were collecting by hand.
- **`host-exec`'s tool twin stays as it is** (`devcontainer_host_exec` already takes a structured
  `argv` array) — making the command match the tool removes the divergence the finding describes,
  rather than adding a third grammar.
