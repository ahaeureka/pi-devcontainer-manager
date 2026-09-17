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

## 5. What the review caught: three defects in this change

The adversarial pass on the first sealed revision returned "not safe to merge as-is", and it was right
three times over. Every one of them was invisible to the tests I had written:

- **A claim without a caller.** `renderStatus` gained an optional `hostRuns` parameter, one of the two
  call sites passed it, and the test that "reuses the same rendering" asserted nothing about the new
  line. So the acceptance criterion, the CHANGELOG bullet, `docs/security.md` and a README row were all
  false while the suite was green. **When a change adds a rendered line, the test must assert the line
  at EVERY surface that renders it** — an optional parameter is exactly how a claim loses its caller.
- **A new failure path outside the audit boundary.** The reverse guard's mapping read goes through the
  registry (`docker ps`), so a Docker failure escaped with no record. The invariant this repository
  earned in an earlier phase — every failure lands on a channel someone reads — applies to the code a
  review adds, not just to the code it critiques.
- **A guard that refused correct work.** A configuration that mirrors a host path into the container at
  its own path (`mounts: source == target`) makes that path the SAME file on both sides, and the guard
  refused it; it also refused the container path whenever that path sat beneath the host path — i.e. it
  refused the very path its own remedy named. **A refusal must be checked against the remedy it
  suggests**, or the guard argues with itself.

Two smaller ones are worth keeping too: the ledger stored argv verbatim (so a credential would have
been rendered in `/devcontainer status`, a plaintext copy of what the audit trail deliberately captures
by fingerprint), and the picker was the only prompt in its file without a `hasUI` guard — which is how a
print/json run would have hung.

## 6. A kata-route detail: the choice file is not always written

`gate approve --boundary review_gate` failed with ENOENT on `user-choice-review_gate.json`: the CLI
reported the boundary in its completion but had not created the file (unlike the earlier tasks). The
file is a small JSON object (`taskId`, `boundary`, `createdAt`, `choice`) and recording the operator's
standing choice there unblocked the route. Worth knowing before concluding that a gate is broken.

## 7. Six independent passes over one change: what the loop actually bought

This task was reviewed by a fresh-context adversarial subagent six times (four over successive sealed
revisions, then a converged pass, then the verify node). The severity curve is the interesting part:

| pass | result |
|---|---|
| 1 | 1 major + 4 minor + 1 nit |
| 2 | 6 minor + 2 nit |
| 3 | 1 major + 3 minor + 1 nit |
| 4 | 1 major (everything else refuted) |
| 5 | **nothing — `no_defect_found`, 8/8 attempts refuted** |

**Every single major was introduced or missed by the author while fixing the previous round.** Three
concrete examples, all of them the same shape — a fix that was correct in the case it was written for
and wrong one step away:

- The withheld-attempt hook was wired into the tool that does not read it instead of the tool that does
  (the compensating control's whole point is the agent's surface).
- The exemption added for a nested container path exempted the entire host path space instead of the
  container's own workspace.
- `selectionFor` took the candidate state from the workspace's primary container while the id came from
  the picker, so a runnable target could answer `target-stopped`.

The rule this leaves behind: **after repairing a finding, the repair itself is the most likely place for
the next defect** — so the next pass must be told *what the last fix touched*, and the fix's own test
must cover the inverse of the case it was written for (the tool that reads the option, the sibling path
that is not exempt, the sibling container whose state differs).

It also shows what "converged" means in practice: the final pass did not merely find nothing, it
re-ran every gate, rebuilt `dist/` and compared, and drove the picker path instrumented — eight
falsification attempts, all refuted. A pass that says "looks fine" without executing anything is worth
nothing.

## 8. The kata adversarial gate is per NODE (verify and review)

`verify` and `review` each hold their own record (`.kata/tasks/<id>/adversarial-{verify,review}.json`),
each bound to its own brief hash and the current revision. So a task needs **two** recorded passes per
revision: one framed as "does the implementation deliver these criteria, with fresh evidence" (verify
node) and one framed as "does the change hold up as a whole" (review node). Fixing anything after that
invalidates both and starts the count again — which is the cost that makes the loop honest.

Practical note for the reviewer prompt: the schema rejects unknown properties (`additionalProperties:
false`), so a subagent that adds a helpful `outcome_note` to an attempt gets its record refused —
fold extra prose into `evidence` instead.

