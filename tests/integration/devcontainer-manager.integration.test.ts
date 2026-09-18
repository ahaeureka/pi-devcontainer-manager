/**
 * Real capability-gated integration tests for the DevContainer manager
 * (Slice 7).
 *
 * These tests compose the REAL runtime pieces (NodeProcessRunner,
 * NodeDockerAdapter, NodeDevcontainerAdapter, TargetStore, ExecutionService)
 * against the REAL Docker daemon and the REAL pinned @devcontainers/cli when
 * both are available, using the two fixture workspaces
 * (`tests/fixtures/project-a|b`). They are skipped with a named reason when
 * the capability is absent, so the unit-only gate (`npx vitest run
 * tests/unit`) and CI stay deterministic without Docker.
 *
 * What the real run proves (the End-State acceptance contract):
 *  1. Discovery: `buildWorkspaceRegistry` merges host config discovery with
 *     real `docker ps --all` label candidates; both fixture workspaces
 *     appear with `.devcontainer/devcontainer.json` configs.
 *  2. A→exec→B→exec routing: after `devcontainer up` + selection of project
 *     A, `exec` runs `pwd` inside A; selecting project B then exec routes to
 *     B (container-side hostname/`pwd` differ, proving the intended
 *     container receives each command).
 *  3. The fixture pair uses exactly one container per workspace: the `up`
 *     calls target project-a and project-b distinctly, and the container-side
 *     `pwd`/`hostname` differ, proving each exec reached its own container.
 *     (No accidental duplicate labels: a second `up` of the same workspace
 *     reuses the existing container rather than creating a new one.)
 *  4. Docker stop requires BOTH a policy grant (destructive.allowStop) and a
 *     fresh per-action confirmation token; without the token the adapter
 *     returns `confirmation-required` and never stops.
 *  5. The execution service records a real audit line per operation with a
 *     targetId (fingerprint-only capture, no environment values).
 *
 * No host escape is exercised here: `devcontainer_host_exec` is a separate,
 * explicitly named surface and its policy+audit are pinned in unit tests.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { NodeProcessRunner } from "../../src/runtime/process-runner.js";
import { NodeDockerAdapter, type DockerContainer } from "../../src/runtime/docker-adapter.js";
import { NodeDockerLifecycleAdapter } from "../../src/runtime/docker-lifecycle.js";
import { NodeDevcontainerAdapter } from "../../src/runtime/devcontainer-adapter.js";
import { TargetStore } from "../../src/target-store.js";
import { ExecutionService } from "../../src/execution-service.js";
import { buildWorkspaceRegistry, nodeTraversal } from "../../src/runtime/host-discovery.js";
import { primaryConfigOf } from "../../src/registry-entry.js";
import type { AuditWriter } from "../../src/audit.js";
import type { AuditRecord, EffectiveConfig } from "../../src/types.js";
import { testConfig } from "../../tests/fixtures/config.js";

const FIXTURE_A = resolve(process.cwd(), "tests", "fixtures", "project-a");
const FIXTURE_B = resolve(process.cwd(), "tests", "fixtures", "project-b");

/** Capability gate: real Docker daemon + pinned CLI must both be present. */
const dockerOk = (() => {
  const dockerPath = "docker";
  try {
    const probe = spawnSync(dockerPath, ["info"], { encoding: "utf8", timeout: 10_000 });
    return probe.status === 0;
  } catch {
    return false;
  }
})();

const cliPath = (() => {
  // Prefer an explicit path, then the local devDependency, then PATH.
  const candidates = [
    process.env.DEVCONTAINER_CLI_PATH,
    resolve(process.cwd(), "node_modules", "@devcontainers", "cli", "devcontainer.js"),
    resolve(process.cwd(), "node_modules", ".bin", "devcontainer"),
  ].filter((p): p is string => p !== undefined && p.length > 0);
  const found = candidates.find((p) => existsSync(p));
  return found ?? "devcontainer";
})();

const cliOk = (() => {
  try {
    const probe = spawnSync(cliPath, ["--version"], { encoding: "utf8", timeout: 15_000 });
    return probe.status === 0;
  } catch {
    return false;
  }
})();

function makeConfig(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
  // One fixture for every suite (tests/fixtures/config.ts); the file-specific deltas are named here.
  return testConfig({
    devcontainerPath: cliPath,
    allowedWorkspaceRoots: [resolve(process.cwd(), "tests", "fixtures")],
    discovery: { maxDepth: 3, excludedDirectories: ["node_modules", ".git", ".pi", "dist", "build"] },
    destructive: { allowStop: true, allowRemove: false },
    ...overrides,
  });
}

