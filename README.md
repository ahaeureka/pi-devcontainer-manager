# pi-devcontainer-manager

[![CI](https://github.com/ahaeureka/pi-devcontainer-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/ahaeureka/pi-devcontainer-manager/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-devcontainer-manager.svg)](https://www.npmjs.com/package/pi-devcontainer-manager)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19.0-brightgreen.svg)](package.json)
[![pi-package](https://img.shields.io/badge/pi-package-blueviolet.svg)](https://pi.dev/packages)

**A host-side Pi extension for governed multi-DevContainer discovery and execution.**

Pi stays on the host. DevContainers are explicitly selected, policy-checked
command-execution targets — never a place where Pi sessions, extensions,
configuration, model credentials, or API keys are installed, copied, mounted, or
persisted.

```text
HOST                                          container
  Pi session · extensions · config              project toolchain
  model credentials · API keys                  container-only mounts
  read / write / edit / grep / find / ls
        │  (host filesystem, same files via bind mount)
        │
  devcontainer_exec ─┐
  routed bash, !, !! ├─▶ governed execution service ─▶ selected DevContainer
  up / build / logs ─┘
  devcontainer_host_exec ─▶ host (explicit, policy-gated, audited)
```

## Table of contents

- [Why](#why)
- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Usage](#usage)
  - [Slash commands](#slash-commands)
  - [Tools](#tools)
  - [Which surface runs where](#which-surface-runs-where)
  - [Discovery and selection](#discovery-and-selection)
- [Configuration](#configuration)
- [Security model](#security-model)
- [How it works](#how-it-works)
- [Compatibility](#compatibility)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Documentation](#documentation)
- [License](#license)

## Why

A DevContainer is where a project's toolchain actually lives, but Pi — with its
configuration, skills, and model credentials — belongs to the host. The useful
question is therefore not "can Pi run inside the container?", it is **"which
environment should this command run in, and is that decision auditable?"**

This extension answers that with explicit routing instead of name-based guessing:

- **While engaged, `bash`, `!`/`!!`, and `devcontainer_exec` are always the container.**
- **`devcontainer_host_exec` and `/devcontainer host-exec` are the only general
  host-argv surfaces**, policy-gated and audited. `/devcontainer setup` is the one
  other host-side operation and runs a single fixed command.
- **Pi's file tools are always the host.** A DevContainer's workspace is a bind
  mount, so host and container see the same files — routing file tools into the
  container would add a round-trip for no benefit.
- **No silent host fallback.** With no usable target, a `container-required` route
  returns a typed error instead of quietly running on the host.

The extension deliberately does **not** classify shell text to pick an
environment: shell operators, substitutions, and compound commands defeat any
name/prefix rule. Instead it gives the agent the facts it needs — current target,
host↔container path mapping, and the surface rules — in the system prompt before
every turn.

## Features

- **Discovers** DevContainer projects beneath your configured workspace roots —
  `devcontainer.json`, `.devcontainer/devcontainer.json`, and `.devcontainer.json`
  — and merges them with Docker label candidates into one workspace registry.
  Config-only projects (never started) are first-class entries.
- **Selects** one target at a time (`/devcontainer list`, `use`, `status`),
  persists the choice in the session, and restores it after `/reload`. When
  nothing is selected yet, the workspace you started Pi in is auto-selected as the
  default if it has a DevContainer configuration (an explicit `/devcontainer use`
  always wins over this empty-selection default).
- **Executes** through a shared, governed service — the `devcontainer_exec` tool,
  routed Pi `bash`, and `!`/`!!` all hit the same target validation, policy,
  environment filtering, audit, output accounting, cancellation, and timeout.
- **Routes the agent with facts, not guesses.** Before each turn the extension
  appends the current target, the `workspaceFolder`/`workspaceMount`
  host↔container mapping, and the execution-surface rules to the system prompt. It
  also refuses host execution of an argv that targets a container-only path (when the
  workspace's configuration declares a mapping to compare against — without one there
  is nothing to test, and the extension says so as a diagnostic), and blocks the
  built-in `powershell` tool while a container is selected.
- **Keeps file tools on the host.** `read`/`write`/`edit`/`grep`/`find`/`ls`
  always operate on the host filesystem — never routed into the container.
- **Manages** lifecycle: `up`, `build`, `stop`, `remove` (stop/remove need a
  policy grant **plus** a fresh per-action confirmation), and bounded `logs`
  (policy-checked and audited like every other operation). A successful `up`
  re-resolves the selection, so a config-only target becomes usable without a
  second `/devcontainer use`.
- **Installs its own prerequisite**: `/devcontainer setup` runs
  `npm install -g @devcontainers/cli` on the host after an interactive
  confirmation (see [Security](docs/security.md#devcontainer-setup)).
- **Loads only where it belongs.** A `devcontainer.json` is a *discovery* input, never
  a load gate, so the extension decides **per session**: in a workspace with no
  DevContainer evidence it stays **dormant** and leaves Pi's built-in `bash`,
  `!`/`!!`, and host file tools exactly as shipped. `/devcontainer use` engages it,
  `/devcontainer off` hands the session back — see
  [`activation`](docs/configuration.md#activation).
- **Named configurations are first-class.** A workspace may carry several
  `.devcontainer/<name>/devcontainer.json` files;
  `/devcontainer use <workspace> --config <name|path>` picks one, and every
  `up`/`build`/`exec` then carries `--config <that path>`.
- **Audits** every operation to a host-local JSONL file: fingerprint capture by
  default, 90-day retention window, `audit.enabled` and `audit.directory` honored.
- **Never falls back silently** to the host: a `container-required` route returns
  a typed `no-candidate` / `ambiguous-candidate` / `target-stopped` /
  `policy-denied` error instead.

Paths that exist **only inside the container** (extra mounts, named volumes,
container-local clones) are not directly readable by `read`/`ls`/`grep`; reach
them through `devcontainer_exec` (e.g. container-side `cat`/`find`), which runs in
the container.

## Requirements

| Requirement | Version / notes |
|---|---|
| Node.js | `>= 22.19.0` (the package `engines` field) |
| Pi | the host coding agent; this package registers tools, commands, and a replacement `bash` tool inside it |
| Docker | Docker Engine or Docker Desktop on **Linux or macOS** |
| Dev Containers CLI | pinned and tested at `@devcontainers/cli@0.88.0`; resolvable on `PATH`, configured via `devcontainerPath`, or installed by `/devcontainer setup` |

Windows, WSL2, Podman, and rootless Docker are **not** supported in v1 — see
[docs/compatibility.md](docs/compatibility.md).

> **Working in a project that has no DevContainer?** The extension is discovered
> globally (from `${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions/` or a
> `pi install` entry) and loads in **every** workspace — a `devcontainer.json` is
> a discovery input, never a load gate. So in a project with no DevContainer
> configuration (or none running), the replacement `bash` tool and
> `devcontainer_exec` fail closed with
> `[no-candidate] No DevContainer target is selected.` rather than falling back to
> a host shell. That is the intended contract (see [Why](#why)), and
> `container-preferred` / `host-only` are rejected at load — there is no
> per-project opt-out short of disabling the extension for that project. See
> [Troubleshooting](docs/troubleshooting.md#the-extension-is-loaded-in-a-project-with-no-devcontainer).

## Install

A Pi extension has to be **registered with Pi**. `npm install -g <package>` puts
files on disk but never registers the extension, so Pi will not load it.

```bash
# from npm
pi install npm:pi-devcontainer-manager

# from git
pi install git:github.com/ahaeureka/pi-devcontainer-manager

# from a release tarball
pi install ./pi-devcontainer-manager-1.0.0.tgz
```

`pi install` records the package in `~/.pi/agent/settings.json`; add `-l` for a
project-local `.pi/settings.json`. Manage it with `pi list`,
`pi update npm:pi-devcontainer-manager`, and `pi remove npm:pi-devcontainer-manager`.

Optional global configuration lives at
`${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions/pi-devcontainer-manager.json` — see
[Configuration](#configuration) and [docs/configuration.md](docs/configuration.md).

**Developing this extension locally?** Symlink this checkout into Pi's
auto-discovery extensions folder
(`${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions`) and run `npm run build` — no
`settings.json` edit needed, and the extension loads in every project. See
[docs/installation.md](docs/installation.md#local-development-install-auto-discovery-symlink).

## Quick start

```bash
# 1. Start Pi inside (or near) the project whose DevContainer you want to use.
cd ~/code/project-a
pi

# 2. In Pi:
/devcontainer list     # discover projects + show the registry
/devcontainer use      # pick a target, or name one: /devcontainer use ~/code/project-b
/devcontainer up       # start a config-only target (re-resolves the selection)

# 3. Run work in the container — all of these hit the same governed service:
devcontainer_exec { "argv": ["npm", "test"] }
bash "pytest -q"
! cargo build          # `!` / `!!` are routed too
```

If the Dev Containers CLI is missing, run `/devcontainer setup` once.

## Usage

### Slash commands

| Command | What it does |
|---|---|
| `/devcontainer` | Interactive verb picker (or a usage line when no UI is available) |
| `/devcontainer list` | Discover + render the registry; also repairs a stale selection |
| `/devcontainer status` | Same status block (target, registry, route, caps) |
| `/devcontainer use [path\|container-id]` | Select a target and persist it in the session; a container id resolves an ambiguous workspace |
| `/devcontainer up [path]` | `devcontainer up --workspace-folder`; re-resolves the selection on success |
| `/devcontainer build [path]` | `devcontainer build` |
| `/devcontainer stop` | Docker stop — policy grant + fresh confirmation |
| `/devcontainer remove` | Docker `rm -f` — policy grant + fresh confirmation |
| `/devcontainer logs [--tail N]` | Bounded `docker logs` (default 100 lines); policy-checked and audited |
| `/devcontainer host-exec --argv <value> [...]` | Audited host escape hatch (granted by default; a configuration can withhold it with `hostExecution.allow: false`). One `--argv` per argument, taken verbatim; `--argv=<value>` passes an empty argument |
| `/devcontainer setup` | Install/upgrade the Dev Containers CLI globally (confirmed, audited) |
| `/devcontainer off` | Clear the target and hand this session back to the host (dormant); the opt-out is persisted, so `/reload` does not restore the target (nor auto-engage it) until you select one again — unless `activation` is `"always"`, which always takes over |

### Tools

| Tool | Surface | Parameters |
|---|---|---|
| `devcontainer_exec` | Container | `argv` (required), `cwd`, `timeoutSeconds` (positive; omitted = no tool timeout) |
| `devcontainer_status` | Read-only | — |
| `devcontainer_host_exec` | Host (policy-gated, audited) | `argv` (required), `timeoutSeconds` (positive; omitted = no tool timeout) |

The built-in `bash` tool is **replaced** by a container-routed version registered
with `exposeSessionEnvironment: false`, and `!`/`!!` share the same operations
instance — so the two surfaces cannot drift.

### Which surface runs where

| Surface | Runs in |
|---|---|
| `devcontainer_exec`, routed `bash` (`bash` tool, `!`, `!!`) | the selected container |
| `devcontainer_host_exec`, `/devcontainer host-exec` | the host (explicit, policy-gated) |
| `/devcontainer setup` | the host (one fixed `npm install -g` behind a confirmation) |
| `/devcontainer stop` / `remove` / `logs`, `up` / `build` | Docker / the Dev Containers CLI on the host, against the container |
| `read` / `write` / `edit` / `grep` / `find` / `ls` | **always the host** |
| everything, while **dormant** | nothing was registered: Pi's built-in host surfaces, unchanged |

### Discovery and selection

- Recognizes `.devcontainer/devcontainer.json`, `.devcontainer.json`,
  `.devcontainer/<name>/devcontainer.json` (named; several per workspace), and the
  legacy root `devcontainer.json`; merges host-config entries with Docker label
  candidates (`devcontainer.local_folder`) into one registry keyed by canonical
  workspace path. The CLI resolves only the first two by itself — for every other form
  the extension passes `--config <path>`, and
  `/devcontainer use <ws> --config <name|path>` selects which one to use, and
  `/devcontainer up|build` accept the same `--config <name|path>` (without it they use
  the configuration already selected for that workspace, else the highest-priority
  discovered form).
- Once a target is selected, a container command may be issued from a workspace that is
  not itself a DevContainer project: it runs against the selected target, and the audit
  record carries the executed target **and** the request's cwd. A request whose cwd is
  another DevContainer project stays `policy-denied` — it would silently act on a
  different repository.
- The bounded scan stops at `discovery.maxDepth` (default `3`), never descends
  into excluded or hidden directories (`.devcontainer` excepted), and refuses
  directories whose real path escapes an allowed root.
- Stopped containers are discoverable and selectable; execution on a stopped
  target fails closed with `target-stopped` until you run `/devcontainer up`.
- Two or more **running** containers for one workspace is `ambiguous` — Docker
  result order is never used to guess; pick one with
  `/devcontainer use <container-id>`.

## Configuration

Two JSON files are merged into one *effective* configuration. All keys are
optional; **defaults are restrictive**.

| Scope | Path | Trusted? |
|---|---|---|
| Global | `${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions/pi-devcontainer-manager.json` | always |
| Project | `<session-cwd>/.pi/pi-devcontainer-manager.json` | only when the project is trusted by Pi |

Policy-relevant values merge **monotonically**: `allowedWorkspaceRoots` and
`environmentAllowlist` intersect, limits take the minimum, `audit.commandCapture`
takes the lower of the two, and `destructive.*` require `true` in **both** files.

`hostExecution.allow` is the one grant that ships **enabled** (host execution is
an audited escape hatch the operator is expected to have), so it merges the other
way round: either file can **withhold** it by setting `false`, and a global
`false` cannot be widened by a project `true`. An untrusted project config can
never expand a global grant.

A minimal example:

```json
{
  "allowedWorkspaceRoots": ["/home/me/code"],
  "environmentAllowlist": ["HOME", "LANG"],
  "audit": { "commandCapture": "fingerprint-only" },
  "destructive": { "allowStop": false, "allowRemove": false },
  "hostExecution": { "allow": true }
}
```

A complete example with every default shown lives at
[examples/pi-devcontainer-manager.settings.json](examples/pi-devcontainer-manager.settings.json).
Every key, default, and merge rule is documented in
[docs/configuration.md](docs/configuration.md).

## Security model

- **Pi never runs inside a container.** No session, extension, skill,
  configuration, credential, or API key is installed, copied, mounted, or
  persisted in a target container.
- **Default deny.** Workspace roots, forwarded environment names, destructive
  actions, and host execution are all denied unless explicitly granted.
- **Fresh validation before every action.** Selection intent is persisted as a
  stable workspace key plus candidate discriminator; each operation re-resolves
  the target and freezes an immutable policy snapshot before any spawn, so a
  concurrent selection switch cannot redirect a bound operation.
- **Minimal child environment.** Children are spawned with a constructed
  environment, not an inherited Pi one. `PI_*` names and secret-pattern names
  (`api_key`, `token`, `secret`, `password`, `credential`, `auth`, `bearer`) are
  always excluded, even if listed in `environmentAllowlist`.
- **Fixed argv, `shell: false`, process-group kill.** Both output streams are
  bounded by `maxOutputBytes`; timeout/cancellation kills the whole process group.
- **Audited.** Every operation writes one host-local JSONL record (mode `0700`
  directory, `0600` files) to the platform audit directory, with SHA-256 argv
  fingerprints by default. Denied attempts are audited too.

The full threat model, gates, and operator checklist are in
[docs/security.md](docs/security.md). To report a vulnerability, see
[SECURITY.md](SECURITY.md).

## How it works

```text
session_start ─▶ load config (global + trusted project, monotonic merge)
              ─▶ compose runtime (process runner, adapters, target store, audit)
              ─▶ advisory capability probe (result discarded)
              ─▶ register tools + replacement `bash`; restore the persisted selection

every turn    ─▶ append execution context to the system prompt
                 (current target, host↔container mapping, surface rules)

each operation─▶ freeze policy snapshot ─▶ bind immutable context (re-resolve target)
              ─▶ build child env ─▶ spawn (fixed argv, shell:false, bounded output)
              ─▶ write one audit record ─▶ return a structured result
```

Workspace registry discovery is lazy (first `/devcontainer` command or tool
call), and the runtime is recomposed on `/reload`. The registry, the target store,
and the execution service live in `src/`; `extensions/index.ts` is the only file
that touches the Pi API.

## Compatibility

Supported: **Linux and macOS with Docker Engine or Docker Desktop**, using the
pinned `@devcontainers/cli@0.88.0`. Unsupported in v1: Windows hosts, WSL2 path
translation, Podman, rootless Docker, non-Docker backends, and Compose teardown.

Failures are typed, not silent: `daemon-unavailable`, `authorization-denied`, and
`devcontainer-cli-failure` instead of degraded behavior. The full matrix is in
[docs/compatibility.md](docs/compatibility.md).

## Troubleshooting

Errors are reported as `[<kind>] <message>` with one of thirteen kinds and, where
possible, a remedy line. Common cases — `target-stopped`, `no-candidate`,
`ambiguous-candidate`, denied `hostExecution`, a missing audit file, a container-only
path — are covered in [docs/troubleshooting.md](docs/troubleshooting.md).

**No DevContainer in the current project?** `bash` and `devcontainer_exec` are
unusable there — `[no-candidate] No DevContainer target is selected.` — because
the extension loads globally and refuses to fall back to the host. That is the
fail-closed contract, not a broken install. See
[docs/troubleshooting.md](docs/troubleshooting.md#the-extension-is-loaded-in-a-project-with-no-devcontainer).

## Development

```bash
npm ci                 # installs the pinned @devcontainers/cli@0.88.0 as well
npm run typecheck      # strict NodeNext, noEmit
npm run test:unit      # deterministic unit tests (capability-gated suites skip)
npm test               # unit + capability-gated integration/e2e + package smoke
npm run build          # emit dist/ (declarations + source maps)
npm run pack:check     # tarball allowlist + manifest contract

node scripts/verify-package.mjs        # whole-package gate (typecheck, tests, build, pack)
node scripts/smoke-pi-package.mjs      # packed-tarball smoke through a real Pi runtime
```

The integration and e2e suites start **real** DevContainers through the pinned
CLI, so they skip themselves when Docker or the CLI is unavailable. CI runs the
deterministic unit + package gates on every push and keeps the real-Docker suites
in a separate workflow.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow, and
[JavaScript/TypeScript conventions](CONTRIBUTING.md#conventions):
`src/` stays Pi-dependency-free so unit tests need no Pi install, and only
`extensions/index.ts` performs the structural casts that wire `src/` into Pi.

## Documentation

| Document | Contents |
|---|---|
| [docs/installation.md](docs/installation.md) | Install, load, verify, uninstall |
| [docs/configuration.md](docs/configuration.md) | Every key, default, and merge rule |
| [docs/security.md](docs/security.md) | Threat model, gates, audit, `/devcontainer setup` |
| [docs/compatibility.md](docs/compatibility.md) | v1 support matrix and failure modes |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Typed errors and their remedies |
| [docs/README.md](docs/README.md) | Documentation index |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Build, test, and PR workflow |
| [SECURITY.md](SECURITY.md) | How to report a vulnerability |
| [CHANGELOG.md](CHANGELOG.md) | Release history |
| [中文说明](README.zh-CN.md) | Chinese overview of this README |

## License

MIT — see [LICENSE](LICENSE). © pi-devcontainer-manager contributors. Changes are
recorded in [CHANGELOG.md](CHANGELOG.md).
