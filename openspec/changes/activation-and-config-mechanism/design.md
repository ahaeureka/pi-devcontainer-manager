# Design — activation-and-config-mechanism

`task: activation-and-config-mechanism` · `role: designer` · `phase: plan`
`branch: feature/activation-and-config-mechanism` · `base: main@a44ee8b`
`profile: git_flow / tdd / security`

Owner-facing messages are Chinese per the Kata skill; this artifact keeps the
technical contract in English so it can be read alongside the code.

## 1. Problem

Three defects share one root cause: **the extension's notion of "a DevContainer
project" disagrees with the Dev Containers CLI's, and there is no activation
gate.**

| # | Defect | Evidence |
|---|---|---|
| D1 | Discovery accepts three config forms; CLI 0.88.0 resolves only two. Root `devcontainer.json` is discovered (`kindFor()` → `"root/devcontainer.json"`) but the adapter argv is `up/build/exec --workspace-folder <ws>` with no `--config`, so `up` can never succeed for that form. | `devcontainer read-configuration` probes: `.devcontainer/devcontainer.json` exit 0, `.devcontainer.json` exit 0, root `devcontainer.json` exit 1, `.devcontainer/<name>/devcontainer.json` exit 1 (exit 0 with `--config`). CLI `--config` help: *"The default is to use `.devcontainer/devcontainer.json` or, if that does not exist, `.devcontainer.json` in the workspace folder."* |
| D2 | Named configurations (`.devcontainer/<name>/devcontainer.json`) — a first-class Dev Containers feature with a VS Code picker — are invisible: the walker checks only `join(dir, ".devcontainer", "devcontainer.json")` and then `continue`s. Such a project is reported as having **no** DevContainer. | `src/runtime/host-discovery.ts` `walkDir()`; `src/runtime/devcontainer-adapter.ts:105,115,136` (no `--config`). |
| D3 | The extension loads globally and unconditionally replaces `bash`; a workspace with no DevContainer gets a broken shell instead of a normal one. There is no activation key and no opt-out. | `pi.registerTool({...bashDefinition})` is factory-scope; `targetStore.bind()` throws `no-candidate`. |
| D4 | Two silent configuration failures: a project file is ignored entirely when Pi does not report the project trusted (`projectTrusted ? readOptional(...) : {}`), and project values that widen a ceiling are clamped by `intersect`/`Math.min` with no diagnostic. | `src/config.ts` `loadConfig()` / `compileConfig()`. |

## 2. Contract (agreed with the task owner)

### 2.1 Config forms align with the CLI

- Authoritative: `.devcontainer/devcontainer.json`.
- Fallback: `.devcontainer.json`.
- **Named**: `.devcontainer/<name>/devcontainer.json` — discovered as multiple
  candidates of the same workspace (workspace = parent of `.devcontainer/`).
- Root `devcontainer.json`: not a CLI default; it is a valid target **only** as an
  explicit `--config` path, and status must say so.
- The adapter gains an optional `--config <path>` for `up`/`build`/`exec`; the
  selection carries the chosen config path. No selection → today's zero-flag argv.

### 2.2 Activation priority chain

| # | Evidence | Result |
|---|---|---|
| 1 | `activation: "never"` (project or global) | dormant |
| 2 | `activation: "always"` | engaged |
| 3 | session cwd is a DevContainer workspace (any accepted form at cwd) | engaged |
| 4 | cwd has a **running** container labelled `devcontainer.local_folder = cwd` | engaged (probed only when 3 misses) |
| 5 | explicit `/devcontainer use\|up` this session, or a restored persisted selection for this workspace | engaged |
| 6 | otherwise | **dormant** |

### 2.3 Dormancy semantics

Dormant means *no execution surfaces taken over* — not *not loaded*:

- `bash` → built-in host shell; `!`/`!!` → local bash (`user_bash` returns
  `undefined`); the three container tools are not in the active set; no execution
  context injected.
- `session_start` still composes the runtime (otherwise the command handler would
  report "runtime not initialized"); `/devcontainer list|use|up` stay available.
- New `/devcontainer off`: clear the selection, return to dormant. `activation:
  "never"` outranks everything.

### 2.4 Merge precedence

Project-first (`project ?? global ?? default`) for: `dockerPath`,
`devcontainerPath`, `routeMode`, `discovery.*`, `audit.*`, `destructive.*`,
`hostExecution.allow`, `activation`.

