---
source_path: .kata/tasks/arch-review-p5-public-surfaces/wiki/arch-review-p5-public-surfaces.md
ingested: 2026-09-17T07:47:43.599Z
sha256: eddd505912b6d421b05996944ff14e4ddc766cb20864d6ec61fe73ebc263c5eb
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
