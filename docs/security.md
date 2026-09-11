# Security model

`pi-devcontainer-manager` keeps Pi and its credentials on the host and treats
DevContainers as **explicitly selected, policy-checked command-execution
targets**. This page documents the threat model, the controls, and the
operational defaults.

## Core invariants

- **Pi never runs inside a container.** No Pi session, extension, skill,
  configuration, model credential, or API key is installed, copied, mounted, or
  persisted inside any target container.
- **No silent host fallback.** A `container-required` route never executes on the
  host. With no explicit selection, the session-cwd workspace is auto-selected as
  the default when it has a DevContainer configuration (an empty-selection-only
  convenience — an explicit `/devcontainer use` always wins); if no container
  target resolves, the route returns a typed error (`no-candidate`,
  `ambiguous-candidate`, `target-stopped`, `policy-denied`). The only host escape hatch
  is the visibly named `devcontainer_host_exec` tool and `/devcontainer
  host-exec` command, which pass a *separate* `hostExecution.allow` policy check
  and write their own audit records.
- **Default-deny policy.** Workspace roots, forwarded environment names,
  destructive actions, and host execution are all denied unless explicitly
  granted. Grants from an untrusted project config can never *expand* a global
  grant (merge is monotonic — see `docs/configuration.md`).
- **Fresh validation before every action.** Selection intent is persisted as a
  stable workspace key + candidate discriminator, and each operation re-resolves
  the target and freezes an immutable policy snapshot before any spawn. A
  concurrent selection switch cannot redirect a bound operation.
- **File tools are a host capability, not a container route.** Pi's built-in
  file tools (`read`/`write`/`edit`/`grep`/`find`/`ls`) always run against
  the host filesystem under the normal Pi trust model; they are never
  delegated into a container, and the container is never a path to a host
  filesystem action. This keeps the container boundary limited to
  execution-shaped commands, which is the only surface where the container
  environment differs from the host.

## Execution pathway

Every command surface — the `devcontainer_exec` tool, routed Pi `bash`,
`!`/`!!`, `up`, `build`, `stop`, `remove`, and `logs` — delegates to the shared
execution service, which:

1. freezes a policy snapshot for the operation and workspace;
2. binds an immutable context from the serialized target store (re-resolving the
   selected target);
3. builds a minimal child environment from the effective allowlist (never an
   arbitrary inherited Pi environment);
4. runs the command with **fixed argv, `shell: false`**, through the pinned
   Dev Containers CLI or Docker, streaming bounded output;
5. writes one audit record and returns a structured result with **no
   environment values**.

## Routing guards

The extension does **not** classify shell text to decide the environment —
shell operators, substitutions, and compound commands defeat any name/prefix
rule (a former command-router experiment was removed for exactly this reason).
Instead:

- `bash`, `!`/`!!`, and `devcontainer_exec` are **always** the container;
  `devcontainer_host_exec` and `/devcontainer host-exec` are the only host
  surfaces, both policy-gated (`hostExecution.allow`) and audited.
- Before each turn the agent receives the current target, the workspace's
  host↔container mapping, and the surface rules, so it chooses explicitly.
- `devcontainer_host_exec` **refuses** an argv that targets a container-only
  path (a reliable check: literal argv carries no shell syntax).
- While a target is selected, the built-in `powershell` tool — which Pi would
  otherwise spawn on the host — is **blocked** through the `tool_call` hook
  with a message pointing at the routed surfaces. (`tool_call` can block or
  rewrite input; it cannot re-route, so no redirection is attempted.)
- Workspace containment compares `realpath`, so a symlink beneath an allowed
  root that points outside it is denied.
- Container execution requires the request workspace to be the bound target
  workspace (or a path below it), and the CLI always receives the bound target
  workspace, so authorization scope, container id, and audit cannot disagree.

## File access model

File access and command execution have different trust surfaces, and this
extension keeps them separate:

- **Host file tools** (`read`/`write`/`edit`/`grep`/`find`/`ls`) read and
  write the host workspace directly. Because a DevContainer's workspace is a
  bind mount of the host folder, those files are the same files the
  container sees — an edit on the host is immediately visible in the
  container. No container round-trip is involved, so no container path,
  translation, or in-container tool availability is in the trust path.