Still narrowing-only: `allowedWorkspaceRoots` (intersect),
`environmentAllowlist` (intersect), `maxTimeoutSeconds` (min),
`maxOutputBytes` (min).

`audit.directory` stays global-only.

### 2.5 Diagnostics replace silence

- Project file present but project untrusted → report the path and the reason in
  `/devcontainer status` and once at session start.
- Project value clamped by a ceiling → report key, requested value, effective
  value, and which file provided the ceiling.

### 2.6 Routing invariant

From *"request workspace == bound target workspace"* to *"the workspace actually
executed == the bound target workspace, and the audit record also names the
requested cwd"*. A request whose cwd is **itself** another DevContainer project is
still refused with `policy-denied`. The injected execution context states the
active target loudly so the model cannot mistake which tree it is touching.

## 3. Acceptance matrix

| id | Criterion (verifiable) |
|---|---|
| AC-1 | For every config form discovery accepts, the argv the extension builds makes `devcontainer read-configuration` exit 0 (contract test over fixtures for each form). |
| AC-2 | `.devcontainer/<name>/devcontainer.json` yields candidates for the same workspace; selecting one makes `up`/`build`/`exec` carry `--config <that path>`; selecting the default form still carries no `--config`. |
| AC-3 | Activation follows the §2.2 chain: `never` beats `always`; cwd-with-config engages; cwd-with-running-container engages when there is no config; explicit `use` engages; otherwise dormant. |
| AC-4 | Dormant state: `bash` is the host built-in, `!`/`!!` run locally, the three container tools are absent from the active set, no execution context is injected, and `/devcontainer list\|use\|up` still work. |
| AC-5 | `/devcontainer off` clears the selection and returns to dormant; `activation: "never"` cannot be overridden by an explicit `use`. |
| AC-6 | Merge precedence matches §2.4 exactly, for both directions (project narrower *and* project wider), with the four ceilings still clamping. |
| AC-7 | Both formerly silent cases now emit the §2.5 diagnostics (untrusted project file; clamped ceiling), asserted on the rendered status text. |
| AC-8 | Routing: executing from a non-DevContainer cwd against an explicitly selected target succeeds, the audit record carries target workspace + `requestedCwd`, and a request whose cwd is another DevContainer project still fails with `policy-denied`. |
| AC-9 | `docs/compatibility.md` (config forms), `docs/configuration.md` (precedence + diagnostics), `docs/security.md` (invariants), and README (discovery/activation) match the implementation; CHANGELOG records it under the unreleased 1.0.0. |
| AC-10 | Regression: the existing 218 unit tests plus the capability-gated integration/e2e suites stay green; `npm run typecheck`, `npm run test:unit`, and `node scripts/verify-package.mjs --unit-tests` pass. |

## 4. Out of scope

- `container-preferred` / `host-only` route modes stay rejected at load.
- Windows / WSL2 / Podman / rootless Docker support.
- Compose-aware teardown (`docker compose down` semantics).
- Initialising Comet / the `.llmwiki` wiki (see §6).
- Packaging-contract changes (`files` allowlist, tarball contents).

## 5. Build order (three slices, TDD per slice)

1. **Discovery ⇔ CLI alignment** — AC-1, AC-2. Independent, testable, no security
   surface. Includes the `--config` adapter path and the contract test.
2. **Activation + dormancy + diagnostics** — AC-3, AC-4, AC-5, AC-7.
3. **Merge precedence + routing invariant** — AC-6, AC-8. Security-relevant;
   reviewed separately.

Documentation (AC-9) lands with each slice.

## 6. Known environment gaps

- Comet/wiki is not initialised in this repository (`comet.projectInit:
  not_requested`), so `.llmwiki/SCHEMA.md`, `.llmwiki/index.md`,
  `.llmwiki/log.md` and `.kata/skills-index.md` do not exist. Five of seven
  `requiredReads` are therefore missing, `wiki ingest` cannot run, and
  `wikiClosureValid` stays `missing`. Recorded as a gap, not worked around by
  fabricating wiki content.
- `.kata/` is currently untracked in git. Whether the governed task store should
  be committed is a repository-policy decision for the owner.
- This repository has no DevContainer of its own, so its own `bash` is dormant
  (AC-4) — the dogfood case for D3.