## 9. Redact what you RECORD, with the rule the record uses

The verify-node pass found the sharpest defect of the whole task in the visibility I had just added, and it
is worth stating as a rule because the mistake is invisible by construction.

The audit trail redacts the **joined command line** (`commandIdentity` joins the argv, `JsonlAuditWriter`
applies `redactText`), and `redactText`'s flag-with-value rules need the flag and its value in ONE string —
that is how `--password s3cr3t` becomes `--password [REDACTED]`. My ledger, the runner's notice and the
withheld-attempt notice each redacted **element by element** and then joined. Both forms hide
`Authorization: Bearer <token>` (one element), so the tests I wrote passed — and both forms are wrong for
the two-element idiom, so `mysql -u root --password s3cr3t` reached the operator notice verbatim while the
audit record redacted it.

Rules from that:

- **A second rendering of the same data must use the same transformation, or it is a second, weaker
  policy.** "I redacted it too" is not the claim; "it went through the same function on the same string" is.
- **Test the shape the policy is written for.** A redaction test using a one-element secret proves nothing
  about the two-element form the policy exists to catch.
- **Grep for every rendering.** The same argv reaches the ledger summary, two notices, `/devcontainer
  status` and the audit record; a per-rendering fix leaves the next one wrong.

The companion finding was a claim mismatch: a withheld attempt is refused BEFORE the runner, so it leaves
no `host-exec` audit record — and the notice I wrote said `(audited)`. **A notice is a claim about what
happened; make it true per refusal path, not in the common case.**

## 10. Nineteen passes: the durable lessons from this task

This task was reviewed nineteen times by fresh-context adversarial reviewers (per-revision passes plus both kata
nodes), which produced 60 findings across 14 sealed revisions. Almost everything it bought reduces to four rules.

**1. A fix applied to one surface and not its mirror was the dominant failure mode — six times.**
The container-surface guard's audited mapping read was not mirrored on the host side. The withheld-attempt hook
was wired to the tool that ignores it instead of the tool that reads it. A program name was treated as
safe-by-assumption instead of rendered by enforcement. The URL rule's password class was taught about slashes
but not about an empty username. The root-path boundary fix reached the reverse guard but not
`findContainerPath`. And the same segment math existed in three places.
The remedy is structural, not another patch: **when a rule is needed in more than one place, make it one
function and delete the copies** (`isAtOrUnder`/`isSamePath` in `src/workspace-path.ts` is now the only segment
test, and `path-mapper`, `routing-guard` and the host runner all call it). Before fixing an instance, ask how
many parallel surfaces implement the same idea.

**2. A security control's observability should be counts and categories, never rendered input.**
The in-session host-run summary started as "the last commands, redacted" and produced five credentials across
five revisions — including two leaks introduced by fixes for the previous leak. Redaction of a rendered command
line is a long tail with no natural end. The surface now shows a count and the PROGRAM names, and it names the
program through one **enforced** renderer (`displayProgram`: first whitespace token, audit redaction, URL
authority host only, control characters stripped, capped, never blank) rather than assuming a program name is
safe — because it can be credential-shaped. **What you choose to display is a security decision.**

**3. Make the rendering safe independently of the filter.**
`redactText` is inherently ambiguous for URLs (a slash inside a password vs a path; an `@` in a password; a
URL-shaped argument that is not the whole argument). Chasing the rule is endless; taking the FIRST token and
rendering a URL as its authority HOST means no credential can reach either operator surface even for the shapes
the rule misses. The two remaining audit-side gaps are documented in `docs/security.md` instead of overclaimed.

**4. A silently-no-op edit is a real defect.**
One repair here did not apply at all — a `str.replace` that did not match — and the finding it was meant to
close came straight back in the next pass. Every edit in this task's later repairs asserts its anchor first, and
the lesson generalises: **assert the replacement, then assert the behaviour.**

Smaller but reusable: parallel test FILES that drive the same external resource must not run concurrently
(`fileParallelism: false` — the real-Docker suites were removing each other's containers and the flakiness looked
like startup timing); a guard's refusal must be checked against the remedy it suggests (the guard once refused
the very path its own message told the operator to use); and a kata adversarial record is per NODE and per
revision, so any post-pass edit invalidates both records and starts the count again.
