---
date: 2026-09-15T08:46:53+0800
author: geebytes
commit: caa6525
branch: main
repository: pi-devcontainer-manager
target: .
target_kind: module
layer_count: 6
unresolved_finding_count: 0
phases:
  - { n: 1, title: Foundation, depends_on: [], blast_radius: internal, effort: S }
  - { n: 2, title: Failure observability, depends_on: [1], blast_radius: cross-module, effort: S }
  - { n: 3, title: Selection integrity, depends_on: [1], blast_radius: on-disk, effort: M }
  - { n: 4, title: Vocabulary and identity shapes, depends_on: [1, 3], blast_radius: cross-module, effort: M }
  - { n: 5, title: Public surfaces and the process boundary, depends_on: [1], blast_radius: cross-module, effort: M }
status: ready
tags: [architecture-review, pi-devcontainer-manager, devcontainer, pi-extension]
last_updated: 2026-09-15T10:07:32+0800
last_updated_by: geebytes
---

# Architecture review — pi-devcontainer-manager

A comprehensive architecture review of the `pi-devcontainer-manager` module: a host-side Pi extension that discovers, selects, and governs execution against DevContainers. The review covers all 23 production TypeScript files (`extensions/index.ts` and `src/**/*.ts`, about 5,617 LOC), excluding generated output, tests, dependencies, and documentation. The approved facade-first review order follows the public Pi registration surface inward through configuration, routing, governed execution, runtime adapters, and foundations.

---

## Conventions

### Finding shape

Each finding is a level-3 heading `### L<layer>-<seq> — <title>` followed by the fields below.

| Field | Meaning |
|---|---|
| **Evidence** | `file.ext:lineA-lineB` (+ short quote when useful) |
| **Current state** | what the code does today |
| **Desired state** | what we want it to look like |
| **Proposed improvement** | concrete action (rename, extract, merge, split, delete) |
| **Severity** | Low / Med / High — how wrong this is today |
| **Effort** | S / M / L — bounded changes ship cheaply |
| **Blast radius** | `internal` / `public-API` / `on-disk` / `cross-module` |
| **Class** | `polish` (rename / refactor / DRY) vs `redesign` (structural shift) |
| **Status** | `open` / `accepted` / `rejected` / `deferred` / `withdrawn` |
| **Depends on** | other finding IDs that must land first |
| **Cross-cut tag** | optional — see "Cross-cutting themes" |

### Status legend

- `open` — flagged, not yet triaged
- `accepted` — will land; includes the chosen option summary
- `rejected` — declined with reason inline
- `deferred` — accepted in principle but punted post-release
- `withdrawn` — initial diagnosis turned out incorrect; kept for audit

### Layers (top → down)

| # | Layer | Files |
|---|---|---|
| 0 | Facade and Pi lifecycle composition | `extensions/index.ts` |
| 1 | Session setup and execution context | `src/config.ts`, `src/activation.ts`, `src/selection-state.ts`, `src/execution-context.ts`, `src/path-mapper.ts` |
| 2 | Public execution surfaces | `src/commands.ts`, `src/tools.ts`, `src/bash-router.ts`, `src/tool-output.ts` |
| 3 | Governed execution core | `src/execution-service.ts`, `src/target-store.ts`, `src/policy.ts`, `src/audit.ts`, `src/errors.ts` |
| 4 | Discovery and runtime adapters | `src/runtime/host-discovery.ts`, `src/runtime/docker-adapter.ts`, `src/runtime/devcontainer-adapter.ts`, `src/runtime/docker-lifecycle.ts`, `src/runtime/capabilities.ts` |
| 5 | Foundations | `src/runtime/process-runner.ts`, `src/workspace-path.ts`, `src/types.ts` |

---

## Methodology principles

### M1 — One owner per invariant

**Origin:** Recurred across triage; stated most plainly when `L5-01` (three workspace-containment implementations), `L4-02` (three copies of the spawn-error mapping), `L3-01` (two refusal-record builders) and `L5-02` (five output-cap defaults) were all accepted as single-sourcing work rather than left as parallel copies.

**Rule.** When the same judgement is expressed in more than one place — identity, containment, error mapping, refusal auditing, output caps — treat the duplication as the defect and pick one owner in the lowest layer that can host it. Parallel copies are only acceptable when the variations are deliberate, and then the variation itself must be named (as `LOGS_MAX_OUTPUT_BYTES` is in `L5-02`) instead of left implicit in two literals.

**Apply to (keep):** single-sourcing of facts the code already agrees on; parameterized helpers (`mapSpawnError(error, { executable, missingKind })`); named constants for genuinely different limits.
**Apply to (drop / change):** copy-pasted mapping blocks, per-adapter private canonicalizers, duplicate record builders, and "defensive" second implementations kept for future callers.

### M2 — Refusals and degradations must be observable

**Origin:** `authorize()` already states the principle in code — a denial is recorded "so denials are visible in the audit trail instead of silently absent" — and triage extended it beyond policy: `L3-02` (bind refusals), `L4-01` (discovery diagnostics computed then discarded), `L2-02` (stderr dropped from structured results), `L5-03` (output lost without callbacks).

**Rule.** A value the code computes for a human — a refusal, a diagnostic, a truncated stream, a distinct error kind — must reach an operator or be deleted. "The operation still failed closed" is not sufficient: an unexplained empty result and a silently truncated scan are both indistinguishable from success at the point of use. Conversely, a kind or message must name what actually happened (`L4-03`, `L3-04`).

**Apply to (keep):** surfacing diagnostics through the existing warning channel; auditing refusals; carrying both streams; distinct error kinds per distinct cause.
**Apply to (drop / change):** fields returned but never consumed; kinds borrowed from a neighbouring failure; `unreachable`-only code paths that exist to satisfy the compiler.

### M3 — Documented behaviour is not a defect

**Origin:** Two findings were rejected because the repository already states the behaviour plainly — `L1-01` (trusted-project executable override) and `L3-08` (`retentionDays` honored only by an unscheduled `prune`).

**Rule.** Before filing a finding whose fix would reverse an existing decision, search the changelog and docs for that decision. If it is documented as intentional, either drop the candidate or keep it only when the documentation is what is wrong — and in that case the finding is about the doc, not the code. A rejected finding must cite the doc location in its Status line so the decision is not re-litigated next review.

**Apply to (keep):** findings where behaviour and documentation disagree; findings where a knob implies an effect it never has and nothing says so.
**Apply to (drop / change):** re-proposing a documented trade-off; treating a deliberate capability boundary (macOS/Linux only, no WSL translation) as a defect.

---

## Layer 0 — Facade and Pi lifecycle composition

Files: `extensions/index.ts`

### L0-01 — Remove dead tool-wrapper code

**Evidence**

`extensions/index.ts:929-974`

```ts
registerNamedTool(pi, () => getRuntime()?.tools.exec, "devcontainer_exec", devcontainerExecParams);
// ...
function resolveTool<TParams extends import("typebox").TSchema>(...) { ... }
```

**Current state**