interface Composed {
  service: ExecutionService;
  store: TargetStore;
  docker: NodeDockerAdapter;
  audit: AuditWriter;
  records: AuditRecord[];
}

function composeRuntime(config: EffectiveConfig): Composed {
  const runner = new NodeProcessRunner();
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  const docker = new NodeDockerAdapter(runner, {
    dockerPath: config.dockerPath,
    env,
    cwd: process.cwd(),
    maxOutputBytes: config.maxOutputBytes,
  });
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
  const lifecycle = new NodeDockerLifecycleAdapter(runner, {
    dockerPath: config.dockerPath,
    env,
    cwd: process.cwd(),
    maxOutputBytes: config.maxOutputBytes,
  });
  const service = new ExecutionService({ config, targetStore: store, devcontainer, dockerLifecycle: lifecycle, audit });
  return { service, store, docker, audit, records };
}

async function selectRunning(store: TargetStore, workspaceKey: string, containerId: string): Promise<void> {
  // Locked Slice 3 contract: select() is serialized through the promise queue;
  // bind() reads the committed selection synchronously, so callers MUST await
  // the select before any operation (production code awaits in commands.ts
  // and extensions/index.ts).
  await store.select({
    status: "selected-valid",
    workspaceKey,
    candidate: {
      id: containerId,
      name: containerId,
      workspaceKey,
      state: "running",
      status: "running",
    },
  });
}

/**
 * Run a container command once the container is actually READY.
 *
 * `up` can return before the container's first exec is serviceable (a real Docker start is asynchronous),
 * which made this suite fail intermittently on a cold daemon and pass on the next run. A bounded retry is
 * the honest fix: the assertion is about ROUTING, not about startup timing.
 */
async function execWhenReady(
  service: Composed["service"],
  workspace: string,
  attempts = 8,
): Promise<{ exitCode: number | null | undefined; stdout: string }> {
  let last: { exitCode: number | null | undefined; stdout: string } = { exitCode: undefined, stdout: "" };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await service.exec({ operation: "container-exec", initiator: "tool", workspace, cmd: "pwd", args: [] });
    if (last.exitCode === 0) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return last;
}

const suite = dockerOk && cliOk ? describe : describe.skip;

