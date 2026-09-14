# Changelog

All notable changes to `pi-devcontainer-manager` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/) and this project adheres
to [Semantic Versioning](https://semver.org/).

## [Unreleased]

Nothing yet — see [1.0.0] for the initial release.

## [1.0.0] - Unreleased

First release. Initial governed multi-DevContainer extension for Pi on Linux and
macOS.

### Added


- Named DevContainer configurations (`.devcontainer/<name>/devcontainer.json`) are
  discovered as candidates for their workspace and selectable with
  `/devcontainer use <workspace> --config <name|path>`; the selected configuration is
  carried through selection into `up`/`build`/`exec` as `--config <path>`.
- `activation` (`"workspace"` (default) | `"always"` | `"never"`): the extension now
  decides **per session** whether to take over the execution surfaces. In a workspace
  with no DevContainer evidence it stays dormant and registers nothing, so Pi's
  built-in `bash`, `!`/`!!`, and host file tools are untouched.
- `/devcontainer off`: clears the target and hands the session back to the host.
- Configuration diagnostics for two formerly silent outcomes: a project file ignored
  because Pi does not trust the project, and a project value clamped by a host
  ceiling (reported at session start and by `/devcontainer status`).
- Host-side Pi extension for governed multi-DevContainer discovery, selection,
  and execution.
- Bounded DevContainer configuration discovery (`devcontainer.json`,
  `.devcontainer/devcontainer.json`, `.devcontainer.json`) across allowed
  workspace roots, merged with Docker label candidates into a single workspace
  registry; config-only (never-started) projects are first-class entries, and
  several running containers for one workspace stay `ambiguous` instead of being
  resolved by Docker result order.
- Selection state machine with seven explicit states, immutable operation
  context binding, and versioned session-entry persistence
  (`devcontainer-manager:selection`, version 1). The persisted selection is
  re-resolved against the live registry on `session_start` and after a
  successful `up`.
- Shared execution service behind every command surface: `devcontainer_exec`
  tool, routed Pi `bash`, `!`/`!!`, `up`, `build`, `stop`, `remove`, and `logs`
  — one policy snapshot, environment filter, audit, output accounting,
  cancellation, and timeout path.
- Dev Containers CLI (`up`/`build`/`exec`) and Docker adapters (read-only
  discovery/inspection, bounded `logs`, confirmed `stop`/`remove`) with fixed
  argv, `shell: false`, and sanitized environments.
- Default-deny configuration and policy: monotonic merge, `PI_*`/secret
  environment exclusion, per-action confirmation tokens for destructive
  actions, and an explicit policy-gated audited host escape hatch
  (`devcontainer_host_exec` / `/devcontainer host-exec`).
- `/devcontainer setup` — confirmed, audited installation/upgrade of the Dev
  Containers CLI (`npm install -g @devcontainers/cli`) with a fixed argv, a 300 s
  timeout, and a `--version` verification probe.
- Host-local JSONL audit with a 90-day retention window (writer `prune(now)`
  removes expired files; the v1 runtime does not schedule it) and
  fingerprint-only command capture by default. `audit.enabled` and
  `audit.directory` are honored (`enabled: false` accepts records but persists
  nothing; `directory` is global-only).
- Deterministic unit tests, capability-gated real-Docker integration/e2e tests,
  packed-tarball smoke tests, and CI/integration/release workflows with an exact
  `@devcontainers/cli@0.88.0` pin.
- Operator documentation: installation, a configuration reference, the security
  model, the v1 compatibility matrix, and a typed-error troubleshooting guide,
  plus a documentation index and a contributing guide.

### Changed

- Routing from outside the selected target: a container operation may now be issued
  from a workspace that is not itself a DevContainer project (it runs against the
  selected target), and the audit record carries the executed workspace **and** the
  request's `requestedCwd`. A request whose cwd is itself another DevContainer project
  is still refused with `policy-denied`, and the CLI always receives the target
  workspace, so authorization scope, execution, and audit cannot disagree.

- Audit records for a request inside the target no longer claim a sub-directory was
  the workspace: `workspace` is always the executed target, with the caller's cwd in
  `requestedCwd` when it differs.

### Fixed

- Discovery and the pinned CLI disagreed about which configuration forms exist: a
  legacy root `devcontainer.json` was listed as a first-class form but was invisible to
  `devcontainer up --workspace-folder`, so such a target could be selected and never
  started, while named `.devcontainer/<name>/devcontainer.json` forms were not
  discovered at all. Every accepted form is now covered by a contract test that runs
  the real pinned CLI, and the non-default forms are passed explicitly with `--config`.

- The global configuration file now follows Pi's config directory
  (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`) instead of being hard-coded to
  `~/.pi/agent/extensions/`. With a relocated agent directory the previous path
  silently ignored the file and applied the restrictive defaults, so a misplaced
  grant looked like a policy denial. `defaultConfigPaths` now takes injectable
  `env`/`home` arguments (mirroring `defaultAuditDirectory`) and is unit-tested.

### Security

- The "no silent host fallback" invariant is now **per workspace**. While dormant the
  extension registers nothing, so `bash` is Pi's built-in host shell by design — that
  restores default behavior rather than widening host access. The audited,

- `bash` replacement registered with `exposeSessionEnvironment: false`; session
  metadata never reaches a container.
- No silent host fallback from `container-required` routes.
- Audit records and error/command text are redacted before write; records never
  contain environment values.
- `/devcontainer setup` is deliberately not gated by `hostExecution.allow`
  because it cannot execute caller-supplied argv; it requires an interactive
  confirmation and is audited as `operation: "setup"`.

[Unreleased]: https://github.com/ahaeureka/pi-devcontainer-manager/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/ahaeureka/pi-devcontainer-manager/releases/tag/v1.0.0
