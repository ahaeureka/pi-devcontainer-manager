# Security model


> **Docs:** [Index](README.md) · [Installation](installation.md) · [Configuration](configuration.md) · [Security](security.md) · [Compatibility](compatibility.md) · [Troubleshooting](troubleshooting.md)
`pi-devcontainer-manager` keeps Pi and its credentials on the host and treats
DevContainers as **explicitly selected, policy-checked command-execution
targets**. This page documents the threat model, the controls, and the
operational defaults.

## Core invariants

- **Pi never runs inside a container.** No Pi session, extension, skill,
  configuration, model credential, or API key is installed, copied, mounted, or
  persisted inside any target container.
- **No silent host fallback inside an engaged workspace.** Once the extension is
  engaged, a `container-required` route never executes on the host: with no explicit
  selection the session-cwd workspace is auto-selected when it has a DevContainer
  configuration (an empty-selection-only convenience — an explicit
  `/devcontainer use` always wins); if no container target resolves, the route
  returns a typed error (`no-candidate`, `ambiguous-candidate`, `target-stopped`,
  `policy-denied`). The explicit host escape hatch
  and write their own audit records. The one other host-side operation is
  `/devcontainer setup`, which runs a single fixed
  `npm install -g @devcontainers/cli` behind an interactive confirmation — it
  never executes caller-supplied argv, so it is not a general host escape.
