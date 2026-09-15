# Design — arch-review-p1-foundation

`task: arch-review-p1-foundation` · `role: designer` · `phase: plan`
`branch: feature/arch-review-p1-foundation` · `base: main@68b0daf`
`profile: git_flow / tdd / security`
`source: .rpiv/artifacts/architecture-reviews/2026-09-15_08-46-53_pi-devcontainer-manager.md`
`matrix: .rpiv/artifacts/architecture-reviews/2026-09-15_08-46-53_pi-devcontainer-manager-phase1-requirements.json`

Owner-facing messages stay Chinese per the Kata skill; this artifact keeps the technical
contract in English so it can be read alongside the code.

## 1. Problem

Phase 1 (Foundation) of the architecture review holds the eight findings whose common
property is that **one judgement is expressed in more than one place** (review principle M1),
plus two error kinds that name the wrong thing (M2). None of them changes an operator-visible
capability; together they remove the drift that later phases would otherwise have to work
around:

| # | Finding | Duplication or mislabel |
|---|---|---|
| 1 | `L0-01` | A dead tool-wrapper (`resolveTool`) sits beside the live one |
| 2 | `L3-01` | Refusal records are built by a second literal, not the shared builder |
| 3 | `L3-03` | One refusal escapes the typed-error contract as a bare `Error` |
| 4 | `L3-04` | A transient state reports the *stopped* error kind |
| 5 | `L3-06` | Credential redaction is a second, partial implementation of "hide the value" |
| 6 | `L4-02` | The spawn-error mapping and runner invocation exist three times, already drifted |
| 7 | `L4-03` | Docker failures report the Dev Containers CLI's kind |
| 8 | `L5-02` | Five fallback output caps of three different sizes |

## 2. Scope

Only these eight findings plus their documentation residue. Every acceptance criterion below
is traceable to a finding ID; nothing in Phase 2–5 of the review is touched.

## 3. Technical design

### 3.1 `L0-01` — delete the dead tool wrapper

`extensions/index.ts:934-975` defines `resolveTool` (comment block plus function). `registerNamedTool`
immediately above is the live wrapper and preserves the runtime-derived prompt metadata that
`resolveTool` would drop. `grep -rn "resolveTool" --include=*.ts` returns the definition only —
no production or test caller.

**Change:** delete lines 934-975. **Guard:** the deletion is compiler-proved — any surviving
caller fails `npm run typecheck`, which is this slice's test-first step (write nothing else;
run typecheck, confirm it passes, delete, confirm it still passes).

### 3.2 `L3-01` — route refusal records through the shared builder

`src/execution-service.ts:394-405` builds a denial `AuditRecord` as its own literal inside
`authorize()`, while `private audit()` (`:412-437`) builds every other record. The literal
already omits the command identity that the builder derives.

**Change:**

```ts
this.audit(
  snapshot,
  undefined,
  { operation: input.operation, initiator: input.initiator,
    ...(input.workspace !== undefined ? { workspace: input.workspace } : {}) },
  { outputTruncated: false },
);
```

**Record equivalence (must be asserted):** `workspaceIdentity(undefined, request)` yields
`request.workspace`; `snapshot.authorized` is `false`; `snapshot.denialReason` is present;
`outputTruncated` is `false`; `commandIdentity` returns `{}` because a refusal carries no
`cmd`. The emitted JSON is therefore identical apart from nothing — the test compares the
parsed record before and after the refactor.

### 3.3 `L3-03` — keep environment refusal inside the typed-error contract

`src/policy.ts:88-90` throws a bare ``new Error(`Environment variable is not allowed: ${name}`)``,
so `errorKindOf` classifies it `unexpected` while the sibling policy refusal is
`policy-denied`.

**Change:** import `RuntimeError` from `./errors.js` (no cycle: `errors.ts` imports nothing)
and throw `new RuntimeError({ kind: "policy-denied", message: \`Environment variable is not allowed: ${name}\`,
remedy: "Add the variable name to environmentAllowlist or drop it from the request." })`.
The message keeps naming the variable.

### 3.4 `L3-04` — give the transient state its own kind

`src/errors.ts:10-23` lists the kinds; `src/target-store.ts:130-135` maps the internal
`refreshing` status to `kind: "target-stopped"` while its message says the state is refreshing.

**Change:** add `"target-refreshing"` to the union and use it in that branch (message and
remedy unchanged). `selected-stopped`, `selected-missing` and the not-running check keep
`target-stopped`.

**Blast radius check (verified):** no exhaustive `switch` over `ErrorKind` exists; `errorKindOf`
has no production call site; `describeError` renders `[${error.kind}]` generically. The only
other place kinds are enumerated is documentation (`docs/troubleshooting.md:15-26`,
`docs/configuration.md:122`), which this task updates.

### 3.5 `L3-06` — redact whole credential values

`src/policy.ts:116` redacts only the prefix that matches `[A-Za-z0-9\-._~+/=]+`, so a value
containing any other character survives from that character on — `Authorization: Bearer
sk-abc,def` lands as `Authorization: [REDACTED],def`, and a CJK value is redacted not at all.