`resolveTool` remains in the facade even though every live tool registration uses `registerNamedTool`; no production or test caller references it. It preserves an obsolete wrapper path that would omit the runtime-derived prompt metadata that `registerNamedTool` deliberately preserves.

**Desired state**

The facade exposes one documented lazy tool-registration wrapper, with no stale alternative for future changes to revive accidentally.

**Proposed improvement**

Delete `resolveTool` and its associated comment block; retain `registerNamedTool` as the sole wrapper.

- **Severity:** Low
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — delete the unused wrapper.
- **Depends on:** none
- **Cross-cut tag:** none

### L0-02 — Make DevContainer JSONC parsing string-safe

**Evidence**

`extensions/index.ts:516-526, 260-267`

```ts
.replace(/(^|[^:"'\\])\/\/.*$/gm, "$1")
// ... parse failure returns undefined
const violation = guardMapping !== undefined ? findContainerPath(argv, guardMapping.containerPath) : undefined;
```

**Current state**

The comment-strip regex can treat `//` inside ordinary JSON string values as a comment, making mapping resolution return `undefined`. The host execution guard then skips its container-path test because it only evaluates when a mapping exists.

**Desired state**

A valid JSONC configuration, including URLs or `//` inside strings, produces a mapping without silently weakening the host container-path guard.

**Proposed improvement**

Replace regex preprocessing with a string-safe JSONC parser and test comment markers, URLs, and `//` inside JSON string values.

- **Severity:** High
- **Effort:** M
- **Blast radius:** internal
- **Class:** redesign
- **Status:** **accepted** — use a JSONC parser.
- **Depends on:** none
- **Cross-cut tag:** `T1-fail-closed-boundaries`

### L0-03 — Normalize and audit setup install failures

**Evidence**

`extensions/index.ts:361-415`

```ts
const runResult = await runner.exec(argv[0]!, [...argv.slice(1)], { ... });
audit.write({ operation: "setup", ... });
// version probe alone is wrapped in try/catch
```

**Current state**

A rejected install spawn, timeout, or abort skips the only setup audit record and escapes as an unnormalized handler error, unlike host execution and the subsequent version probe.

**Desired state**

Every setup attempt is auditable and failure has a uniform structured command result.

**Proposed improvement**

Catch install-stage failures, write the corresponding `setup` audit record with error details, and return `{ installed: false, error }`.

- **Severity:** Med
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — audit and normalize install failures.
- **Depends on:** none
- **Cross-cut tag:** `T2-observable-failure-paths`

### L0-04 — Guard asynchronous lifecycle generations

**Evidence**

`extensions/index.ts:573, 591-620, 644-646`

```ts
let runtime: Runtime | undefined;
runtime = rt;
evidence.workspaceHasRunningContainer = await probeRunningContainer(rt, ctx.cwd);
registerDevcontainerTools(pi, () => runtime);
```

**Current state**

An asynchronous `session_start` can resume after another start, reload, or shutdown has superseded its shared runtime. It can then register surfaces from a stale activation decision whose callbacks dereference a newer or missing runtime.

**Desired state**

Composition, activation, and registration have one lifecycle owner; superseded starts cannot mutate the current session surface.

**Proposed improvement**

Track a monotonic lifecycle generation (or equivalent abort state) and verify it after each await before assigning/using runtime or registering surfaces.

- **Severity:** High
- **Effort:** M
- **Blast radius:** internal
- **Class:** redesign
- **Status:** **accepted** — add a lifecycle generation guard.
- **Depends on:** none
- **Cross-cut tag:** `T1-fail-closed-boundaries`

### Layer 0 — tally

| Status | Count |
|---|---|
| accepted | 4 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: `T1-fail-closed-boundaries`, `T2-observable-failure-paths`.
Cross-cutting tags reused: none.

Dependency edges within Layer 0: none.

---

## Layer 1 — Session setup and execution context

Files: `src/config.ts`, `src/activation.ts`, `src/selection-state.ts`, `src/execution-context.ts`, `src/path-mapper.ts`

### L1-01 — Establish trusted project executable-path policy

**Evidence**

`src/config.ts:178-179`; `extensions/index.ts:120-134`

```ts
dockerPath: project.dockerPath ?? global.dockerPath ?? DEFAULTS.dockerPath,
devcontainerPath: project.devcontainerPath ?? global.devcontainerPath ?? DEFAULTS.devcontainerPath,
```

**Current state**

Trusted project configuration overrides `dockerPath` and `devcontainerPath`, which become host-side adapter executables. The code offers no explicit policy statement or test establishing this as an intentional trusted-project exception to the other restrictive merge rules.

**Desired state**

The trusted-project override remains deliberate, visible, and regression-tested as part of the extension’s trust model.

**Proposed improvement**

Keep project precedence; document executable-path override as a trusted-project capability and add configuration/adapter-boundary coverage for its intended scope.

- **Severity:** Low
- **Effort:** S
- **Blast radius:** cross-module
- **Class:** polish
- **Status:** **rejected** — allow trusted override; document and test its trust-boundary intent.
- **Depends on:** none
- **Cross-cut tag:** `T1-fail-closed-boundaries`

### L1-02 — Persist `/devcontainer off` as an opt-out

**Evidence**

`src/selection-state.ts:66-74`; `src/commands.ts:324-325`; `extensions/index.ts:580, 594-599, 631-638`

```ts
// last parseable record wins
await services.targetStore.clear();
hasExplicitSelection: recovered !== undefined,
```

**Current state**

`off` clears only in-memory selection. The append-only session record remains and is restored as activation evidence when a session starts or reloads.

**Desired state**

An explicit opt-out survives restore until the operator selects a target again.

**Proposed improvement**

Add a versioned clear/tombstone selection entry; recovery returns the latest intent including opt-out, and a subsequent selection supersedes it.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** on-disk
- **Class:** redesign
- **Status:** **accepted** — add an opt-out tombstone.
- **Depends on:** none
- **Cross-cut tag:** `T3-persisted-selection-integrity`

### L1-03 — Validate restored candidate identity

**Evidence**

`src/selection-state.ts:16-24`; `src/commands.ts:166-171, 216-218`

```ts
// container IDs are ephemeral across rebuilds
id: candidateId,
if (hint.candidateId !== undefined && entry.ambiguous !== true) { ... }
```

**Current state**

Restore treats a persisted container ID as a selected candidate without checking current registry membership, despite the record’s own comment identifying IDs as ephemeral.

**Desired state**

A restored candidate is selected only when it exists in the fresh registry result; otherwise the system applies explicit missing/ambiguous reconciliation.

**Proposed improvement**

Resolve persisted candidate IDs against `entry.containerCandidates` before binding the target and test rebuilt/replaced-container paths.

- **Severity:** High
- **Effort:** M
- **Blast radius:** internal
- **Class:** redesign
- **Status:** **accepted** — validate then reconcile restored candidate identity.
- **Depends on:** none
- **Cross-cut tag:** `T3-persisted-selection-integrity`

### L1-04 — Preserve selected configuration through restore and context

**Evidence**

`src/selection-state.ts:16-24`; `src/commands.ts:141-174`; `extensions/index.ts:441-446`

