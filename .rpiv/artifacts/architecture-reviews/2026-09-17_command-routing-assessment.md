# Command-routing assessment — is the host/DevContainer mechanism reasonable?

`date: 2026-09-17` · `main: b4e4940` · assessment of the routing design as shipped after the
architecture review (P1–P5) and the `host-exec-default` change.

This is an assessment, not a review: it asks whether the *mechanism* is the right shape, not whether
the code matches a specification. Findings are graded by whether they are deliberate tradeoffs worth
keeping, gaps worth closing, or defects (none of the latter were found here — the review already
closed those).

## 1. What the mechanism is, in one paragraph

Shell-shaped work (`bash`, `!`/`!!`) is routed into the selected container whenever the session is
*engaged*; a session engages from workspace evidence or an explicit act, and when it does not engage,
nothing is registered and Pi's built-in host `bash` stays exactly as shipped (`src/activation.ts:62-91`).
The HOST is reachable only through surfaces that say so in their name — `devcontainer_host_exec` and
`/devcontainer host-exec` — which are policy-gated, path-guarded and audited (`src/host-runner.ts`).
The extension never classifies a command: it supplies facts (target, the host↔container mapping,
container-only mounts, surface rules) and lets the model choose, then enforces the boundary it can
enforce reliably on literal argv (`src/execution-context.ts:42-79`, `src/host-runner.ts` Layer-3 guard).

## 2. Invariants that are right and should not be traded away

1. **No silent fallback in either direction.** A container-side failure never retries on the host, and
   a host-side failure never retries in the container (`src/bash-router.ts:18-22`; the failure rows in
   `docs/troubleshooting.md`). For a governed execution layer this is the property that matters most:
   the operator can always answer "where did that run?" from the surface they see and the audit record
   they can read.
2. **The dangerous surface is the one that requires naming.** The host is the side with the operator's
   real environment, so it is the side that needs an explicit tool, a policy key, an audit operation
   and a path guard — while the container is the default for shell work.
3. **Facts, not classification.** Any heuristic that inferred "this command belongs on the host" from
   its name or its shell text would be both wrong and security-relevant. The one boundary check that
   *can* be done reliably — a literal argv reaching for a container-only path on a host surface — is
   the one that exists (`src/host-runner.ts`), and the review agreed a classifier over shell text
   could never be safe there.
4. **One owner per layer.** The activation decision (`decideActivation`), the surface set
   (`surfacesFor`), the policy gate (`evaluatePolicy`) and the target binding (`TargetStore.bind`)
   each have exactly one implementation, so the four execution surfaces cannot drift apart.
5. **`!`/`!!` fail closed rather than fall through.** Returning `undefined` from `user_bash` would let
   Pi execute the operator's command on the host; the handler returns a full `{ result }` instead
   (`extensions/index.ts:769-800`). This is a subtle, correct handling of a third-party contract.
6. **`off` is respected twice.** The opt-out is persisted (so `/reload` does not undo it) *and* holds
   for the rest of the session even though Pi cannot unregister tools (`src/activation.ts:71-81`).

## 3. Tradeoffs that are deliberate — worth stating, not fixing

1. **The reverse guard does not exist.** A host path handed to a container surface is not refused: it
   resolves inside the container or fails there. This is defensible (the container is usually the
   less privileged side, and the mapping facts are in the prompt) but it is *not* symmetric with the
   host-side guard, and it is silently wrong when the same absolute path exists on both sides with
   different content (a container-only mount, `/tmp`, `/etc`).
2. **`routeMode` is a knob with one legal value.** v1 implements only `container-required` and rejects
   anything else with a clear message (`src/config.ts:305-311`). Honest, but it is surface that cannot
   be used.
3. **Activation evidence is cwd-anchored.** A devcontainer configuration in a subdirectory of a
   monorepo leaves the session dormant unless the operator uses `always` or an explicit `use`
   (`src/activation.ts:87`). The dormant notification explains itself, so this is a usability sharp
   edge rather than a mystery.
4. **Only `powershell` is blocked.** Other host-spawning surfaces (a user-added tool, an MCP server)
   are outside the extension's governance. The extension governs *its* surfaces, and says so.

## 4. Gaps worth an explicit decision

1. **The host escape hatch is less gated than `stop`/`remove`.** A destructive container operation
   needs a policy grant *and* a fresh per-action confirmation token; an arbitrary host command needs
   the policy grant only — and since the `host-exec-default` change that grant ships **enabled**
   (`src/config.ts` DEFAULTS). The asymmetry is now the sharpest edge in the mechanism: the most
   powerful surface has the weakest per-action gate. Options, cheapest first:
   (a) leave it and rely on the prompt rules + audit trail (status quo);
   (b) add a session-scoped count of host runs to `/devcontainer status` so drift is visible;
   (c) require confirmation for host runs whose argv is not on a narrow allowlist;
   (d) restore `false` as the shipped default.
2. **The reverse guard could be cheap.** A host-side path check already exists; mirroring it is
   feasible *if* the rule is stated narrowly: warn (or refuse) when an argv passed to a CONTAINER
   surface contains an absolute path that is neither under the mapping's `containerPath` nor under the
   workspace mount — i.e. pointing at something the host owns and the container only happens to have.
   The hard part is not detection but avoiding false positives on tool flags (`--prefix=/usr`).
3. **Ambiguity between containers is human-only and id-only.** `/devcontainer use` lists the candidate
   ids and refuses to choose (`src/commands.ts`, `selectionFor`), which is correct — but the chooser is
   an interactive `ui.select` for *workspaces* only, so the operator must copy a 12+ character id. A
   container picker (name, status, image) would resolve it in one keystroke without weakening the
   "never let Docker order decide" rule.
4. **The per-turn context does not report accumulated host use.** The model sees the target and the
   mapping; the operator sees audit records. Nothing summarises "this session ran 6 host commands",
   which is exactly the signal that would catch a model drifting toward the escape hatch.

## 5. Verdict

**The core mechanism is reasonable and I would not redesign it.** Its two load-bearing decisions —
container-by-default with an explicitly named host surface, and no automatic fallback in either
direction — are the right shape for governed execution, and the layer boundaries (activation /
facts / gates) are cleanly separated with one owner each. Several of the properties above are pinned
by tests, and the review's five phases removed the ways the mechanism could fail silently.

The honest criticisms are unequal gating (§4.1), the missing reverse guard (§4.2), and the effort
ambiguity costs the operator (§4.3). None of them is a defect; each is a decision the operator should
make explicitly rather than inherit. §4.1 is the one I would decide first, because it is the only gap
that the `host-exec-default` change made more consequential: a granted-by-default arbitrary host
command with no per-action confirmation is the strongest surface with the weakest gate.
