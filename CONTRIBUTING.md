# Contributing

Thanks for helping improve `pi-devcontainer-manager`. This page covers the local
workflow, what CI enforces, and how a release happens.

By participating you agree to keep discussion technical and respectful. The
project is MIT-licensed; contributions are accepted under the same license.

## Prerequisites

- Node.js `>= 22.19.0`
- Docker Engine or Docker Desktop on Linux or macOS (only needed for the
  integration/e2e suites)
- A real Pi CLI install if you want to run the runtime smoke test

## Set up

```bash
git clone https://github.com/ahaeureka/pi-devcontainer-manager
cd pi-devcontainer-manager
npm ci          # also installs the pinned @devcontainers/cli@0.88.0
npm run build
```

To load your working copy into Pi while developing, symlink the checkout into
Pi's auto-discovery extensions folder and rebuild on change:

```bash
ln -sfn "$PWD" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/pi-devcontainer-manager"
# in Pi: /reload    (after each `npm run build`)
```

See [docs/installation.md](docs/installation.md#local-development-install-auto-discovery-symlink)
for details. The extension then loads in every project without a `settings.json`
edit.

## Project layout

```text
extensions/index.ts   the only file that imports the Pi API:
                      session lifecycle, prompt injection, tool/command/bash registration
src/                  Pi-dependency-free runtime
  config.ts             load + monotonic merge + validation
  types.ts              config, policy, audit, and registry types
  errors.ts             the thirteen typed error kinds
  policy.ts             policy evaluation, workspace containment, env filter, redaction
  audit.ts              host-local JSONL writer (+ prune)
  execution-service.ts  the single governed execution gate
  bash-router.ts        routed BashOperations + timeout/cancellation helpers
  commands.ts           /devcontainer verb handlers and rendering
  tools.ts              the three LLM tool definitions
  target-store.ts       selection state machine
  workspace-path.ts     canonical workspace identity
  path-mapper.ts        host<->container mapping from devcontainer.json
  runtime/              process runner, capabilities, docker + devcontainer CLI adapters
tests/unit              deterministic, no Docker, no Pi
tests/integration       real Docker + pinned CLI, capability-gated
tests/e2e               multi-workspace end-to-end, capability-gated
tests/fixtures          two DevContainer fixture projects
scripts/                verify-package.mjs, smoke-pi-package.mjs
docs/                   user documentation
```

`src/` must stay free of `@earendil-works/pi-coding-agent` imports so the unit
suites run without a Pi installation. `extensions/index.ts` performs the
structural casts that wire `src/` into Pi.

## Commands

| Command | What it does |
|---|---|
| `npm run typecheck` | strict `tsc --noEmit` twice: `tsconfig.json` (`src`, `extensions`) and `tsconfig.tests.json` (`tests/**`, `noEmit`) — a test file outside `tests/**` escapes BOTH |
| `npm run test:unit` | deterministic unit tests — the fast local loop |
| `npm test` | full vitest run (unit + integration + e2e + package smoke) |
| `npx vitest run tests/integration` | real Docker + pinned Dev Containers CLI |
| `npm run build` | emit `dist/` with declarations and source maps |
| `npm run clean` | remove `dist/` |
| `npm run pack:check` | tarball allowlist + manifest contract (`npm pack --dry-run`) |
| `node scripts/verify-package.mjs` | whole-package gate: typecheck → tests → build → pack check → engines probe → CLI-pin probe |
| `node scripts/smoke-pi-package.mjs --no-model` | packed-tarball manifest/registration smoke (no model) |

`dist/` is **committed to the repository**: Pi installs git packages with
`npm install --omit=dev`, so `pi install git:github.com/ahaeureka/pi-devcontainer-manager`
needs a working `dist/extensions/index.js` without a TypeScript toolchain (a `tsc`-based
`prepare` script fails that install outright — `scripts/prepare-package.mjs` therefore
refreshes `dist/` only when the toolchain is present). Rebuild and commit `dist/` with any
source change: CI runs `git diff --exit-code -- dist` after a fresh build and fails if the
committed output is stale.

### Test layers

- **Unit** (`tests/unit`) — deterministic and capability-free. They must not need
  Docker, the CLI, or a model, and must not depend on the host's real paths.
- **Integration / e2e** (`tests/integration`, `tests/e2e`) — start **real**
  DevContainers through the pinned CLI. They skip with a named reason when Docker
  or the CLI is unavailable, and use a 120 s per-test budget because a container
  `up` routinely exceeds the 5 s default. Run them with Docker up:

  ```bash
  DEVCONTAINER_CLI_PATH=node_modules/@devcontainers/cli/devcontainer.js \
    npx vitest run tests/integration tests/e2e
  ```

- **Package smoke** (`scripts/smoke-pi-package.mjs`) — packs the tarball, installs
  it into a throwaway Pi package store, and (unless `--no-model`) boots a real Pi
  turn against the packed extension.

## Conventions

- **TypeScript, strict.** The compiler options are part of the contract:
  `exactOptionalPropertyTypes` (so optional properties are spread conditionally,
  never assigned `undefined`), `noUncheckedIndexedAccess` (so array/record
  lookups are narrowed), and `verbatimModuleSyntax` (so type imports stay
  `import type`). Do not weaken `tsconfig.json` to make a change compile.
- **No shell strings.** Every child process is spawned with a fixed executable,
  an argv array, and `shell: false`. Never build a command string by
  interpolation, and never route a container command through a shell for the
  extension's own purposes.
- **No silent fallbacks.** A `container-required` route must fail with a typed
  `RuntimeError` kind, never degrade to the host. If you add a failure mode, add
  it to the `ErrorKind` union and to
  [docs/troubleshooting.md](docs/troubleshooting.md).
- **One execution gate.** Command execution goes through `ExecutionService` so
  policy, environment filtering, audit, output accounting, cancellation, and
  timeout cannot drift between surfaces. Do not spawn directly from a command or
  tool handler.
- **Never widen a default.** New configuration keys default to the restrictive
  value, and project configuration must never be able to expand a global grant.
  Add the merge rule to the table in
  [docs/configuration.md](docs/configuration.md).
- **Redact before persisting.** Anything written to an audit record goes through
  `redactText`; environment *values* are never recorded at all.
- **Deterministic tests.** No sleeping, no wall-clock assertions, no dependency on
  Docker ordering, and no reliance on ambient environment variables.

### Documentation is part of the change

Anything user-visible needs a matching documentation change in the same commit:

| Change | Update |
|---|---|
| A new slash-command verb | the README [Slash commands](README.md#slash-commands) table and `/devcontainer` help text |
| A new tool or parameter | the README [Tools](README.md#tools) table |
| A new config key or default | [docs/configuration.md](docs/configuration.md) (reference **and** merge-rules table) and `examples/pi-devcontainer-manager.settings.json` when it illustrates a default |
| A new policy gate or denial reason | [docs/security.md](docs/security.md) |
| A new error kind or failure mode | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Install/upgrade behavior | [docs/installation.md](docs/installation.md) |
| Anything user-visible | `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) |

## Commit messages

The history uses [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `docs:`, `chore:`, plus a scoped form such as `docs(plan):`.
Write an imperative subject describing the behavior change, and keep the suffix
specific enough to be useful in a changelog:

```text
fix: fail closed in user_bash when runtime is uninitialized
feat: add /devcontainer setup to install the Dev Containers CLI
```

## Pull requests

Before opening one, run the same gates CI runs:

```bash
npm run typecheck
npm run test:unit
node scripts/verify-package.mjs --unit-tests
node scripts/smoke-pi-package.mjs --no-model
```

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs those on Node 22.19
for every push to `main` and every pull request, plus a job that fails the build
if a credential-looking string was committed.
[`.github/workflows/integration.yml`](.github/workflows/integration.yml) runs the
real-Docker suites separately (they need a Docker daemon and are slower).

In the PR description, state what changed, why, and how you verified it. If you
touched policy, audit, or process spawning, say explicitly what you checked — a
security-relevant change without that reasoning will be sent back.

## Releasing

The package version in `package.json` is the source of truth, and the release
workflow refuses to publish when the git tag does not match it.

1. Land everything for the release on `main`.
2. Move the entries in [CHANGELOG.md](CHANGELOG.md) from `## [Unreleased]` into a
   dated `## [x.y.z] - YYYY-MM-DD` section, and update the link references at the
   bottom of that file.
3. Bump `version` in `package.json` (and `package-lock.json`), commit, and tag
   `vx.y.z`.
4. Dispatch the **Release** workflow with that tag and `dry_run: true` to verify
   the gates and produce the tarball artifact.
5. Dispatch it again with `dry_run: false` to publish to npm. This requires the
   `NPM_TOKEN` repository secret. The packed-tarball Pi runtime smoke job runs only
   when the `PI_PROVIDER` secret is configured; if it is absent the job is skipped
   and publishing proceeds.
6. Verify the npm page renders this README and that the tarball contains `dist/`,
   `docs/`, `examples/`, `README.md`, `CHANGELOG.md`, and `LICENSE`.
