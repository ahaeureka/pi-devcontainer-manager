---
template_version: 1
date: 2026-09-06T23:51:32+0800
author: geebytes
commit: no-commit
branch: no-branch
repository: unknown
topic: "Validation of Host-machine Pi extension for governed multi-DevContainer discovery and execution"
status: ready
verdict: pass
parent: ".rpiv/artifacts/plans/2026-09-06_17-54-27_pi-devcontainer-manager.md"
tags: [validation, plan, pi-extension, devcontainer, docker, typescript, security, audit]
last_updated: 2026-09-06T23:51:32+0800
---

## Validation Report: Host-machine Pi extension for governed multi-DevContainer discovery and execution

_Git history unavailable — validation based on file inspection only (`in_repo: no`; no commit/branch exists at authoring time)._

### Implementation Status

- ✓ Phase 1: Package contracts, configuration, policy, and audit foundation — Fully implemented (5/5 auto SC checked)
- ✓ Phase 2: Safe host process and capability boundary — Fully implemented (5/5 auto SC checked)
- ✓ Phase 3: Docker discovery and session-safe target state — Fully implemented (9/9 auto SC checked; discovery spec revised to the minimal-field template and re-synced byte-for-byte)
- ✓ Phase 4: Host-side configuration discovery and workspace registry — Fully implemented (5/5 auto SC checked)
- ✓ Phase 5: Dev Containers and governed execution services — Fully implemented (plain-bullet SC; suites pass)
- ✓ Phase 6: Pi extension integration and dual execution interfaces — Fully implemented (plain-bullet SC; suites pass)
- ✓ Phase 7: Package quality gates and real multi-workspace integration — Fully implemented (10/10 auto SC checked; real-Docker suites green)
- ✓ Phase 8: Operator-facing documentation and release contract — Fully implemented (7/7 auto SC checked)

### Automated Verification Results

- ✓ `npx tsc -p tsconfig.json --noEmit` — clean, zero errors
- ✓ Deterministic suites: `npx vitest run tests/unit tests/package-smoke.test.ts` — 160/160 pass
- ✓ `node scripts/verify-package.mjs --unit-tests` — all gates passed (engines probe, @devcontainers/cli@0.88.0 exact, typecheck, unit tests, build, pack:check)
- ✓ `node scripts/smoke-pi-package.mjs --no-model` — all checks passed (real pack → hermetic `pi install` into scratch `PI_CODING_AGENT_DIR` → dist probes for `/devcontainer`, `user_bash`, `registerTool`)
- ✓ Integration suite (separate invocation): `npx vitest run tests/integration --testTimeout=120000` — 5/5 pass (discovery merge of both fixtures, up→exec A→B routing with differing `pwd`/`hostname`, stop requiring policy grant + fresh token, audit `targetId`/`fingerprint-only`, real pinned-CLI `build`)
- ✓ E2E suite (separate invocation): `npx vitest run tests/e2e --testTimeout=120000` — 5/5 pass on 4 consecutive runs (discovery `host-config`, `use project-b` fails closed, A→exec→B→exec routing, fail-closed no-selection/ambiguous, real-Pi layer reaching `agent_start`)
- ✓ Real-Docker discovery on this host is now fast: the minimal 7-field `ps` template renders 78 containers in ~0.19s (the former top-level `{{json .}}` form stalled the degraded daemon)
- ✓ No regressions detected

### Code Review Findings

#### Matches Plan:

