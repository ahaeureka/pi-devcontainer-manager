---
source_path: .kata/tasks/arch-review-p1-foundation/wiki/arch-review-p1-foundation.md
ingested: 2026-09-15T05:18:02.493Z
sha256: 844b2c6fbe2e85ae9f876e47e64005a5a8daaf3d537ca99ddca1c1e67493f440
---
# Kata role defaults vs task ownership (Phase 1 build notes)

Captured while implementing `arch-review-p1-foundation` (Phase 1 / Foundation of the
architecture review). Two constraints surfaced during the build that design alone could not
foresee; both are worth knowing before opening the next Kata task in this repository.

## 1. The implementer handoff's `allowedWrites` is a role default, not the task's ownership

`handoff show` reports `permissions.allowedWrites`, and the packet calls it authoritative.
For the implementer role the CLI computes it as a **constant**:

```
allowedWrites("implementer") = [ "packages/" if a packages/ dir exists else "src/", "tests/", "docs/" ]
```

It ignores the task's `ownedPaths`. This task's owned paths are
`src, extensions, tests, dist, CHANGELOG.md`, so the handoff denied the very paths two of its
own acceptance criteria need: `AC-1` edits `extensions/index.ts`, and `AC-9` requires
rebuilding the committed `dist/` and recording the change in `CHANGELOG.md`.

Resolution (owner-approved, and the honest one): treat the task's `ownedPaths` as the
authoritative ownership record, and use the CLI's own extension point rather than writing
outside ownership —

```bash
kata-cli build --change <task> --seal --owned-path docs --owned-path openspec
```

`resolveSealOwnedPaths` unions the supplied paths with the existing `ownedPaths` and
persists the merged list, so the sealed revision then covers every path the task actually
touches. The sealed scope came out as
`CHANGELOG.md, dist, docs, extensions, openspec, src, tests`.

Do not silently widen writes instead: surface the conflict and get an explicit decision,
because the packet's wording makes `allowedWrites` look binding.

## 2. Sealing requires a receipt for the CURRENT head

`Workflow mutation requires a current acknowledged handoff receipt for implementer` is what
the first `build --seal` returned after the implementation commit: the previously
acknowledged packet anchored the pre-commit head, so committing invalidated it. The retry
sequence is:

```bash
kata-cli orient --change <task> --role implementer --platform pi --task-kind implementation
# take handoff.id from the reply, then:
kata-cli handoff verify   --task <task> --id <id>
kata-cli handoff acknowledge --task <task> --id <id> --platform pi --role implementer
kata-cli build --change <task> --seal --owned-path …
```

Same rule as the archive flow: commit first, then orient → verify → acknowledge → act.

## 3. Two smaller facts

- `kata-cli hooks activate` only accepts the role matching the current phase. While the phase
  is still `plan`, `--role implementer` is refused (`expected designer`); activate with the
  phase-appropriate role, or after the phase transitions.
- `kata-cli build --seal` runs the quality gate itself (typecheck, then the test suite) and
  records the evidence envelopes, so a separate evidence run is not required before sealing —
  but the gate must be green locally anyway, and the committed `dist/` must be current
  because CI compares a fresh build against the commit.

## Related

- `.kata/tasks/activation-and-config-mechanism/wiki/activation-and-config-mechanism.md` —
  the archived task's `workspaceDrift` lesson, which is why `openspec/` is now sealed
  together with the code it authorizes.
- `.rpiv/artifacts/architecture-reviews/2026-09-15_08-46-53_pi-devcontainer-manager.md` —
  the review that produced this task's scope.
