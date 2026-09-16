# Design — host-exec-default

`task: host-exec-default` · `role: designer` · `phase: plan`
`branch: feature/host-exec-default` · `base: main@679edef`
`profile: git_flow / tdd / security`
`matrix: openspec/changes/host-exec-default/requirements.json`

Owner-facing messages stay Chinese per the Kata skill; this artifact keeps the technical contract in
English so it can be read alongside the code.

## 1. Problem

`hostExecution.allow` ships as `false`, so `devcontainer_host_exec` and `/devcontainer host-exec`
answer "Host execution is disabled by policy." in every project on a machine without a global
configuration file. That is what the operator hit, and the product decision (2026-09-16) is that host
execution should be **granted by default** — the escape hatch is expected to work out of the box —
while a configuration must still be able to withhold it.

Two code facts shape the change:

- `mergeHostExecution` (`src/config.ts:236`) hard-codes the fallback as `false` and derives the grant
  only from the two files, so flipping `DEFAULTS.hostExecution` alone would change nothing.
- The rule the repository documents is "a project can withhold, never widen". A naive
  `project ?? global ?? true` would break withholding: a project that sets `false` while the global
  file says nothing would then be granted.

## 2. Technical design

### 2.1 One place decides the posture (AC-1, AC-2)

```ts
// src/config.ts
hostExecution: Object.freeze({ allow: true }),        // DEFAULTS — the shipped posture

function mergeHostExecution(
  global?: Partial<HostExecutionConfig>,
  project?: Partial<HostExecutionConfig>,
): HostExecutionConfig {
  // An explicit deny from EITHER layer wins: a project file may withhold, and a global file may
  // withhold even when a project asks for it. The shipped default applies only when neither layer
  // speaks, so `DEFAULTS.hostExecution` is the single place the posture lives.
  if (project?.allow === false || global?.allow === false) return { allow: false };
  return { allow: project?.allow ?? global?.allow ?? DEFAULTS.hostExecution.allow };
}
```

Truth table the tests pin (global × project):

| global | project | effective |
|---|---|---|
| unset | unset | **allow = true** (the change) |
| true | unset | allow = true |
| unset | true | allow = true |
| true | true | allow = true |
| false | unset | allow = false |
| unset | false | allow = false |
| true | false | allow = false |
| false | true | allow = false (a deny cannot be widened) |

Nothing else moves: `destructive.*` stays `false`, and `routeMode`, `activation`, the ceilings and
the discovery limits keep their current defaults — asserted in the same test file so a future
"helpful" default change has to argue with a test.

### 2.2 The remedies have to tell the truth (AC-4)

The denial currently advises "Set `hostExecution.allow=true` in the global configuration", which
becomes false advice once the default grants it. All three refusal sites get wording that names the
real cause and both places it can be set:

- `src/tools.ts` — `devcontainer_host_exec`'s typed `policy-denied` error (`remedy`).
- `src/commands.ts` — `/devcontainer host-exec`'s refusal text.
- `extensions/index.ts` — the facade's host-exec guard message, which carries its own `remedy`.

New text (same in all three, trimmed to fit each surface): *host execution is withheld by
configuration — remove a `hostExecution.allow: false` from the project file (`.pi/pi-devcontainer-manager.json`,
needs a trusted project) or from the global file, then `/reload`.* A configuration DENY is the only
remaining cause, so the message says so instead of pointing at a knob that is already on.

### 2.3 Governance stays put (AC-3)

The flip changes *who may* run host commands, not *what is recorded* or *how* they are transported:
`operation: "host-exec"`, `initiator: "host-escape"`, the configured capture mode, literal argv with
no shell, `/devcontainer setup` still ungated by this policy, and `stop`/`remove` keeping both the
policy grant and the fresh per-action token. The design asserts these as invariants; the tests that
already cover them (audit shape, literal argv, lifecycle gates) must stay green unchanged.

### 2.4 Documentation is part of the change (AC-5)

- `README.md` (the requirement table, the "both files" paragraph, the example configuration) and
  `README.zh-CN.md` (its requirement table) — the two must not disagree.
- `docs/configuration.md` — the `hostExecution` section and the merge table row.
- `docs/security.md` and `SECURITY.md` — the posture statements.
- `CHANGELOG.md` — an explicit behaviour-change note: an installation that relied on deny-by-default
  must now write `false` (its own file or the project's).
- `docs/troubleshooting.md` — a "host-exec is denied by policy" entry: which files to check, the
  deny-wins rule, that `/reload` is needed after a configuration change, and that a project file must
  be trusted to be read at all.

## 3. Acceptance matrix

| AC | Implementation | Tests | Evidence |
|---|---|---|---|
| AC-1 | `src/config.ts` (`DEFAULTS`, `mergeHostExecution`) | `tests/unit/config.test.ts`: the truth table above, starting with both layers unset | `npm run test:unit` |
| AC-2 | `src/config.ts` | `tests/unit/config.test.ts`: deny-wins from either layer; the untouched defaults asserted alongside | `npm run test:unit` |
| AC-3 | none (invariants) | `tests/unit/tools.test.ts`, `tests/unit/commands.test.ts`, `tests/unit/audit.test.ts`, `tests/unit/docker-lifecycle.test.ts` unchanged and green | `npm run test:unit` |
| AC-4 | `src/tools.ts`, `src/commands.ts`, `extensions/index.ts` | `tests/unit/tools.test.ts` and `tests/unit/commands.test.ts`: the refusal text names configuration as the cause and both layers | `npm run test:unit` |
| AC-5 | `README.md`, `README.zh-CN.md`, `docs/configuration.md`, `docs/security.md`, `SECURITY.md`, `CHANGELOG.md`, `docs/troubleshooting.md` | docs reviewed for the new posture; no test | `git diff` inspection |
| AC-6 | `dist/`, `task.json` `acceptanceMatrix` | full suite | `npm run typecheck`, `npm run test:unit`, `node scripts/verify-package.mjs --unit-tests`, `git diff --exit-code -- dist`, `node scripts/smoke-pi-package.mjs --no-model`, `npm run install:local -- --check` |

## 4. Build order (TDD, four slices)

1. **Posture** — `DEFAULTS` + `mergeHostExecution` with the truth table as tests (RED first: the
   "both unset → allow" test fails against today's code).
2. **Remedies** — the three refusal sites, with tests asserting the new text and the new cause.
3. **Documentation** — README ×2, configuration, security, SECURITY, CHANGELOG (behaviour change),
   troubleshooting entry.
4. **Hygiene** — `acceptanceMatrix` into `task.json`, `npm run build` **and commit `dist/`** (the
   Phase 3 lesson: a stale `dist/` makes the seal supersede itself), full gate set.

## 5. Risks and notes

- **This is a security-posture change** and the review mode is `security`: the reviewer should check
  that the default flip cannot be widened by a project file beyond the shipped default, that the
  deny rules hold in both directions, and that nothing else in the effective config moved.
- **Existing installations**: anyone relying on deny-by-default now has host execution granted
  unless they write `false`. That is a deliberate, CHANGELOG-noted behaviour change, and the
  troubleshooting entry tells them exactly how to withhold it.
- **The audit trail is unchanged**, so the change is visible after the fact in the same place as
  every other host run — the flip does not create an unrecorded surface.
- **`hostExecution.allow` remains the only gate** for the two host surfaces; `/devcontainer setup`
  keeps its own confirmation and stays ungated (constraint 9 of the architecture review).
