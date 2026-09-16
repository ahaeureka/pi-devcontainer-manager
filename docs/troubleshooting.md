# Troubleshooting

> **Docs:** [Index](README.md) · [Installation](installation.md) · [Configuration](configuration.md) · [Security](security.md) · [Compatibility](compatibility.md) · [Troubleshooting](troubleshooting.md)

Every failure is reported as a **typed** error, not a generic crash. Command
output and tool output both use the shape:

```text
[<kind>] <message>
<remedy, when the error carries one>
```

`kind` is one of fifteen values from `src/errors.ts`:
`executable-missing`, `spawn-permission-denied`, `daemon-unavailable`,
`authorization-denied`, `devcontainer-cli-failure`, `docker-cli-failure`, `no-candidate`,
`ambiguous-candidate`, `target-stopped`, `target-refreshing`, `policy-denied`, `timeout`,
`cancelled`, `parse-failure`, `unexpected`.

## Error kinds

| Kind | What it means | What to do |
|---|---|---|
| `no-candidate` | No registry entry matched the requested workspace, or the workspace itself is not a valid target. | `/devcontainer list`, then `/devcontainer use <path>`. |
| `ambiguous-candidate` | Two or more **running** containers map to the same workspace. Docker result order is never used to guess. | `/devcontainer use <container-id>` with one of the ids in the message. |
| `target-stopped` | A target is selected but its container is not running. | `/devcontainer up` (re-resolves the selection for you). |
| `target-refreshing` | A selection is mid-refresh (a registry re-check has not finished yet). | Retry the operation; the state resolves on its own. |
| `policy-denied` | A policy gate refused the operation. The message names the reason (`workspace-not-allowed`, `destructive-operation-disabled`, `host-execution-disabled`, `environment-variable-denied`, or a container-only path on a host command). | Fix the specific grant named in the message, or use the surface the policy expects. |
| `daemon-unavailable` | The Docker executable is missing or the daemon is unreachable. | Start Docker / Docker Desktop; confirm `docker ps` works in a host shell. |
| `authorization-denied` | The OS refused the Docker or Dev Containers CLI spawn (permissions). | Check the account's permission to run `docker` (for example `docker` group membership on Linux). |
| `executable-missing` | A configured executable could not be resolved. | Check `dockerPath` / `devcontainerPath`, or install the CLI. |
| `devcontainer-cli-failure` | The CLI could not be run, or returned a structured failure for `up`/`build`/`exec`. | Re-run the operation; read the CLI output included in the error. |
| `docker-cli-failure` | The Docker CLI returned a nonzero exit for `stop`/`remove`; the exit code is carried on the error. | Check Docker daemon reachability and the container state. |
| `timeout` | The operation exceeded its timeout (`maxTimeoutSeconds` ceiling). | Raise `maxTimeoutSeconds`, or narrow the command. |
| `cancelled` | The operation was cancelled; the whole process group was killed. | Nothing to fix. |
| `parse-failure` | A CLI/Docker response could not be parsed. | Usually a CLI version mismatch — check the pinned `@devcontainers/cli@0.88.0`. |
| `unexpected` | Anything else, including a **nonzero container-side exit code**. | For a nonzero exit, read the command output printed with the error; the exit code is intentional, not a bug. |

