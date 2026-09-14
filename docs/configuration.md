# Configuration

> **Docs:** [Index](README.md) · [Installation](installation.md) · [Configuration](configuration.md) · [Security](security.md) · [Compatibility](compatibility.md) · [Troubleshooting](troubleshooting.md)

The extension loads JSON configuration from two locations and merges them into
one *effective* configuration. All keys are optional; defaults are restrictive.

## Configuration locations

| Scope | Path | Trusted? |
|---|---|---|
| Global | `~/.pi/agent/extensions/pi-devcontainer-manager.json` | Always |
| Project | `<session-cwd>/.pi/pi-devcontainer-manager.json` | Only when the project is trusted by Pi |

A file may be absent or `{}`. Global config is always applied. Project config is
applied **only when Pi reports the project trusted**
(`ctx.isProjectTrusted()`); an untrusted project's file is ignored entirely.

The session cwd is **always** added as an allowed workspace root, in addition to
`allowedWorkspaceRoots`.

> The files are parsed directly as the manager configuration object — there is
> **no wrapper key**. See `examples/pi-devcontainer-manager.settings.json` for a
> complete example with every default shown.

## Effective-config merge rules

Policy-relevant lists are merged **monotonically** (the intersection wins), so an
untrusted/less-privileged project config can never *expand* a global grant:

| Key | Merge |
|---|---|
| `allowedWorkspaceRoots` | `project ∩ global` |
| `environmentAllowlist` | `project ∩ global` |
| `maxTimeoutSeconds`, `maxOutputBytes` | `min(project, global)` |
| `discovery.maxDepth` | `min(project, global)` |
| `discovery.excludedDirectories` | `project ∩ global` |
| `audit.retentionDays` | `min(project, global)` |
| `audit.commandCapture` | lower of the two in `none < fingerprint-only < redacted-text` |
| `audit.enabled` | project `false` wins; else global `false`; else default `true`. When `false` the runtime accepts records but persists nothing. |
| `destructive.allowStop/allowRemove` | `true` only when **both** global and project grant it |
| `hostExecution.allow` | `true` only when **both** grant it |

`audit.directory` is merged global-only into the effective config (a project
config cannot relocate the audit directory) and **is honored** by the runtime;
when unset, the platform default is used. `audit.enabled: false` accepts
records but persists nothing.
`dockerPath`/`devcontainerPath`/`routeMode` prefer project over global when
both set (these do not raise privilege, so project wins). In v1 `routeMode`
must be `"container-required"`; the other values are rejected at load.

## Reference

### `version`

- Type: `number` · Default: unset
- Must equal `1` (`CONFIG_VERSION`) if present. A mismatched version rejects the
  file with a named error. Intended for future migrations.

### `dockerPath`

- Type: `string` · Default: `"docker"`
- Executable used for discovery, inspection, bounded logs, and confirmed
  Docker stop/remove.

### `devcontainerPath`

- Type: `string` · Default: `"devcontainer"`
- Executable used for `up`, `build`, and `exec` (resolved through `PATH`; see
  [installation.md](installation.md) for how the pinned CLI is supplied).

### `routeMode`

- Type: `"container-required" | "container-preferred" | "host-only"`
- Default: `"container-required"`

| Mode | Behavior |
|---|---|
| `container-required` | Execution requires a running selected target. With no explicit selection, the session-cwd workspace is auto-selected as the default when it has a DevContainer configuration; if still no target resolves (no config, ambiguous, stale/stopped, denied) the route returns `no-candidate` / `ambiguous-candidate` / `target-stopped` / `policy-denied`. **Never** executes on the host. |
| `container-preferred` | **Not implemented** — setting it is rejected at load so a mode that silently does nothing cannot be configured. |
| `host-only` | **Not implemented** — rejected at load. |

In v1 the implemented, tested, and default mode is `container-required`; the
other two values are accepted by the type but rejected by validation. The general
host execution surface is the explicit, policy-gated, audited
`devcontainer_host_exec` tool and `/devcontainer host-exec` command
(`hostExecution.allow`); `/devcontainer setup` is the one other host-side
operation and runs a single fixed command behind an interactive confirmation.

### What routes into the container vs what stays on the host

`routeMode` governs **execution-shaped** operations only:

| Surface | Where it runs |
|---|---|
| `devcontainer_exec` tool | Container (selected target) |
| routed `bash` (`bash` tool, `!`/`!!`) | Container (selected target) |
| `devcontainer_host_exec` tool / `/devcontainer host-exec` | Host (explicit, policy-gated) |
| `/devcontainer setup` | Host (one fixed `npm install -g`, confirmation required) |
| `read` / `write` / `edit` / `grep` / `find` / `ls` | **Always host** |

Pi's file tools are deliberately never routed into the container. A
DevContainer's workspace is a bind mount of your host folder
(`workspaceMount`), so the host path and the container path are the *same
files* — running file tools in the container would add a per-call
`devcontainer exec` round-trip for zero benefit. File edits made through the
host tools appear inside the container immediately (and vice versa).

Execution is the environment-sensitive half: the toolchain, interpreter,
platform-specific dependencies, and container-only mounts live in the
container, which is why commands route there. Paths that exist only inside
the container (extra mounts, named volumes) are not visible to the host file
tools; use `devcontainer_exec` (container-side `cat`/`find`) to reach them.

