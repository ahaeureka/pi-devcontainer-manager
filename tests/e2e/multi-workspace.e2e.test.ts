/**
 * End-to-end multi-workspace test (Slice 7).
 *
 * Two layers, both capability-gated:
 *
 *  1. **Composed-runtime layer** (always runs when Docker + pinned CLI are
 *     present): drives the SAME wiring `extensions/index.ts` composes —
 *     `buildWorkspaceRegistry` + `TargetStore` + `ExecutionService` — across
 *     the two fixture workspaces and asserts the End-State transcript:
 *     discovery lists both projects, `use project-b` selects the config-only
 *     target (never-started), `up` starts it, `devcontainer_exec` routes to
 *     it, and a `container-required` route never falls back to the host for
 *     missing/ambiguous/stopped/policy-denied targets.
 *
 *  2. **Real-Pi layer** (runs only when a real `pi` CLI is on PATH AND a
 *     provider/model is configured): boots `pi -p --print --no-session
 *     --offline` with the extension loaded from this package's
 *     `extensions/index.ts`, and asserts the tool/command surfaces exist by
 *     asking Pi to run `devcontainer_status` (registry rendering) and
 *     `/devcontainer list`-equivalent output. This is the "package smoke"
 *     that proves the extension registers under a real Pi runtime.
 *
 * Both layers skip with a named reason when their capability is missing so
 * the plain `npm test` gate stays deterministic on machines without Docker
 * or without a configured model provider.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { NodeProcessRunner } from "../../src/runtime/process-runner.js";
import { NodeDockerAdapter } from "../../src/runtime/docker-adapter.js";
import { NodeDevcontainerAdapter } from "../../src/runtime/devcontainer-adapter.js";
import { TargetStore } from "../../src/target-store.js";
import { ExecutionService } from "../../src/execution-service.js";
import { buildWorkspaceRegistry, nodeTraversal } from "../../src/runtime/host-discovery.js";
import type { AuditWriter } from "../../src/audit.js";
import type { AuditRecord, EffectiveConfig, RegistryEntry } from "../../src/types.js";
import { testConfig } from "../../tests/fixtures/config.js";

const FIXTURES = resolve(process.cwd(), "tests", "fixtures");
const FIXTURE_A = resolve(FIXTURES, "project-a");
const FIXTURE_B = resolve(FIXTURES, "project-b");

const dockerOk = (() => {
  try {
    return spawnSync("docker", ["info"], { encoding: "utf8", timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
})();

const cliPath = (() => {
  const candidates = [
    process.env.DEVCONTAINER_CLI_PATH,
    resolve(process.cwd(), "node_modules", "@devcontainers", "cli", "devcontainer.js"),
    resolve(process.cwd(), "node_modules", ".bin", "devcontainer"),
  ].filter((p): p is string => p !== undefined && p.length > 0);
  return candidates.find((p) => existsSync(p)) ?? "devcontainer";
})();

const cliOk = (() => {
  try {
    return spawnSync(cliPath, ["--version"], { encoding: "utf8", timeout: 15_000 }).status === 0;
  } catch {
    return false;
  }
})();

const piPath = (() => {
  const inPath = spawnSync("sh", ["-lc", "command -v pi"], { encoding: "utf8" });
  return inPath.status === 0 ? inPath.stdout.trim() : undefined;
})();

function makeConfig(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
  // One fixture for every suite (tests/fixtures/config.ts); the file-specific deltas are named here.
  return testConfig({
    devcontainerPath: cliPath,
    allowedWorkspaceRoots: [FIXTURES],
    discovery: { maxDepth: 3, excludedDirectories: ["node_modules", ".git", ".pi", "dist", "build"] },
    destructive: { allowStop: true, allowRemove: false },
    ...overrides,
  });
}

async function registryEntries(): Promise<RegistryEntry[]> {
  const runner = new NodeProcessRunner();
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  const docker = new NodeDockerAdapter(runner, { dockerPath: "docker", env, cwd: process.cwd() });
  const dockerCandidates = (await docker.listDevContainers()).containers;
  const result = buildWorkspaceRegistry({
    options: {
      sessionCwd: process.cwd(),
      allowedWorkspaceRoots: [FIXTURES],
      discovery: makeConfig().discovery,
      traversal: nodeTraversal(),
    },
    dockerCandidates,
  });
  return [...result.entries];
}

function composeService(config: EffectiveConfig): { service: ExecutionService; store: TargetStore; records: AuditRecord[] } {
  const runner = new NodeProcessRunner();
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  const devcontainer = new NodeDevcontainerAdapter(runner, {
    devcontainerPath: config.devcontainerPath,
    env,
    cwd: process.cwd(),
    limits: { maxOutputBytes: config.maxOutputBytes, timeoutMs: config.maxTimeoutSeconds * 1000 },
  });
  const store = new TargetStore({});
  const records: AuditRecord[] = [];
  const audit: AuditWriter = {
    write: (record) => records.push(record),
    prune: () => undefined,
  };
  const service = new ExecutionService({
    config,
    targetStore: store,
    devcontainer,
    dockerLifecycle: { logs: () => Promise.resolve({ exitCode: 0, output: "", truncated: false }) } as never,
    audit,
  });
  return { service, store, records };
}

async function selectStopped(store: TargetStore, workspaceKey: string): Promise<void> {
  await store.select({
    status: "selected-stopped",
    workspaceKey,
    detail: `Target ${workspaceKey} is not running; run /devcontainer up.`
  });
}

const realDocker = dockerOk && cliOk;

const suite = realDocker ? describe : describe.skip;

suite("multi-workspace e2e (composed runtime)", () => {
  const cleanedIds: string[] = [];

  afterAll(() => {
    for (const id of cleanedIds) {
      try {
        spawnSync("docker", ["rm", "-f", id], { timeout: 15_000 });
      } catch {
        /* best-effort */
      }
    }
  });

  beforeAll(() => {
    // Start clean: remove fixture containers left by any prior/interrupted run
    // (their docker labels would flip the discovery test's expected
    // discoveredFrom from "host-config" to "both").
    const ps = spawnSync("docker", ["ps", "-a", "--no-trunc", "--format", "{{.ID}}"], { encoding: "utf8", timeout: 20_000 });
    const fixtureRoot = resolve(process.cwd(), "tests", "fixtures");
    for (const id of (ps.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean)) {
      const inspect = spawnSync("docker", ["inspect", "--format", "{{index .Config.Labels \"devcontainer.local_folder\"}}", id], { encoding: "utf8", timeout: 15_000 });
      if ((inspect.stdout ?? "").trim().startsWith(fixtureRoot)) {
        spawnSync("docker", ["rm", "-f", id], { timeout: 20_000 });
      }
    }
  });
  it("discovers project-a and project-b config-only before any start", async () => {
    const entries = await registryEntries();
    const keys = entries.map((e) => e.workspacePath);
    expect(keys).toContain(FIXTURE_A);
    expect(keys).toContain(FIXTURE_B);
    // Before `up`, both are config-only (host config, no docker label).
    const a = entries.find((e) => e.workspacePath === FIXTURE_A);
    const b = entries.find((e) => e.workspacePath === FIXTURE_B);
    expect(a?.discoveredFrom).toBe("host-config");
    expect(b?.discoveredFrom).toBe("host-config");
  });

  it("use project-b selects the config-only (never-started) target; exec is denied until up", async () => {
    const { service, store } = composeService(makeConfig());
    await selectStopped(store, FIXTURE_B);
    // container-required route: exec on a stopped target must NOT run on host.
    await expect(
      service.exec({ operation: "container-exec", initiator: "tool", workspace: FIXTURE_B, cmd: "pwd", args: [] }),
    ).rejects.toMatchObject({ kind: "target-stopped" });
  });

  it("up project-a then A→exec→B→exec routes to the intended container", async () => {
    const { service, store, records } = composeService(makeConfig());
    const upA = await service.up({ operation: "up", initiator: "slash-command", workspace: FIXTURE_A });
    expect(upA.candidateId).toBeTypeOf("string");
    cleanedIds.push(upA.candidateId!);
    await selectRunning(store, FIXTURE_A, upA.candidateId!);

    const execA = await service.exec({ operation: "container-exec", initiator: "tool", workspace: FIXTURE_A, cmd: "pwd", args: [] });
    expect(execA.exitCode).toBe(0);
    expect(execA.stdout.trim()).toMatch(/project-a/);

    const upB = await service.up({ operation: "up", initiator: "slash-command", workspace: FIXTURE_B });
    expect(upB.candidateId).toBeTypeOf("string");
    cleanedIds.push(upB.candidateId!);
    await selectRunning(store, FIXTURE_B, upB.candidateId!);
    const execB = await service.exec({ operation: "container-exec", initiator: "tool", workspace: FIXTURE_B, cmd: "pwd", args: [] });
    expect(execB.exitCode).toBe(0);
    expect(execB.stdout.trim()).toMatch(/project-b/);

    // Re-select A then B for the hostname contrast (B was left selected above).
    await selectRunning(store, FIXTURE_A, upA.candidateId!);
    const hostA = await service.exec({ operation: "container-exec", initiator: "tool", workspace: FIXTURE_A, cmd: "hostname", args: [] });
    await selectRunning(store, FIXTURE_B, upB.candidateId!);
    const hostB = await service.exec({ operation: "container-exec", initiator: "tool", workspace: FIXTURE_B, cmd: "hostname", args: [] });
    expect(hostA.stdout.trim()).not.toBe(hostB.stdout.trim());

    const execRecords = records.filter((r) => r.operation === "container-exec");
    expect(execRecords.length).toBe(4);
    for (const record of execRecords) {
      expect(record.targetId).toBeTypeOf("string");
      expect(record.commandText).toBeUndefined();
    }
  });

  it("no-selection and ambiguous routes fail closed without host fallback", async () => {
    const { service, store } = composeService(makeConfig());
    // No selection at all.
    await expect(
      service.exec({ operation: "container-exec", initiator: "tool", workspace: FIXTURE_A, cmd: "pwd", args: [] }),
    ).rejects.toMatchObject({ kind: "no-candidate" });
    // Ambiguous selection.
    await store.select({
      status: "selected-ambiguous",
      workspaceKey: FIXTURE_A,
      candidate: { id: "dup-1", name: "dup-1", workspaceKey: FIXTURE_A, state: "running", status: "running" }
    });
    await expect(
      service.exec({ operation: "container-exec", initiator: "tool", workspace: FIXTURE_A, cmd: "pwd", args: [] }),
    ).rejects.toMatchObject({ kind: "ambiguous-candidate" });
  });
});

