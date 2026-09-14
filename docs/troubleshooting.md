# Troubleshooting

> **Docs:** [Index](README.md) · [Installation](installation.md) · [Configuration](configuration.md) · [Security](security.md) · [Compatibility](compatibility.md) · [Troubleshooting](troubleshooting.md)

Every failure is reported as a **typed** error, not a generic crash. Command
output and tool output both use the shape:

```text
[<kind>] <message>
<remedy, when the error carries one>
```

`kind` is one of thirteen values from `src/errors.ts`:
`executable-missing`, `spawn-permission-denied`, `daemon-unavailable`,
`authorization-denied`, `devcontainer-cli-failure`, `no-candidate`,
`ambiguous-candidate`, `target-stopped`, `policy-denied`, `timeout`,
`cancelled`, `parse-failure`, `unexpected`.

## Error kinds

| Kind | What it means | What to do |
|---|---|---|
| `no-candidate` | No registry entry matched the requested workspace, or the workspace itself is not a valid target. | `/devcontainer list`, then `/devcontainer use <path>`. |
| `ambiguous-candidate` | Two or more **running** containers map to the same workspace. Docker result order is never used to guess. | `/devcontainer use <container-id>` with one of the ids in the message. |
| `target-stopped` | A target is selected but its container is not running. | `/devcontainer up` (re-resolves the selection for you). |
| `policy-denied` | A policy gate refused the operation. The message names the reason (`workspace-not-allowed`, `destructive-operation-disabled`, `host-execution-disabled`, `environment-variable-denied`, or a container-only path on a host command). | Fix the specific grant named in the message, or use the surface the policy expects. |
| `daemon-unavailable` | The Docker executable is missing or the daemon is unreachable. | Start Docker / Docker Desktop; confirm `docker ps` works in a host shell. |
| `authorization-denied` | The OS refused the Docker or Dev Containers CLI spawn (permissions). | Check the account's permission to run `docker` (for example `docker` group membership on Linux). |
| `executable-missing` | A configured executable could not be resolved. | Check `dockerPath` / `devcontainerPath`, or install the CLI. |
| `devcontainer-cli-failure` | The CLI could not be run, or returned a structured failure for `up`/`build`/`exec`. | Re-run the operation; read the CLI output included in the error. |
| `timeout` | The operation exceeded its timeout (`maxTimeoutSeconds` ceiling). | Raise `maxTimeoutSeconds`, or narrow the command. |
| `cancelled` | The operation was cancelled; the whole process group was killed. | Nothing to fix. |
| `parse-failure` | A CLI/Docker response could not be parsed. | Usually a CLI version mismatch — check the pinned `@devcontainers/cli@0.88.0`. |
| `unexpected` | Anything else, including a **nonzero container-side exit code**. | For a nonzero exit, read the command output printed with the error; the exit code is intentional, not a bug. |

## Common situations

### `DevContainer runtime not initialized; run /reload or restart pi.`

The extension's runtime is composed on `session_start`, so a command or tool
invoked before that (or during a reload) fails closed rather than falling back to
the host. Run `/reload`, or restart Pi.

### The extension is loaded in a project with no DevContainer

The extension is discovered from
`${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions/` (or a `pi install` entry) and
loads in **every** workspace it serves, so its replacement `bash` tool is always
active. A `devcontainer.json` is a *discovery* input, not a load gate.

In a project with no DevContainer configuration, discovery produces no registry
entry for the session cwd, so no target can be selected and every routed command
fails closed:

```text
[no-candidate] No DevContainer target is selected.
Run /devcontainer list then /devcontainer use <workspace>.
```

This is intentional — there is no silent host fallback — and it is not
overridable per project: `routeMode` values other than `container-required` are
rejected at load, and selecting *another* project's target does not rescue the
current directory, because an operation is refused with `policy-denied` when the
request workspace is not the bound target workspace.

To use a host shell in such a project, take the extension out of the picture for
it: run `pi config` (`pi config -l` for project-level overrides) and disable the
extension, remove the auto-discovery symlink, or `pi remove` the package — then
restart Pi.

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

`hostExecution.allow` is `false` (the default). Set it in the global
configuration — the project file alone cannot grant it. A denial here is not a
signal to retry the command in the container: check which surface the command
actually needs.

### Nothing is written to the audit directory

Check, in order: `audit.enabled` (when the effective value is `false`, records
are accepted but never persisted), `audit.directory` (global-only — a project
file cannot relocate it), and whether you are looking at the platform default
path (see [Configuration → `audit`](configuration.md#audit)). Retention
(`audit.retentionDays`) is only applied by the writer's `prune` method; the
shipped extension does not schedule pruning, so rotate the dated `.jsonl` files
yourself if you need bounded disk usage.

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
