# Lifecycle diagnostic logs design

## Purpose

Persist a VS Code Dev Containers-style troubleshooting transcript for container lifecycle work. The transcript must make an `up`, build, initialization, setup, stop, removal, or discovery failure diagnosable after the Pi turn ends.

This is **not** a replacement for the existing JSONL audit trail. Audit records remain small, queryable, and redacted/fingerprint-oriented. Diagnostic logs are raw, operator-local process transcripts.

## Scope

### Included

A lifecycle log is created for each parsed attempt of:

- `/devcontainer up`
- `/devcontainer build`
- `/devcontainer rebuild`
- `/devcontainer setup`
- `/devcontainer stop`
- `/devcontainer remove`

The log records relevant registry/discovery diagnostics, command start/end metadata, actual CLI argv, stdout, stderr, exit/signal outcome, duration, and bounded-output or log truncation.

An attempt rejected by policy, declined at confirmation, or failed before a child process starts still receives a short lifecycle log. That is necessary to diagnose why an action did not run.

### Excluded

The first version does **not** persist output from:

- `devcontainer_exec`
- routed `bash`, `!`, or `!!`
- `devcontainer_host_exec` or `/devcontainer host-exec`
- `/devcontainer logs`

Those are routine command-execution surfaces, potentially high-volume and secret-bearing. They remain governed by the existing execution and audit contracts.

Routine background registry scans do not create standalone files. Discovery information is attached to the lifecycle operation that caused it.

## Design

### Separate log plane

Add `src/lifecycle-log.ts`, with a narrow writer interface similar to `AuditWriter`:

- create a run before a lifecycle handler executes;
- append structured headers and tagged `stdout` / `stderr` bytes while the child runs;
- finalize exactly once with result or error metadata;
- prune old files independently of audit JSONL files.

`src/audit.ts` and `AuditRecord` are not extended with raw output. Their current privacy and querying contract stays intact.

### Storage and protection

Default directories:

- Linux: `$XDG_STATE_HOME/pi-devcontainer-manager/lifecycle-logs/`, or `~/.local/state/pi-devcontainer-manager/lifecycle-logs/`
- macOS: `~/Library/Application Support/pi-devcontainer-manager/lifecycle-logs/`

The directory is created with mode `0700`; each file is created and re-chmodded to `0600`. File names contain only timestamp, lifecycle operation, and a generated opaque suffix; they never include a workspace path, image name, container id, or command text.

Each operation has one text log, e.g. `2026-09-28T14-31-10.123Z-up-a1b2c3.log`. Its format is intentionally human-readable:

```text
# pi-devcontainer-manager lifecycle log
operation: up
startedAt: 2026-09-28T14:31:10.123Z
workspace: /host/workspace
argv: devcontainer up --workspace-folder /host/workspace

--- stderr ---
...
--- stdout ---
...

finishedAt: ...
exitCode: 0
durationMs: 12034
```

Logs contain raw output because the approved purpose is post-mortem diagnosis. They may therefore contain credentials emitted by a registry, Docker build, feature installer, or user initialization command. They are operator-local files, never inserted into model context, never copied to the audit JSONL, and must not be displayed by a slash-command result. `/devcontainer status` may show only the newest file path.

### Bounded retention

A single log is capped at 10 MiB. On reaching the cap, the writer appends one explicit truncation marker and continues draining the child process without blocking it. A log write failure is recorded in the command result/audit diagnostics where possible but never changes the lifecycle operation's result.

Files older than 14 days are pruned at `session_start`; no background scheduler is added. This mirrors audit pruning's explicit, session-bound maintenance model while using a shorter retention period for raw data.

### Process boundary

The current `ProcessRunner` captures bounded result streams, and a streaming callback currently suppresses final stream capture. Lifecycle logging needs both: adapters must keep the final bounded `stdout` for Dev Containers CLI JSON parsing while teeing every lifecycle byte into its file.

Add an observer/tap channel to `ProcessRunner` that is independent of existing consumer callbacks. The runner invokes the observer for each stdout/stderr chunk but still applies its present capture and truncation semantics. This preserves the P5 `ProcessResult` contract and avoids a second ad-hoc `chunks.push` implementation.

`NodeDevcontainerAdapter` receives a lifecycle-run sink for `up` and `build`; rebuild reuses the same `up` path. It adds the public `--log-level debug` flag to those calls so build and initialization progress reaches the transcript. It does not rely on the CLI's undocumented `--terminal-log-file` interface.

`NodeDockerLifecycleAdapter` tees `stop`/`remove`, and `createSetupCli` tees install/probe output. Command handlers own lifecycle-run creation and finalization for command-parse, policy, confirmation, adapter, and refresh/reconcile outcomes.

### Operator surface

`/devcontainer status` adds a diagnostic-log location line only when a lifecycle file exists. It exposes the path, timestamp, operation, and terminal outcome, never raw contents. The user can inspect the `0600` file through their normal local tools.

The successful command result likewise may name the file path but never embeds the raw transcript. This keeps sensitive process output out of agent-visible command text.

## Failure behavior

- A child spawn failure, timeout, cancellation, nonzero exit, or JSON parse failure is finalized in the log with all output received before the failure.
- A policy denial, cancelled confirmation, or unavailable UI finalizes a no-child log with its typed reason.
- If the directory cannot be created or a write fails, lifecycle work still proceeds; the result carries a concise operator-facing warning that diagnostic logging was unavailable.
- Log retention failure never blocks session startup or a lifecycle operation.

## Verification

Tests must prove:

1. Each included operation creates and finalizes one log on success, error, policy denial, and confirmation cancellation as applicable.
2. stdout and stderr both reach the transcript, preserve their stream labels, and do not suppress the adapter's final JSON parsing/result capture.
3. The configured byte cap appends exactly one truncation marker and does not block or alter child completion.
4. Directories/files use `0700`/`0600`; filenames do not leak workspace or command data.
5. Pruning removes only expired lifecycle logs.
6. A writer failure is visible to the operator but does not change the operation's success/failure semantics.
7. Audit records remain metadata-only and raw transcript content is absent from slash-command output and model-facing execution context.
8. `/devcontainer status` reports metadata/path only.

## Non-goals

- Replacing Docker's own container logs.
- Persisting arbitrary container or host command output.
- Uploading, sharing, or transmitting diagnostic logs.
- Live UI streaming or a log viewer command that would feed raw text into model context.
- Configuring undocumented Dev Containers CLI log-file flags.
