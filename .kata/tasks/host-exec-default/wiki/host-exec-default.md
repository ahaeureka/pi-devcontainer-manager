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