```ts
// selection record has no configPath
mapping = readWorkspaceMapping(entry.configPath);
```

**Current state**

A live selection can retain a named configuration, but persistence drops it and per-turn context reads the registry primary configuration rather than the selected snapshot configuration.

**Desired state**

The selected configuration survives restore and drives mapping, prompt context, and host-path protection.

**Proposed improvement**

Persist a validated selected config identity and have mapping resolution prefer the target snapshot’s selected config path, with named-config recovery coverage.

- **Severity:** High
- **Effort:** M
- **Blast radius:** on-disk
- **Class:** redesign
- **Status:** **accepted** — persist selected config and use it for context/guard mapping.
- **Depends on:** L1-02, L1-03
- **Cross-cut tag:** `T3-persisted-selection-integrity`

### L1-05 — Populate container-only mount facts

**Evidence**

`src/execution-context.ts:27-31, 58-60`; `extensions/index.ts:449-453`

```ts
readonly containerOnlyMounts?: readonly string[];
// runtime only supplies candidateId, status, and mapping
```

**Current state**

The execution-context vocabulary and renderer advertise container-only mount facts, but the sole composition path never supplies them.

**Desired state**

The prompt receives these safety-relevant facts from a reliable configuration/runtime source.

**Proposed improvement**

Extract container-only mounts through the mapping/configuration path, supply them to `renderExecutionContext`, and add composition coverage.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** cross-module
- **Class:** redesign
- **Status:** **accepted** — implement the runtime data path.
- **Depends on:** L0-02
- **Cross-cut tag:** `T1-fail-closed-boundaries`

### L1-06 — Engage surfaces only after successful selection

**Evidence**

`extensions/index.ts:715-720`; `src/commands.ts:357-365, 387-388`

```ts
if (verb === "use" || verb === "up") engageDevcontainerSurfaces(...);
return `No container candidate found ...`;
return "Selection cancelled.";
```

**Current state**

The entrypoint engages container tools and replaces `bash` after `use` or `up` regardless of whether the command found/selected a target or the user cancelled.

**Desired state**

A successful command result explicitly establishes a valid target before it changes the session execution surface.

**Proposed improvement**

Expose a typed command outcome that distinguishes successful target establishment from errors/cancellation; only the former triggers engagement.

- **Severity:** High
- **Effort:** M
- **Blast radius:** cross-module
- **Class:** redesign
- **Status:** **accepted** — engage only on successful target establishment.
- **Depends on:** L1-03
- **Cross-cut tag:** `T1-fail-closed-boundaries`

### Layer 1 — tally

| Status | Count |
|---|---|
| accepted | 5 |
| rejected | 1 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: `T3-persisted-selection-integrity`.
Cross-cutting tags reused: `T1-fail-closed-boundaries`.

Dependency edges within Layer 1: `L1-04` depends on `L1-02` and `L1-03`; `L1-05` depends on `L0-02`; `L1-06` depends on `L1-03`.
---

## Layer 2 — Public execution surfaces

Files: `src/commands.ts`, `src/tools.ts`, `src/bash-router.ts`, `src/tool-output.ts`


### L2-01 — Refresh registry before reconciling successful `up`

**Evidence**

`src/commands.ts:304-305, 318-319`

```ts
const target = await resolveUpBuildTarget(args, ctx); // carries pre-up entries
const selection = await reconcileSelection(services, ctx, { workspaceKey: workspace }, target.entries);
```

**Current state**

The command reconciles a successful start using registry data captured before the container was created or started, despite its own comment promising a refreshed lookup.

**Desired state**

A completed `up` resolves selection from a registry refresh performed after the lifecycle operation, so the execution surface becomes usable immediately.

**Proposed improvement**

Call `refreshRegistry` after successful `up` and reconcile against its returned entries; cover config-only and previously-stopped target transitions.

- **Severity:** High
- **Effort:** S
- **Blast radius:** cross-module
- **Class:** redesign
- **Status:** **accepted** — refresh after `up` before reconciling.
- **Depends on:** L1-03
- **Cross-cut tag:** `T3-persisted-selection-integrity`

### L2-02 — Preserve stdout and stderr in tool results

**Evidence**

`src/tools.ts:99-101, 124-125`; `src/bash-router.ts:180-181`

```ts
outcome.stdout.length > 0 ? outcome.stdout : outcome.stderr
if (outcome.stdout.length > 0) execOptions.onData(Buffer.from(outcome.stdout, "utf8"));
if (outcome.stderr.length > 0) execOptions.onData(Buffer.from(outcome.stderr, "utf8"));
```

**Current state**

Structured execution chooses stdout whenever it exists and drops stderr from the displayed and persisted result, whereas routed bash emits both streams.

**Desired state**

Both public execution surfaces present a complete, unambiguous account of mixed command output.

**Proposed improvement**

Build a labeled combined output stream for `devcontainer_exec` before formatting/truncation; preserve both streams in nonzero-exit errors and add mixed-stream coverage.

- **Severity:** Med
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — combine and label stdout/stderr.
- **Depends on:** none
- **Cross-cut tag:** `T2-observable-failure-paths`

### L2-03 — Require a positive public timeout

**Evidence**

`src/tools.ts:29-32, 49-52`; `src/bash-router.ts:88-123`

```ts
timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
timer = setTimeout(() => { controller.abort(); ... }, timeoutMs);
```

**Current state**

The schema accepts `0`, but a supplied zero becomes an immediate abort timer rather than an intelligible default/no-timeout value.

**Desired state**

The tool schema and enforcement agree on a clear, useful timeout contract.

**Proposed improvement**

Require `timeoutSeconds` to be positive at the TypeBox boundary and cover zero rejection and valid fractional/whole timeout behavior.

- **Severity:** Low
- **Effort:** S
- **Blast radius:** public-API
- **Class:** polish
- **Status:** **accepted** — require a positive timeout.
- **Depends on:** none
- **Cross-cut tag:** `T2-observable-failure-paths`

### L2-04 — Replace free-text host-exec splitting with structured argv

**Evidence**

`src/commands.ts:535-545`

```ts
const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
while ((match = re.exec(input)) !== null) { ... }
```

**Current state**

The explicit host escape hatch accepts shell-like free text but implements only a narrow quote splitter, so escaped quotes, concatenated segments, and compound empty arguments are unexpectedly reinterpreted.

**Desired state**

A security-sensitive host command surface accepts arguments without ambiguous shell-like parsing.

**Proposed improvement**

Replace the slash-command free-text grammar with guided/structured argv collection; retain literal argv transport to the host runner and cover empty/space-containing arguments.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** public-API
- **Class:** redesign
- **Status:** **accepted** — require structured argv.
- **Depends on:** L0-03
- **Cross-cut tag:** `T1-fail-closed-boundaries`

### Layer 2 — tally

| Status | Count |
|---|---|
| accepted | 4 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: none.
Cross-cutting tags reused: `T1-fail-closed-boundaries`, `T2-observable-failure-paths`, `T3-persisted-selection-integrity`.

Dependency edges within Layer 2: `L2-01` depends on `L1-03`; `L2-04` depends on `L0-03`.
---

## Layer 3 — Governed execution core