**Change (rule 1 only):**

```ts
out = out.replace(/\b(Bearer|Basic|Token)(\s+)("[^"]*"|'[^']*'|\S+)/gi, (_m, scheme: string, space: string, value: string) => {
  const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : "";
  return `${scheme}${space}${quote}[REDACTED]${quote}`;
});
```

The whole value to the next whitespace is consumed; a leading quote is preserved so quoted
commands stay parseable-looking. Rule 2's bare-token alternative (`[^\s"']+`) already runs to
whitespace and needs no change; it is covered by a regression case, not by an edit. Rule 1
consuming a trailing quote in `-H 'Authorization: Bearer eyJ.abc'` is expected and matches the
existing test's contract (`not.toContain`).

### 3.6 `L4-02` — one spawn-error mapper, one bounded invocation

Three adapters repeat the same two-case mapping and assemble the same runner options:

| Site | Mapping today |
|---|---|
| `src/runtime/docker-adapter.ts` (`safeRun`, `:112-140`) | missing → `daemon-unavailable`, denied → `authorization-denied` |
| `src/runtime/docker-lifecycle.ts` (`rethrowMapped`, `:174-192`) | same |
| `src/runtime/devcontainer-adapter.ts` (`rethrowMappedSpawnError`, `:225-243`) | missing → `devcontainer-cli-failure`, denied → `authorization-denied` (already drifted) |

Six `kind: "unexpected", message: "unreachable … path"` throws exist purely to satisfy the
compiler: `docker-lifecycle.ts:102,153`, `devcontainer-adapter.ts:198,222,270,288`.

**Change — new `src/runtime/spawn-error.ts`:**

```ts
export interface SpawnErrorSpec {
  readonly executable: string;
  readonly missingKind: "daemon-unavailable" | "devcontainer-cli-failure";
  readonly missingMessage: string;
  readonly missingRemedy: string;
  readonly permissionMessage: string;
  readonly permissionRemedy: string;
}
export function mapSpawnError(error: unknown, spec: SpawnErrorSpec): Error;
```

`mapSpawnError` returns the mapped `RuntimeError` (preserving `cause`) for
`executable-missing` / `spawn-permission-denied`, and returns the original error unchanged
otherwise. Returning an `Error` rather than `never` is what lets callers write
`throw mapSpawnError(error, spec)` and drop the dead trailing throws.

**Change — `src/runtime/process-runner.ts` gains:**

```ts
export interface BoundedRunOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly onData?: (chunk: Buffer) => void;
  readonly onStderr?: (chunk: Buffer) => void;
  readonly spawnError: SpawnErrorSpec;
}
export async function runBounded(runner: ProcessRunner, file: string, args: readonly string[], options: BoundedRunOptions): Promise<ProcessResult>;
```

`runBounded` assembles the runner options and maps spawn failures before rethrowing, so the
adapters lose their `try`/`catch` and their unreachable throws. Existing per-tool behaviour is
preserved verbatim, including timeouts (docker 30 s logs / 60 s destructive, CLI 300 s) and
each adapter's stream capture.

**`parseUp` / `parseBuild` (`devcontainer-adapter.ts:245-289`) are restructured** so the
nonzero-exit path throws and the zero-exit path returns, removing the last two dead throws
without changing which error is produced for which CLI output.

### 3.7 `L4-03` — attribute Docker failures to Docker

`src/runtime/docker-lifecycle.ts:141-147` throws `kind: "devcontainer-cli-failure"` with the
message `docker ${action} failed with exit ${result.exitCode}.`.

**Change:** add `"docker-cli-failure"` to `ErrorKind` and use it there (message, `exitCode`
and remedy unchanged), plus the documentation rows from §3.4.

### 3.8 `L5-02` — one named output cap

`src/runtime/process-runner.ts:27` (`50 * 1024`) and `src/runtime/devcontainer-adapter.ts:103`
(`64 * 1024`) both call themselves `DEFAULT_MAX_OUTPUT_BYTES`; `docker-adapter.ts:121` and
`docker-lifecycle.ts:138` use bare `64 * 1024`; `docker-lifecycle.ts:89` uses `256 * 1024`.
Every production call site passes `config.maxOutputBytes`, so no fallback is reachable in
production.

**Change:** export `DEFAULT_MAX_OUTPUT_BYTES` (50 KiB) and `LOGS_MAX_OUTPUT_BYTES` (256 KiB)
from `process-runner.ts`; import them in the three adapters and delete the local constant and
the three literals.

**Deliberate, test-visible side effect:** an adapter constructed without an explicit cap now
falls back to 50 KiB instead of 64 KiB (logs stays 256 KiB). Production is unaffected because
`extensions/index.ts` always supplies `config.maxOutputBytes`; the change is called out here so
the reviewer does not read it as drift.

## 4. Acceptance matrix

| AC | Implementation | Tests | Evidence |
|---|---|---|---|
| AC-1 (`L0-01`) | `extensions/index.ts` | `npm run typecheck`; `tests/unit/dormant-bash.test.ts`, `tests/unit/activation.test.ts`, `tests/unit/tools.test.ts` | typecheck + `npm run test:unit` |
| AC-2 (`L3-01`) | `src/execution-service.ts` | `tests/unit/execution-service.test.ts` (denial record deep-equal), `tests/unit/audit.test.ts` | `npm run test:unit` |
| AC-3 (`L3-03`) | `src/policy.ts` | `tests/unit/policy-hardening.test.ts` (direct `buildChildEnvironment` call) | `npm run test:unit` |
| AC-4 (`L3-04`) | `src/errors.ts`, `src/target-store.ts`, `docs/troubleshooting.md`, `docs/configuration.md` | `tests/unit/target-store.test.ts` | `npm run test:unit` |
| AC-5 (`L3-06`) | `src/policy.ts` | `tests/unit/policy-hardening.test.ts` (`redactText` describe) | `npm run test:unit` |
| AC-6 (`L4-02`) | `src/runtime/spawn-error.ts` (new), `src/runtime/process-runner.ts`, `src/runtime/docker-adapter.ts`, `src/runtime/docker-lifecycle.ts`, `src/runtime/devcontainer-adapter.ts` | `tests/unit/spawn-error.test.ts` (new), existing `docker-adapter`, `devcontainer-adapter`, `process-runner` suites | `npm run test:unit` |
| AC-7 (`L4-03`) | `src/errors.ts`, `src/runtime/docker-lifecycle.ts`, `docs/troubleshooting.md` | `tests/unit/docker-lifecycle.test.ts` (new) | `npm run test:unit` |
| AC-8 (`L5-02`) | `src/runtime/process-runner.ts`, three adapters | `tests/unit/process-runner.test.ts`, adapter suites asserting the captured `maxOutputBytes` | `npm run test:unit` |
| AC-9 (no regression) | `dist/`, `CHANGELOG.md` | full suite | `npm run typecheck`, `npm run test:unit`, `node scripts/verify-package.mjs --unit-tests`, `git diff --exit-code -- dist`, `node scripts/smoke-pi-package.mjs --no-model` |

## 5. Build order (TDD, four slices)

1. **Runtime plumbing** (`L5-02`, `L4-02`) — export the caps, add `spawn-error.ts` and
   `runBounded`, migrate the three adapters, delete the dead throws, restructure
   `parseUp`/`parseBuild`. New tests: `spawn-error.test.ts`; existing adapter suites must stay
   green unchanged.
2. **Error kinds** (`L3-04`, `L4-03`, `L3-03`) — union additions, the three call sites, the two
   documentation rows. New tests: `docker-lifecycle.test.ts`, plus the `policy-hardening` and
   `target-store` cases.
3. **Execution core** (`L3-01`, `L3-06`) — refusal records onto the shared builder, whole-value
   redaction. Characterization test first for the denial record, regression cases for values
   containing `,`, `;`, `:`, quotes and CJK.
4. **Facade and release hygiene** (`L0-01`) — delete `resolveTool`; rebuild `dist`, add the
   CHANGELOG entry, run the full gate set from AC-9.

Each slice ends green with `npm run typecheck` and `npm run test:unit` before the next begins.

## 6. Out of scope

- Every other finding in the review (Phases 2–5): the un-audited bind refusals (`L3-02`),
  discarded discovery diagnostics (`L4-01`), `ProcessResult` carrying output (`L5-03`),
  container-identity binding (`L3-07`), the registry union (`L4-04`), and the rest.
- New configuration keys, changes to `src/config.ts` defaults, or any change to the
  `hostExecution` / destructive / route-mode policy surface.
- The `.llmwiki` wiki store and the Comet lifecycle: untouched by this task.

## 7. Risks and notes

- **`dist/` is committed.** Every slice must end with `npm run build`; CI fails on a stale
  commit (`git diff --exit-code -- dist`). `dist` is already an owned path.
- **Seal-time owned paths.** `ownedPaths` today is `src, extensions, tests, dist, CHANGELOG.md`.
  This design adds two paths that must be declared when sealing — `openspec` (this artifact)
  and `docs` (the kind lists in `troubleshooting.md` / `configuration.md`) — via
  `kata-cli build --seal --owned-path openspec --owned-path docs`. This is exactly the lesson
  the archived `activation-and-config-mechanism` task recorded after its design artifact landed
  outside the sealed revision.
- **Fallback cap change (50 vs 64 KiB)** is test-visible but production-neutral; see §3.8.
- **No public Pi surface changes.** The tool names, parameters and prompt text are untouched;
  the only operator-visible differences are two error kinds and the redacted-text output.
- **Review mode is `security`**, so the reviewer will scrutinise §3.5 (redaction) and §3.3
  (environment refusal) most closely; both are covered by tests that fail before the change.
