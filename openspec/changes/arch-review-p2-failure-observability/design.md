# Design — arch-review-p2-failure-observability

`task: arch-review-p2-failure-observability` · `role: designer` · `phase: plan`
`branch: feature/arch-review-p2-failure-observability` · `base: main@30f1d74`
`profile: git_flow / tdd / security`
`source: .rpiv/artifacts/architecture-reviews/2026-09-15_08-46-53_pi-devcontainer-manager.md`
`matrix: .rpiv/artifacts/architecture-reviews/2026-09-15_08-46-53_pi-devcontainer-manager-phase2-requirements.json`

Owner-facing messages stay Chinese per the Kata skill; this artifact keeps the technical
contract in English so it can be read alongside the code.

## 1. Problem

Phase 2 (Failure observability) of the architecture review holds the five findings whose shared
property is that **something the code already knows about a failure never reaches anyone**
(review principle M2). Phase 1 fixed the two mislabelled kinds and single-sourced the runtime
helpers; this phase closes the five places where a failure is computed and then dropped.

| # | Finding | What is computed and then lost |
|---|---|---|
| 1 | `L0-03` | A rejected setup install skips its audit record and returns an unnormalized error |
| 2 | `L2-02` | `devcontainer_exec` drops stderr whenever stdout exists (and same in the host hatch) |
| 3 | `L2-03` | `timeoutSeconds: 0` is accepted, then aborts the command immediately |
| 4 | `L3-02` | A `bind()` refusal is never audited, unlike a policy refusal |
| 5 | `L4-01` | Discovery diagnostics and Docker parse errors are computed and discarded |

## 2. Scope

Only these five findings plus their documentation residue. Every acceptance criterion below is
traceable to a finding ID; Phases 3–5 of the review are out of scope.

## 3. Technical design

### 3.1 `L0-03` — make the setup install an audited, testable unit

`extensions/index.ts:347-392` (`setupCli`) awaits `runner.exec(["npm","install","-g", …])` with
no `try`/`catch`; the `setup` audit record is written **after** the spawn returns. A rejected
spawn (npm missing, timeout, abort) therefore throws past the audit, and the `/devcontainer
setup` handler (`src/commands.ts`) reports it through the generic `describeError` path instead of
the structured `[setup-failed] …` one. The version probe below it *is* wrapped in `try`/`catch`,
so the same function treats its two stages inconsistently.

**Change — extract the stage into `src/setup-cli.ts`:**

```ts
export interface SetupCliDeps {
  readonly runner: ProcessRunner;
  readonly audit: AuditWriter;
  readonly config: EffectiveConfig;
  readonly sessionWorkspace: string;
  readonly env: Readonly<Record<string, string>>;
  readonly clock?: () => string;
}
export interface SetupCliResult {
  readonly installed: boolean;
  readonly version?: string;
  readonly error?: string;
}
/** One attempt = exactly one `setup` audit record, whatever stage fails. */
export function createSetupCli(deps: SetupCliDeps): (options?: { signal?: AbortSignal }) => Promise<SetupCliResult>;
```

- Install stage: wrap the spawn; on rejection write the `setup` audit record with
  `exitCode: null`, `durationMs`, `errorSummary: <failure>` (the audit writer redacts it) and
  return `{ installed: false, version: undefined, error: <failure> }`.
- Install stage success (including a nonzero exit): unchanged — one record carrying the real
  `exitCode`, then the existing nonzero-exit return.
- Version probe: unchanged (already returns `{ installed: false, error }`).
- `extensions/index.ts` becomes wiring: `setupCli: createSetupCli({ runner, audit, config, sessionWorkspace, env })`.