Files: `src/execution-service.ts`, `src/target-store.ts`, `src/policy.ts`, `src/audit.ts`, `src/errors.ts`

### L3-01 — Route refusal records through the shared audit builder

**Evidence**

`src/execution-service.ts:394-405`; `:412-437`

```ts
// authorize(): a hand-built AuditRecord literal
this.options.audit.write({ version: 1, at: this.clock(), ... });
// audit(): the shared builder every other record flows through
private audit(snapshot, ctx, request, extra, targetIdOverride?) { ... }
```

**Current state**

`authorize()` composes its refusal record as its own object literal while every other record in the service is composed by `private audit()`. The two field sets are maintained in parallel, so a refusal record cannot inherit later additions — it already omits the command identity fields and duration/exit accounting that `audit()` derives.

**Desired state**

One record builder. A refusal record differs from a success record only by the denial override it carries, so the two can never drift apart.

**Proposed improvement**

Call `this.audit(snapshot, undefined, request, { outputTruncated: false })` from `authorize()` using the un-authorized snapshot, and delete the inline literal.

- **Severity:** Med
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — unify refusal records onto `audit()`.
- **Depends on:** none
- **Cross-cut tag:** `T2-observable-failure-paths`

### L3-02 — Audit pre-spawn target refusals

**Evidence**

`src/execution-service.ts:150-153`; `:391-405`

```ts
if (this.options.targetStore.snapshot().status === "none") {
  await this.options.autoSelect?.(request.workspace);
}
const ctx = this.options.targetStore.bind();   // throws outside any try
```

**Current state**

`bind()` throws `no-candidate`, `ambiguous-candidate`, `target-stopped`, or `refreshing` before the service's only audited boundary, so a refused operation is absent from the audit trail. This contradicts the documented intent of `authorize()`, which records a policy denial precisely so refusals are "visible in the audit trail instead of silently absent".

**Desired state**

Every refused operation is equally visible, whether the refusal came from policy or from target state.

**Proposed improvement**

Wrap the `bind()` call, write a refusal record with the failure as `errorSummary`, and rethrow the typed error unchanged.

- **Severity:** Med
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — audit bind-time refusals.
- **Depends on:** none
- **Cross-cut tag:** `T2-observable-failure-paths`

### L3-03 — Keep environment refusal inside the typed-error contract

**Evidence**

`src/policy.ts:87-91`; `src/errors.ts:31-63`

```ts
if (!isEnvironmentAllowed(name, allowlist)) {
  throw new Error(`Environment variable is not allowed: ${name}`);
}
```

**Current state**

`buildChildEnvironment` is the one refusal in the governed execution core that throws a bare `Error`, so `errorKindOf` classifies it as `unexpected` and the operator loses the kind/remedy vocabulary every sibling refusal provides. The branch is also unreachable from `ExecutionService` because `authorize()` rejects disallowed environment names first, which hides the inconsistency from tests.

**Desired state**

Environment refusal carries the same typed kind and remedy as the policy probe that normally pre-empts it.

**Proposed improvement**

Throw `new RuntimeError({ kind: "policy-denied", message, remedy })` and cover the direct-call path in unit tests.

- **Severity:** Low
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — throw a typed `RuntimeError`.
- **Depends on:** none
- **Cross-cut tag:** `T2-observable-failure-paths`

### L3-04 — Give the refreshing state its own error kind

**Evidence**

`src/target-store.ts:130-135`

```ts
if (selection.status === "refreshing") {
  throw new RuntimeError({
    kind: "target-stopped",
    message: "Target state is refreshing; retry the operation.",
```

**Current state**

A transient internal state borrows the error kind that means "the target is not running", so callers and any consumer of the typed kind cannot distinguish a momentary refresh from a stopped container, and the kind's usual remedy semantics disagree with this message's advice.

**Desired state**

The status-to-error-kind mapping reflects real semantics: a retryable transient state is not reported as a stopped target.

**Proposed improvement**

Add a distinct kind (for example `target-refreshing`) or map the transient state to a non-stopped kind, keep the retry remedy, and update the status/kind mapping in one place.

- **Severity:** Med
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — introduce a distinct kind for the transient state.
- **Depends on:** none
- **Cross-cut tag:** `T2-observable-failure-paths`

### L3-05 — Decide auto-selection inside the store's serialization queue

**Evidence**

`src/execution-service.ts:150-153`; `src/target-store.ts:88-100`

```ts
if (this.options.targetStore.snapshot().status === "none") {
  await this.options.autoSelect?.(request.workspace);
}
```

**Current state**

The "nothing is selected yet" test and the auto-select write are separated by an `await`, while `select`/`clear` are serialized inside the store. An explicit `/devcontainer use` committed in that window is overwritten by the later-enqueued auto-select, contradicting the hook's stated contract that an explicit prior selection always wins.

**Desired state**

Auto-selection commits only if the store is still empty at commit time, so an explicit selection can never be clobbered.

**Proposed improvement**

Add `TargetStore.selectIfNone(selection)` that performs the emptiness check inside `enqueue`, and have the service call it instead of the snapshot-plus-select pair.

- **Severity:** Med
- **Effort:** S
- **Blast radius:** internal
- **Class:** redesign
- **Status:** **accepted** — add an atomic `selectIfNone`.
- **Depends on:** none
- **Cross-cut tag:** `T3-persisted-selection-integrity`

### L3-06 — Redact whole credential values, not matching prefixes

**Evidence**

`src/policy.ts:113-120`

```ts
out = out.replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9\-._~+/=]+/gi, "$1 [REDACTED]");
```

**Current state**

The auth-scheme rule matches only a restricted character class, and the following `key: value` rule then consumes the remainder of the token as its "key". A value containing any character outside that class is redacted only up to that character: `Authorization: Bearer sk-abc,def` is written to the audit file as `Authorization: [REDACTED],def`, leaking the tail of a live credential. The same truncation applies to non-ASCII values.

**Desired state**

Everything after the auth scheme is replaced, whatever characters the credential contains.

**Proposed improvement**

Consume the whole value up to whitespace in rule 1 (`\s+\S+`), widen rule 2's bare-token alternative to `[^\s]+`, and add regression coverage for values containing `,` `;` `:` quotes and CJK characters.

- **Severity:** Med
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — redact whole values and add regression cases.
- **Depends on:** none
- **Cross-cut tag:** `T4-credential-redaction`

### L3-07 — Bind container identity instead of trusting the caller

**Evidence**

`src/execution-service.ts:347-374`, `:303-341`; `src/commands.ts:487-497`, `:565-585`

```ts
result = await this.options.dockerLifecycle.logs(request.containerId, { ... });
result = await this.options.dockerLifecycle[request.operation](request.container, request.confirmation);
```

**Current state**

`logs`, `stop`, and `remove` accept a caller-supplied container identity, never call `bind()`, and record that identity as the audit `targetId`. The `exec` path enforces the opposite discipline: it re-resolves the target, refuses a request whose workspace differs from the bound target (AC-8), and always sends the bound workspace to the adapter so "authorization scope, execution, and audit cannot disagree". Two surfaces of the same service therefore hold different invariants about whether the operated container belongs to the authorized workspace.

