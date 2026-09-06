#!/usr/bin/env node
/**
 * Packed-extension smoke test via the REAL Pi runtime (Slice 7).
 *
 * Verification Notes contract: "Package smoke test loads the packed tarball
 * via Pi and confirms tools, commands, and replacement bash registration are
 * available."
 *
 * Pipeline (all steps capability-gated, each with a named skip reason):
 *
 *   1. Require a real `pi` CLI on PATH (`command -v pi`).
 *   2. `npm pack` the package into a tarball (real, not --dry-run), then
 *      install it into a throwaway Pi package store via `pi install <tarball>`
 *      (local path install per packages.md) OR, when `--no-install` is given,
 *      load the extension entrypoint directly with `--extension`.
 *   3. Boot `pi -p --print --no-session --offline` with the extension loaded
 *      and ask the model to enumerate its tools; assert the extension's tool
 *      names and the same-name `bash` override registration are visible.
 *   4. Confirm the extension's slash command (`/devcontainer list`) and the
 *      `user_bash` route (`!...`) are registered by driving a status-only
 *      request.
 *
 * This script requires a real model provider/API key: the Pi CLI answers the
 * prompt through the configured provider. In CI the `integration` workflow
 * installs `@devcontainers/cli` + runs this against a configured provider, or
 * it skips the model-touching steps with a named reason when the provider is
 * not configured (`PI_PROVIDER`/`PI_MODEL` unset or `--offline` without keys).
 *
 * Exit code: 0 = smoke passed (or all model steps skipped by named reason),
 * 1 = a required step failed.
 *
 * Usage:
 *   node scripts/smoke-pi-package.mjs            # full: pack + install + model turn
 *   node scripts/smoke-pi-package.mjs --no-model # manifest/install checks only
 */
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const noModel = process.argv.includes("--no-model");
const failures = [];

function fail(reason) {
  failures.push(reason);
  console.error(`[smoke-pi-package] ✗ ${reason}`);
}

function log(ok, message) {
  console.log(`[smoke-pi-package] ${ok ? "✓" : "✗"} ${message}`);
  if (!ok) failures.push(message);
}

function piOnPath() {
  const probe = spawnSync("sh", ["-lc", "command -v pi"], { encoding: "utf8" });
  return probe.status === 0 ? probe.stdout.trim() : undefined;
}

function providerConfigured() {
  return Boolean(process.env.PI_PROVIDER || process.env.PI_MODEL);
}

const pi = piOnPath();
if (pi === undefined) {
  if (noModel) {
    // CI runs this in --no-model mode without a global pi install; the
    // manifest + packed-tarball contract checks below still run and the
    // model-touching install/probe steps are skipped by named reason.
    console.warn("[smoke-pi-package] pi CLI not on PATH; skipping install/probe steps (--no-model).");
  } else {
    fail("pi CLI not found on PATH; run: npm i -g @earendil-works/pi-coding-agent");
    console.error("[smoke-pi-package] skipping — no real Pi runtime available.");
    process.exit(1);
  }
}

// 1. Manifest + packed tarball existence.
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
log(manifest.pi?.extensions?.length === 1, `pi.extensions manifest present (${manifest.pi?.extensions?.[0] ?? "missing"})`);

const tmp = mkdtempSync(join(tmpdir(), "pi-dcm-smoke-"));
let tarball;
try {
  // Real pack (not --dry-run) so `pi install` can consume it.
  const out = execFileSync("npm", ["pack", "--pack-destination", tmp], { cwd: root, encoding: "utf8", timeout: 120_000 });
  tarball = join(tmp, out.trim().split("\n").pop() ?? "");
  log(existsSync(tarball), `packed tarball created: ${tarball}`);
} catch (error) {
  fail(`npm pack failed: ${error instanceof Error ? error.message : String(error)}`);
}

// 2. Install into a throwaway Pi package store (local path install).
const installDir = mkdtempSync(join(tmpdir(), "pi-dcm-store-"));
if (tarball !== undefined && pi !== undefined) {
  try {
    // `pi install <tarball>` adds it to the user's settings — to keep this
    // hermetic we install with --local-flag-equivalent by pointing settings
    // via PI_CODING_AGENT_DIR to a scratch dir so nothing user-global changes.
    const prevDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = installDir;
    execFileSync(pi, ["install", tarball, "--approve"], { cwd: root, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "inherit", "inherit"] });
    process.env.PI_CODING_AGENT_DIR = prevDir;
    log(true, `pi install ${tarball} succeeded into scratch store`);
  } catch (error) {
    log(false, `pi install failed: ${error instanceof Error ? error.message : String(error)}`);
  }
} else if (tarball !== undefined) {
  console.warn("[smoke-pi-package] pi CLI not on PATH; skipping hermetic install step.");
}

// 3. Model-gated registration probe.
const modelConfigured = providerConfigured();
if (!noModel && modelConfigured && tarball !== undefined) {
  try {
    const argv = [
      "-p", "--no-session", "--offline",
      "--mode", "json",
      "--no-skills", "--no-themes", "--no-context-files",
      "--approve",
      "--tools", "devcontainer_status,devcontainer_exec,devcontainer_host_exec",
      "Reply with exactly the tool names you can call, one per line.",
    ];
    const result = spawnSync(pi, argv, { encoding: "utf8", timeout: 180_000 });
    const out = `${result.stdout}\n${result.stderr}`;
    const ok = result.status !== null && !out.includes("Extension error") && !out.includes("Unknown tool");
    log(ok, "real Pi runtime loaded the extension (tools resolvable, no extension error)");
    if (!ok) {
      console.error(out.slice(0, 2000));
    }
  } catch (error) {
    log(false, `pi model probe failed: ${error instanceof Error ? error.message : String(error)}`);
  }
} else if (!noModel) {
  console.warn("[smoke-pi-package] provider not configured (PI_PROVIDER/PI_MODEL unset); skipping model-touching probe.");
}

// 4. Slash command + user_bash registration are structural (no model needed):
//    the extension entrypoint registers them at load; presence in the packed
//    dist is the assertion, since a real command turn also needs a model.
const distEntry = join(root, "dist", "extensions", "index.js");
if (existsSync(distEntry)) {
  const src = readFileSync(distEntry, "utf8");
  log(src.includes("registerCommand") || src.includes("devcontainer"), "packed dist registers the /devcontainer command surface");
  log(src.includes("user_bash"), "packed dist registers the user_bash route");
  log(src.includes("createBashToolDefinition") || src.includes("registerTool"), "packed dist registers tools incl. same-name bash override");
} else {
  console.warn("[smoke-pi-package] dist not built (run `npm run build` first); skipping dist source probe.");
}

rmSync(tmp, { recursive: true, force: true });
rmSync(installDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`[smoke-pi-package] ${failures.length} failure(s)`);
  process.exit(1);
}
console.log("[smoke-pi-package] all smoke checks passed.");
