---
date: 2026-08-31T09:40:17+0800
author: geebytes
commit: no-commit
branch: no-branch
repository: unknown
topic: "Host-machine Pi extension for multi-DevContainer discovery, routing, lifecycle management, and governance"
tags: [research, pi-extension, devcontainer, docker, typescript, security, audit]
status: ready
last_updated: 2026-08-31T09:40:17+0800
last_updated_by: geebytes
---

# Research: Host-machine Pi extension for multi-DevContainer management

## Research Question

Validate a complete technical approach for a host-machine TypeScript Pi extension that discovers, selects, manages, and executes commands in multiple VS Code DevContainers without installing Pi, Pi credentials, or Pi sessions inside containers. The intended downstream outcome is a full-project design and implementation plan, covering both an explicit structured execution tool and a safe `bash` routing capability.

## Summary

The repository is a documentation-and-placeholder baseline, not an existing extension: `package.json:1-12` names a CommonJS package but references a missing `index.js` and deliberately fails tests. The proposed extension must therefore establish its complete package, runtime, configuration, test, CI, release, and operational model rather than integrate with local implementation conventions.

Current Pi extension APIs support the required shape. A TypeScript extension factory can register tools and slash commands, persist session entries, and replace or wrap a shell tool. Pi exposes `BashOperations`, an async command execution interface with abort signal, timeout, and output streaming, specifically intended for remote execution surfaces. This is the suitable seam for a container-aware `bash` replacement; the proposal's string-based `spawnHook` is not sufficient for a safe boundary.

The complete project should deliver two complementary execution interfaces sharing one target-selection state machine and one policy/audit pipeline:

1. `devcontainer_exec` is an explicit, structured tool for unambiguous target, command, environment, timeout, and result semantics.
2. A replacement `bash` tool uses custom `BashOperations` to route shell text through a parameterized Dev Containers CLI process when container routing is enabled and a valid target is selected; it must otherwise follow a documented host-mode or error policy.

Docker should be the discovery, state, logs, and explicitly confirmed destructive-lifecycle adapter. Dev Containers CLI should be the workspace-oriented `up`, `build`, and `exec` adapter. The external-command boundary needs an injectable asynchronous argv runner, capability discovery, immutable per-operation policy snapshot, bounded streaming output, cancellation, and typed diagnostics. Container records must preserve ambiguity rather than silently selecting the first label match.

The local environment currently has Docker client `27.3.1`, but has no `devcontainer` executable available. Therefore actual execution against the installed CLI could not be exercised here; the project must pin and test a supported Dev Containers CLI version in CI. Package metadata for current `@devcontainers/cli` identifies `devcontainer.js` as its executable and upstream as `github.com/devcontainers/cli`; npm registry currently reports `0.88.0` as latest. This validates the packaging surface but not a local runtime capability.

## Detailed Findings

### 1. Repository and delivery baseline

