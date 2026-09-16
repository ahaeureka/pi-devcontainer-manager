# Host execution granted by default (design + policy notes)

Captured while making `hostExecution.allow` ship as `true` (`host-exec-default`). The change is small
in lines and large in posture, so the durable output is the shape of the merge and the rules a
security-posture default must satisfy.

## 1. Where a shipped default has to live

`hostExecution.allow` was `false` in `DEFAULTS` **and** hard-coded again inside the merge:

```ts
const allow = (project?.allow === true && global?.allow === true)
           || (project?.allow === undefined && global?.allow === true)
           || (project?.allow === undefined && global?.allow === undefined && false); // ← duplicate
```

Flipping `DEFAULTS.hostExecution` alone would therefore have changed **nothing**. The merge now reads
the default instead of restating it:

```ts
if (project?.allow === false || global?.allow === false) return { allow: false };
return { allow: project?.allow ?? global?.allow ?? DEFAULTS.hostExecution.allow };
```

Rule: **a default that appears in a merge function as a literal is a second source of truth**; when a
policy value is merged, the merge must consult `DEFAULTS` or the constant and the merge will drift.

## 2. Deny-wins is what makes a granted default safe

A granted default is only safe if every layer can still withhold it, in both directions:

| global | project | effective |
|---|---|---|
| unset | unset | grant (the shipped posture) |
| unset | `false` | deny |
| `false` | unset | deny |
| `false` | `true` | **deny** — a deny cannot be widened by a child layer |

The last row is the one a naive `project ?? global ?? true` gets wrong, and it is the row a security
review should ask about. Express it as an explicit early return for the deny, never as a chain of
`??`.

## 3. A posture change includes its messages

All three refusal sites told the operator to "set `hostExecution.allow=true` in the global
configuration". With the default granted, that advice points at a knob that is already on, and the
only remaining cause is a configuration deny. A denial message is part of the policy contract: when
the default moves, the *remedy* has to name the new cause (which file, which layer, and that
`/reload` is needed because the effective config is composed at `session_start`).

## 4. What a granted default must NOT change

The flip changes *who may* run host commands, never *what is recorded*: the audit operation
(`host-exec`) and initiator (`host-escape`), the capture mode, the literal-argv transport (no shell),
`/devcontainer setup` staying ungated by this policy, and `stop`/`remove` keeping both the policy
grant and a fresh per-action confirmation token. Assert those alongside the default so a later
"helpful" change has to argue with a test.

## 5. Kata mechanics learned here

- **The seal runs evidence commands as argv, not through a shell.** A matrix evidence entry like
  `grep -rn 'hostExecution' README.md docs` becomes a single literal argument, matches nothing, and
  exits 1 — failing the seal's gate while the code is green. Keep evidence commands quote-free and
  single-purpose (`grep -rn hostExecution README.md`).
- **A `verify` that returns `success: false` with every criterion PASS and `governanceReady: false`**
  is the deferred wiki-closure gate, not an implementation failure: write the note, ingest it, record
  the closure decision, re-run verify.

## 6. What the review cycle added: an AC is not satisfied until something would FAIL if it broke

The independent pass showed the difference between "the code does this" and "the suite would notice if
it stopped". AC-3 asserted that audit records, literal-argv transport and the container-path guard
were unchanged by the default flip — all true, and **all unverified**: deleting the audit writes kept
414 tests green, because the guard and the audit calls lived inline in the facade, where this
repository has no unit harness.

The repair is the pattern to reuse: **extract the governed behaviour into an injectable module**
(`src/host-runner.ts`, exactly as Phase 2 extracted `src/setup-cli.ts`) so the properties can be
pinned — the audit record and its `operation`/`initiator`, the record a refusal writes *before* it
throws, the container-path refusal *before* any spawn, the timeout ceiling, the failure record. Then
the wiring that stays in the facade is small enough to describe honestly as smoke-covered.

Two more lessons from the same pass:

- **A posture change has to sweep every document that describes the old posture**, including the ones
  the change does not otherwise touch. The entry the reviewer caught (`docs/troubleshooting.md`: "the
  defaults are restrictive, so a grant in the wrong file simply never applies") had been true for
  years and became false the moment the default granted — and it is exactly the page an operator
  reads when they hit the denial.
- **A default that GRANTS turns "unreadable input" into a policy hole.** Any layer whose
  `hostExecution` cannot be read (`"garbage"`, `42`, `[]`, `{"hostExecution": "no"}`, `null`) used to
  fall back to the deny-by-default. Now it must WITHHOLD and say why, because silently inheriting the
  grant means an operator who wrote something broken gets the opposite of what they wrote.

## 7. Documentation consistency as a test

AC-5 ("the docs match the new posture") looked untestable and was evidenced by a grep that asserted
nothing. It now has a real assertion: `tests/unit/docs-consistency.test.ts` reads the documents and
requires the stated default to equal the exported `DEFAULTS` (and the two READMEs to agree). It is a
weak test, but it fails in the right direction — move the default and forget a document, and the
suite says so.