**Desired state**

One invariant for every operation: the container acted on is derived from (or verified against) the bound target, and the audit record's target identity comes from that binding.

**Proposed improvement**

Bind in `logs`/`lifecycle` and verify the supplied container id against the bound target's registry candidates before the adapter call, or derive the container inside the service; keep `request.container` only as an explicit pre-bind override with its own audit field.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** cross-module
- **Class:** redesign
- **Status:** **accepted** — bind and verify container identity in the service.
- **Depends on:** none
- **Cross-cut tag:** `T1-fail-closed-boundaries`

### L3-08 — Retention pruning stays unscheduled

**Evidence**

`src/audit.ts:42-52`; `CHANGELOG.md:58-59`; `docs/configuration.md:224-226`

```ts
prune(now: Date): void { /* never called from src/ or extensions/ */ }
```

**Current state**

`retentionDays` (default 90) is honored only by a writer method that nothing in the runtime schedules, so the audit directory grows without bound and the configuration knob has no observable effect. Both the changelog and the configuration doc state plainly that v1 does not schedule pruning, so the limitation is documented rather than concealed.

**Desired state**

Retention is either executed or continuously described as an unwired capability, never silently implied to be active.

**Proposed improvement**

Either call `writer.prune(now)` during session setup so `retentionDays` takes effect, or keep the current documented-unscheduled posture and leave the knob described as writer-only.

- **Severity:** Low
- **Effort:** S
- **Blast radius:** on-disk
- **Class:** polish
- **Status:** **rejected** — keep unscheduled; both the changelog and the configuration doc already state that v1 does not schedule pruning, so the retention window is not overclaimed.
- **Depends on:** none
- **Cross-cut tag:** `T2-observable-failure-paths`

### L3-09 — Make the status-to-error mapping exhaustive

**Evidence**

`src/target-store.ts:108-180`

```ts
if (selection.status === "none") { throw new RuntimeError({ kind: "no-candidate", ... }); }
if (selection.status === "refreshing") { throw new RuntimeError({ kind: "target-stopped", ... }); }
// ... five more repeated blocks, then an unreachable defensive branch
```

**Current state**

`bind()` repeats the same `RuntimeError` construction once per selection status and ends with a branch that cannot be reached (`selected-valid` with an undefined candidate), so the mapping is not single-sourced and a newly added `SelectionStatus` produces no compiler signal — it silently falls through to the same `unexpected` branch.

**Desired state**

One exhaustive dispatch from status to refusal error, with a `never` guard that makes a future status a compile error.

**Proposed improvement**

Replace the chain with an exhaustive `switch` over `selection.status` returning the error options, and drop the unreachable fallback.

- **Severity:** Low
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — refactor to an exhaustive switch with a `never` guard.
- **Depends on:** L3-04
- **Cross-cut tag:** `T2-observable-failure-paths`

### L3-10 — Host-side and container-side workspace paths (withdrawn)

**Evidence**

`src/execution-service.ts:214-218`; `:265`; `:301`

```ts
const presentedWorkspace = await this.options.resolveContainerWorkspace(ctx.workspaceKey) ?? ctx.workspaceKey;   // exec
workspaceKey: canonicalWorkspaceKey(request.workspace),   // up and build
```

**Current state**

As originally filed: `exec` presents the container-side workspace when a mapping exists while `up` and `build` report the canonical host path, which read as two vocabularies for one workspace.

**Desired state**

Corrected during triage: these are not two spellings of the same identity. `up` and `build` are host-side operations run by the Dev Containers CLI on the host — `build` produces an image and has no container at all, and `up` already carries the container-side path separately in `remoteWorkspaceFolder`. Reporting host identity for them is correct; only `exec`, the operation that actually runs inside the container, presents a container-side path to the agent. The split is the design, not a defect.

**Proposed improvement**

No code change. If a follow-up is wanted, it is documentation only: state in the adapter and outcome docs that `exec` presents the container-side workspace while `up`/`build` report host identity, so a later reader does not "unify" the two.

- **Severity:** Low
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **withdrawn** — the initial diagnosis was incorrect: the two paths belong to host-side (`up`/`build`) versus container-side (`exec`) operations, and `build` has no container to map.
- **Depends on:** none
- **Cross-cut tag:** none

### Layer 3 — tally

| Status | Count |
|---|---|
| accepted | 8 |
| rejected | 1 |
| deferred | 0 |
| withdrawn | 1 |

Cross-cutting tags introduced: `T4-credential-redaction`.
Cross-cutting tags reused: `T1-fail-closed-boundaries`, `T2-observable-failure-paths`, `T3-persisted-selection-integrity`.

Dependency edges within Layer 3: `L3-09` depends on `L3-04`.

---

## Layer 4 — Discovery and runtime adapters

Files: `src/runtime/host-discovery.ts`, `src/runtime/docker-adapter.ts`, `src/runtime/devcontainer-adapter.ts`, `src/runtime/docker-lifecycle.ts`, `src/runtime/capabilities.ts`

### L4-01 — Surface (or delete) discovery diagnostics

**Evidence**

`src/runtime/host-discovery.ts:388`; `extensions/index.ts:173-174, 196`; `src/runtime/docker-adapter.ts:16-20`

```ts
return { entries, configOnly, orphanDockerCandidates, diagnostics };
const dockerCandidates = (await docker.listDevContainers()).containers;   // .errors dropped
```

**Current state**

Host discovery and Docker parsing both produce diagnostics — unreadable directories, symlink escapes out of the allowed root, `maxDepth` pruning (whose code comments say "surface it once instead of silently stopping"), and Docker candidates with no `devcontainer.local_folder` label — but every production caller destructures only `entries`/`containers`. The remaining fields are referenced exclusively by unit tests, so a truncated or degraded discovery looks identical to an empty one.

**Desired state**

A degraded discovery reaches the operator through the same warning channel that already renders config-load diagnostics, or the fields stop being computed and returned.

**Proposed improvement**

In the command/service layer, emit `diagnostics` (and `DockerDiscoveryResult.errors`) through `ctx.ui.notify` as warnings the way `loaded.diagnostics` already is; drop `configOnly`/`orphanDockerCandidates` if they stay unconsumed.

- **Severity:** Med
- **Effort:** S
- **Blast radius:** cross-module
- **Class:** redesign
- **Status:** **accepted** — surface discovery diagnostics to the operator.
- **Depends on:** none
- **Cross-cut tag:** `T2-observable-failure-paths`

### L4-02 — Single-source the spawn-error mapping and runner plumbing

**Evidence**

`src/runtime/docker-adapter.ts` (`safeRun` catch); `src/runtime/docker-lifecycle.ts` (`rethrowMapped`); `src/runtime/devcontainer-adapter.ts` (`rethrowMappedSpawnError`, `runCli`); six `unreachable … path` throws

```ts
if (error instanceof RuntimeError && error.kind === "executable-missing") {
  throw new RuntimeError({ kind: "daemon-unavailable", ... });
}
throw new RuntimeError({ kind: "unexpected", message: "unreachable exec path" });
```