Every spawn failure names the OS error code, so the three ways a command can fail to start are
distinguishable from the error text alone: `executable-missing` (`ENOENT`) means the binary is
not resolvable, `authorization-denied` (`EACCES`/`EPERM`) means it cannot be executed, and
`unexpected` with an errno in the message means the process could not start for another reason —
see [the host cannot start any executable](#the-host-cannot-start-any-executable-enotconn) for
the one that looks least like a spawn problem.

## Common situations

### `DevContainer runtime not initialized; run /reload or restart pi.`

The extension's runtime is composed on `session_start`, so a command or tool
invoked before that (or during a reload) fails closed rather than falling back to
the host. Run `/reload`, or restart Pi.

### The extension is dormant in my project (it did not take over `bash`)

That is the default, and it is deliberate. The extension is loaded for every
workspace, so it decides **per session** whether to engage at all:

| # | Evidence | Result |
|---|---|---|
| 1 | `activation: "never"` | dormant |
| 2 | `activation: "always"` | engaged |
| 3 | the session cwd owns a DevContainer configuration (`.devcontainer/devcontainer.json`, a named `.devcontainer/<name>/devcontainer.json`, `.devcontainer.json`, or a root `devcontainer.json`) | engaged |
| 4 | a **running** container is labelled `devcontainer.local_folder` for the cwd | engaged |
| 5 | you ran `/devcontainer use`/`up`, or a selection for this workspace was restored | engaged |
| 6 | none of the above | **dormant** |

Dormant means nothing was registered: `bash`, `!`/`!!`, and the host file tools
behave exactly as in a Pi without this extension. `/devcontainer list`, `status`,
`use`, and `up` still work — they are how you engage it:

```text
/devcontainer use <workspace>     # engage this session against that target
/devcontainer off                 # hand the session back to the host
```

Step 4 costs one bounded `docker ps` (2.5 s cap) and only runs when every cheaper
signal missed; any failure there counts as "no evidence". To force a decision, set
[`activation`](configuration.md#activation) in the project or global configuration.

### `[policy-denied] Requested workspace … is not the selected target workspace`

You are standing in one DevContainer project while a different target is selected.
Routing from *outside* any project is allowed — that is how you drive a selected target
from a plain repository — but a request from another project's workspace is refused on
purpose, because it would act on a different repository than the one you are in. Run
`/devcontainer use` for the project you are standing in, or issue the command from a
directory that is not another project.

### `bash` refuses to run anything

That is the fail-closed contract. `bash` is routed into the selected
DevContainer, so it needs a **running** selected target:

- nothing selected → the route fails closed (`no-candidate`);
- selected but stopped → `target-stopped` → run `/devcontainer up`.

Before a target is selected, the workspace Pi started in is auto-selected as a
default **only** if it has its own DevContainer configuration; an explicit
`/devcontainer use` always wins.

### A file that exists in the container is not readable by `read`/`grep`/`ls`

Expected. Pi's file tools always act on the **host** filesystem. The workspace
bind mount covers the host workspace, so those files are visible — but paths that
exist only inside the container (extra mounts, named volumes, container-local
clones) are not. Reach them by executing a container-side command
(`devcontainer_exec` with `cat`/`find`), which keeps the access on the audited
execution pathway.

### `bash` says `PI_*` variables are not available

Intentional. The replacement `bash` tool registers with
`exposeSessionEnvironment: false`, so Pi session metadata never reaches a
container. The same reason applies to environment variables: only names in
`environmentAllowlist` are forwarded, and names starting with `PI_` or matching
secret patterns are always denied.

### Docker says the label does not match / a project is missing from the registry

Discovery is scoped and bounded: only the session cwd and
`allowedWorkspaceRoots` are scanned, to `discovery.maxDepth` (default 3), and
`discovery.excludedDirectories` (default `node_modules`, `.git`, `.pi`, `dist`,
`build`) plus hidden directories are never traversed (`.devcontainer` is).
A directory whose real path escapes the allowed root is skipped as a symlink
escape. Check the registry for diagnostics — `/devcontainer list` prints them
alongside the entries.

### Docker-only containers appear as registry entries with no config path

That is a **diagnostic** entry. A container carrying a
`devcontainer.local_folder` label but no discoverable configuration is retained
so you can see the orphan rather than having it silently dropped.

### `/devcontainer stop` or `/devcontainer remove` refuses to run

Both need **two** things: the policy grant in the *effective* config
(`destructive.allowStop` / `destructive.allowRemove`, which must be `true` in
both the global and project file) **and** an interactive confirmation naming the
exact container. In a noninteractive (print/JSON) session you get
`[confirmation-required]` and nothing happens; there is no bypass.

### `/devcontainer setup` says `confirmation-required` or `setup-failed`

`setup` installs a global npm package, so it needs an interactive confirmation —
it cannot run in print/JSON mode. `[setup-failed]` means the `npm install -g
@devcontainers/cli` exit was nonzero (the reason is included), or the CLI did not
become resolvable on PATH afterwards. See
[Security → `/devcontainer setup`](security.md#devcontainer-setup).

### `devcontainer_host_exec` is denied

Host execution is **granted by default**, so a denial means a configuration is
withholding it. Check, in order:

1. `<session-cwd>/.pi/pi-devcontainer-manager.json` — does it set
   `hostExecution.allow: false`? (It is only read at all when the project is
   trusted by Pi.) A project `false` withholds the default grant.
2. `${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions/pi-devcontainer-manager.json` —
   the same key, global. A global `false` cannot be widened by a project `true`.
3. Did you change either file in this session? The effective configuration is
   composed at `session_start`, so a change needs `/reload` (or a restart).

Delete the `hostExecution` block (or set `allow: true`) in the file that has the
`false`, then `/reload`. A denial here is not a signal to retry the command in
the container: check which surface the command actually needs.

### Nothing is written to the audit directory

Check, in order: `audit.enabled` (when the effective value is `false`, records
are accepted but never persisted), `audit.directory` (global-only — a project
file cannot relocate it), and whether you are looking at the platform default
path (see [Configuration → `audit`](configuration.md#audit)). Retention
(`audit.retentionDays`) is only applied by the writer's `prune` method; the
shipped extension does not schedule pruning, so rotate the dated `.jsonl` files
yourself if you need bounded disk usage.

### `/devcontainer` prints `[devcontainer-manager] …` warnings

Those are discovery diagnostics: the host scan could not finish, or a Docker record could not be
parsed. Typical lines are `cannot read directory <dir>`, `max depth N reached; not traversing
<dir>`, `not traversing <dir>: resolves outside allowed workspace root`, and `no
devcontainer.local_folder label`. Each distinct line is reported **once per session** (the sink
dedupes, because the registry is re-read on every command), and they are shown to you only — they
never enter the model's context and are never written to the audit file. An empty workspace scan
and a scan that stopped half way used to look identical; now they do not. Fix the reported cause
(permissions on a workspace root, a `discovery.maxDepth` that is too shallow, a container started
without the Dev Container label) or ignore the line if the workspace it names is irrelevant.

### The host cannot start any executable (`ENOTCONN`)

Symptom: a container is up and running, yet `devcontainer_exec` and the routed `bash` fail, and
the error text carries `ENOTCONN` — for example
`Failed to spawn: devcontainer (ENOTCONN) — the host cannot traverse part of PATH`. Other
extensions report `spawn ENOTCONN` at the same time, and a host shell can still run commands.

Cause: a **filesystem mount inside `PATH` is half-dead**. The usual offender on Linux desktops is
an AppImage launcher (for example Orca) whose runtime mount under `/tmp/.mount_*` was left behind
after an unclean exit or a restart: the daemon is gone but the mount stays, so `ls` on it reports
`Transport endpoint is not connected`. glibc's `execvp` **aborts the whole `PATH` search** when it
reaches such a directory, which is why bare-name spawns fail while absolute paths still work and
why a shell — which skips the bad entry — makes the binary look resolvable.

Fix (no root needed; it also repairs processes that are already running, because the leftover
mount point becomes an ordinary empty directory):

```bash
for d in /tmp/.mount_*; do [ -d "$d" ] && ! ls "$d" >/dev/null 2>&1 && fusermount3 -u "$d"; done
```

Verify with `env node --version` and `devcontainer --version` in the same terminal Pi was started
from — the first one reproduces the failure and the second proves the CLI itself was never the
problem. Then retry: Pi does not need a restart, because the fix is in the filesystem, not in the
environment it inherited.

### My global configuration seems to be ignored

Check the path first: the global config follows Pi's config directory —
`${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions/pi-devcontainer-manager.json`. If
`PI_CODING_AGENT_DIR` is set (for example to `/data/work/pi`), a file under
`~/.pi/agent/extensions/` is **not** read.

The failure is quiet, because the defaults are restrictive: a grant in the wrong
file does not error, it simply never applies — `/devcontainer host-exec` keeps
returning `policy-denied`, `destructive.*` stays disabled, and so on. If an edit to
the global file appears to do nothing, run `echo "$PI_CODING_AGENT_DIR"`, place the
file accordingly, then `/reload`.

Two other causes of the same symptom: the project file is ignored unless Pi reports
the project trusted, and a `routeMode` other than `container-required` is rejected
at load (which surfaces as an error, not a silent no-op).

### The extension does not load at all

`npm install -g <package>` does **not** register a Pi extension. Use
`pi install npm:pi-devcontainer-manager` (or a tarball/git path) and then
`/reload`. See [Installation](installation.md).

## Still stuck?

Open an issue with the failing surface, the typed error line, and the relevant
section of your effective configuration (redact the audit directory and any
paths you consider private):
<https://github.com/ahaeureka/pi-devcontainer-manager/issues>.
