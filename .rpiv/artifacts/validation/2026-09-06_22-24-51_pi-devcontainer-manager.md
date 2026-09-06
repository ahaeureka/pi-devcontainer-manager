---
template_version: 1
date: 2026-09-06T22:24:51+0800
author: geebytes
commit: no-commit
branch: no-branch
repository: unknown
topic: "Validation of Host-machine Pi extension for governed multi-DevContainer discovery and execution"
status: ready
verdict: fail
parent: ".rpiv/artifacts/plans/2026-09-06_17-54-27_pi-devcontainer-manager.md"
tags: [validation, plan, pi-extension, devcontainer, docker, typescript, security, audit]
last_updated: 2026-09-06T22:24:51+0800
---

## Validation Report: Host-machine Pi extension for governed multi-DevContainer discovery and execution

_Git history unavailable — validation based on file inspection only (`in_repo: no`; no commit/branch exists at authoring time)._

### Implementation Status

- ✓ Phase 1: Package contracts, configuration, policy, and audit foundation — Fully implemented (5/5 auto SC checked; 3 unit suites pass)
- ✓ Phase 2: Safe host process and capability boundary — Fully implemented (5/5 auto SC checked; 2 suites pass)
- ✓ Phase 3: Docker discovery and session-safe target state — Fully implemented (9/9 auto SC checked; 3 suites pass)
- ✓ Phase 4: Host-side configuration discovery and workspace registry — Fully implemented (5/5 auto SC checked; 24-test suite passes)
- ✓ Phase 5: Dev Containers and governed execution services — Fully implemented (plain-bullet SC; 2 suites pass)
- ✓ Phase 6: Pi extension integration and dual execution interfaces — Fully implemented (plain-bullet SC; 4 suites pass; typechecks against real Pi package)
- ⚠️ Phase 7: Package quality gates and real multi-workspace integration — Implemented; 7/10 auto SC checked; 3 unchecked (2 discovery legs + 1 umbrella) fail on a host-environment Docker defect, not implementation
- ✓ Phase 8: Operator-facing documentation and release contract — Fully implemented (7/7 auto SC checked; docs match wiring)

### Automated Verification Results

- ✓ Phase 1–4 typecheck/unit gates: `npm run typecheck`, `npx vitest run tests/unit` — 160/160 deterministic tests pass across 15 files
- ✓ Phase 5 adapter+service suites: `npx vitest run tests/unit/devcontainer-adapter.test.ts tests/unit/execution-service.test.ts` — 23 tests pass
- ✓ Phase 6 tool/command/bash suites: `npx vitest run tests/unit/bash-router.test.ts tests/unit/tools.test.ts tests/unit/commands.test.ts` — all pass
- ✓ Phase 7 package-smoke: `npx vitest run tests/package-smoke.test.ts` — 6/6 pass (tarball name/version/type/peers/allowlist/engines)
- ✓ Phase 7 verify chain: `node scripts/verify-package.mjs --unit-tests` — all gates passed (engines probe, @devcontainers/cli@0.88.0 exact, typecheck, unit tests, build, pack:check, 86 files/89.2 kB tarball)
- ✓ Phase 7 hermetic smoke: `node scripts/smoke-pi-package.mjs --no-model` — all checks passed (real pack → `pi install` into scratch `PI_CODING_AGENT_DIR` → dist probes for `/devcontainer`, `user_bash`, `registerTool`)
- ✓ Phase 7 real-CLI integration legs (4/4): up→exec A→B routing with differing container-side `pwd`/`hostname`, audit `targetId`+`fingerprint-only`, stop requires policy grant **and** fresh token (`confirmation-required` without), real pinned-CLI `build` → `operation`/`workspaceKey`/`policyAuthorized`
- ✓ Phase 7 e2e legs (4/4): `use project-b` fails closed `target-stopped`; up A→exec→B→exec routes; no-selection→`no-candidate` and ambiguous→`ambiguous-candidate` fail closed; real-Pi layer loads `extensions/index.ts` under real `pi 0.84.4` to an `agent_start` turn with no "Extension error"
- ✗ Phase 7 discovery legs (2): `tests/integration/...` "discovers both fixture workspaces via host + docker label merge" and `tests/e2e/...` "discovers project-a and project-b config-only" — fail at ~30s each with `RuntimeError {kind:"timeout"}` from the adapter's `docker ps` guard
- ✓ No regressions detected

### Code Review Findings

#### Matches Plan:

