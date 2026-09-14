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
 *   3. Extract the SAME tarball, LOAD the packed dist and drive its factory with a
 *      stub Pi API, asserting which surfaces it actually registers — in an engaged
      workspace and in a dormant one (never the checkout's dist).
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  // No Pi runtime on PATH is only fatal when a real smoke was actually possible: with
  // `--no-model`, or with no provider configured at all, there is nothing to smoke and
  // the packed-artifact checks below still run. (A `--provider`-less CI runner lands
  // here; `integration.yml` used to skip this step entirely via a secret gate, which
  // GitHub rejects because `secrets` is not allowed in `if:`.)
  if (noModel || !providerConfigured()) {
    console.warn(
      `[smoke-pi-package] pi CLI not on PATH; running the packed-artifact checks only${noModel ? " (--no-model)" : " (no provider configured)"}.`,
    );
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

/**
 * Load the packed extension and drive its factory with a stub Pi API, then run its
 * `session_start` handler so the per-session registration decision is observable. Only
 * `activation` is configured, so neither branch needs Docker or a real workspace:
 * `"always"` engages, `"never"` stays dormant.
 */
async function probeRegisteredSurfaces(distPath, activation) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-dcm-agent-"));
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(
    join(agentDir, "extensions", "pi-devcontainer-manager.json"),
    `${JSON.stringify({ version: 1, activation }, null, 2)}\n`,
  );
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const stub = { tools: [], commands: [], hooks: new Map(), entries: [] };
    const pi = {
      registerTool: (definition) => stub.tools.push(definition?.name ?? "(unnamed)"),
      registerCommand: (name) => stub.commands.push(name),
      on: (event, handler) => stub.hooks.set(event, handler),
      appendEntry: (customType, data) => stub.entries.push({ customType, data }),
    };
    const mod = await import(pathToFileURL(distPath).href);
    mod.default(pi);
    await stub.hooks.get("session_start")({}, {
      cwd: root,
      hasUI: false,
      isProjectTrusted: () => true,
      ui: { notify: () => {}, select: async () => undefined, confirm: async () => true },
      sessionManager: { getEntries: () => [] },
    });
    return stub;
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
}

// 3. Packed-artifact surface probe (no model needed). Loading the packed dist and
//    driving its factory is the only way to assert REGISTRATION: a text search over the
//    bundle also passes when the code registers nothing, which is what the previous
//    implementation did — and it could not have noticed the dormancy change either way.
if (packedDist !== undefined && existsSync(packedDist)) {
  // An installed package resolves Pi's API through the package store; the extracted
  // tree needs the checkout's modules on its resolution path.
  symlinkSync(join(root, "node_modules"), join(extractDir, "package", "node_modules"), "dir");
  const engaged = await probeRegisteredSurfaces(packedDist, "always");
  log(engaged.commands.includes("devcontainer"), "packed dist registers the /devcontainer command surface");
  log(engaged.hooks.has("user_bash"), "packed dist registers the user_bash route");
  const expected = ["bash", "devcontainer_exec", "devcontainer_status", "devcontainer_host_exec"];
  const missing = expected.filter((name) => !engaged.tools.includes(name));
  log(
    missing.length === 0,
    `packed dist registers the container tools and the same-name bash override (${engaged.tools.join(", ") || "none"})${missing.length > 0 ? ` — missing: ${missing.join(", ")}` : ""}`,
  );
  const dormant = await probeRegisteredSurfaces(packedDist, "never");
  log(dormant.commands.includes("devcontainer"), "a dormant session still answers /devcontainer (AC-4)");
  const leaked = dormant.tools.filter((name) => expected.includes(name));
  log(
    leaked.length === 0,
    `a dormant session registers no execution surface (AC-4)${leaked.length > 0 ? ` — leaked: ${leaked.join(", ")}` : ""}`,
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