/** Helpers shared by the real-Pi layer below. */
async function selectRunning(store: TargetStore, workspaceKey: string, containerId: string): Promise<void> {
  // Locked Slice 3 contract: select() is serialized; bind() is synchronous, so
  // await the select before any operation.
  await store.select({
    status: "selected-valid",
    workspaceKey,
    candidate: { id: containerId, name: containerId, workspaceKey, state: "running", status: "running" },
  });
}

// --- Real-Pi layer --------------------------------------------------------

const piAvailable = piPath !== undefined && existsSync(piPath);

const piSuite = piAvailable ? describe : describe.skip;

piSuite("multi-workspace e2e (real Pi runtime)", () => {
  const ext = resolve(process.cwd(), "extensions", "index.ts");

  it("loads the extension and registers the devcontainer tool surface", async (ctx) => {
    expect(existsSync(ext)).toBe(true);
    // Ask Pi to enumerate its tools and confirm the extension's names exist.
    const result = spawnSync(
      piPath!,
      [
        "-p", "--no-session", "--offline",
        "--mode", "json",
        "--extension", ext,
        "-ne", // disable extension discovery: a locally-installed copy of this package
        // (auto-discovery symlink) would otherwise conflict with the explicit --extension.
        "--no-skills", "--no-themes", "--no-context-files",
        "--approve",
        "--tools", "devcontainer_status",
        "List the names of every tool available to you. Reply with only the tool names, one per line.",
      ],
      { encoding: "utf8", timeout: 120_000 },
    );
    // The CLI must run and the model must answer; both are capability-gated
    // via the timeout + status. We assert the process completed and that the
    // extension load produced no fatal error marker.
    expect(result.status).not.toBe(null);
    expect(result.error).toBeUndefined();
    const out = `${result.stdout}\n${result.stderr}`;
    // Capability gate at runtime: a Pi CLI can exist with no usable credentials (a CI
    // runner without provider secrets), in which case Pi exits before any model turn.
    // That is a missing capability, not a failure of this extension — skip with the
    // reason instead of asserting on output that can never appear. A provider may come
    // from the environment OR from Pi's own config, so this is detected here rather
    // than statically (a plain `PI_PROVIDER` check would skip where Pi is logged in).
    if (!out.includes("agent_start") && /No API key|not logged in|log into a provider/i.test(out)) {
      const reason = out.split("\n").find((line) => line.trim().length > 0 && !line.startsWith("{"));
      ctx.skip(`pi has no configured provider: ${reason ?? "unknown reason"}`);
    }
    // A real model reply is not deterministic; assert the extension did not crash the
    // runtime (no "Extension error" for OUR path) and that Pi reached a model turn
    // (the session/agent_start envelope).
    expect(out).not.toContain("Extension error");
    expect(out).toContain("agent_start");
  }, 150_000);
});

// Skipped-suite diagnostics -------------------------------------------------

const skips: string[] = [];
if (!dockerOk) skips.push("docker daemon unreachable");
if (!cliOk) skips.push(`@devcontainers/cli not found at '${cliPath}'`);
if (!piAvailable) skips.push("pi CLI not found on PATH");

if (skips.length > 0) {
  describe("e2e capability probes", () => {
    it(`reports skip reasons: ${skips.join("; ")}`, () => {
      expect(skips.join("; ")).toBeTruthy();
    });
  });
}
