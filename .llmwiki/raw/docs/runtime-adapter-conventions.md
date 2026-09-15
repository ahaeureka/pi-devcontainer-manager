---
source_path: .kata/tasks/arch-review-p1-foundation/wiki/runtime-adapter-conventions.md
ingested: 2026-09-15T05:37:19.247Z
sha256: 0217d41e7a38eb2303e43b4b1d037561d05e12aaec44ad89f52c496d73f3ea6a
---
# Runtime adapter conventions (pi-devcontainer-manager)

Rules the runtime adapters follow after the Phase 1 consolidation
(`arch-review-p1-foundation`, findings `L4-02` and `L5-02`). Follow these when touching
`src/runtime/docker-adapter.ts`, `docker-lifecycle.ts` or `devcontainer-adapter.ts`, and when
adding a new adapter.

## 1. Spawn through `runBounded`, never `runner.exec` directly

`runBounded(runner, file, args, options)` in `src/runtime/process-runner.ts` owns the option
block (cwd, env, cap, timeout, signal, stream callbacks) and maps a failed spawn before it
leaves the call. An adapter that calls `runner.exec` itself is re-introducing the duplication
that existed in three copies and had already drifted.

## 2. Each executable gets a named spawn-error spec

`src/runtime/spawn-error.ts` holds the mapper (`mapSpawnError`) and the specs. The per-tool
mapping is deliberate — do not normalise it:

| Executable | missing executable → | permission denied → |
|---|---|---|
| Docker (`dockerSpawnErrorSpec`) | `daemon-unavailable` | `authorization-denied` |
| Dev Containers CLI (`devcontainerSpawnErrorSpec`) | `devcontainer-cli-failure` | `authorization-denied` |

`mapSpawnError` returns an `Error` instead of throwing, so a call site writes
`throw mapSpawnError(error, spec)` and needs no `catch`. Never reintroduce a
`throw new RuntimeError({ kind: "unexpected", message: "unreachable … path" })` after a
`catch`: six of those existed only to satisfy the compiler and were removed.

## 3. Output caps come from the runner

`DEFAULT_MAX_OUTPUT_BYTES` (50 KiB) and `LOGS_MAX_OUTPUT_BYTES` (256 KiB) are exported from
`src/runtime/process-runner.ts` and imported by the adapters. Production always passes
`config.maxOutputBytes` (`extensions/index.ts` wires it), so the exported defaults are the
documented fallback rather than a policy — the previous five literals of three different sizes
(50/64/256 KiB) disagreed with each other and only differed in tests.

## 4. Timeouts stay per-adapter and explicit

`runBounded` takes `timeoutMs` as a required option: `docker logs` 30 s, docker lifecycle
60 s, Dev Containers CLI 300 s (overridable via `AdapterLimits`). The config ceiling
(`maxTimeoutSeconds`) clamps *tool-requested* timeouts, not these adapter defaults.

## Evidence

`tests/unit/spawn-error.test.ts` pins the mapper and both specs;
`tests/unit/process-runner.test.ts` pins `runBounded`'s option forwarding, its spawn mapping
and the exported caps; the existing `docker-adapter` and `devcontainer-adapter` suites pin the
per-tool kinds; `tests/unit/docker-lifecycle.test.ts` pins the confirmation gate and the
`docker-cli-failure` result.
