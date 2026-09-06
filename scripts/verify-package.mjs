#!/usr/bin/env node
/**
 * Whole-package quality gate (Slice 7).
 *
 * Runs the full release pipeline in a fresh child process per step so a
 * failure in any step is isolated and reported with its exit code:
 *
 *   1. `npm run typecheck`   — strict NodeNext compile (noEmit).
 *   2. `npm test`            — full vitest run (unit + integration + e2e +
 *                              package-smoke; capability-gated suites skip).
 *   3. `npm run build`       — emit `dist/` (declaration + source maps).
 *   4. `npm pack --dry-run`  — tarball allowlist + manifest contract.
 *   5. Engines probe         — verify the running Node satisfies
 *                              `engines.node` (>=22.19.0), the clean-Node
 *                              contract from Verification Notes.
 *   6. CLI pin probe         — assert the resolved `@devcontainers/cli`
 *                              version is EXACTLY the pinned 0.88.0 (never a
 *                              range), so integration behavior is stable.
 *
 * Exits nonzero on the first failing step with a named gate label, so CI can
 * `continue-on-error` selectively and humans see which gate failed.
 *
 * Usage:
 *   node scripts/verify-package.mjs [--skip-build]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Expected exact pinned Dev Containers CLI version (Verification Notes). */
const PINNED_DEVCONTAINER_CLI = "0.88.0";

function run(label, argv, options = {}) {
  try {
    execFileSync(argv[0], argv.slice(1), {
      cwd: root,
      stdio: ["ignore", "inherit", "inherit"],
      timeout: 600_000,
      ...options,
    });
    console.log(`[verify-package] ✓ ${label}`);
  } catch (error) {
    const code = error?.status ?? 1;
    console.error(`[verify-package] ✗ ${label} (exit ${code})`);
    // Review fix (plan review R8): exit immediately with the child's code
    // rather than throwing — the throw made the "all gates passed" tail
    // unreachable and could mask later diagnostics on first failure.
    process.exit(code);
  }
}

function probeNodeEngine() {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const engines = manifest.engines ?? {};
  const range = engines.node;
  if (typeof range !== "string" || range.length === 0) {
    console.error("[verify-package] ✗ engines.node is missing from package.json");
    process.exit(1);
  }
  const semver = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v);
    return m ? m.slice(1).map(Number) : null;
  };
  const current = semver(process.version);
  if (current === null) {
    console.error(`[verify-package] ✗ cannot parse Node version ${process.version}`);
    process.exit(1);
  }
  const required = semver(range.replace(">=", "").replace(" ", ""));
  if (required !== null && (current[0] < required[0] || (current[0] === required[0] && current[1] < required[1]))) {
    console.error(`[verify-package] ✗ Node ${process.version} does not satisfy engines.node ${range}`);
    process.exit(1);
  }
  console.log(`[verify-package] ✓ engines.node ${range} satisfied by ${process.version}`);
}

function probeCliPin() {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const devDeps = manifest.devDependencies ?? {};
  const pinned = devPinned(devDeps["@devcontainers/cli"]);
  if (!pinned) {
    console.error("[verify-package] ✗ @devcontainers/cli is not pinned to an exact version in devDependencies");
    process.exit(1);
  }
  if (pinned !== PINNED_DEVCONTAINER_CLI) {
    console.error(`[verify-package] ✗ @devcontainers/cli pinned to ${pinned}; expected exactly ${PINNED_DEVCONTAINER_CLI}`);
    process.exit(1);
  }
  // Resolve the installed copy (devDependency in node_modules) and read its
  // actual version from its package.json, guarding against a hoisted range.
  const candidates = [
    resolve(root, "node_modules", "@devcontainers", "cli", "package.json"),
    resolve(root, "node_modules", ".pnpm", `@devcontainers+cli@${pinned}`, "node_modules", "@devcontainers", "cli", "package.json"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (found === undefined) {
    // Not installed locally (integration gated) — the manifest pin is the gate.
    console.log(`[verify-package] ✓ @devcontainers/cli manifest pin is ${pinned} (not installed locally; integration gated)`);
    return;
  }
  const installed = JSON.parse(readFileSync(found, "utf8"));
  const actual = installed.version;
  if (actual !== pinned) {
    console.error(`[verify-package] ✗ installed @devcontainers/cli is ${actual}; expected ${pinned}`);
    process.exit(1);
  }
  console.log(`[verify-package] ✓ @devcontainers/cli installed at exactly ${pinned}`);
}

function devPinned(spec) {
  if (typeof spec !== "string") return undefined;
  return /^\d+\.\d+\.\d+$/.test(spec) ? spec : undefined;
}

const skipBuild = process.argv.includes("--skip-build");
// In the deterministic CI gate, run only the unit suites: on a runner with a
// Docker daemon + installed @devcontainers/cli the capability gates pass and
// the real-Docker integration/e2e suites would run here AND in the dedicated
// integration workflow, racing the same fixtures. The real-runtime suites
// belong to the integration/release workflows only.
const unitTests = process.argv.includes("--unit-tests");

console.log("[verify-package] package root:", root);
probeNodeEngine();
probeCliPin();
run("typecheck (tsc --noEmit)", ["npm", "run", "typecheck"]);
if (unitTests) {
  run("test:unit (vitest --run tests/unit)", ["npm", "run", "test:unit"]);
} else {
  run("test (vitest run)", ["npm", "test"]);
}
if (!skipBuild) {
  run("build (tsc -p tsconfig.json)", ["npm", "run", "build"]);
  run("pack:check (npm pack --dry-run)", ["npm", "run", "pack:check"]);
} else {
  console.log("[verify-package] --skip-build: build + pack:check skipped");
}
console.log("[verify-package] all gates passed.");
