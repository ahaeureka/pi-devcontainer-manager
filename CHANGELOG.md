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

### Security

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