**Current state**

The same two-case spawn mapping (`executable-missing` → `daemon-unavailable`, `spawn-permission-denied` → `authorization-denied`) is copy-pasted into three adapters, and the copies have already diverged — the Dev Containers adapter reports a missing executable as `devcontainer-cli-failure` instead. Each of the six call sites is additionally followed by a compile-time-only `unreachable … path` throw, and the runner invocation block (cwd, env, byte cap, timeout, signal, both stream callbacks) is assembled twice inside `devcontainer-adapter.ts` alone.

**Desired state**

One parameterized mapper and one invocation helper serve every runtime adapter, with no dead throws and no drift between tools.

**Proposed improvement**

Extract a runtime-layer helper (for example `mapSpawnError(error, { executable, missingKind, remedy })` returning an `Error`) plus a shared `runBounded()` invocation wrapper; call them with `throw` from each catch.

- **Severity:** Med
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — extract a shared spawn-error mapper and invocation helper.
- **Depends on:** none
- **Cross-cut tag:** `T2-observable-failure-paths`
### L4-03 — Attribute Docker lifecycle failures to Docker

**Evidence**

`src/runtime/docker-lifecycle.ts:141-147`

```ts
kind: "devcontainer-cli-failure",
message: `docker ${action} failed with exit ${result.exitCode}.`,
```

**Current state**

A failed `docker stop`/`docker rm` is reported under the kind that names the Dev Containers CLI, so the operator and any consumer of the typed kind attribute a Docker fault to a different executable than the one that ran. The kind's remedy text also points at daemon reachability, which is correct, while the kind says otherwise.

**Desired state**

The failure kind names the tool that actually failed.

**Proposed improvement**

Add a Docker-specific failure kind (or reuse a tool-neutral container-runtime kind) and cover the stop/remove nonzero-exit path in the adapter's unit tests.

- **Severity:** Low
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — report Docker failures under a Docker-specific kind.
- **Depends on:** none
- **Cross-cut tag:** `T2-observable-failure-paths`

### L4-04 — Read registry state from one discriminant, not field combinations

**Evidence**

`src/types.ts:35-53`; `src/runtime/host-discovery.ts:376-387`; `extensions/index.ts:201`

```ts
readonly configPath: string;      // "" for docker-label-only entries
readonly containerId?: string;    // first discovered, may not be the running one
readonly containerCandidates?: readonly RegistryCandidate[];
readonly ambiguous?: boolean;
```

**Current state**

A single `RegistryEntry` encodes "no configuration exists", "no container candidate exists", "several candidates exist", and "several running candidates exist" through a required-but-sentinel `configPath: ""`, four optional fields, and the `discoveredFrom` union — with the doc comment naming `discoveredFrom` as "the authoritative discriminator" precisely because the shape is not self-describing. Consumers must reconstruct the state by combining fields (for example `entry.configPath.length === 0`), and the primary `containerId` may disagree with `containerCandidates`.

**Desired state**

The entry's state is read from a single discriminant, so consumers cannot forget a sentinel check and the primary candidate's relationship to its siblings is explicit.

**Proposed improvement**

Convert `RegistryEntry` to a discriminated union (host-config vs docker-label vs both), make `configPath` present only where a configuration exists, and keep candidate identity in one collection with an explicit "primary" marker.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** cross-module
- **Class:** redesign
- **Status:** **accepted** — convert to a discriminated union.
- **Depends on:** none
- **Cross-cut tag:** `T5-registry-state-vocabulary`

### Layer 4 — tally

| Status | Count |
|---|---|
| accepted | 4 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: `T5-registry-state-vocabulary`.
Cross-cutting tags reused: `T2-observable-failure-paths`.

Dependency edges within Layer 4: none (`L4-04` rewrites the same `configPath`/`containerCandidates` reads that `L1-03` and `L1-04` depend on, so those should land first).


---

## Layer 5 — Foundations

Files: `src/runtime/process-runner.ts`, `src/workspace-path.ts`, `src/types.ts`

### L5-01 — Consolidate workspace identity and containment into one owner

**Evidence**

`src/policy.ts:54-72`; `src/workspace-path.ts:24-42`; `src/execution-service.ts:163`

```ts
export function isWorkspaceAllowed(workspace: string, roots: readonly string[]): boolean   // realpath-aware, own canonicalForPolicy
export function isPathBelow(workspace: string, root: string, platform?): boolean            // lexical prefix compare
const withinTarget = requestKey === targetKey || requestKey.startsWith(`${targetKey}/`);   // third copy, inline
```

**Current state**

"Is this workspace the one we authorized?" is answered three different ways: policy containment resolves `realpath` and compares with `relative`, `isPathBelow` compares canonicalized string prefixes, and `exec` compares keys inline. Their fallbacks also disagree — `canonicalForPolicy` falls back to `resolve`, while `resolveRealPath` falls back to `canonicalWorkspaceKey`, which lowercases on Windows. A symlinked or case-differing path can therefore pass one check and fail another, and the two failures land in different refusal paths.

**Desired state**

One canonicalization function and one containment function, owned by the foundations layer and reused by policy, discovery, and the execution service.

**Proposed improvement**

Delete `canonicalForPolicy` and `isPathBelow`'s private logic, have `isWorkspaceAllowed` and `exec`'s target check both call the shared containment helper, and pin the chosen fallback semantics with tests for symlinks and case-differing paths.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** cross-module
- **Class:** redesign
- **Status:** **accepted** — consolidate identity and containment into `workspace-path.ts`.
- **Depends on:** none
- **Cross-cut tag:** `T1-fail-closed-boundaries`

### L5-02 — Keep one named output-cap default

**Evidence**

`src/runtime/process-runner.ts:50,61`; `src/runtime/devcontainer-adapter.ts:178,212`; `src/runtime/docker-adapter.ts:121`; `src/runtime/docker-lifecycle.ts:89,138`; `extensions/index.ts:135-147,304,365`

```ts
const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024;   // process-runner
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;   // devcontainer-adapter
maxOutputBytes: this.options.maxOutputBytes ?? 64 * 1024,   // docker-adapter
```

**Current state**

Five fallback caps of three different sizes (50, 64, and 256 KiB) are spread across the runner and three adapters, yet every production call site passes `config.maxOutputBytes` explicitly, so none of the fallbacks is reachable outside unit tests. The naming suggests a layered default policy that does not exist, and a future caller that omits the option silently gets a tool-dependent cap.

**Desired state**

A single named default, in one place, with the adapters either inheriting it or requiring an explicit value.

**Proposed improvement**

Export one `DEFAULT_MAX_OUTPUT_BYTES` from the runtime layer, import it in the adapters, and remove the duplicated literals; keep the 256 KiB logs cap as an explicitly named `LOGS_MAX_OUTPUT_BYTES`.

- **Severity:** Low
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — keep a single named default.
- **Depends on:** none
- **Cross-cut tag:** none

### L5-03 — Let the process result carry its bounded output

**Evidence**

