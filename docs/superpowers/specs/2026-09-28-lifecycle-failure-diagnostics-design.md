# Lifecycle failure diagnostics design

## Purpose

When a lifecycle operation (`up`, `build`, `rebuild`, `setup`, `stop`, or `remove`) fails, make the failure immediately actionable to the agent without turning the project-local raw transcript into model context.

The existing raw transcript remains the authoritative post-mortem record at:

```text
<session-cwd>/.pi/devcontainer-manager/lifecycle-logs/
```

It is secret-bearing (`0700` directory, `0600` files) and stays local. This change adds a separate, bounded **failure diagnostic packet** for automatic analysis.

## Decision

Use a two-plane design:

1. **Raw lifecycle transcript** — unchanged: full stdout/stderr in the private project `.pi` directory, never automatically read by the agent.
2. **Safe failure diagnostic packet** — deterministic, bounded metadata and locally classified failure facts carried with the lifecycle error/tool result. It is explicitly marked as untrusted diagnostics, not instructions.

The packet makes common failures automatically diagnosable. If it cannot safely classify the cause, it says so and reports whether a raw log is available; the agent must ask the operator before reading any raw range. It must never silently claim the packet is complete.

## Threat model and boundary

Lifecycle output can contain registry credentials, proxy URLs, private paths, untrusted build-script text, and prompt-injection-like instructions. Existing `redactText` is intentionally not a suitable proof of safe arbitrary-log disclosure: it serves the audit contract and has documented residual gaps.

Therefore this feature does **not** copy arbitrary stdout/stderr lines, a stream tail, or regex-selected context windows to the agent. Those approaches improve apparent coverage but cannot guarantee that a credential or hostile text was not selected.

The automatic packet may contain only:

- operation, typed error kind, exit code/signal, elapsed duration, and output-truncated flag;
- `rawLogAvailable: boolean` and an opaque log identifier; and
- a finite taxonomy of recognised lifecycle failure classes; and
- fixed remediation text owned by this extension.

A recognised class may include fixed, non-log-derived fields such as `postCreateCommand`, `postStartCommand`, `Docker daemon`, or `Dev Containers CLI`; it must not include the command text or an arbitrary captured value.

Every packet carries `complete: false` unless its classifier is explicitly exhaustive for that failure class. In practice this means the agent treats the packet as a triage lead, not proof.

## Failure taxonomy

The initial taxonomy is deliberately small and derived from typed errors and stable Dev Containers CLI failure shapes:

| Class | Evidence source | Agent-safe diagnosis |
| --- | --- | --- |
| `policy-denied` | `RuntimeError.kind` | configuration or confirmation prevented the lifecycle operation |
| `cancelled` / `timeout` | `RuntimeError.kind` or process result | operation was cancelled or exceeded its configured deadline |
| `docker-daemon-unavailable` | typed Docker error | Docker daemon cannot be reached |
| `devcontainer-cli-unavailable` | typed spawn error | Dev Containers CLI is absent or cannot start |
| `post-create-failed` | stable CLI envelope | container creation completed but configured post-create hook failed |
| `post-start-failed` | stable CLI envelope | container started but configured post-start hook failed |
| `lifecycle-command-failed` | nonzero exit with no safe subtype | operation failed; raw transcript may contain the root cause |
| `unclassified` | all other errors | no safe automatic diagnosis is available |

The classifier consumes error kinds and bounded result metadata first. It may recognise an exact stable CLI envelope, but never emits the matched source text. New error shapes remain `unclassified` until a test proves both the classifier and its safe, fixed wording.

## Data flow

1. `LifecycleLogWriter` finalizes the raw log before any packet is built.
2. The lifecycle owner (`ExecutionService` for `up/build/rebuild/stop/remove`, `createSetupCli` for `setup`) constructs a `LifecycleFailureDiagnostic` on every non-success path.
3. The diagnostic is attached to the typed lifecycle failure/result and propagated through both public surfaces: the `devcontainer_*` tools and `/devcontainer` command handlers.
4. The model-facing result contains the fixed diagnostic fields plus `rawLogAvailable` and an opaque id; it never includes a host path, raw transcript fragment, or summary-file path containing captured output. The existing operator-only status/notice surface may expose the local path.
5. The agent receives the packet in the normal operation failure result and analyzes its category/remedy automatically. When `complete` is false, it must state that an operator-local transcript is available but requires explicit operator approval to inspect.

No background agent, watcher, filesystem scan, or extra model call is introduced. Failed operations produce the packet synchronously from data already available at their boundary.

## Operator experience

A lifecycle failure produces a concise result conceptually shaped as:

```text
Lifecycle diagnostic: post-start-failed (incomplete)
Container startup reached postStartCommand but that hook failed.
An operator-local raw log is available. It was not read automatically.
Ask the operator before inspecting it.
```

For a complete policy/confirmation classification, the packet says `complete: true` and has no need to request raw-log inspection. A raw-log write failure still cannot block the operation: packet creation reports `rawLogAvailable: false` and preserves the existing safe warning.

## Non-goals

- Do not auto-read, auto-summarize with an LLM, upload, or attach raw logs to the model context.
- Do not expand audit JSONL or change its redaction/fingerprint contract.
- Do not analyse routine `devcontainer_exec`, bash, host-exec, or `logs` output.
- Do not promise a generic failure packet is exhaustive.
- Do not provide automatic remediation or rerun failed lifecycle commands.

## Verification

Tests must prove:

1. Every included lifecycle failure surface exposes a packet with operation, typed class, terminal metadata, and `rawLogAvailable`; the raw host path is absent from the model-facing packet.
2. A `postStartCommand` failure from the real Dev Containers CLI envelope yields `post-start-failed` and exposes none of the envelope text.
3. Unrecognised stdout/stderr content, including a synthetic credential and instruction-like string, is absent from the packet while the raw transcript retains it.
4. Policy denial, cancellation, timeout, Docker unavailable, and executable missing each map to their correct fixed class/remedy.
5. A raw-log write failure does not alter lifecycle result semantics and reports `rawLogAvailable: false` safely.
6. Tool and slash-command result surfaces expose the same packet shape.
7. Existing raw-log permission, retention, audit isolation, and no-model-context guarantees remain green.