### `allowedWorkspaceRoots`

- Type: `string[]` · Default: `[]`
- Absolute host directories beneath which DevContainer configuration discovery
  is allowed. The session cwd is always included. Every registry entry and
  execution target must live under an allowed root; otherwise policy denies with
  `workspace-not-allowed`.

### `environmentAllowlist`

- Type: `string[]` · Default: `[]`
- Environment variable *names* that may be forwarded into a container exec or
  routed-bash child. Two classes are always excluded regardless of the list:
  names starting with `PI_` and names matching secret patterns
  (`api_key`, `token`, `secret`, `password`, `credential`, `auth`, `bearer`).
  Requesting a denied name raises `policy-denied`
  (`environment-variable-denied`).

### `maxTimeoutSeconds`

- Type: `number` · Default: `900`
- Positive finite number. Upper bound for per-operation timeouts (merged as the
  minimum of project/global).

### `maxOutputBytes`

- Type: `number` · Default: `51200` (`50 * 1024`)
- Positive finite number. Each output stream (stdout and stderr) is bounded
  independently, so a command that floods stderr cannot exhaust the extension
  process; overflow sets the `truncated` flag while the streams keep draining
  (no pipe deadlock). Captured memory is therefore at most 2× this value.

### `discovery`

- Type: `object`
- `maxDepth` — `number`, default `3`. Positive integer; the bounded host scan
  stops at this depth (default exclusions still apply; a pruning diagnostic is
  emitted only when pruning actually occurs).
- `excludedDirectories` — `string[]`, default `["node_modules", ".git", ".pi",
  "dist", "build"]`. Directories never traversed. Hidden directories are skipped
  except `.devcontainer`.

Discovery recognizes all three canonical forms:
`devcontainer.json` (root), `.devcontainer/devcontainer.json`, and
`.devcontainer.json` (dot-file at root).

### `audit`

- Type: `object`
- `enabled` — `boolean`, default `true`. Merged as shown in the table above and
  **honored by the runtime**: the effective value is passed to `JsonlAuditWriter`,
  and when it is `false` `write()` returns before creating the directory or
  appending, so records are accepted but nothing is persisted.
- `directory` — `string`, global-only (a project config cannot relocate the audit
  directory). **Honored by the runtime** when set; when unset the platform default
  below is used:
  - Linux: `$XDG_STATE_HOME/pi-devcontainer-manager/audit`
    (`~/.local/state/pi-devcontainer-manager/audit` when `XDG_STATE_HOME` is unset)
  - macOS: `~/Library/Application Support/pi-devcontainer-manager/audit`
  - Any other platform: `session_start` fails with `Unsupported audit platform`,
    so the extension reports a startup error instead of guessing.
- `retentionDays` — `number`, default `90`. Positive. The audit writer's
  `prune(now)` method removes `.jsonl` files older than this; the extension
  does not schedule pruning itself (see [security.md](security.md)).
- `commandCapture` — `"none" | "fingerprint-only" | "redacted-text"`, default
  `"fingerprint-only"`.
  - `none` — no command identity recorded.
  - `fingerprint-only` — a SHA-256 fingerprint over argv (default).
  - `redacted-text` — fingerprint **plus** the joined command text with
    secret-looking patterns redacted.

### `destructive`

- Type: `object`
- `allowStop` — `boolean`, default `false`.
- `allowRemove` — `boolean`, default `false`.
- Both must be `true` in the **effective** config (global AND project) for
  `/devcontainer stop` / `/devcontainer remove` to pass the policy gate. The
  interactive flow still requires a fresh per-action confirmation naming the
  exact action and target container; a noninteractive caller gets a typed
  `confirmation-required` result and can never bypass the gate.

### `hostExecution`

- Type: `object`
- `allow` — `boolean`, default `false`.
- When `false`, `devcontainer_host_exec` and `/devcontainer host-exec` are
  denied by policy before any spawn. When `true`, host runs are audited under
  the same capture policy as every other operation (`operation: "host-exec"`,
  `initiator: "host-escape"`).
- `hostExecution.allow` does **not** gate `/devcontainer setup`, which runs a
  single fixed `npm install -g @devcontainers/cli` behind an interactive
  confirmation — see
  [Security → `/devcontainer setup`](security.md#devcontainer-setup).

## Validation failures

Invalid values reject the whole file with a named-field error (e.g. an invalid
`routeMode`, a non-array `allowedWorkspaceRoots`, a non-positive
`maxTimeoutSeconds`, a `version !== 1`). A malformed file also throws
`Invalid configuration at <path>: ...`. Fix the file and run `/reload`.

## Full example

A complete example with every default shown is in
[`examples/pi-devcontainer-manager.settings.json`](../examples/pi-devcontainer-manager.settings.json).
`audit.directory` is intentionally absent there: it has no default value — the
platform default above applies until you set it.

## See also

- [Installation](installation.md) — how the Dev Containers CLI is supplied
- [Security](security.md) — the threat model and every policy gate
- [Compatibility](compatibility.md) — supported platforms and failure modes
- [Troubleshooting](troubleshooting.md) — what each typed error means