- All 53 plan-declared files across 8 phases exist; the Phase 3 §2 `docker-adapter.ts` and its unit-test code fences in the plan are **byte-identical** to the shipped files (verified by extraction comparison), honoring the plan's fence-byte-match contract
- `src/types.ts`, `src/config.ts`, `src/policy.ts`, `src/audit.ts`, `src/errors.ts` — exact 13-kind `ErrorKind`, four-value `denialReason`, `confirmation-required` lifecycle status; defaults `container-required`, 90-day `fingerprint-only` audit, destructive/host-exec both `false`
- `src/runtime/process-runner.ts` — `shell: false`, fixed argv, piped stdout/stderr with ignored stdin, drain-after-truncation, `timeout`/`cancelled` typed paths
- `src/runtime/docker-adapter.ts` — read-only `docker ps --all --no-trunc` (minimal 7-field template) + `inspect` only; no mutation surface; parses full IDs/names/state/status/image/created/labels; extracts `devcontainer.local_folder` → `workspaceKey`; keeps duplicate labels as separate candidates; malformed records → `errors`
- `src/target-store.ts` — exactly seven selection states; serialized promise queue (last-wins); `bind()` returns immutable context only from `selected-valid` running
- `src/runtime/host-discovery.ts` — `DirectoryTraversal` seam; `maxDepth` bound + pruning diagnostic; excluded/hidden dirs; realpath-escape refusal; registry merge semantics
- `src/runtime/devcontainer-adapter.ts` — 0.88.0 argv contracts, `--` separator, single `--remote-env`, trailing-space JSON parse, marker→ErrorKind mapping, container-side exit carried
- `src/execution-service.ts` — policy frozen BEFORE target resolution; env filtered; audit fingerprint-only with `targetId`; confirmation never bypassed
- `extensions/index.ts` — lazy `session_start` composition, `exposeSessionEnvironment: false`, `user_bash` same ops instance, selection recovery, TypeBox tools
- Phase 8 docs byte-match the plan fences; links resolve; fences balanced; vocabulary consistent; LICENSE carries the 2026 MIT copyright

#### Deviations from Plan:

- None outstanding. The discovery-format deviation that existed at the prior validation run was reconciled in `/skill:revise` (2026-09-06T23:44:10+0800): the plan's Phase 3 §2 spec, code fence, unit-test fence, and SC items now describe the shipped minimal 7-field `ps` template, and the Testing Strategy documents the separate-invocation requirement for the shared-fixture real-Docker suites. The Follow-up section records the rationale (top-level `{{json .}}` forced unread per-container `Size` computation that stalls degraded storage backends).

#### Pattern Conformance:

- ✓ Imports follow the locked `.js`-suffixed NodeNext specifiers consistently
- ✓ Test structure is uniform: vitest `describe`/`it` with capability gating via `const suite = ok ? describe : describe.skip`
- ✓ `cliPath` resolution order and awaited `store.select(...)` before synchronous `bind()` match the plan
- ✓ `src/` modules stay Pi-package-free; only `extensions/index.ts` imports `@earendil-works/pi-coding-agent`
- ✓ No drift: no stale `{{json .}}` locked-invocation text remains in the plan outside the Follow-up history record

#### Potential Issues:

- None requiring action. The real-Pi e2e layer boots a live model (PI_PROVIDER=litellm) and asserts `agent_start` within a 150s window; one transient failure was observed across five consecutive suite runs (4× 5/5 since). This is the plan's documented capability/availability-gated layer, not a deterministic gate — model latency can exceed the spawn timeout. All deterministic and real-CLI legs are stable.

### Manual Testing Required:

None — the plan's manual criteria are inspection items already verified during implementation (docs-vs-wiring conformance, adapter read-only surface, serialized target-store bind, versioned selection payloads, capability-gating structure, hermetic scratch install). Real-Docker discovery, routing, lifecycle, audit, the real-Pi runtime load, and the minimal-field discovery format are exercised automatically and pass on this host.

### Recommendations:

- Ready to commit — implementation is complete and validated on this host against the revised plan.
- The real-Pi model-touching e2e layer is inherently latency-sensitive; run it with the provider available and treat an isolated timeout as environmental, re-running once before investigating.
- Proceed to `/skill:commit` to group the validated changes (8 phases + the discovery-format fix) into atomic commits.
