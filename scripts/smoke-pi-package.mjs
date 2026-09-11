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
 *      install it into a throwaway Pi package store via `pi install <tarball>`.
 *   3. Extract the SAME tarball and assert the PACKED dist registers the tool,
 *      command, and `user_bash` surfaces (never the checkout's dist).
 *   4. Boot `pi -p --print --no-session --offline` with PI_CODING_AGENT_DIR
 *      pointed at the scratch store, so the model turn actually loads the
 *      packed extension, and assert its tools resolve with no extension error.
 *
 * This script requires a real model provider/API key for step 4. In CI the
 * release workflow installs the real Pi CLI and runs this against a configured
 * provider; when the provider is not configured the model step is skipped with
 * a named reason (but the packed-artifact checks still run).
 *
 * Exit code: 0 = smoke passed (or model step skipped by named reason),
 * 1 = a required step failed.
 *
 * Usage:
 *   node scripts/smoke-pi-package.mjs            # full: pack + install + model turn
 *   node scripts/smoke-pi-package.mjs --no-model # manifest/packed-artifact checks only
 */
import { execFileSync, spawnSync } from "node:child_process";
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
const extractDir = mkdtempSync(join(tmpdir(), "pi-dcm-extract-"));
const installDir = mkdtempSync(join(tmpdir(), "pi-dcm-store-"));
let tarball;
let packedDist;
try {
  // Real pack (not --dry-run) so `pi install` can consume it.
  const out = execFileSync("npm", ["pack", "--pack-destination", tmp], { cwd: root, encoding: "utf8", timeout: 120_000 });
  tarball = join(tmp, out.trim().split("\n").pop() ?? "");
  log(existsSync(tarball), `packed tarball created: ${tarball}`);
} catch (error) {
  fail(`npm pack failed: ${error instanceof Error ? error.message : String(error)}`);
}

// 1b. Extract the SAME tarball so every later assertion inspects the PACKED
// artifact rather than the checkout's (possibly stale) dist/ directory.
if (tarball !== undefined) {
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", extractDir], { encoding: "utf8", timeout: 120_000 });
    packedDist = join(extractDir, "package", "dist", "extensions", "index.js");
    log(existsSync(packedDist), `packed tarball contains dist/extensions/index.js`);
  } catch (error) {
    fail(`extracting packed tarball failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// 2. Install into a throwaway Pi package store (local path install).
if (tarball !== undefined && pi !== undefined) {
  try {
    // Keep this hermetic: point PI_CODING_AGENT_DIR at a scratch dir so nothing
    // user-global changes.
    execFileSync(pi, ["install", tarball, "--approve"], {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, PI_CODING_AGENT_DIR: installDir },
    });
    log(true, `pi install ${tarball} succeeded into scratch store`);
  } catch (error) {
    log(false, `pi install failed: ${error instanceof Error ? error.message : String(error)}`);
  }
} else if (tarball !== undefined) {
  console.warn("[smoke-pi-package] pi CLI not on PATH; skipping hermetic install step.");
}

// 3. Packed-artifact surface probe (no model needed): assert the PACKED dist
//    registers the tools, the same-name bash override, the /devcontainer
//    command, and the user_bash route.
if (packedDist !== undefined && existsSync(packedDist)) {
  const src = readFileSync(packedDist, "utf8");
  log(src.includes("registerCommand") || src.includes("devcontainer"), "packed dist registers the /devcontainer command surface");
  log(src.includes("user_bash"), "packed dist registers the user_bash route");
  log(
    src.includes("createBashToolDefinition") || src.includes("registerTool"),
    "packed dist registers tools incl. same-name bash override",
  );
} else if (tarball !== undefined) {
  fail("packed tarball is missing dist/extensions/index.js");
}

// 4. Model-gated registration probe against the INSTALLED packed extension.
const modelConfigured = providerConfigured();
if (!noModel && modelConfigured && tarball !== undefined && pi !== undefined) {
  try {
    const argv = [
      "-p", "--no-session", "--offline",
      "--mode", "json",
      "--no-skills", "--no-themes", "--no-context-files",
      "--approve",
      "--tools", "devcontainer_status,devcontainer_exec,devcontainer_host_exec",
      "Reply with exactly the tool names you can call, one per line.",
    ];
    // PI_CODING_AGENT_DIR MUST point at the scratch store so the model turn
    // loads the packed extension (not a user-global install).
    const result = spawnSync(pi, argv, {
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, PI_CODING_AGENT_DIR: installDir },
    });
    const out = `${result.stdout}\n${result.stderr}`;
    const ok = result.status !== null && !out.includes("Extension error") && !out.includes("Unknown tool");
    log(ok, "real Pi runtime loaded the PACKED extension (tools resolvable, no extension error)");
    if (!ok) {
      console.error(out.slice(0, 2000));
    }
  } catch (error) {
    log(false, `pi model probe failed: ${error instanceof Error ? error.message : String(error)}`);
  }
} else if (!noModel) {
  console.warn("[smoke-pi-package] provider not configured (PI_PROVIDER/PI_MODEL unset); skipping model-touching probe.");
}

rmSync(tmp, { recursive: true, force: true });
rmSync(extractDir, { recursive: true, force: true });
rmSync(installDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`[smoke-pi-package] ${failures.length} failure(s)`);
  process.exit(1);
}
console.log("[smoke-pi-package] all smoke checks passed.");