`src/runtime/process-runner.ts:5-11,17-19`; `src/runtime/docker-adapter.ts` (`safeRun`); `src/runtime/devcontainer-adapter.ts` (`exec`, `runCli`); `src/runtime/capabilities.ts` (`probeExecutable`); `extensions/index.ts` host-runner note

```ts
export interface ProcessResult { exitCode; signal; durationMs; truncated; }
readonly onData?: (chunk: Buffer) => void;
readonly onStderr?: (chunk: Buffer) => void;
```

**Current state**

The process boundary's result type carries no output at all: bytes exist only if the caller supplied callbacks, so every consumer re-implements the same `chunks.push` collection block, and the host runner's own comment records the sharp edge — without callbacks, "the host's stdout/stderr would be discarded". Any new caller that forgets the callbacks silently loses all output while still receiving a clean exit code.

**Desired state**

A result that carries the bounded streams it already knows how to bound, while callbacks remain available for live streaming.

**Proposed improvement**

Add optional bounded `stdout`/`stderr` strings (or buffers) to `ProcessResult`, populated whenever the caller did not supply callbacks, and migrate the adapter collection blocks to the new fields.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** cross-module
- **Class:** redesign
- **Status:** **accepted** — carry bounded output on `ProcessResult` (callbacks retained for streaming).
- **Depends on:** none
- **Cross-cut tag:** `T2-observable-failure-paths`

### Layer 5 — tally

| Status | Count |
|---|---|
| accepted | 3 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: none.
Cross-cutting tags reused: `T1-fail-closed-boundaries`, `T2-observable-failure-paths`.

Dependency edges within Layer 5: none (`L5-01` overlaps the identity reads that `L4-04` and `L3-07` rewrite).

---

## Cross-cutting themes

### T1 — Fail-closed boundaries (active)

**Findings:** `L0-02`, `L0-04`, `L1-01` (rejected), `L1-05`, `L1-06`, `L2-04`, `L3-07`, `L5-01`.

Everything that decides *what the extension is allowed to touch*: the string-safe JSONC parse that keeps the container-path guard meaningful, the lifecycle-generation guard that stops a superseded session from re-registering surfaces, the surfaces that must engage only after a real selection, container-only mounts that must reach the prompt, the structured argv grammar of the host escape hatch, and the container-identity binding on `logs`/`stop`/`remove`. The thread lands when containment itself has one owner (`L5-01`): each of these findings currently checks a boundary with its own private copy of "is this the same workspace", so the shared helper is the closing move. `L1-01` stays rejected — the trusted-project executable override is deliberate, and the finding was really a request to document it.

### T2 — Observable failure paths (active)

**Findings:** `L0-03`, `L2-02`, `L2-03`, `L3-01`, `L3-02`, `L3-03`, `L3-04`, `L3-08` (rejected), `L3-09`, `L4-01`, `L4-02`, `L4-03`, `L5-03`.

The largest theme, and the one with the most independent instances: setup failures that skip their audit record, structured results that drop stderr, a `timeoutSeconds: 0` that reads as a default but aborts immediately, refusal records built by a second code path, target-state refusals that are unaudited entirely, an environment refusal that escapes the typed-error contract, a transient refresh reported as a stopped target, discovery diagnostics computed and thrown away, a spawn mapping duplicated until it drifted, Docker failures filed under the Dev Containers CLI's kind, and a process result that loses its output unless the caller remembered two callbacks. It closes when whatever the code knows about a failure reaches an operator with a kind and remedy that name the real cause — `L4-01` and `L3-02` are the visible ends of that thread. `L3-08` stays rejected: the retention window is documented as unscheduled, so the missing effect is a documented capability boundary rather than a defect.

### T3 — Persisted selection integrity (active)

**Findings:** `L1-02`, `L1-03`, `L1-04`, `L2-01`, `L3-05`.

