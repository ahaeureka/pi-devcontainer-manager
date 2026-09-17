# Routing hardening (build notes)

Captured while closing the three gaps the command-routing assessment named
(`.rpiv/artifacts/architecture-reviews/2026-09-17_command-routing-assessment.md` §4). The durable
output is the reasoning behind each decision, because all three were judgement calls rather than
specification work.

## 1. Visibility beats a confirmation on a surface the agent drives

The assessment's sharpest observation was an asymmetry: `stop`/`remove` need a policy grant AND a fresh
per-action confirmation token, while an arbitrary host command needs the grant only — and that grant
now ships enabled. The obvious "fix" is to add a confirmation. It is the wrong one here.

A confirmation exists to make a *human* pause before an irreversible act they initiated. The host
escape hatch is initiated by the model, in the middle of a task; an interactive prompt would either
stall the run or be clicked through unread — and a rubber stamp is worse than no gate, because it
looks like one.

What the asymmetry actually needed was **observability**, and it cost a bounded ledger: count every
host attempt (refusals, container-path violations, failures and successes alike), keep the last few
argv, report them in `/devcontainer status`, and announce the FIRST one of a session on the operator
channel. Drift becomes visible while it happens. The audit trail stays the authoritative record; the
ledger is a summary, and the code says so.

The decision is now written down in `docs/security.md` rather than left as an implicit design quirk —
that is the part that stops it being re-litigated every time someone notices the asymmetry.

## 2. A reverse guard has to be an identity check, not a heuristic

The forward guard (collapsing a container-only path onto a host surface) works because literal argv is
exact. The reverse direction looked harder — "is this command about the host's copy of a file?" is a
question about intent — but the reliable core of it is small: a container-surface argv element that
**IS the host workspace path, or lies beneath it**. That is path identity with a segment boundary, so
`/host/project-other` is not "beneath" `/host/proj`, and a value like `host/proj` (no leading slash) is
not a path at all.

Three deliberate limits, each with a reason:

- **Only the structured surface.** `devcontainer_exec` carries argv; routed shell text does not. The
  Phase-5 review established that a heuristic over shell text cannot be made safe, so `bash`, `!`/`!!`
  are not inspected — the per-turn mapping facts are the guidance there.
- **Silent when there is no mapping, or when the mapping keeps the path.** With no configuration to
  read there is nothing to compare; with `workspaceMount` mapping the host path to the same path, the
  host path IS the container path and the command is correct as written.
- **Refuse, and name the alternative.** The remedy is the container path, not "try again".

## 3. Wiring: a session-scoped ledger has to live where the session does

The host runner is built inside a module-level `composeRuntime`, so a per-session ledger cannot be
created there — it would be shared across sessions and never reset. It is created in the extension
closure and threaded in through a small `hostVisibility` parameter (ledger + the one-shot notice
callback), which also gives the status surface its summary. The same shape was used for the mapping
reader: one helper, consumed by BOTH guards (the host-side container-path guard and the new
container-side host-path guard), so the two directions cannot disagree about what the mapping is.

Lesson worth reusing: **anything with per-session lifetime belongs in the closure that owns the
session, and gets passed to the modules that need it** — the same reasoning that put the lifecycle
generation there.

## 4. One requirement adapted, and said out loud

`REQ-4` asked for a container picker showing "id, state, image". The registry candidate type carries
`id` and `state` only (the union conversion in Phase 4 deliberately keeps the container identity
minimal), so the labels are `id — state`. Fetching the image would mean a Docker read inside the
command path — the kind of extra scan the review's contract avoids. The picker still removes the
copy-a-64-character-id problem, which was the point; the deviation is recorded in the review record
rather than quietly satisfied.
