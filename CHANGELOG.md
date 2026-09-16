# Changelog

All notable changes to `pi-devcontainer-manager` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/) and this project adheres
to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- The session selection is one persisted contract now. `/devcontainer off` appends an **opt-out**
  that survives `/reload` — it suppresses the workspace-derived activation and in-session
  auto-selection until you select a target again (an explicit `activation: "always"` still takes
  over, and a project file can still withhold it) — and the selected configuration travels with the
  selection: it drives the prompt context,
  the exec-path presentation and the host container-path guard instead of those falling back to the
  workspace's primary configuration. Sessions written before this change restore unchanged.
- `/devcontainer use` engages the container surfaces only when it actually established a target: a
  `use` that matched nothing, hit an ambiguous workspace, or was cancelled leaves `bash`, `!`/`!!`
  and the file tools exactly as they were.
- `timeoutSeconds` on `devcontainer_exec` and `devcontainer_host_exec` must now be
  **positive**: `0` and negative values are rejected by the tool schema instead of
  becoming an immediate abort (`timeout: Command timed out after 0s`). Omitted still
  means "no tool timeout", and fractional values still work.
- The host registry no longer returns the `configOnly` / `orphanDockerCandidates`
  collections (nothing read them — the same information lives in `entries`), and the
  diagnostics discovery already produced — an unreadable directory, a symlink escaping
  the allowed root, `maxDepth` pruning, a Docker candidate without its
  `devcontainer.local_folder` label, an unparsable `docker ps` record — are now surfaced
  as warnings after a `/devcontainer` command instead of being computed and discarded.
- Audit redaction replaces a **whole** authentication value instead of the prefix
  that happened to match a character class, so a value containing `,`, `;`, `:` or
  non-ASCII characters no longer leaves its tail in the audit file.
- Two error kinds are now distinct: `target-refreshing` (a selection is mid-refresh;
  retry the operation) and `docker-cli-failure` (a `stop`/`remove` failed in the
  Docker CLI, which previously reused `devcontainer-cli-failure`). Both are listed in
  `docs/troubleshooting.md`.
- Refusals, the spawn-error mapping, the runner invocation and the fallback output cap
  each have a single owner: refusal records are written by the same builder as every
  other audit record, the three runtime adapters share one spawn-error mapper and one
  bounded-invocation helper (removing six compile-time-only `unreachable … path`
  throws), the five fallback caps collapsed into `DEFAULT_MAX_OUTPUT_BYTES` plus a
  named `LOGS_MAX_OUTPUT_BYTES`, and the unused `resolveTool` wrapper in
  `extensions/index.ts` is gone. No operator-visible behaviour changes beyond the two
  kinds above and the redaction fix.

### Fixed

- A refused `/devcontainer setup` install (npm missing, the install timing out, an abort) is
  now audited and reported through the structured `[setup-failed] …` path. The install stage
  used to run without a `try`/`catch`, so it skipped its `setup` audit record entirely and
  reached the handler as an unnormalized error — while the version probe below it was already
  normalized. One attempt now always writes exactly one `setup` record.
- A structured execution no longer drops stderr when the command also wrote stdout.
  `devcontainer_exec` and `devcontainer_host_exec` show both streams, with the stderr
  section labelled `--- stderr ---`, instead of falling back to stdout alone.
- A refused execution is audited. No target selected, an ambiguous or stopped target, a
  store mid-refresh, or a failing auto-select now writes a record carrying the failure
  (policy authorized, target state refused) before the typed error is rethrown, matching
  how policy denials were already recorded.
- DevContainer configurations are parsed with a string-safe JSONC reader. A `//` inside an ordinary
  string value (a URL such as `https://registry.example.com//v2`, or `"bash // bootstrap"`) used to
  truncate the document, which made the derived host<->container mapping disappear and, with it, the
  host container-path guard that depends on it — a fail-open in a safety check. A configuration that
  cannot be parsed is now reported as a diagnostic instead of looking like one that declares no
  mapping.
- A restored container ID is validated against the fresh registry: a rebuilt container's stale ID no
  longer reselects it (the workspace's current candidate is resolved instead), while an ambiguous
  workspace still fails closed rather than letting Docker's result order decide.
- A successful `/devcontainer up` refreshes the registry before reconciling, so the target becomes
  usable immediately instead of lingering as `selected-missing` right after a successful start.
- Auto-selection commits atomically (`TargetStore.selectIfNone`): an explicit `/devcontainer use`
  that lands while discovery is still running can no longer be overwritten by it.
- The container-only mounts the execution context advertises are populated again: the runtime reads
  them from the same parsed configuration that produces the workspace mapping, instead of leaving
  the prompt field permanently empty.
- Every spawn failure now names the OS error code, and `ENOTCONN` gets its own explanation:
  `Failed to spawn: devcontainer` used to be the whole message for *any* failure other than
  `ENOENT`/`EACCES`, which made a half-dead filesystem mount inside `PATH` (the case behind one
  2026-09-15 misdiagnosis) look exactly like a missing binary. See
  [Troubleshooting](docs/troubleshooting.md#the-host-cannot-start-any-executable-enotconn).
- The three surfaces that still discarded stderr do not any more: `/devcontainer host-exec`
  (the command, not just the tool), `docker logs` (the container's stderr half was dropped
  entirely), and `stop`/`remove`, whose failure message now carries what Docker actually said
  instead of only the exit code.
- A positive timeout that rounds to zero (`0.0004`) no longer means "abort immediately": the
  millisecond budget is floored at 1 ms at both entry points, and a sub-second deadline is
  reported in milliseconds instead of as `timed out after 0s`.
- `/devcontainer setup` reports what actually happened: a signal-killed install names the signal
  instead of `exited null`, the `setup` record is written after the verification step so a failed
  probe can no longer leave a success-shaped record behind, a failing audit sink is surfaced in
  the result instead of escaping unnormalized, and the failure text handed back to the operator
  and the model is redacted the same way the audit copy is.
- Discovery diagnostics are delivered even when a verb handler throws (the drain moved into a
  `finally`), and `/devcontainer <verb>` prints its result again: Pi's command dispatcher ignores
  a handler's return value, so `list`, `status`, `logs` and the rest were producing no output at
  all.

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

- While dormant, the `bash` tool delegates to Pi's own local bash operations instead of a
  hand-rolled host shell, so the surface matches the built-in exactly (shell resolution,
  environment, truncation) and dormancy can only ever restore the default.
- `/devcontainer up` no longer discovers the registry twice per invocation (the resolved
  entries are handed to the selection reconcile step).

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
