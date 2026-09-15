# P2 scope and tooling note

## Seal-time owned paths for this task

`kata-cli open` recorded: `src, extensions, tests, dist, CHANGELOG.md, docs, openspec`.

This branch also carries one unrelated tooling addition (`scripts/install-local.mjs`, the
`install:local` npm script in `package.json`, and the matching `docs/installation.md` section),
owner-approved while the task was still in `intake`. The sealed revision must therefore be
declared with the two extra paths:

```bash
kata-cli build --change arch-review-p2-failure-observability --seal \
  --owned-path docs --owned-path openspec --owned-path scripts --owned-path package.json
```

`resolveSealOwnedPaths` unions the flags with the stored `ownedPaths`, so nothing is lost.

Why this matters here: a handoff packet's `permissions.allowedWrites` is a role constant that
ignores the task's `ownedPaths` (the lesson the archived `arch-review-p1-foundation` task
recorded), and CI's `git diff --exit-code -- dist` plus the seal's revision scope both check
ownership — an undeclared path lands outside the sealed revision.

## What the local-install script is

`scripts/install-local.mjs` automates the documented local-checkout install
(`docs/installation.md` → "From a local checkout"): preflight (manifest entry point,
`engines.node`, `pi` CLI, active settings file), `npm run build` with a committed-`dist`
freshness report, `pi install <checkout>`, then assert that `pi list` resolves the path and
that no duplicate settings entry exists.

Flag surface: `--check` (verify only), `--no-build`, `--no-register`, `--local`
(project-local install), `--verify-runtime` (boots a real `pi` through `tests/e2e`),
`--dry-run`, `PI_BIN=<path>`.

Two implementation facts worth keeping:

- `pi` resolution must skip this checkout's `node_modules/.bin`: under `npm run`, PATH puts the
  dev-dependency `pi` (0.84.4 here) first, and installing with it instead of the user's own Pi
  (0.85.1) is the wrong actor writing `settings.json`. The script scans PATH in order, skips
  `node_modules/.bin`, honours `PI_BIN`, and warns when only the local shim is available.
- The script never edits `settings.json` directly — it delegates to `pi install` — and exits
  nonzero with a named reason when the checkout would not load.