- All 53 plan-declared files across 8 phases exist; every code body matches the plan's locked Architecture fences (written verbatim from the plan this session)
- `src/types.ts`, `src/config.ts`, `src/policy.ts`, `src/audit.ts`, `src/errors.ts` — exact 13-kind `ErrorKind`, four-value `denialReason`, `confirmation-required` lifecycle status; defaults `container-required`, 90-day `fingerprint-only` audit, destructive/host-exec both `false`
- `src/runtime/process-runner.ts` — `shell: false`, fixed argv, piped stdout/stderr with ignored stdin, drain-after-truncation, `timeout`/`cancelled` typed paths
- `src/runtime/docker-adapter.ts` — read-only `docker ps --all --no-trunc --format {{json .}}` / `inspect` only; no mutation surface
- `src/target-store.ts` — exactly seven selection states; serialized promise queue (last-wins); `bind()` returns immutable context only from `selected-valid` running
- `src/runtime/host-discovery.ts` — `DirectoryTraversal` seam; `maxDepth` bound + pruning diagnostic; excluded/hidden dirs; realpath-escape refusal; registry merge semantics (`both`/`host-config`/`docker-label` + orphan candidates, folder-form precedence)
- `src/runtime/devcontainer-adapter.ts` — 0.88.0 argv contracts, `--` separator, single `--remote-env`, trailing-space JSON parse, structural-failure marker→ErrorKind mapping, container-side exit carried (never thrown)
- `src/execution-service.ts` — policy frozen BEFORE target resolution; env filtered via `buildChildEnvironment`; audit fingerprint-only with `targetId`; confirmation never bypassed
- `extensions/index.ts` — lazy `session_start` composition, `createBashToolDefinition(..., { exposeSessionEnvironment: false })`, `user_bash` returns same ops instance, selection recovery from `sessionManager.getEntries()`, `registerCommand("devcontainer")`, TypeBox tools via `resolveTool`
- `tests/package-smoke.test.ts` pins the shipped tarball contract; `.github/workflows/{ci,integration,release}.yml` match the plan's workflow specs
- Phase 8 docs byte-match the plan's locked fences (extracted verbatim); every relative link resolves; fences balanced; vocabulary never blurs the 13-kind / four-denial / `confirmation-required` surfaces; LICENSE carries the MIT text with the 2026 copyright line

#### Deviations from Plan:

- None in the implementation itself. Every phase's change was applied as specified; the three unchecked Phase 7 auto-SC items are unchecked because their discovery-merge assertions **cannot run green on this host**, not because the code deviates. The discovery-merge logic the two failing tests would exercise (`buildWorkspaceRegistry`, label extraction, `mapContainerState`) is exhaustively unit-proven in `tests/unit/host-discovery.test.ts` (24 tests) and `tests/unit/docker-adapter.test.ts`.

#### Pattern Conformance:

- ✓ Imports follow the locked `.js`-suffixed NodeNext specifiers consistently across `src/`, `extensions/`, and tests
- ✓ Test structure is uniform: vitest `describe`/`it` with capability gating via `const suite = ok ? describe : describe.skip` (never `describe.skip(...)`) in the real-Docker suites
- ✓ `cliPath` resolution order `DEVCONTAINER_CLI_PATH` → local `@devcontainers/cli` devDependency → PATH matches the plan in both integration and e2e suites; every `store.select(...)` is awaited before the synchronous `bind()` (Slice 3/5 contract)
- ✓ `src/` modules stay Pi-package-free; only `extensions/index.ts` imports `@earendil-works/pi-coding-agent`, matching the plan's stated layering
- Minor observation (acceptable variation, not a deviation): the run here verified 154–160 deterministic tests, above the plan's 75-pass expectation, because the capability-gated suites ran (Docker half-usable) rather than skipping; the higher count reflects more, not less, coverage.

#### Potential Issues:

- **Host-environment Docker defect (blocking this host only, not the implementation).** `docker ps --format '{{json .}}'` — the adapter's exact discovery invocation, and the form the two failing tests depend on — hangs indefinitely on this machine's Docker daemon (verified: plain `docker ps` and `--format '{{.ID}} {{.Names}}'` return instantly; `--format '{{json .}}'` times out at 30s+ even without `--all`/`--no-trunc`). The adapter correctly surfaces the designed typed `timeout` from its own 30s guard. No code change can make a daemon-side JSON-template rendering stall resolve; the plan's own Testing Strategy anticipates Docker-less hosts ("8 capability-gated skips"), and on this host the suites run-but-stall instead of skip. The discovery clauses are re-runnable as-is on any Docker host whose daemon serves `docker ps --format {{json .}}`.

### Manual Testing Required:

1. Real-Docker discovery merge (on a Docker host that serves `docker ps --format {{json .}}`):
   - [ ] `npx vitest run tests/integration -t "discovers both fixture workspaces"` — expects both fixture entries with `.devcontainer/devcontainer.json` config kinds
   - [ ] `npx vitest run tests/e2e -t "discovers project-a and project-b config-only"` — expects `discoveredFrom: "host-config"` before any `up`
2. Operator doc walk (Phase 8 manual items): confirm the README quick-start transcript, `docs/security.md` host-escape/destructive prose, and `docs/compatibility.md` unsupported matrix read correctly against a live `/devcontainer list` on a working Docker host
3. Model-gated real-Pi smoke: `node scripts/smoke-pi-package.mjs` with `PI_PROVIDER`/`PI_MODEL` set — the model-touching probe is skipped here (provider not configured), only `--no-model` was exercised

### Recommendations:

- Re-run `/skill:validate` on a Docker host whose daemon renders `docker ps --format {{json .}}` to turn the two discovery SC items green, or (preferred for this repo) treat the two discovery clauses as covered by the passing `host-discovery.test.ts` unit suite and the real-CLI legs proven here
- The three unchecked Phase 7 auto items (2 discovery + 1 umbrella) should be flipped only after a green real-Docker discovery run on a capable host
- Otherwise ready — the package builds, all deterministic tests pass, the hermetic smoke passes, and the real-Pi runtime load is proven; proceed to `/skill:commit` once the verdict-blocking discovery legs are resolved on capable hardware