- The repository contains only `package.json` and the proposal document, plus RPIV artifacts. There is no source directory, extension entry, build configuration, test runner, dependency lockfile, CI workflow, release configuration, or user-facing package documentation.
- `package.json:1-12` has `main: "index.js"`, `type: "commonjs"`, no dependencies, no Pi manifest, an empty keyword list, and `npm test` set to an erroring placeholder. It cannot currently be loaded as a package or tested.
- Pi package distribution requires either convention directories or a `pi` manifest in `package.json`; the installed Pi package documentation states that a package manifest lists extension paths and that `pi-package` is a discoverability keyword. Runtime dependencies are installed as production dependencies, while Pi core packages should be peer dependencies.
- The downstream design must choose a source/distribution model deliberately: TypeScript sources in a named extension directory, a testable build output (or source loading only where Pi's jiti loader is the intended distribution contract), package `files` allowlist, `exports`, peer-dependency range policy, and package smoke checks.

**Implication:** all project infrastructure is in scope. This is not a patch to an existing extension.

### 2. Pi extension API and state capabilities

- Pi's extension documentation shows a default factory accepting `ExtensionAPI`, with tool registration through `pi.registerTool()` and slash commands through `pi.registerCommand()`.
- `pi.registerTool()` can be called during initialization or later and immediately refreshes the tool set. Tool definitions receive a cancellation signal and progress callback (`docs/extensions.md:1365-1407`).
- Pi supports durable custom session entries through `pi.appendEntry()` and recovery on `session_start` through `ctx.sessionManager.getEntries()` (`docs/extensions.md:1471-1486`). This supports a session-scoped selected-target record that survives session restoration without becoming a global machine default.
- Extension command names can collide; Pi preserves them with numeric suffixes by load order (`docs/extensions.md:1525-1539`). Project commands therefore need a distinctive namespace, such as `/devcontainer` with documented subcommands, instead of many generic command names.
- Same-name tool registration is a supported override pattern in Pi. It is appropriate to expose a replacement `bash` only after preserving a direct host execution mode and applying target/policy checks at execution time.

**State model finding:** selected target should be session-scoped and persisted as an append-only selection event, reconstructed on session start, then validated against fresh discovery before use. A persistent record must contain a stable workspace identity and selected candidate discriminator, not a stale container ID alone. Container IDs are ephemeral across rebuilds.

### 3. The correct `bash` routing seam

- The proposal rewrites a `bash` command by returning `devcontainer exec ... bash -lc "${command}"` from `spawnHook` (`docs/pi-devconatiner-manager.md:584-608`). Its command and workspace are interpolated into one shell string.
- Pi's public declarations define a `BashSpawnHook` as a transformation of only `{ command, cwd, env }`; no argv field, abort signal, stdout/stderr separation, or typed child-process result exists at that hook (`dist/core/tools/bash.d.ts:51-67`). Pi documentation also confirms that built-in bash exposes Pi session environment values before the spawn hook unless `exposeSessionEnvironment: false` is configured (`docs/extensions.md:2144-2164`).
- In contrast, `BashOperations.exec` receives the raw shell command plus `cwd`, `signal`, `timeout`, `env`, and an output callback. Pi documents this interface as the extension seam for delegating command execution to remote systems (`dist/core/tools/bash.d.ts:20-39`; `docs/extensions.md:2111-2142`).
- The shell command itself remains semantically a shell program; it cannot be decomposed losslessly into arbitrary argv. The safe boundary is to invoke the host executable with a fixed argv such as `devcontainer`, `exec`, workspace flags, a fixed container-side shell executable, `-lc`, and the entire command as exactly one final argv item. The host process must never use `shell: true` or concatenate untrusted workspace/command text into its own shell program.

**Required outcome:** implement `bash` routing through custom `BashOperations`, not `spawnHook`. The implementation must set `exposeSessionEnvironment: false`, construct a filtered child environment, honor Pi's signal/timeout/output callback contracts, and stream bounded output. It must distinguish: route disabled, no selection, ambiguous selection, stale selection, stopped target, policy denial, and process failure. None may silently execute in a different environment.

### 4. Two execution interfaces are required for the full project

The developer decision is to finish both interfaces as part of the complete project period, rather than define a reduced first-release-only scope.

- **Structured execution tool:** `devcontainer_exec` takes explicit schema fields such as selected target reference or workspace, command form, shell mode, approved environment map, timeout, and output limit. It returns target identity, invocation summary, exit code, stdout/stderr or combined stream semantics, truncation status, duration, and typed diagnostic category. This is the least ambiguous integration interface for LLM tools, tests, audit, and future automation.
- **Routed shell tool:** replacement `bash` preserves Pi's familiar command UX. Its routing policy must be explicit and visible in status/UI: `container-required`, `container-preferred`, or `host-only`. It must never use automatic host fallback for a failed or missing container target in `container-required` mode.
- **Direct user shell:** Pi fires `user_bash` for `!`/`!!` commands and permits custom operations (`docs/extensions.md:877-906`). The project should apply the same route policy and shared container executor to both LLM `bash` and user shell operations, or explicitly document that user shell commands are host-only. A mixed, undocumented behavior would defeat operator expectations.
- **Host escape hatch:** the full design must retain an intentional host-native execution option for extension maintenance and host administration. It needs an unmistakable tool/command name or mode, target display, policy authorization, and audit source marker. It must not be an accidental fallback from container routing.

### 5. Container discovery and identity

- The proposal's `findDevContainerId()` filters Docker with `devcontainer.local_folder` but uses `docker ps` and returns only the first result (`docs/pi-devconatiner-manager.md:573-582`). `docker ps` excludes stopped containers by default, and first-result selection loses information in the presence of Compose services, historical duplicate containers, or malformed labels.
- Discovery must query all relevant containers (`docker ps --all`) using parameterized filters and a machine-readable format. It must parse full container IDs, names, state/status, image, created timestamp, and selected labels such as `devcontainer.local_folder` and config metadata where present.
- Paths require a canonical comparison key while retaining the original labelled path for diagnostics. The canonicalizer must use realpath only where the path exists, normalize platform separators deliberately, and record unresolved/missing paths rather than collapsing different values. Windows/WSL conversion is an explicit capability boundary, not an assumption.
- A workspace may map to zero, one, or multiple candidates. The data model needs a `CandidateSet`/ambiguity status. Selection by display name must resolve deterministically or require an explicit candidate ID. The extension must never pick an arbitrary result merely because a query returned multiple lines.
- Discovery should be read-only: listing, status refresh, and selection do not create, rebuild, or restart any container.

**Selection states:** `none`, `selected-valid`, `selected-ambiguous`, `selected-missing`, `selected-stopped`, `selected-policy-denied`, and transient `refreshing`. Routing and lifecycle actions must consume these states rather than rediscovering ad hoc.

### 6. Dev Containers and Docker adapters

- The functional baseline specifies Dev Containers CLI as the workspace-semantics boundary and Docker as discovery, status, logs, and limited lifecycle support (`.rpiv/artifacts/discover/2026-08-31_01-55-59_pi-devcontainer-manager.md:109-126`). This division remains technically sound.
- Dev Containers CLI must own workspace-oriented `up`, `build`, and `exec`, because these operations depend on workspace configuration, remote user, mounts, and Dev Container configuration resolution. A successful `up` or rebuild must be followed by Docker rediscovery before target state is reported as valid.
- The local proposal asserts candidate lifecycle commands but does not provide verified CLI evidence for `devcontainer stop` or `devcontainer down`; its own CI example only invokes `build`, `up`, and `exec` (`docs/pi-devconatiner-manager.md:639-659`). Upstream capability validation completed so far confirms `up`, `build`, and `exec` as the project baseline but does not establish `stop`/`down` as stable Dev Containers CLI operations.
- Stop/remove must therefore be designed through a separate Docker lifecycle adapter using full selected container IDs and explicit destructive confirmation/policy checks. The design must label it as a Docker action, restrict it to a resolved unique candidate, and rediscover afterwards. Compose-aware teardown beyond a single labeled container needs its own identified scope and should not be hidden behind a generic `down` label.
- Docker log access is permitted only with fixed argv, explicit target candidate, bounded bytes/lines, timeout, and a redaction pass before output/audit persistence.
- The package must perform startup/on-demand capability checks for executable location, `--version`, Docker daemon connectivity, permission failures, backend identity, and supported OS/path behavior. It should offer typed degradation: discovery unavailable, CLI unavailable, daemon inaccessible, backend unsupported, and permissions denied.

### 7. Security, credentials, and audit boundary

- The proposal states that Pi-related credentials and `~/.pi` must not be exposed inside containers (`docs/pi-devconatiner-manager.md:626-631`). The FRD makes this a mandatory requirement: no default model/Pi credential propagation and explicit environment allowlisting (`.rpiv/artifacts/discover/2026-08-31_01-55-59_pi-devcontainer-manager.md:104-108`).
- Docker socket access is a high-privilege host boundary. The extension cannot make Docker inherently least-privilege; it can reduce accidental scope by allowlisted workspace roots, fixed executable paths, argv-only invocation, no automatic privileged escalation, explicit destructive action gates, and operator-visible audit.
- The process environment supplied to `devcontainer` and Docker needs to be built from a minimal baseline rather than inherited wholesale. It must exclude `PI_*`, provider/API/token credential patterns, and all unapproved variables. Explicitly allowed variables must use a name allowlist; values should not be recorded in tool details, UI, or audit records.
- Audit records should be structured JSON Lines stored under an OS-appropriate host state directory, with configurable enablement, retention/rotation, restrictive file permissions, and no write path inside the target container. Records require timestamp, session correlation that is not a secret, operation kind, initiator (`tool`, `slash-command`, `routed-bash`, `user-bash`), resolved workspace/candidate, policy outcome, duration, exit category/code, output-truncated flag, and redacted error summary.
- Command text is potentially sensitive because developers can pass secrets directly. The policy must support command recording modes: `none`, `fingerprint-only` (recommended default for governance), and `redacted-text`; plaintext full command capture must be explicit and warned. Secret redaction is defense in depth, not authorization to store arbitrary command text.

### 8. Configuration and policy evaluation

- The initial requirement calls for global and project-level configuration covering binary paths/backend, routing mode, output limits, timeout, allowed workspace roots, and audit (`.rpiv/artifacts/discover/2026-08-31_01-55-59_pi-devcontainer-manager.md:100-108`).
- Configuration needs a schema-validating loader and a single documented precedence chain. A suitable model is package defaults < user-level Pi extension configuration < project-level configuration < explicit tool request only for fields allowed to be overridden. Restrictive fields such as workspace roots, destructive operations, environment allowlists, and audit settings must not become less restrictive through an untrusted project configuration unless the administrator explicitly permits that delegation.
- Resolve configuration once into an immutable policy snapshot per operation. This prevents concurrent target switches or hot reloads from changing the authorization basis partway through a process invocation.
- Backend abstraction should define Docker as the supported initial backend. Podman and Windows/WSL require feature probes and must report unsupported/degraded status rather than pretending Docker CLI semantics apply. Linux/macOS Docker is the validated design baseline; cross-platform path adapters are a separately testable capability.

### 9. Process execution and error model

- The proposal's synchronous `spawnSync` test idea (`docs/pi-devconatiner-manager.md:617-624`) cannot model streaming output, cancellation, concurrency, timeout cleanup, or abort signal behavior required by Pi tools.
- The project needs an injected asynchronous `ProcessRunner` boundary taking `file`, `args`, `cwd`, sanitized `env`, timeout, abort signal, output limits, and stream callbacks. Production implementation wraps `node:child_process.spawn` with `shell: false`; test implementation is a deterministic fake.
- Process results must preserve exit code/signal, stdout/stderr or ordered combined chunks, elapsed duration, truncation indication, spawn error, and timeout/cancellation state. On output limit, the implementation continues draining or terminates according to a documented strategy so child processes cannot block on full pipes.
- Error taxonomy must distinguish executable missing, spawn permission error, Docker daemon unavailability, Docker authorization denial, Dev Containers CLI failure, no candidate, ambiguous candidate, selected target stopped, path/policy denial, timeout, cancellation, parsing failure, and nonzero target command exit. Each maps to a concise remedy while retaining machine-readable kind.
- Concurrency is per session but tool calls may execute in parallel. State mutation (select, clear, start/rebuild/stop/remove) needs a serialized target-state store; read-only discovery may run concurrently. A command invocation binds one immutable `ExecutionContext` before spawning, so a concurrent A→B selection cannot redirect an in-flight command.

### 10. Verification strategy

- Unit tests must exercise Docker label parsing, all-container discovery, path canonicalization, duplicate/missing labels, target state transitions, policy merge and restriction monotonicity, argv construction, environment filtering, output truncation, errors, audit redaction, selection persistence/recovery, and concurrent target switch safety.
- Process-runner contract tests must simulate `ENOENT`, `EACCES`, nonzero exit, streaming large output, timeout, abort, child termination, and mixed stdout/stderr. These tests need no Docker daemon.
- Pi integration tests should load the packaged extension into a disposable Pi invocation and assert tool and command registration, session-state recovery, tool override behavior, command namespace behavior, and rendered diagnostics. They must verify no `PI_*` or known model credential variables cross the container execution environment.
- Docker/Dev Containers integration tests should create at least two fixture workspaces and use a pinned Dev Containers CLI version. They verify read-only discovery, explicit select A→exec→select B→exec, stale/missing target recovery, `up` reuse, supported rebuild flow, Docker stop/remove confirmation boundary, audit artifacts, and cleanup. They should be capability-gated in CI and produce a clear skipped result only where Docker is unavailable.
- Release checks must include typecheck, lint, unit test, package build, package tarball contents (`npm pack --dry-run`), clean-install load test, extension smoke test, and dependency/security review. The proposal's example CI uses old generic setup actions and unpinned runtime behavior (`docs/pi-devconatiner-manager.md:639-659`), so it is reference material rather than an acceptable final release pipeline.

## Code References

- `package.json:1-12` — existing placeholder package metadata and deliberately failing test script.
- `docs/pi-devconatiner-manager.md:1-27` — host Pi / multiple target-container intent.
- `docs/pi-devconatiner-manager.md:573-582` — proposed Docker label lookup that incorrectly collapses candidates to the first running result.
- `docs/pi-devconatiner-manager.md:584-608` — proposed `spawnHook` bash redirection; unsafe host-shell interpolation seam.
- `docs/pi-devconatiner-manager.md:610-624` — preliminary configuration/test examples that lack schema and async process isolation.
- `docs/pi-devconatiner-manager.md:626-631` — credential isolation and Docker permission assertions.
- `docs/pi-devconatiner-manager.md:633-659` — incomplete validation/CI proposal; confirmed use of `build`, `up`, and `exec` only.
- `.rpiv/artifacts/discover/2026-08-31_01-55-59_pi-devcontainer-manager.md:22-45` — problem intent and goals.
- `.rpiv/artifacts/discover/2026-08-31_01-55-59_pi-devcontainer-manager.md:63-108` — functional, security, configuration, and testing requirements.
- `.rpiv/artifacts/discover/2026-08-31_01-55-59_pi-devcontainer-manager.md:160-177` — chosen host-only Pi, multi-target session, Docker discovery, Dev Containers CLI, and audit decisions.
- `/home/work/.nvm/versions/node/v24.19.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:64-100` — extension factory, tool, and command example.
- `/home/work/.nvm/versions/node/v24.19.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:1365-1407` — tool registration and execution callback contract.
- `/home/work/.nvm/versions/node/v24.19.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:1471-1486` — session custom-entry persistence/recovery.
- `/home/work/.nvm/versions/node/v24.19.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:1525-1539` — command registration and collision behavior.
- `/home/work/.nvm/versions/node/v24.19.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:2111-2164` — remote operations, spawn hook limitation, and Pi session environment exposure.
- `/home/work/.nvm/versions/node/v24.19.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.d.ts:20-67` — `BashOperations` and `BashSpawnHook` type contracts.
- `/home/work/.nvm/versions/node/v24.19.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/packages.md:116-171` — Pi package manifest, discovery, and dependency requirements.

## Integration Points

### Inbound References

- Pi extension loader — discovers the package-provided TypeScript/JavaScript extension using the package `pi.extensions` manifest or extension convention directory.
- Pi tool runtime — invokes explicit DevContainer tools and replacement `bash` tool using schemas and cancellation signals.
- Pi command runtime — invokes the namespaced user command interface for discovery, selection, status, lifecycle, and policy visibility.
- Pi session manager — restores custom selection-state entries and records subsequent state transitions.
- Developer or LLM — supplies workspace selection, explicit lifecycle requests, and command content.

### Outbound Dependencies

- Docker CLI/daemon — all-container label discovery, state inspection, bounded logs, and uniquely resolved stop/remove operations.
- Dev Containers CLI — workspace-aware `up`, `build`, and `exec` operations.
- Host filesystem — project configuration, canonicalization checks, package state/audit directory, and fixture workspaces in test runs.
- Node.js process APIs — argv-only child processes, abort/timeout management, bounded output collection, and typed errors.
- Pi core and TypeBox — extension API, `BashOperations`, tool schemas, and package peer dependencies.

### Infrastructure Wiring

- `package.json` — package metadata, Pi manifest, runtime/peer/dev dependencies, scripts, exports/files, engine policy, and publish contents.
- extension entry module — composes config loader, capability service, process runner, discovery/lifecycle adapters, target store, executor, audit writer, tools, commands, and event handlers.
- CI workflows — run hermetic unit/package checks and capability-gated Docker integration suites using pinned Node, Pi, Docker, and Dev Containers CLI versions.
- operational configuration — resolves global, team, and project policy with validated precedence and restriction boundaries.

## Architecture Insights

- **Separate identity from execution.** Docker labels describe observable candidates; a session selection names one candidate/workspace; an immutable execution context binds the selected target; only then does a CLI process run.
- **Separate workspace semantics from container inspection.** Dev Containers CLI owns workspace operations; Docker owns concrete container inspection and explicitly labeled low-level actions. Avoid treating Docker as a substitute for Dev Container configuration resolution.
- **Use a single policy gate for every pathway.** Explicit tool execution, routed `bash`, user `!` shell execution, slash-command lifecycle actions, logs, and host escape all must pass the same workspace/environment/destructive-action/audit policy evaluator.
- **Do not conflate raw shell syntax with host shell interpolation.** A target-side shell may intentionally interpret a shell command. The host launch remains safe when its executable/argument vector is fixed and the raw command occupies one argv item.
- **Prefer state validation over optimistic reuse.** Persist selection intent at session scope, but rediscover/verify before action because container IDs and state are volatile.
- **Treat tool output and audit output differently.** Tool results may contain useful bounded diagnostics; durable audit must minimize data, redact, and make command-text recording an explicit governance decision.

## Precedents & Lessons

Git history is unavailable: repository metadata reports `no-commit` and `no-branch`, and the working directory is not a Git repository. No repository precedent can be inferred.

### Lessons from current proposal material

- `docs/pi-devconatiner-manager.md:573-582` demonstrates the risk of discovery code that assumes a one-workspace/one-running-container mapping. Candidate ambiguity must be a first-class result.
- `docs/pi-devconatiner-manager.md:584-608` demonstrates why a shell-text `spawnHook` is not the process-isolation boundary for the final design.
- `docs/pi-devconatiner-manager.md:617-624` demonstrates why synchronous-child-process mocks are inadequate for cancellation, streaming, and concurrent selection correctness.
- `docs/pi-devconatiner-manager.md:626-631` establishes the central non-negotiable: containers are execution targets, not hosts for Pi configuration or credentials.

## Historical Context (from `.rpiv/artifacts/`)

- `.rpiv/artifacts/discover/2026-08-31_01-55-59_pi-devcontainer-manager.md` — functional requirements document and previous decisions for this project.

## Developer Context

**Q (discover: 以单个宿主机 Pi 管理多个容器): 该项目应只支持“一次宿主机安装、多个独立 Pi session”，还是支持“一个 Pi session 动态选择多个 DevContainer”？**
A: 一个常驻 Pi session 可以面向多个动态可选的 DevContainer；Pi 归属 Host，DevContainer 是执行目标。

**Q (discover: 三类用户共同作为目标角色): 技术方案优先服务开发者、团队维护者还是平台运维者？**
A: 开发者、团队维护者和平台运维者三者兼顾。

**Q (discover: Pi 与凭据保留在宿主机): Pi 是否应安装、运行或将配置/凭据挂载到目标 DevContainer？**
A: Pi、credentials、模型配置、extensions、sessions 和 skills 全部保留在 Host。

**Q (discover: Dev Containers CLI 为主执行边界): 容器内命令应优先使用裸 `docker exec` 还是 Dev Containers CLI？**
A: 推荐 `devcontainer exec --workspace-folder`，而非裸 `docker exec`。

**Q (discover: 标签化多容器发现): 如何从宿主机识别可用的 VS Code DevContainer？**
A: 以 Docker 标签，尤其 `devcontainer.local_folder`，关联容器和工作区，并以规范化路径为稳定键。

**Q (discover: 安全默认值与可审计执行): 宿主机高权限 Docker 调用和容器命令执行应采用何种安全模型？**
A: 最小权限、凭据隔离、受控路由和审计均为必须约束。

**Q (discover: 直接产出下游方案输入): 是否继续进行逐项访谈以细化每个实现取舍？**
A: 直接梳理已有讨论并输出技术方案路径所需的需求基线。

**Q (`docs/pi-devconatiner-manager.md:584-608`): 现有提案用 `spawnHook` 重写内置 `bash`，但 hook 仅处理 shell 字符串，无法提供 argv 级隔离或区分输出；完整项目周期的执行入口应如何界定？**
A: 完整项目应一致性交付独立结构化 `devcontainer_exec` 工具和安全 `bash` 路由能力，而非仅定义 MVP。两种接口共享状态、策略、审计和进程执行抽象。

## Related Research

- None.

## Open Questions

- Pin which Dev Containers CLI version(s) the project supports, then validate exact `exec`, `up`, and `build` argv, output, exit code, and failure behavior against that version in CI. The local host lacks `devcontainer`, so this remains runtime validation work.
- Define the approval model for Docker stop/remove actions: per action confirmation, workspace-level policy grant, administrator-only configuration, or a combination.
- Decide whether Pi `user_bash` (`!`/`!!`) must follow the same container-routing policy as LLM tool `bash`, versus being intentionally host-only with an explicit container command alternative.
- Define platform commitments and acceptance fixture matrix for Linux, macOS, Windows, WSL2, Docker Desktop, rootless Docker, and Podman.
- Establish audit retention defaults, state-directory locations by OS, and the platform owner responsible for audit collection and review.
