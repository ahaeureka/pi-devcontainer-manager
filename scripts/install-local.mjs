#!/usr/bin/env node
/**
 * Install (or refresh) THIS checkout into the local Pi as a local-path extension.
 *
 * The documented local-checkout flow (docs/installation.md) has three steps that are easy to
 * get subtly wrong: rebuild the compiled entry point, register the checkout with Pi, and
 * remember that Pi only picks the new code up after `/reload`. This script performs all three
 * and asserts the outcome, so "update the local extension" is one repeatable command.
 *
 * Pi documents local paths as added to settings WITHOUT copying, so the checkout being edited
 * IS the package Pi loads: there is nothing to fetch and `pi update` is not needed. What
 * matters is that `dist/` (the manifest entry point, committed to this repository) is current
 * and that the path is registered.
 *
 * What it checks before changing anything:
 *   1. `package.json` declares `pi.extensions`, and the declared entry file exists.
 *   2. The running Node satisfies `engines.node`.
 *   3. A `pi` CLI is on PATH, and it names the settings file it will write
 *      (`PI_CODING_AGENT_DIR` is respected, so the active config directory is reported).
 *   4. Whether this checkout is already registered.
 *
 * What it does (each step skippable):
 *   - `npm run build`, then reports whether the committed `dist/` matches the fresh build
 *     (CI fails on a stale commit, so a mismatch is a warning worth acting on).
 *   - `pi install <checkout>` (idempotent for a local path).
 *   - Verifies `pi list` resolves the checkout, then prints the `/reload` reminder.
 *
 * Usage:
 *   node scripts/install-local.mjs [options]
 *
 * Options:
 *   --check          verify only: no build, no settings change
 *   --no-build       skip the `npm run build` step
 *   --no-register    skip `pi install` (print the command instead)
 *   --local          register project-locally (`pi install -l`, writes .pi/settings.json)
 *   --verify-runtime also run the real-Pi e2e layer (`tests/e2e`), ~15 s and needs Docker
 *   --dry-run        print the commands that would run, without running them
 *   -h, --help       this text
 *
 * Exits 0 when the checkout is loadable by the local Pi, nonzero with a named reason
 * otherwise.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const log = (message) => console.log(`[install-local] ${message}`);
const ok = (message) => console.log(`[install-local] ✓ ${message}`);
const warn = (message) => console.warn(`[install-local] ! ${message}`);
const fail = (message) => {
  console.error(`[install-local] ✗ ${message}`);
  process.exit(1);
};

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
if (flag("-h") || flag("--help")) {
  console.log(
    [
      "Usage: node scripts/install-local.mjs [options]",
      "",
      "  --check           verify only: no build, no settings change",
      "  --no-build        skip `npm run build`",
      "  --no-register     skip `pi install` (print the command instead)",
      "  --local           register project-locally (`pi install -l`)",
      "  --verify-runtime  also run the real-Pi e2e layer (tests/e2e)",
      "  --dry-run         print the commands that would run",
      "  -h, --help        this text",
    ].join("\n"),
  );
  process.exit(0);
}
const checkOnly = flag("--check");
const skipBuild = checkOnly || flag("--no-build");
const skipRegister = checkOnly || flag("--no-register");
const projectLocal = flag("--local");
const dryRun = flag("--dry-run");

/** Run a command, capturing output; never throws. */
function run(command, args, options = {}) {
  if (dryRun) {
    log(`would run: ${[command, ...args].join(" ")}`);
    return { status: 0, stdout: "", stderr: "", skipped: true };
  }
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 600_000,
    stdio: options.inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

log(`checkout: ${root}`);

// ---------------------------------------------------------------------------
// 1. Manifest contract
// ---------------------------------------------------------------------------
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const entries = manifest?.pi?.extensions;
if (!Array.isArray(entries) || entries.length === 0) {
  fail("package.json does not declare pi.extensions — Pi would have nothing to load");
}
const entryPoint = resolve(root, entries[0]);
if (!existsSync(entryPoint)) {
  fail(`declared entry point is missing: ${entries[0]} (run \`npm run build\`)`);
}
ok(`${manifest.name}@${manifest.version} declares ${entries[0]} and the file exists`);

// ---------------------------------------------------------------------------
// 2. Engine
// ---------------------------------------------------------------------------
const range = manifest?.engines?.node;
const required = typeof range === "string" ? /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(range.trim()) : null;
if (required) {
  const [major, minor, patch] = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
  const [rMajor, rMinor, rPatch] = required.slice(1).map((part) => Number.parseInt(part, 10));
  const suffices =
    major > rMajor || (major === rMajor && (minor > rMinor || (minor === rMinor && patch >= rPatch)));
  if (!suffices) fail(`node ${process.versions.node} does not satisfy engines.node ${range}`);
  ok(`node ${process.versions.node} satisfies ${range}`);
} else if (range) {
  warn(`engines.node is '${range}'; this script only checks '>=X.Y.Z' ranges — skipping`);
}

// ---------------------------------------------------------------------------
// 3. Pi CLI and the active config directory
// ---------------------------------------------------------------------------
/**
 * Find the user's Pi CLI.
 *
 * `npm run` puts this checkout's `node_modules/.bin` first on PATH, which contains the dev
 * dependency `pi` used by the test suites — NOT the Pi the user has installed and configured.
 * Prefer the first `pi` outside `node_modules`, fall back to the local shim only with a
 * warning, and allow an explicit override via PI_BIN.
 */
function resolvePiPath() {
  const override = process.env.PI_BIN;
  if (override) return existsSync(override) ? override : undefined;
  const isExecutable = (candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const onPath = (process.env.PATH ?? "")
    .split(":")
    .filter((dir) => dir.length > 0)
    .map((dir) => resolve(dir, "pi"));
  const localBin = `${resolve(root, "node_modules")}/`;
  const found = onPath.filter((candidate) => !candidate.startsWith(localBin)).find(isExecutable);
  return found ?? onPath.find(isExecutable);
}

const piPath = resolvePiPath();
if (piPath === undefined) {
  fail("no `pi` CLI on PATH — install Pi first, then re-run this script");
}
if (piPath.startsWith(`${resolve(root, "node_modules")}/`)) {
  warn("only a checkout-local `pi` shim was found on PATH; set PI_BIN to your installed pi if that is not the intended target");
}
const piVersion = run(piPath, ["--version"]).stdout.trim();
ok(`pi CLI: ${piPath}${piVersion ? ` (${piVersion})` : ""}`);

const agentDir = process.env.PI_CODING_AGENT_DIR ?? resolve(process.env.HOME ?? "~", ".pi", "agent");
const settingsFile = projectLocal ? resolve(root, ".pi", "settings.json") : resolve(agentDir, "settings.json");
log(`settings file: ${settingsFile}${process.env.PI_CODING_AGENT_DIR ? " (PI_CODING_AGENT_DIR)" : ""}`);
if (!projectLocal && !existsSync(settingsFile)) {
  warn(`settings file does not exist yet; \`pi install\` will create it`);
}

// ---------------------------------------------------------------------------
// 4. Registration state
// ---------------------------------------------------------------------------
const listInstalled = () => run(piPath, ["list"], { timeoutMs: 60_000 }).stdout;
const registered = (stdout) => stdout.split("\n").some((line) => line.trim() === root);
const before = dryRun ? "" : listInstalled();
if (!dryRun && registered(before)) {
  ok("already registered in Pi settings (re-registering is idempotent)");
} else if (!dryRun) {
  log("not registered yet — this run will register it");
}

// ---------------------------------------------------------------------------
// 5. Build the entry point
// ---------------------------------------------------------------------------
if (skipBuild) {
  log("skipping build (--check/--no-build)");
} else {
  const build = run("npm", ["run", "build"], { inherit: true });
  if (build.status !== 0) fail(`\`npm run build\` failed (exit ${build.status})`);
  ok("rebuilt dist/");
  if (!dryRun) {
    // CI fails when the committed dist differs from a fresh build, so surface it here.
    const diff = run("git", ["diff", "--exit-code", "--", "dist"]);
    if (diff.status === 0) {
      ok("committed dist matches the fresh build");
    } else {
      warn("committed dist differs from the fresh build — commit dist/ or CI's freshness check fails");
      for (const line of (diff.stdout + diff.stderr).split("\n").slice(0, 6)) {
        if (line.trim()) warn(`  ${line}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Register with Pi
// ---------------------------------------------------------------------------
if (skipRegister) {
  log(`skipping registration; run: pi install ${root}${projectLocal ? " -l" : ""}`);
} else {
  const args = ["install", root];
  if (projectLocal) args.push("-l");
  const install = run(piPath, args, { inherit: true, timeoutMs: 300_000 });
  if (install.status !== 0) fail(`\`pi install ${root}\` failed (exit ${install.status})`);
  ok(`registered ${root}`);
}

// ---------------------------------------------------------------------------
// 7. Assert Pi resolves the checkout
// ---------------------------------------------------------------------------
if (dryRun) {
  log("dry run: nothing was changed");
} else {
  const after = listInstalled();
  if (!registered(after)) {
    fail(`\`pi list\` does not show ${root} after install`);
  }
  ok(`pi list resolves ${root}`);
  if (before !== "" && registered(before)) {
    const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    const hits = (settings.packages ?? []).filter((pkg) => resolve(agentDir, pkg) === root || pkg === root);
    if (hits.length > 1) warn(`${hits.length} duplicate entries for this checkout: ${hits.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// 8. Optional runtime proof
// ---------------------------------------------------------------------------
if (flag("--verify-runtime")) {
  log("running the real-Pi e2e layer (tests/e2e)…");
  const verify = run(process.execPath, ["node_modules/vitest/vitest.mjs", "--run", "tests/e2e"], {
    inherit: true,
    timeoutMs: 900_000,
  });
  if (verify.status !== 0) fail(`tests/e2e failed (exit ${verify.status})`);
  ok("real-Pi e2e layer passed (the extension registers under a real `pi` runtime)");
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------
log("");
log("Next: inside Pi run  /reload  (or restart pi) so the session composes the new code.");
log(`Remove later with:  pi remove ${root}`);
log(`Entry point Pi loads: ${entries[0]}`);
process.exit(0);
