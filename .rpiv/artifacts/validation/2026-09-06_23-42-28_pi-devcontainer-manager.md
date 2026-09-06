---
template_version: 1
date: 2026-09-06T23:42:28+0800
author: geebytes
commit: no-commit
branch: no-branch
repository: unknown
topic: "Validation of Host-machine Pi extension for governed multi-DevContainer discovery and execution"
status: ready
verdict: pass
parent: ".rpiv/artifacts/plans/2026-09-06_17-54-27_pi-devcontainer-manager.md"
tags: [validation, plan, pi-extension, devcontainer, docker, typescript, security, audit]
last_updated: 2026-09-06T23:42:28+0800
---

## Validation Report: Host-machine Pi extension for governed multi-DevContainer discovery and execution

_Git history unavailable — validation based on file inspection only (`in_repo: no`; no commit/branch exists at authoring time)._

### Implementation Status

- ✓ Phase 1: Package contracts, configuration, policy, and audit foundation — Fully implemented (5/5 auto SC checked; 3 unit suites pass)
- ✓ Phase 2: Safe host process and capability boundary — Fully implemented (5/5 auto SC checked; 2 suites pass)
- ✓ Phase 3: Docker discovery and session-safe target state — Fully implemented (9/9 auto SC checked; discovery `ps` format deviates from the plan's locked spec — see Deviations; real-Docker discovery now green)
- ✓ Phase 4: Host-side configuration discovery and workspace registry — Fully implemented (5/5 auto SC checked; 24-test suite passes)
- ✓ Phase 5: Dev Containers and governed execution services — Fully implemented (plain-bullet SC; 2 suites pass)
- ✓ Phase 6: Pi extension integration and dual execution interfaces — Fully implemented (plain-bullet SC; 4 suites pass; typechecks against real Pi package)
- ✓ Phase 7: Package quality gates and real multi-workspace integration — Fully implemented (all auto SC green after the discovery fix: 5/5 integration + 5/5 e2e + real-Pi layer pass on this host)
- ✓ Phase 8: Operator-facing documentation and release contract — Fully implemented (7/7 auto SC checked; docs match wiring)

### Automated Verification Results

- ✓ `npx tsc -p tsconfig.json --noEmit` — clean, zero errors (strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`)
- ✓ Deterministic suites: `npx vitest run tests/unit tests/package-smoke.test.ts` — 160/160 pass across 15 files
- ✓ `node scripts/verify-package.mjs --unit-tests` — all gates passed (engines probe, @devcontainers/cli@0.88.0 exact, typecheck, unit tests, build, pack:check, 86 files / 89.2 kB tarball)
- ✓ `node scripts/smoke-pi-package.mjs --no-model` — all checks passed (real pack → hermetic `pi install` into scratch `PI_CODING_AGENT_DIR` → dist probes for `/devcontainer`, `user_bash`, `registerTool`)
- ✓ Integration suite (real Docker + pinned CLI): `npx vitest run tests/integration --testTimeout=120000` — **5/5 pass**, including discovery merge (host config + docker labels for both fixtures), up→exec A→B routing with differing container-side `pwd`/`hostname`, audit `targetId`+`fingerprint-only`, stop requiring policy grant **and** fresh token, real pinned-CLI `build`
- ✓ E2E suite: `npx vitest run tests/e2e --testTimeout=120000` — **5/5 pass** when run in the CI-prescribed separate order (discovery `host-config`, `use project-b` fails closed `target-stopped`, up A→exec→B→exec routing, no-selection→`no-candidate`, ambiguous→`ambiguous-candidate`, real-Pi layer loads `extensions/index.ts` under real `pi` to an `agent_start` turn with no "Extension error")
- ✓ Full `npx vitest run` (all 17 files in parallel) — 168/170; the 2 failures are the known cross-file fixture race between the integration and e2e suites (integration's `up` creates fixture containers before e2e's discovery test expects `host-config`); the plan's own CI (`integration.yml`) runs the two suites in separate steps for exactly this reason, and both pass individually
- ✓ No regressions detected

### Code Review Findings

#### Matches Plan:

- All 53 plan-declared files across 8 phases exist; every code body matches the plan's locked Architecture fences except the Phase 3 discovery-format deviation documented below
- `src/types.ts`, `src/config.ts`, `src/policy.ts`, `src/audit.ts`, `src/errors.ts` — exact 13-kind `ErrorKind`, four-value `denialReason`, `confirmation-required` lifecycle status; defaults `container-required`, 90-day `fingerprint-only` audit, destructive/host-exec both `false`
- `src/runtime/process-runner.ts` — `shell: false`, fixed argv, piped stdout/stderr with ignored stdin, drain-after-truncation, `timeout`/`cancelled` typed paths
- `src/runtime/docker-adapter.ts` — read-only `docker ps --all --no-trunc` / `inspect` only; no mutation surface; parses full IDs/names/state/status/image/created/labels; extracts `devcontainer.local_folder` → `workspaceKey`; keeps duplicate labels as separate candidates; malformed records → `errors`
- `src/target-store.ts` — exactly seven selection states; serialized promise queue (last-wins); `bind()` returns immutable context only from `selected-valid` running
- `src/runtime/host-discovery.ts` — `DirectoryTraversal` seam; `maxDepth` bound + pruning diagnostic; excluded/hidden dirs; realpath-escape refusal; registry merge semantics (`both`/`host-config`/`docker-label` + orphan candidates, folder-form precedence)
- `src/runtime/devcontainer-adapter.ts` — 0.88.0 argv contracts, `--` separator, single `--remote-env`, trailing-space JSON parse, structural-failure marker→ErrorKind mapping, container-side exit carried (never thrown)
- `src/execution-service.ts` — policy frozen BEFORE target resolution; env filtered via `buildChildEnvironment`; audit fingerprint-only with `targetId`; confirmation never bypassed
- `extensions/index.ts` — lazy `session_start` composition, `createBashToolDefinition(..., { exposeSessionEnvironment: false })`, `user_bash` returns same ops instance, selection recovery, `registerCommand("devcontainer")`, TypeBox tools
- Phase 8 docs byte-match the plan's locked fences; every relative link resolves; fences balanced; vocabulary never blurs the 13-kind / four-denial / `confirmation-required` surfaces; LICENSE carries the MIT text with the 2026 copyright line

#### Deviations from Plan:

- `src/runtime/docker-adapter.ts` (discovery format, applied during the validate fix-loop): the plan's locked spec invokes `docker ps --all --no-trunc --format {{json .}}` (Phase 3 §2, SC item) and the unit test pins that argv. This host's Docker daemon **cannot render `--format '{{json .}}'`** — the top-level object serialization forces per-container `Size` computation that deadlocks on the degraded storage backend (verified: `docker ps --size` and `docker system df` hang; explicit-field templates and `docker ps -n ≤5` return instantly). The adapter now requests **only the seven fields discovery consumes** via a minimal multi-line template (`{{json .ID}}\n{{json .Names}}\n{{json .State}}\n{{json .Status}}\n{{json .Image}}\n{{json .CreatedAt}}\n{{json .Labels}}\n`), emitting exactly 7 JSON-string lines + one blank line per container; `parsePsAll` groups by blank-line boundaries. This is a minimal-dependency narrowing: the parsed `DockerContainer` shape, label extraction, and all downstream consumers are unchanged. The unit-test argv assertion and fixtures were updated to the new format; all 11 docker-adapter unit tests pass. **Rationale**: the old form demanded Size computation the system never reads — a violation of minimal-dependency reading — and was un-runnable on this host. This is a plan-spec deviation (the plan's Phase 3 SC item and code fence describe the old `{{json .}}` argv); `/skill:revise` should update the plan's Phase 3 spec to the field-scoped template.

#### Pattern Conformance:

- ✓ Imports follow the locked `.js`-suffixed NodeNext specifiers consistently across `src/`, `extensions/`, and tests
- ✓ Test structure is uniform: vitest `describe`/`it` with capability gating via `const suite = ok ? describe : describe.skip` in the real-Docker suites
- ✓ `cliPath` resolution order and awaited `store.select(...)` before synchronous `bind()` match the plan
- ✓ `src/` modules stay Pi-package-free; only `extensions/index.ts` imports `@earendil-works/pi-coding-agent`
- Minor observation (acceptable variation, not a deviation): the full parallel `npm test` shows a cross-file fixture race (integration vs e2e both using `tests/fixtures/project-a|b` labels); the plan's own CI runs the suites in separate steps, which is the correct execution mode and passes 10/10.

#### Potential Issues:

- **Known cross-file test race (non-blocking):** running integration and e2e suites in one parallel vitest process can fail e2e's first discovery test if integration's `up` created fixture containers first (expects `host-config`). CI and `verify-package.mjs` run the suites separately; document that `npm test` full-parallel may show this transient race. Not a code defect — the suites are independently green.
- The Phase 3 plan-spec drift (discovery `ps` format) should be reconciled via `/skill:revise` so the plan's code fence and SC item match the shipped minimal-field template; the runtime behavior (parsed fields, no mutation surface) is unchanged.

### Manual Testing Required:

None — the plan's manual criteria are inspection items already verified during implementation (docs-vs-wiring conformance, adapter read-only surface, serialized target-store bind, versioned selection payloads, capability-gating structure, hermetic smoke). Real-Docker discovery, routing, lifecycle, audit, and the real-Pi runtime load are now exercised automatically and pass on this host.

### Recommendations:

- Run `/skill:revise .rpiv/artifacts/plans/2026-09-06_17-54-27_pi-devcontainer-manager.md` to update Phase 3 §2's locked spec + SC item + unit-test argv from `{{json .}}` to the field-scoped minimal template (record the minimal-dependency rationale), then re-run `/skill:validate` for a clean report against the revised plan.
- After revise, run `/skill:commit` to group the validated changes (8 phases + the discovery-format fix) into atomic commits.
- Ready to commit — implementation is complete and validated on this host.