- **Per-workspace engagement** ([activation](configuration.md#activation)). The
  extension is loaded for every workspace, so it decides *per session* whether to
  take over the execution surfaces at all. In a workspace with no DevContainer
  evidence it registers nothing: `bash`, `!`/`!!`, and the host file tools stay
  exactly as Pi shipped them. Dormancy restores the behavior of a Pi without this
  extension installed, so it can only narrow what the extension controls, never
  widen host access. `/devcontainer off` returns an engaged session to that state;
  the host-local shell it then uses is Pi's own built-in behavior, not the audited
  `devcontainer_host_exec` surface.
- **Default-deny policy.** Workspace roots, forwarded environment names,
  destructive actions, and host execution are all denied unless explicitly
  granted. Grants from an untrusted project config can never *expand* a global
  grant (merge is monotonic — see [configuration.md](configuration.md)).
- **Fresh validation before every action.** Selection intent is persisted as a
  stable workspace key + candidate discriminator, and each operation re-resolves
  the target and freezes an immutable policy snapshot before any spawn. A
  concurrent selection switch cannot redirect a bound operation.
- **The executed workspace is always the bound target.** An operation issued from a path
  outside the selected target runs against the target (that is the explicit-selection
  workflow) and its audit record carries the caller's cwd in `requestedCwd`; a request
  whose cwd is itself another DevContainer project is refused with `policy-denied`, so
  a caller can never silently act on a different repository. The CLI always receives
  the target workspace, so authorization scope, execution, and audit cannot disagree.
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
  surfaces, both policy-gated (`hostExecution.allow`, granted by default and
  withholdable from either configuration file) and audited.
- Before each turn the agent receives the current target, the workspace's
  host↔container mapping, and the surface rules, so it chooses explicitly.
- `/devcontainer host-exec` takes **one `--argv` per argument**, verbatim: there is no shell-like
  parsing to reinterpret on a surface whose arguments are executed on the host (the tool twin
  `devcontainer_host_exec` has always taken a structured `argv` array).
- A structured CONTAINER request (`devcontainer_exec`) **refuses** an argv element that names the HOST
  workspace path when the workspace's configuration mounts it somewhere else, naming the container path
  to use instead. Routed-shell text is deliberately not inspected: a heuristic over shell text cannot
  be made safe (see the Phase-5 review).
- `devcontainer_host_exec` **refuses** an argv that targets a container-only
  path, when the selected workspace's configuration declares a
  `workspaceFolder`/`workspaceMount` to compare against (a reliable check: literal
  argv carries no shell syntax). A configuration that declares neither leaves the
  guard with nothing to test — that is reported as a diagnostic, because the escape
  hatch is granted by default.
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
| `logs` / `/devcontainer stop` / `/devcontainer remove` | a target must be selected (`selected-valid` or `selected-stopped` — a stopped container is exactly what these are for) | The requested container id must be the BOUND target's candidate; anything else is refused before Docker runs, and the audit `targetId` comes from the binding |
| `devcontainer_host_exec` / `/devcontainer host-exec` | `hostExecution.allow` (granted by default; a configuration can withhold it with `false`) | Audited with `operation: "host-exec"`, `initiator: "host-escape"` |
| `/devcontainer setup` | **none** — not gated by `hostExecution.allow` | Interactive confirmation naming the exact command; fixed argv (`npm install -g @devcontainers/cli`), audited as `operation: "setup"`, 300 s timeout |

### What the redaction covers, and what it does not

`redactText` (used by the audit records) hides: an auth scheme value (`Bearer`/`Basic`/`Token <value>`,
quoted or bare), a secret-named key/value pair (`password=…`, `token: …`), a secret-named flag
(`--password …`, `--api-key=…`), and credentials embedded in a URL (`scheme://user:pass@host`).

It does **not** hide a bare `-u user:pass` pair (`curl -u alice:hunter2 https://…`), an unflagged secret
that appears as a plain positional argument, or the part of a flag value that follows a space (a command
line is redacted as one space-joined string, so `--password "a b"` hides up to the space). Two URL shapes are
inherently ambiguous to a rule and also survive: a **slash inside the password**
(`https://alice:/hunter2@host` — a rule cannot tell it from a path) and a **URL-shaped argument that is not
the whole argument** (`ssh alice:hunter2@host`, with no scheme to key on). Under the audit
default `audit.commandCapture: "fingerprint-only"` no command text is recorded at all, so those three gaps
matter only under `"redacted-text"` — but the in-session summary renders a program name, so a
credential-shaped `argv[0]` is the one place they would have shown up there, which is why that rendering is
enforced (`displayProgram`) rather than assumed: it takes the FIRST whitespace-delimited token of `argv[0]`,
and a URL-shaped name renders as the authority HOST only — so no credential reaches either operator surface
even for the shapes the audit-side rule misses. A rule that guessed at unflagged secrets would redact ordinary arguments
too, so extending it is a policy decision rather than a bug fix, and belongs in its own change.

The **in-session visibility deliberately keeps no command text at all**: `/devcontainer status` reports a
count and the program names, and the one-shot notice names the program. Five adversarial passes found
credentials reachable through a rendered command line (two of them through fixes for the previous one), so
the surface that produced them was removed rather than patched again.

### How the host escape hatch is gated (a deliberate asymmetry)

`stop`/`remove` require a policy grant **and** a fresh per-action confirmation token. An arbitrary host
command requires the policy grant and leaves an audit record, but **no per-action confirmation** — and
since the host-execution default change that grant ships enabled. This is a decision, not an oversight:
the surface is driven by the agent, so an interactive confirmation would either stall an autonomous run
or degrade into a confirmation the operator clicks through. The compensating controls are the audit
trail (every attempt that reaches the runner, including refusals and failures — an attempt a
configuration withholds is refused before it and is visible only through the in-session summary), the
in-session visibility added for host runs
(`/devcontainer status` reports the session's host command attempts and the programs they named — every
attempt counts, including one a configuration withheld, and the first of a session is announced on the
operator channel), the container-path guard, and `hostExecution.allow: false` in either
configuration file, which withdraws the surface entirely.


### `/devcontainer setup`

`/devcontainer setup` is a dedicated setup capability, not a general host
escape. It exists because the Dev Containers CLI is a host prerequisite that
users otherwise install by hand.

- **What it runs**: exactly `npm install -g @devcontainers/cli`, with a fixed
  executable and argv array, `shell: false`, a sanitized environment, a 300 s
  timeout, and bounded output. The caller supplies no argv.
- **Gate**: an interactive `ctx.ui.confirm` naming the command. A noninteractive
  caller (print/JSON mode) gets `[confirmation-required]` and nothing runs.
- **Not gated by `hostExecution.allow`**: that policy gates *arbitrary* host
  argv, which `setup` cannot express. Denying host execution is therefore not
  the same as denying `setup`.
- **Audit**: one record with `operation: "setup"`, `initiator: "slash-command"`,
  `policyAuthorized: true`, the command fingerprint/text under the same
  `audit.commandCapture` policy, the exit code, duration, and truncation flag.
- **Verification**: after a zero exit it probes `devcontainerPath --version`; a
  non-resolvable CLI is reported as a setup failure with the reason.
- **Bounded by policy?** No. If your threat model requires that no global npm
  install may happen, do not run `/devcontainer setup`; install or pin the CLI
  through your own package manager and set `devcontainerPath` instead.
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