- **Container execution** runs only through the governed execution service
  (fixed argv, policy snapshot, minimal env, audit). A command can read or
  write whatever the container user can — including host files reachable
  through the bind mount — but always as an explicitly routed, audited
  execution action, never as Pi's own file tooling.
- **Container-only paths** (extra mounts such as a model cache, named
  volumes, container-local clones) are outside the host file tools' view.
  They are reachable only by executing a command in the container (for
  example `devcontainer_exec` with a container-side `cat` or `find`), which
  keeps those accesses on the audited execution pathway.

## Environment control

- `PI_*` variables and secret-pattern names (`api_key`, `token`, `secret`,
  `password`, `credential`, `auth`, `bearer`) are always excluded from child
  environments, even if listed in `environmentAllowlist`.
- Requesting a denied environment variable raises `policy-denied`
  (`environment-variable-denied`) — the operation is refused, never silently
  stripped.
- The extension's replacement `bash` tool is registered with
  `exposeSessionEnvironment: false`, so the container never sees Pi session
  metadata.

## Destructive and host-escape gates

| Action | Policy grant | Additional gate |
|---|---|---|
| `/devcontainer stop` | `destructive.allowStop = true` | Fresh per-action confirmation naming the exact action + container ID; noninteractive callers receive `confirmation-required` and can never bypass |
| `/devcontainer remove` | `destructive.allowRemove = true` | Same confirmation contract |
| `devcontainer_host_exec` / `/devcontainer host-exec` | `hostExecution.allow = true` | Audited with `operation: "host-exec"`, `initiator: "host-escape"` |

## Audit

Every operation writes a host-local JSONL record. `audit.enabled` (default
**true**) is honored: when `false`, records are accepted but nothing is
persisted. `audit.directory` (global-only) is honored when set; otherwise the
platform default below is used. Default retention is **90 days** with
**`fingerprint-only` command capture**. Denied attempts are audited too (a
policy probe is visible, not silent), and adapter failures for
`up`/`build`/`lifecycle`/`logs` record an `errorSummary` instead of vanishing.
`/devcontainer logs` is now policy-checked and audited like every other
operation.

- Audit directory (mode `0700`, files `0600`):
  - Linux: `$XDG_STATE_HOME/pi-devcontainer-manager/audit`
    (default `~/.local/state/pi-devcontainer-manager/audit`)
  - macOS: `~/Library/Application Support/pi-devcontainer-manager/audit`
- Command identity is a SHA-256 **fingerprint** over argv by default, never
  plaintext. `redacted-text` mode stores the joined command with secret-looking
  patterns redacted (`key=[REDACTED]`); `none` stores no command identity.
- Audit records never contain environment values, and error/command text is
  redacted before write.
- `retentionDays` (default 90) is the retention window passed to the audit
  writer. Its `prune(now)` method (unit-tested, available to host code that
  constructs `JsonlAuditWriter` directly) removes `.jsonl` files whose mtime
  is older than the window; the shipped extension does not schedule periodic
  pruning itself, so operators who want bounded disk usage should rotate or
  delete the dated `.jsonl` files (one file per day) externally.

## Process boundary

- All host and container processes are spawned with `shell: false`, a fixed
  executable, an argv array, a sanitized environment, cancellation, timeout, and
- **Both** stdout and stderr are bounded by `maxOutputBytes` (each stream
  independently), and overflow sets `truncated`; a stderr flood cannot exhaust
  the extension process.
- Children are spawned as their own process group, and timeout/cancellation
  kills the **group**, so a shell that forks background work cannot outlive the
  operation that was reported as cancelled.
- Only read-only `docker ps --all` / `inspect` exist on the discovery adapter;
  the lifecycle adapter is the *sole* owner of `docker logs`, `stop`, and
  `rm -f`.

## Operator checklist

- Keep `routeMode: "container-required"` unless you have a concrete host-exec
  workflow; use the explicit host escape surface for it.
- Grant `environmentAllowlist` names sparingly — the container inherits the
  *values* from the host session.
- Grant `destructive.*` only to workspaces whose containers you are willing to
  stop/remove; the confirmation token is a second, human-in-the-loop gate.
- Set `audit.commandCapture` above `fingerprint-only` only when your retention
  and review process justify storing command text.
- On shared hosts, remember project config is ignored unless the project is
  trusted by Pi — do not rely on an untrusted project's file for *more*
  restrictive policy than the global file already sets.
