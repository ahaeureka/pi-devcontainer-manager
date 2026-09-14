import { describe, expect, it, vi } from "vitest";
import { ExecutionService } from "../../src/execution-service.js";
import { RuntimeError } from "../../src/errors.js";
import type { AuditRecord, AuditWriter, EffectiveConfig } from "../../src/types.js";
import type { ExecutionContext, TargetStore } from "../../src/target-store.js";
import type { DevcontainerAdapter, ExecResult } from "../../src/runtime/devcontainer-adapter.js";
import type { DockerLifecycleAdapter } from "../../src/runtime/docker-lifecycle.js";

/**
 * AC-8: routing from outside the selected target.
 *
 * Once a target is explicitly selected, the operator must be able to drive it from a
 * plain repository (that is the whole point of `activation: "workspace"` + explicit
 * `use`). The invariant therefore becomes:
 *
 *   the EXECUTED workspace is always the bound target workspace, and the audit record
 *   additionally carries the request's cwd when it differs
 *
 * A request whose cwd is itself another DevContainer project stays refused: acting on
 * a different repository than the one the caller is standing in is exactly the
 * mis-route this guard exists for.
 */

const TARGET = "/ws/project-a";
const PLAIN_REPO = "/repo-plain";
const OTHER_PROJECT = "/ws/project-b";

function makeConfig(): EffectiveConfig {
  return {
    version: 1,
    dockerPath: "docker",
    devcontainerPath: "devcontainer",
    routeMode: "container-required",
    activation: "workspace",
    allowedWorkspaceRoots: ["/ws", PLAIN_REPO],
    environmentAllowlist: [],
    maxTimeoutSeconds: 900,
    maxOutputBytes: 50 * 1024,
    discovery: { maxDepth: 3, excludedDirectories: ["node_modules", ".git"] },
    audit: { enabled: true, retentionDays: 90, commandCapture: "fingerprint-only" },
    destructive: { allowStop: false, allowRemove: false },
    hostExecution: { allow: false },
  };
}

interface Harness {
  readonly service: ExecutionService;
  readonly records: AuditRecord[];
  readonly execCalls: string[];
}

/**
 * @param projectWorkspaces workspaces the injected probe reports as DevContainer
 * projects (the real probe is a filesystem check; unit tests inject it).
 */
function makeHarness(projectWorkspaces: readonly string[]): Harness {
  const context: ExecutionContext = {
    workspaceKey: TARGET,
    candidateId: "abc123",
    candidateName: "project-a",
    boundAt: "2026-08-31T09:47:28.000Z",
  };
  const store = {
    bind: () => context,
    snapshot: () => ({ status: "selected-valid", workspaceKey: TARGET, candidateId: "abc123", detail: undefined }),
  } as unknown as TargetStore;

  const records: AuditRecord[] = [];
  const audit: AuditWriter = {
    write: vi.fn((record: AuditRecord) => {
      records.push(record);
    }),
    prune: vi.fn(),
  };

  const execCalls: string[] = [];
  const devcontainer = {
    up: vi.fn(),
    build: vi.fn(),
    exec: vi.fn(async (workspace: string): Promise<ExecResult> => {
      execCalls.push(workspace);
      return { exitCode: 0, signal: null, durationMs: 1, truncated: false, stdout: "ok", stderr: "" };
    }),
  } as unknown as DevcontainerAdapter;

  const service = new ExecutionService({
    config: makeConfig(),
    targetStore: store,
    devcontainer,
    dockerLifecycle: { logs: vi.fn(), stop: vi.fn(), remove: vi.fn() } as unknown as DockerLifecycleAdapter,
    audit,
    workspaceHasConfig: (workspace: string) => projectWorkspaces.includes(workspace),
  });

  return { service, records, execCalls };
}

function execRequest(workspace: string) {
  return {
    operation: "container-exec" as const,
    initiator: "tool" as const,
    workspace,
    cmd: "pwd",
    args: [] as string[],
  };
}

describe("routing from outside the selected target (AC-8)", () => {
  it("executes on the target from a non-DevContainer cwd and records the requested cwd", async () => {
    const harness = makeHarness([TARGET, OTHER_PROJECT]);
    await harness.service.exec(execRequest(PLAIN_REPO));
    // Executed workspace is the bound target, never the request's cwd.
    expect(harness.execCalls).toEqual([TARGET]);
    const record = harness.records.at(-1);
    expect(record?.workspace).toBe(TARGET);
    expect(record?.requestedCwd).toBe(PLAIN_REPO);
    expect(record?.policyAuthorized).toBe(true);
  });

  it("still refuses a cwd that is itself a DevContainer project", async () => {
    const harness = makeHarness([TARGET, OTHER_PROJECT]);
    await expect(harness.service.exec(execRequest(OTHER_PROJECT))).rejects.toBeInstanceOf(RuntimeError);
    expect(harness.execCalls).toEqual([]);
    const record = harness.records.at(-1);
    // Policy AUTHORIZED this operation — the refusal is a routing mismatch, not a policy
    // denial, so the record marks it with the error summary instead.
    expect(record?.errorSummary).toBe("request-workspace-mismatch");
  });

  it("keeps today's record shape when the request is the target itself", async () => {
    const harness = makeHarness([TARGET]);
    await harness.service.exec(execRequest(TARGET));
    expect(harness.execCalls).toEqual([TARGET]);
    const record = harness.records.at(-1);
    expect(record?.requestedCwd).toBeUndefined();
  });

  it("keeps sub-directory requests unflagged (they are inside the target)", async () => {
    const harness = makeHarness([TARGET]);
    await harness.service.exec(execRequest(`${TARGET}/src`));
    expect(harness.execCalls).toEqual([TARGET]);
    // A sub-directory is inside the target, so the operation is allowed; the caller's
    // cwd is still recorded because it differs from the executed workspace (before this
    // change the record claimed the SUBDIRECTORY was the workspace, which was wrong).
    expect(harness.records.at(-1)?.requestedCwd).toBe(`${TARGET}/src`);
  });
});
