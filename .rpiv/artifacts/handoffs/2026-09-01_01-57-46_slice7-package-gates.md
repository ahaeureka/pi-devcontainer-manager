---
date: 2026-09-01T01:57:46+0800
author: geebytes
commit: no-commit
branch: no-branch
repository: unknown
topic: "Slice 7 Package quality gates and real multi-workspace integration"
tags: [design, slice-7, pi-extension, devcontainer, integration-tests, workflows]
status: in_progress
last_updated: 2026-09-01T01:57:46+0800
last_updated_by: geebytes
type: feature_development
---

# Handoff: Slice 7 — package gates + multi-workspace integration (design skill)

## Task(s)
- **Active**: continue the design skill (user said 继续) for **Slice 7** of the design artifact `.rpiv/artifacts/designs/2026-08-31_09-47-28_pi-devcontainer-manager.md` (6932+ lines; Slice 7 section ~6764, Slice 8 ~6772). Goal: package quality gates + real multi-workspace integration. **Stop after Slice 7; NO Slice 8 (docs) this session.**
- All 10 Slice 7 files are **written and gate-green** in the dev tree `/tmp/slice7-src` (details below). Remaining: slice-verifier dispatch → 6.3 checkpoint → approval → byte-identical fence fill → Design History/front matter → handoff.
- Slices 1–6 previously locked/verified/persisted (66 unit tests green at Slice 6; now 75 passed + 8 skipped with Slice 7 files).

## Critical References
- Design artifact (authoritative, read-only until fence-fill): `/data/work/ahaeureka/pi-devcontainer-manager/.rpiv/artifacts/designs/2026-08-31_09-47-28_pi-devcontainer-manager.md` — Slice 7 §6764–6778, empty fences §6531–6601 (markers json/ts/js/yaml), End-State transcript ~§6780–6800, Verification Notes §6846+, Design History §6912–6920, locked Slice 1 package.json/tsconfig fences ~§124–185.
- Dev working tree (verified sources): `/tmp/slice7-src/` (node_modules → symlink to `/tmp/slice5-src/node_modules`: vitest 2.1.9, typescript 5.6, typebox, stub pi).
- Design skill: `/home/work/.pi/agent/npm/node_modules/@juicesharp/rpiv-pi/skills/design/SKILL.md` (§6.2 slice-verifier dispatch protocol, §6.3 checkpoint).

## Recent changes
All in `/tmp/slice7-src` (slice-7 additions only; no locked source modified):
- `tests/fixtures/project-a/.devcontainer/devcontainer.json` + `project-b/...` — fixture workspaces (name/image `mcr.microsoft.com/devcontainers/base:ubuntu-24.04`/remoteUser vscode/`customizations.pi.marker` distinct).
- `tests/integration/devcontainer-manager.integration.test.ts` — capability-gated real Docker+CLI suite (5 tests, 4 skipped locally). Fixed: top-level `import { spawnSync } from "node:child_process"` (ESM, no bare `require`), real `NodeDockerLifecycleAdapter` wired in `composeRuntime` (replaced `{logs} as never` stub), `beforeAll` assigns `composed`, `const suite = dockerOk && cliOk ? describe : describe.skip` (calling `describe.skip(...)` returns a non-callable `SuiteCollector`).
- `tests/e2e/multi-workspace.e2e.test.ts` — two layers: composed-runtime (real Docker+CLI, gated) asserting discovery/A→exec→B→exec/no-host-fallback; real-Pi layer booting `pi -p --no-session --offline --mode json --extension <abs extensions/index.ts>` asserting `agent_start` + no "Extension error" (runs locally: pi CLI + model on PATH, passed in ~15.8s).
- `tests/package-smoke.test.ts` — pack dry-run contract: README/LICENSE/CHANGELOG/docs/examples present (**no `package/` prefix** — actual pack paths are bare), tests/src/.github/scripts absent, `pi.extensions` manifest, peerDeps pi+typebox, no dependencies, devDeps `@devcontainers/cli` EXACT `"0.88.0"`, engines.node `>=22.19.0`, type module.
- `scripts/verify-package.mjs` — engines probe, CLI pin probe (manifest exact + installed version when present; PNPM path candidate), typecheck→test→build→pack:check chain, nonzero exit + named label on first failure; `--skip-build` flag.
- `scripts/smoke-pi-package.mjs` — real pi CLI required; `npm pack` real tarball → `pi install <tarball>` into scratch `PI_CODING_AGENT_DIR` (hermetic) → model-touching probe gated on `PI_PROVIDER`/`PI_MODEL` → dist-source probes (`registerCommand`/`devcontainer`, `user_bash`, `registerTool`); `--no-model` skips model steps.
- `.github/workflows/ci.yml` (npm ci + typecheck + test:unit + verify-package on node 22.19 + security grep), `integration.yml` (real Docker + npm ci + vitest run tests/integration + tests/e2e + secret-gated smoke via `secrets.PI_PROVIDER != ''`), `release.yml` (workflow_dispatch tag + dry_run input; verify→upload tarball→publish gated on `!dry_run`→secret-gated smoke).
- Placeholders created for pack contract: `README.md`, `LICENSE` (MIT), `CHANGELOG.md`, `docs/installation.md`, `examples/pi-devcontainer-manager.settings.json` (Slice 8 will fill real content).