**Why extraction:** the closure is unreachable from a unit test today (only
`tests/unit/commands.test.ts`'s stub exercises the command side), so the failure path that this
finding is about cannot be tested where it lives. The extraction is the smallest change that
makes "one attempt, one record" assertable.

### 3.2 `L2-02` — present both streams of a structured execution

`src/tools.ts:99-101` (nonzero exit) and `:124-125` (success) both select
`stdout.length > 0 ? stdout : stderr`, so stderr disappears whenever stdout has anything —
while the routed bash path (`src/bash-router.ts:180-181`) replays both. The host hatch has the
same selection at `src/tools.ts:245-246`.

**Change — add to `src/tool-output.ts`:**

```ts
/** Label-then-append: stdout, then a `--- stderr ---` section when both exist. */
export function combineCommandOutput(stdout: string, stderr: string): string;
```

- Both empty → `""` (existing `(no output)` handling stays).
- One present → that stream unchanged (no new label; single-stream output is already unambiguous).
- Both present → `${stdout}\n--- stderr ---\n${stderr}`.

Use it in `devcontainer_exec` (nonzero-exit error text **and** the success `content`, so the
persisted/displayed result carries both) and in `devcontainer_host_exec`.

**Scope note:** the finding names `devcontainer_exec`; the host hatch has the identical defect in
the same module and is fixed with it rather than left as a known inconsistency. The routed bash
path already emits both streams and is untouched (Pi's `onData` contract has no labelling
channel).

### 3.3 `L2-03` — make the public timeout contract positive

`src/tools.ts:31` and `:43` declare `timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 }))`.
A supplied `0` reaches `executeWithTimeout` (`src/bash-router.ts:88-123`) as `timeoutMs = 0`,
where `setTimeout(…, 0)` fires immediately and the caller gets `timeout: Command timed out after
0s` — an abort, not a default.

**Change:** both schemas become `Type.Number({ exclusiveMinimum: 0 })`.

**Verified that Pi enforces it:** Pi validates tool arguments with TypeBox's compiler — the
installed Pi bundle imports `typebox/compile` and calls `validateToolArguments`, and it carries
`exclusiveMinimum`. Reproduced against the local TypeBox 1.3.28 with the same compiled check:
`{argv:["x"]}` → valid, `timeoutSeconds: 0` → **invalid**, `0.5` → valid, `900` → valid,
`-1` → invalid. Fractional timeouts therefore stay legal while zero and negatives are rejected
at the boundary instead of aborting.

Documentation residue: the tool table in `README.md:222-224` gains the "must be positive"
wording.

### 3.4 `L3-02` — audit pre-spawn target refusals

`src/execution-service.ts:150-153` runs `autoSelect` and then `bind()` **outside** any audit
boundary: `TargetStore.bind()` throws `no-candidate` / `ambiguous-candidate` / `target-stopped` /
`target-refreshing` before the service's only audited region, so a refused execution leaves no
trace — while `authorize()` deliberately records policy refusals "so denials are visible in the
audit trail instead of silently absent".

**Change:** wrap the auto-select + bind block:

```ts
let ctx: ExecutionContext;
try {
  if (this.options.targetStore.snapshot().status === "none") {
    await this.options.autoSelect?.(request.workspace);
  }
  ctx = this.options.targetStore.bind();
} catch (error) {
  this.audit(
    snapshot,
    undefined,
    { operation: request.operation, initiator: request.initiator, workspace: request.workspace },
    { outputTruncated: false, errorSummary: this.asAuditError(error).message },
  );
  throw error;
}
```

The record is honest about the two layers: `policyAuthorized: true` (policy passed) with the
domain failure in `errorSummary`. The typed error is rethrown unchanged, so the operator-facing
behaviour is identical apart from the new record.

**Scope note:** the same `try` covers the `autoSelect` hook, whose registry failures would
otherwise escape unaudited as well; the acceptance criterion names the `bind()` states and the
test asserts those.

### 3.5 `L4-01` — surface discovery diagnostics, delete the fields nobody reads

`src/runtime/host-discovery.ts:388` returns `{ entries, configOnly, orphanDockerCandidates,
diagnostics }`, but every production caller destructures only `entries`
(`extensions/index.ts:164-165`, `:174`, `:196`), and `registry()` also drops
`DockerDiscoveryResult.errors` (`src/runtime/docker-adapter.ts`). A degraded scan — unreadable
directory, symlink escape, `maxDepth` pruning, Docker candidate without the
`devcontainer.local_folder` label — is indistinguishable from an empty one, even though the
traversal code says "surface it once instead of silently stopping".

**Change, three parts:**

1. **A testable sink** — new `src/discovery-diagnostics.ts`:

```ts
export interface DiagnosticSink {
  /** Add lines, ignoring blanks and duplicates already collected. */
  add(lines: Iterable<string>): void;
  /** Return the un-reported lines and clear them. */
  drain(): string[];
}
export function createDiagnosticSink(): DiagnosticSink;
```

2. **Wire it** — the composed runtime owns one sink; `registry()` feeds it
   `<RegistryResult>.diagnostics` **and** `<DockerDiscoveryResult>.errors` on every pass; the
   `/devcontainer` command dispatch (`extensions/index.ts:690-717`) drains after the verb handler
   runs and emits each line through `ctx.ui.notify(line, "warning")` — the same channel the
   config-load diagnostics already use (`:627-629`). Dedupe lives in the sink, so a per-turn
   `executionContext()` registry call cannot spam the same warning.
   `probeRunningContainer` (activation chain step 4) must **not** notify: it has no UI guarantee
   and must stay silent and fail toward dormancy.

3. **Delete the unconsumed fields** — remove `configOnly` and `orphanDockerCandidates` from
   `RegistryResult` and stop collecting them in `buildWorkspaceRegistry`. The `docker-label`
   placeholder **entries** stay (the status renderer consumes them); only the duplicate
   collections go. Six assertions in `tests/unit/host-discovery.test.ts` (lines 331-332, 350,
   368, 394, 439) move to the behaviour that remains (entries + diagnostics).

## 4. Acceptance matrix

| AC | Implementation | Tests | Evidence |
|---|---|---|---|
| AC-1 (`L0-03`) | `src/setup-cli.ts` (new), `extensions/index.ts` wiring | `tests/unit/setup-cli.test.ts` (new): success, nonzero exit, rejected spawn (one record + `{installed:false,error}`), probe failure; `tests/unit/commands.test.ts` unchanged | `npm run test:unit` |
| AC-2 (`L2-02`) | `src/tool-output.ts`, `src/tools.ts` | `tests/unit/tool-output.test.ts` (helper), `tests/unit/tools.test.ts` (mixed streams in content, stderr in the nonzero-exit error) | `npm run test:unit` |
| AC-3 (`L2-03`) | `src/tools.ts`, `README.md` | `tests/unit/tools.test.ts` (compiled schema: `0`/`-1` rejected, omitted/`0.5`/`900` accepted) | `npm run test:unit` |
| AC-4 (`L3-02`) | `src/execution-service.ts` | `tests/unit/execution-service.test.ts` (no-selection refusal record + rethrown kind; refresh state) | `npm run test:unit` |
| AC-5 (`L4-01`) | `src/discovery-diagnostics.ts` (new), `extensions/index.ts`, `src/runtime/host-discovery.ts`, `src/types.ts` | `tests/unit/discovery-diagnostics.test.ts` (new), `tests/unit/host-discovery.test.ts` (fields gone, diagnostics kept) | `npm run test:unit` |
| AC-6 (no regression) | `dist/`, `CHANGELOG.md` | full suite | `npm run typecheck`, `npm run test:unit`, `node scripts/verify-package.mjs --unit-tests`, `git diff --exit-code -- dist`, `node scripts/smoke-pi-package.mjs --no-model`, `npm run install:local -- --check` |

## 5. Build order (TDD, five slices)

1. **Setup install** (`L0-03`) — extract `createSetupCli`, wrap the install stage, wire the
   extension. New `tests/unit/setup-cli.test.ts`.
2. **Stream completeness** (`L2-02`) — `combineCommandOutput` + both structured tools.
3. **Timeout contract** (`L2-03`) — schema constraint + README wording.
4. **Pre-spawn refusals** (`L3-02`) — audited bind/auto-select block.
5. **Discovery diagnostics** (`L4-01`) — sink, wiring, field removal, test updates.
6. **Release hygiene** — `CHANGELOG.md` entry, `npm run build` (commit `dist`), full gate set.

Each slice ends green with `npm run typecheck` and `npm run test:unit` before the next begins.

## 6. Out of scope

- Findings of Phases 3–5 (`L0-02`, `L1-02`…`L1-06`, `L2-01`, `L3-05`, `L3-07`, `L3-09`, `L4-04`,
  `L5-01`, `L0-04`, `L2-04`, `L5-03`).
- The routed bash path's unlabelled stream replay (already emits both; Pi's `onData` contract has
  no labelling channel) and Pi's own `timeout` semantics for `bash`.
- Any change to policy gates, the environment allowlist, host-execution gating, or the audit
  file's location/permissions.

## 7. Risks and notes

- **`dist/` is committed**: every slice ends with `npm run build`; CI fails on a stale commit.
- **Seal-time owned paths**: this branch also carries the local-install tooling
  (`scripts/install-local.mjs`, the `install:local` script in `package.json`,
  `docs/installation.md`), so sealing must declare
  `--owned-path docs --owned-path openspec --owned-path scripts --owned-path package.json`
  (recorded in the task's wiki note).
- **Public surface changes**: `L2-03` constrains a documented tool parameter (README table), and
  `L4-01` narrows an exported type (`RegistryResult`) consumed by tests. Both are additive from
  the operator's point of view; neither changes route mode, policy, or defaults.
- **Audit volume**: `L3-02` adds records only on refused operations, and `L4-01` emits each
  distinct diagnostic line once per session. Neither can flood the trail.
- **Review mode is `security`**: the reviewer will look hardest at §3.1 (a host-side global npm
  install — the change must not widen what it runs, only how failures are reported) and §3.5
  (the window between collection and display).
