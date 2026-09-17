---
source_path: .kata/tasks/arch-review-p5-public-surfaces/wiki/arch-review-p5-public-surfaces.md
ingested: 2026-09-17T08:07:39.651Z
sha256: 2bf93778a254bb23a1e059150b198dd085efd76e23b315a71cf4667c6786a0f4
---
# Public surfaces and the process boundary (Phase 5 build notes)

Captured while implementing `arch-review-p5-public-surfaces`, the review's last phase. Its three
findings had one shape: an interface narrower than the thing behind it, so the difference leaked as a
defect — a lifecycle with no owner, a free-text grammar on a surface that executes the result, and a
process result with no output on it.

## 1. An asynchronous lifecycle needs an owner, not just a variable

`session_start` awaits (an activation probe, a selection reconcile, a registry read) and then assigned
the shared `runtime` and registered surfaces. A start that resumed after a reload, a second start or a
shutdown overwrote a newer runtime and registered tools from an activation decision that no longer
described the session.

The pattern that fixes it, and the reason it is a small module rather than an inline counter:

```ts
const generation = lifecycle.begin();              // BEFORE the first await
const superseded = () => !lifecycle.isCurrent(generation);
runtime = rt;                                      // every mutation guarded …
if (superseded()) return;
const evidence = await probe(rt, ctx.cwd);
if (superseded()) return;                          // … and every await followed by a check
```

- **Open the generation before the first await.** Anything captured later is already stale.
- **A superseded start returns; it does not throw.** It did nothing wrong, it is simply no longer the
  owner.
- **Invalidation must not be sticky.** Shutdown bumps the generation so an in-flight start dies, but
  the NEXT start must be current — otherwise a reload could never re-engage the extension. Both
  directions belong in the tests.
- **Extract it (`src/lifecycle.ts`) so it is testable**, exactly as `src/setup-cli.ts` and
  `src/host-runner.ts` were: the facade has no unit harness, so anything that must be verified cannot
  live only there.

## 2. A shell-like grammar on an executing surface is a security interface

`/devcontainer host-exec` accepted free text split by a narrow quote-aware regex, so escaped quotes,
concatenated segments and empty arguments were reinterpreted — on the one surface whose arguments are
then executed on the host. The replacement is one flag per argument, taken verbatim:

```
--argv <value>      one argument, spaces included, no quote processing
--argv=<value>      the same; the only way to pass an EMPTY argument
```

Two things worth reusing: (a) **a refusal must teach the new form** — the old syntax fails closed with
the usage line, because a public-API break that only says "no" costs the operator a search; (b)
**the invariants are asserted on the new grammar, not assumed from the old one** — literal argv to the
runner, the container-path guard on exactly the resolved array, and the audit fingerprint over the
argv that ran. The tool twin (`devcontainer_host_exec`) already took a structured array, so the
command now matches the tool instead of carrying a third grammar.

## 3. A boundary that carries no output forces every caller to re-implement it

`ProcessResult` had four fields and no bytes: output existed only if the caller passed `onData`
callbacks, so six consumers hand-rolled the same `chunks.push` block and any caller that forgot them
got a clean exit code with silently discarded output. The result now carries optional bounded
`stdout`/`stderr`, populated **only for a stream the caller is not streaming** (a streamed one is
already in the caller's hands; duplicating it would double the memory for the largest outputs), with an
empty stream reported as `""` so "no output" and "not captured" stay distinguishable.

The migration showed the cost of the old shape: every adapter's test fake had been written to *emit
into a callback*, so once the callback disappeared the fakes produced empty streams and the tests
failed — which is the honest signal that the fake encoded the old contract. When a boundary grows a
field, expect the doubles to need the same change.

## 4. Sealing writes evidence the reader rejects (recurring, and now understood)

This phase hit the same kata-CLI schema collision Phase 4 diagnosed, on the first seal: `verify`
reported `missing_test_evidence` for all six criteria because the three freshly-written evidence
envelopes had `name`s containing spaces (`AC-1-test-npm run test:unit`) while the current schema
requires `^[A-Za-z0-9_.-]+$`, and a single invalid envelope makes the whole evidence directory
unreadable. The repair is mechanical and changes no facts: relabel each `name` (spaces and slashes →
`-`), then re-run the gate.

Practical rule: **after any `build --seal`, validate the new envelopes before trusting a FAIL** —
`kind` in the current enum (`integration` was removed while the task matrix still allows it), `name`
matching the pattern, and the required fields present. A gate that reports "no evidence at all" is
describing the reader, not the work.

## 5. What the review cycle added: the interface edge cases are the bug

The independent pass on this phase found no blocking defect and still produced two real bugs in the new
parser, both **silent**, both on the surface that executes on the host:

- `--argv` was matched by prefix, so `--argverbose` was accepted as the flag and yielded the argument
  `erbose` — a mangled command name. **Match a flag as a whole word.**
- The `--argv=<value>` recovery slice was off by the flag's length, so a value that ended at the next
  `--argv` was REFUSED instead of split (`--argv= --argv x`). An off-by-N in a parser is invisible in
  the happy path and total in the edge path.

It also caught a documentation-shaped defect worth generalizing: the CHANGELOG's migration example
used shell quoting in a grammar where quotes are ordinary characters, i.e. **an example that runs a
different command than it shows**. When the point of a change is "there is no shell here", every
example has to be written as literally as the parser reads it.

## 6. Process mechanics this phase had to work out

Repairing a sealed revision after a PASS is a specific route, and the CLI is explicit about each step:

1. Move the task into `review` (`kata-cli review --confirm-host-model`), and record the repair as a
   **blocking** finding in `review.json` — in this phase it was a *process* finding ("the tree no
   longer matches the sealed revision"), not a defect, because the review's items were already fixed.
   `status` may only be `pending` or `approved`.
2. The first `build --seal` after that **enters implement and does NOT seal** — its diagnostics say so
   in as many words. Run `build --seal` a second time to create the new revision.
3. A mutation needs a **current acknowledged handoff receipt for the role that matches the phase**,
   and the phase does not change until the command succeeds: after moving to `review` the reviewer
   receipt is the one that unblocks `review`, and after the repair entry the *implementer* receipt
   unblocks the seal.
4. `hardVerify` cannot go straight back to implement: the repair entry from that phase needs a
   repairable verify FAIL, which a PASS does not provide — hence step 1.

And the rule from the previous phase paid for itself immediately: **validate the freshly-sealed
evidence envelopes before trusting a gate.** Three of this phase's envelopes again had `name`s with
spaces (the seal writes `${acceptanceId}-${kind}-${command}`), so the reader rejected the directory
and every criterion read as `missing_test_evidence`; relabelling them took one command instead of a
wasted verify round.