## Learnings
- **`npm pack` includes only existing files**: with `files: [dist, README.md, LICENSE, CHANGELOG.md, docs, examples]`, a pre-build dry-run packs only what exists → placeholders were required. Pack paths have NO `package/` prefix.
- **`describe.skip(...)` typed as `SuiteCollector` (non-callable)** → use `const suite = ok ? describe : describe.skip`.
- **`subagent_spawn` rejects `subagent_type: "slice-verifier"`** ("root must not have additional properties"). Dispatch via the `Agent` tool with `subagent_type: "slice-verifier"`. First background dispatch (`0f15d48f-1a66-48d`) was cleaned up before completion; a foreground re-dispatch returned "No result provided". **Re-dispatch and wait** (`run_in_background: false` or background + `get_subagent_result wait:true`).
- **Dev tree tsconfig vs locked build config**: dev `tsconfig.json` is noEmit + includes tests (typechecks tests). The LOCKED Slice 1 tsconfig (emits `dist`, excludes tests) was temporarily swapped in to prove `dist/extensions/index.js` emission + smoke dist probes (all passed), then restored. CI uses the locked config.
- **verify-package.mjs full chain passed** including build + pack:check; **smoke-pi-package.mjs --no-model passed** (pack → `pi install` into scratch store OK → dist probes OK). `npm pack` contract: 82 files incl. `dist/extensions/index.js`, no tests/src/.github/scripts.
- Gates on `/tmp/slice7-src`: `npx tsc -p tsconfig.json` clean; `npx vitest run` → **75 passed, 8 skipped** (8 = capability-gated integration/e2e; real-Pi e2e layer ran and passed).
- Fixture note: `buildWorkspaceRegistry` marks pre-up fixtures `discoveredFrom: "host-config"`; e2e asserts that.

## Artifacts
- `/data/work/ahaeureka/pi-devcontainer-manager/.rpiv/artifacts/designs/2026-08-31_09-47-28_pi-devcontainer-manager.md` (Slice 7 section + 10 empty fences + empty Automated/Manual Verification + Design History rows Slice 7–8 pending).
- `/tmp/slice7-src/` — full verified working tree (sources Slice 1–6 + 10 Slice 7 files + placeholders; `package.json` = locked Slice 1 contract; `package.json.bak` = old scaffolding; `tsconfig.json` = dev noEmit config).
- `/tmp/fill-slice7-fences.mjs` — byte-identical fence filler (refuses non-empty fences; generic ``` opener matching for json/ts/js/yaml).
- `/tmp/verify-slice7-fences.mjs` — byte-diff fence verifier (extracts fence interior vs source file; exit 1 on mismatch).
- Prior: `/tmp/fill-slice6-fences.mjs`, `/tmp/verify-slice6-fences.mjs`, `/tmp/slice6-src/` (Slice 6 verified base).

## Action Items & Next Steps
1. **Dispatch slice-verifier** (Agent tool, `subagent_type: "slice-verifier"`, `run_in_background: false` or wait on result) with `artifact_path`, `slice_id: "Slice 7"`, `current_slice_code` (the 10 files), `target_files` (the 10 paths). Adversarial checklist already prepared (ESM safety, real lifecycle adapter, capability gating + cliPath resolution order, contract fidelity vs locked sources, e2e End-State behavior, verify/smoke assertions, workflow contents, no locked-file modification, strict-TS safety, fixture validity).
2. On any VIOLATION: fix-and-re-dispatch OR surface-and-proceed (verbatim VIOLATION row in 6.3 with by-design rationale). Never reach 6.3 with a VIOLATION absent.
3. **6.3 condensed checkpoint** (per-file summaries, signatures, key blocks, mandatory Fit line, any VIOLATION rows) → wait for approval.
4. On approval: run `/tmp/fill-slice7-fences.mjs` (fills the 10 empty fences byte-identically), fill Slice 7 `#### Automated Verification:` / `#### Manual Verification:` subsections, append `- Slice 7: ... — approved as generated` to Design History, update front matter (`last_updated` to `%Y-%m-%dT%H:%M:%S%z`, rewrite `last_updated_note`). Use anchored `replace` (NOT sed) for front matter.
5. Byte-check with `/tmp/verify-slice7-fences.mjs` (10/10 match), verify fence balance, print design-skill handoff, **STOP** (no Slice 8).

## Other Notes
- Environment facts: real `pi` CLI at `/home/work/.nvm/versions/node/v24.19.0/bin/pi` with configured model (`PI_PROVIDER=litellm`, `PI_MODEL=deepseek-v4-flash-goat`) — real-Pi e2e layer and smoke model probe work here. Docker daemon reachable (`/usr/bin/docker` 27.3.1). `@devcontainers/cli` NOT installed locally (pinned 0.88.0 arrives only via `npm ci` in CI) → integration/e2e suites skip locally by design.
- ESM: package is `"type": "module"` — never bare `require` in .ts tests or .mjs scripts; use top-level `import`.
- exactOptionalPropertyTypes: never write `optionalProp: undefined` in object literals (omit via destructuring-rest); noUncheckedIndexedAccess: check array/record index access.
- The 8 skipped tests are: 4 integration + 4 e2e composed-runtime (capability-gated). The real-Pi e2e layer (2 tests incl. 1 probe) is NOT skipped locally.
- Artifact editing rule: byte-identical fence fill via scripts only; subsection/front-matter edits via anchored `replace`; re-run tsc + vitest after any edit.