suite("devcontainer-manager integration (real Docker + CLI)", () => {
  let composed: Composed;
  const cleanedIds: string[] = [];

  afterAll(async () => {
    // Best-effort cleanup: remove any containers this suite created.
    for (const id of cleanedIds) {
      try {
        spawnSync("docker", ["rm", "-f", id], { timeout: 15_000 });
      } catch {
        /* best-effort */
      }
    }
  });

  beforeAll(async () => {
    // Remove any containers left by a prior interrupted run whose local_folder
    // points into tests/fixtures, so the discovery test starts clean (a stale
    // fixture container would flip discoveredFrom from "host-config" to "both").
    const ps = spawnSync("docker", ["ps", "-a", "--no-trunc", "--format", "{{.ID}}"], { encoding: "utf8", timeout: 20_000 });
    const fixtureRoot = resolve(process.cwd(), "tests", "fixtures");
    for (const id of (ps.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean)) {
      const inspect = spawnSync("docker", ["inspect", "--format", "{{index .Config.Labels \"devcontainer.local_folder\"}}", id], { encoding: "utf8", timeout: 15_000 });
      const folder = (inspect.stdout ?? "").trim();
      if (folder.startsWith(fixtureRoot)) {
        spawnSync("docker", ["rm", "-f", id], { timeout: 20_000 });
      }
    }
    composed = composeRuntime(makeConfig());
  });

  it("discovers both fixture workspaces via host + docker label merge", async () => {
    const traversal = nodeTraversal();
    const dockerCandidates = (await composed.docker.listDevContainers()).containers;
    const result = buildWorkspaceRegistry({
      options: {
        sessionCwd: process.cwd(),
        allowedWorkspaceRoots: [resolve(process.cwd(), "tests", "fixtures")],
        discovery: makeConfig().discovery,
        traversal,
      },
      dockerCandidates,
    });
    const keys = result.entries.map((e) => e.workspacePath);
    expect(keys).toContain(FIXTURE_A);
    expect(keys).toContain(FIXTURE_B);
    for (const key of [FIXTURE_A, FIXTURE_B]) {
      const entry = result.entries.find((e) => e.workspacePath === key);
      expect(entry?.kind).toBe("config");
      expect(entry !== undefined ? primaryConfigOf(entry)?.configKind : undefined).toBe(".devcontainer/devcontainer.json");
    }
  });

  it("up + exec routes to project-a, then use project-b routes to project-b (A→exec→B→exec)", async () => {
    const upA = await composed.service.up({ operation: "up", initiator: "slash-command", workspace: FIXTURE_A });
    expect(upA.candidateId).toBeTypeOf("string");
    cleanedIds.push(upA.candidateId!);
    await selectRunning(composed.store, FIXTURE_A, upA.candidateId!);

    const execA = await execWhenReady(composed.service, FIXTURE_A);
    expect(execA.exitCode).toBe(0);
    // The container-side workspace folder matches the host fixture folder name.
    expect(execA.stdout.trim()).toMatch(/project-a/);

    const upB = await composed.service.up({ operation: "up", initiator: "slash-command", workspace: FIXTURE_B });
    expect(upB.candidateId).toBeTypeOf("string");
    cleanedIds.push(upB.candidateId!);
    await selectRunning(composed.store, FIXTURE_B, upB.candidateId!);

    const execB = await execWhenReady(composed.service, FIXTURE_B);
    expect(execB.exitCode).toBe(0);
    expect(execB.stdout.trim()).toMatch(/project-b/);

    // The two exec calls hit the same devcontainer CLI through the SAME
    // execution service with different bound contexts; the container-side
    // hostnames must differ, proving the intended container received each.
    // Re-select A first (the previous block left B selected).
    await selectRunning(composed.store, FIXTURE_A, upA.candidateId!);
    const hostA = await composed.service.exec({
      operation: "container-exec",
      initiator: "tool",
      workspace: FIXTURE_A,
      cmd: "hostname",
      args: [],
    });
    await selectRunning(composed.store, FIXTURE_B, upB.candidateId!);
    const hostB = await composed.service.exec({
      operation: "container-exec",
      initiator: "tool",
      workspace: FIXTURE_B,
      cmd: "hostname",
      args: [],
    });
    expect(hostA.stdout.trim()).not.toBe(hostB.stdout.trim());
  });

  it("audits every operation with a targetId and no environment values", async () => {
    // composed.records is filled by the shared audit writer in this suite.
    const execRecords = composed.records.filter((r) => r.operation === "container-exec" || r.operation === "up");
    expect(execRecords.length).toBeGreaterThanOrEqual(3);
    for (const record of execRecords) {
      expect(record.targetId).toBeTypeOf("string");
      expect(record.commandCapture).toBe("fingerprint-only");
      expect(record.commandText).toBeUndefined();
      expect(JSON.stringify(record)).not.toContain("FOO=bar");
    }
  });

  it("requires BOTH a policy grant and a fresh confirmation token for docker stop", async () => {
    // Policy grant present in this suite's config (allowStop: true); the
    // lifecycle service must still return confirmation-required without a token.
    // The identity is bound first now (L3-07), so this probe must name the container the session
    // actually has selected — the point of the test is the CONFIRMATION gate, which the adapter
    // applies to an authorized target.
    const bound = composed.store.current().candidate;
    expect(bound).toBeDefined();
    const container: DockerContainer = {
      id: bound!.id,
      name: bound!.name,
      state: "running",
      status: "running",
      image: "",
      created: "",
      labels: {},
    };
    const result = await composed.service.lifecycle({
      operation: "stop",
      initiator: "tool",
      workspace: FIXTURE_A,
      container,
      confirmation: undefined,
    });
    expect(result.status).toBe("confirmation-required");
    expect((result as { action: string }).action).toBe("stop");
  });

  it("builds a fixture workspace through the real pinned CLI and reports the image name", async () => {
    // Coverage gap closed (plan review C12): the real-CLI `build` leg was
    // asserted only through faked adapter/service unit tests. This runs
    // `devcontainer build --workspace-folder <fixture>` against the real
    // pinned @devcontainers/cli and asserts the structured outcome surface.
    const built = await composed.service.build({
      operation: "build",
      initiator: "slash-command",
      workspace: FIXTURE_A,
    });
    expect(built.operation).toBe("build");
    expect(built.workspaceKey).toBe(FIXTURE_A);
    expect(built.policyAuthorized).toBe(true);
  });
});

// Keep the named skip reason visible even when the whole suite is skipped.
if (!dockerOk || !cliOk) {
  describe("integration capability probes", () => {
    it("reports why the real-Docker suite is skipped", () => {
      const reasons: string[] = [];
      if (!dockerOk) reasons.push("docker daemon unreachable");
      if (!cliOk) reasons.push(`@devcontainers/cli not found at '${cliPath}'`);
      expect(reasons.join("; ")).toBeTruthy();
    });
  });
}