The session selection is written to an append-only log, read back at activation, and reconciled against a fresh registry — and each step currently drops or mistrusts something: `off` is not persisted as an opt-out, a restored container ID is trusted without registry membership (though the record's own comment calls IDs ephemeral), the selected named configuration never survives the round trip, a successful `up` is reconciled against pre-`up` entries, and the auto-select race can clobber an explicit `/devcontainer use`. The thread delivers one contract: what was selected — including not-selecting — is what the next session resumes, and nothing else may overwrite it.

### T4 — Credential redaction (active)

**Findings:** `L3-06`.

A single finding today, kept as its own theme because it governs a different kind of surface: the audit file is the one place where secrets can outlive the process, and its redaction is documented as best-effort. The finding shows the best-effort boundary failing in a way the documentation does not cover — an auth-scheme value is redacted only up to the first character outside a fixed class, so `Bearer sk-abc,def` lands in the log as `[REDACTED],def`. Closing it means whole-value replacement plus regression cases for the characters that currently terminate the match.

### T5 — Registry state vocabulary (active)

**Findings:** `L4-04`.

One finding, and deliberately narrow: `RegistryEntry` encodes "no configuration", "no container", "several containers" and "several running containers" as a combination of optional fields plus a `configPath: ""` sentinel whose doc comment has to declare which field is the real discriminator. Every consumer of the registry — selection recovery, mapping resolution, status rendering — re-derives that state by hand. Converting it to a discriminated union is what lets the other themes stop hand-rolling state checks.

---

## Consolidated polish plan

28 accepted findings, topo-sorted by their `Depends on` edges and grouped by leverage. No source file was modified during this review; each phase below is a self-contained unit of work for `blueprint` → `implement`.

### Phase 1 — Foundation

Low-risk, dependency-free polish, all of it `internal`: single-source the helpers that currently exist in multiple copies and fix the two mislabelled kinds.

- **Findings:** 8 — `L0-01`, `L3-01`, `L3-03`, `L3-04`, `L3-06`, `L4-02`, `L4-03`, `L5-02`.
- **Files touched:** 9 — `extensions/index.ts`, `src/execution-service.ts`, `src/policy.ts`, `src/errors.ts`, `src/target-store.ts`, `src/runtime/process-runner.ts`, `src/runtime/docker-adapter.ts`, `src/runtime/docker-lifecycle.ts`, `src/runtime/devcontainer-adapter.ts`.
- **Blast-radius mix:** 8 `internal`, 0 `public-API`, 0 `on-disk`, 0 `cross-module`.
- **Coordination:** none.
- **Class mix:** 8 polish / 0 redesign.
- **Dependency:** none.

### Phase 2 — Failure observability

Make the failures the code already detects visible, and tighten the timeout contract at the tool boundary.

- **Findings:** 5 — `L0-03`, `L2-02`, `L2-03`, `L3-02`, `L4-01`.
- **Files touched:** 6 — `extensions/index.ts`, `src/commands.ts`, `src/tools.ts`, `src/bash-router.ts`, `src/execution-service.ts`, `src/runtime/host-discovery.ts`.
- **Blast-radius mix:** 3 `internal`, 1 `public-API`, 0 `on-disk`, 1 `cross-module`.
- **Coordination:** none.
- **Class mix:** 5 polish / 0 redesign.
- **Dependency:** Phase 1 (shares `execution-service.ts` and `extensions/index.ts`).
- **⚠ Risk flag — `public-API`:** `L2-03` narrows the `devcontainer_exec` / routed-bash `timeoutSeconds` schema from `minimum: 0` to a positive minimum, so a caller that passes `0` today (which aborts immediately) starts failing validation instead.

### Phase 3 — Selection integrity

One contract for the session selection: what was selected — including *not* selecting — survives restore, and reconciliation never trusts a stale identity.

- **Findings:** 8 — `L0-02`, `L1-02`, `L1-03`, `L1-04`, `L1-05`, `L1-06`, `L2-01`, `L3-05`.
- **Files touched:** 6 — `extensions/index.ts`, `src/selection-state.ts`, `src/commands.ts`, `src/execution-service.ts`, `src/target-store.ts`, `src/execution-context.ts`.
- **Blast-radius mix:** 2 `internal`, 0 `public-API`, 2 `on-disk`, 4 `cross-module`.
- **Coordination:** none.
- **Class mix:** 0 polish / 8 redesign.
- **Dependency:** Phase 1.
- **⚠ Risk flag — `on-disk`:** `L1-02` and `L1-04` extend the append-only selection record (a versioned opt-out tombstone and a validated configuration identity). Existing session logs must keep restoring without a migration, and the new records must degrade to the current behaviour when read by an older runtime.

### Phase 4 — Vocabulary and identity shapes

Give identity one owner and one shape: the registry entry stops encoding state in sentinels, container identity stops being caller-supplied, and workspace containment stops being implemented three times.

- **Findings:** 4 — `L3-07`, `L3-09`, `L4-04`, `L5-01`.
- **Files touched:** 7 — `src/types.ts`, `src/runtime/host-discovery.ts`, `src/workspace-path.ts`, `src/policy.ts`, `src/execution-service.ts`, `src/target-store.ts`, `src/commands.ts`.
- **Blast-radius mix:** 1 `internal`, 0 `public-API`, 0 `on-disk`, 3 `cross-module`.
- **Coordination:** none.
- **Class mix:** 1 polish / 3 redesign.
- **Dependency:** Phase 3 (`L4-04` rewrites the `configPath`/`containerCandidates` reads that `L1-03` first made trustworthy), Phase 1 (`L3-09` builds on the distinct kind from `L3-04`).
- **⚠ Risk flag — `cross-module`:** `RegistryEntry` is consumed by the command layer, the execution service, and discovery, so the union conversion in `L4-04` is the phase's widest change and the phase should not be split mid-conversion.

### Phase 5 — Public surfaces and the process boundary

Close the loop on the two user-facing surfaces and the process contract they stand on.

- **Findings:** 3 — `L0-04`, `L2-04`, `L5-03`.
- **Files touched:** 6 — `extensions/index.ts`, `src/commands.ts`, `src/runtime/process-runner.ts`, `src/runtime/docker-adapter.ts`, `src/runtime/devcontainer-adapter.ts`, `src/runtime/capabilities.ts`.
- **Blast-radius mix:** 1 `internal`, 1 `public-API`, 0 `on-disk`, 1 `cross-module`.
- **Coordination:** none.
- **Class mix:** 0 polish / 3 redesign.
- **Dependency:** Phase 1 (`L5-03` extends the shared invocation helper extracted by `L4-02`).
- **⚠ Risk flag — `public-API`:** `L2-04` replaces the free-text grammar of `/devcontainer host-exec` with structured argv, a documented user-facing surface; `L0-04` adds a lifecycle generation guard to the facade, which is the only change in this review that can affect `/reload` behaviour.

### Host and DevContainer contract constraints

Every phase above is scoped to preserve the real host/container split and the pinned Dev Containers CLI contract. These are the invariants a phase implementation is checked against, each drawn from the code the review read:

1. **Host-side and container-side paths stay distinct.** `devcontainer up|build|exec` are all invoked with `--workspace-folder <host path>` and the CLI maps it itself; `up`/`build` report host identity because they run on the host (`build` produces an image and has no container), and only `exec`, which runs inside the container, presents a container-side path to the agent. No phase may collapse the two, and a container path must never be handed to the CLI.
2. **The pinned 0.88.0 argv contract is unchanged.** `up`/`build` emit exactly one JSON document on stdout regardless of log format; `exec` must never be given `--log-format json` (it hides command stdout); allowlisted variables cross via repeated `--remote-env name=value`; `exec`'s exit code is the container-side command's own code and is carried in the result, never thrown. Phase 1's `L4-02` consolidates error mapping and the invocation wrapper only — no argv shape changes.
3. **Host-side reads stay lazy, read-only, and bounded.** Discovery is demand-driven (facade ordering constraint 6), scans only the session cwd plus `allowedWorkspaceRoots`, never enters hidden or excluded directories, refuses symlink escapes out of the allowed root, and stops at `discovery.maxDepth`. Phase 2's `L4-01` surfaces the diagnostics this traversal already produces; it must not make discovery eager or gate startup on it.
4. **Destructive operations keep BOTH gates.** `stop`/`remove` require a policy grant *and* a fresh per-action confirmation token that names the exact action and container ID. Phase 4's `L3-07` adds container-identity verification on top; it must not weaken the adapter-level confirmation check, and `logs` stays read-only (`docker logs --tail`).
5. **The container environment stays composed, never inherited.** Only `environmentAllowlist` names that are neither `PI_*` nor secret-looking cross into the container, and the child environment is built from scratch. No phase may forward the host Pi environment, and Phase 1's `L3-03` keeps the refusal typed rather than relaxing the filter.
6. **Host execution remains an explicit escape hatch.** `/devcontainer host-exec` and `devcontainer_host_exec` stay gated on `hostExecution.allow`, audited, and transported as literal argv (no shell). Phase 5's `L2-04` changes only the argument *grammar* of that surface.
7. **The platform boundary is unchanged.** macOS and Linux only, with no WSL translation; the deliberate win32 branches (case-folded canonical keys, direct kill instead of process-group signalling) survive Phase 4's `L5-01` consolidation rather than being normalized away.
8. **Targets are never auto-started.** Auto-selection may only select an existing candidate — a config-only or stopped project is selected in `selected-stopped` so `exec` fails closed with the `/devcontainer up` remedy. Phase 3 must not introduce an implicit start.
9. **`/devcontainer setup` stays a confirmed host-side install.** Fixed argv, timeout, and a version probe on the host; Phase 2's `L0-03` adds failure auditing and a structured result without widening what the command may run.
10. **The audit trail stays host-local and capture-mode-consistent.** Records are written under the documented per-platform directory with `0600` modes and fingerprint-only command capture by default; Phase 1's `L3-06` hardens credential redaction inside the existing capture modes without changing their defaults.

### Dependency graph

```
Phase 1 (Foundation)
   ├──► Phase 2 (Failure observability)
   ├──► Phase 3 (Selection integrity)
   │        ↓
   │     Phase 4 (Vocabulary and identity shapes)
   └──► Phase 5 (Public surfaces and the process boundary)
```

`in-progress` → `ready` flips when this plan is confirmed. The rejected findings (`L1-01`, `L3-08`) and the withdrawn `L3-10` carry no phase; they remain in the artifact as documented decisions.
