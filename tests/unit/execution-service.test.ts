/**
 * Unit tests for the shared execution service (Slice 5).
 *
 * The service is the single funnel for `container-exec`, `routed-bash`,
 * `up`/`build`, and lifecycle operations. Fakes stand in for the adapters,
 * target store, and audit writer; assertions pin that every operation:
 * - freezes an {@link OperationPolicySnapshot} BEFORE target resolution;
 * - binds a frozen {@link ExecutionContext} (selection switch cannot
 *   redirect an in-flight operation);
 * - filters environment through `buildChildEnvironment` + the allowlist;
 * - carries nonzero target exits in the result (never throws);
 * - emits one audit record without environment values.
 */
import { describe, expect, it, vi } from "vitest";
import { ExecutionService } from "../../src/execution-service.js";
import { RuntimeError } from "../../src/errors.js";
import type { AuditWriter } from "../../src/audit.js";
import type { AuditRecord, EffectiveConfig } from "../../src/types.js";
import type { ExecutionContext, TargetStore } from "../../src/target-store.js";
import type { DevcontainerAdapter, ExecResult, UpResult, BuildResult } from "../../src/runtime/devcontainer-adapter.js";
import type { DockerLifecycleAdapter, LifecycleConfirmation, LifecycleResult } from "../../src/runtime/docker-lifecycle.js";
import type { DockerContainer } from "../../src/runtime/docker-adapter.js";

function makeConfig(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
  return {
    version: 1,
    dockerPath: "docker",
    devcontainerPath: "devcontainer",
    routeMode: "container-required",
    allowedWorkspaceRoots: ["/ws"],
    environmentAllowlist: ["FOO"],
    maxTimeoutSeconds: 900,
    maxOutputBytes: 50 * 1024,
    discovery: { maxDepth: 3, excludedDirectories: ["node_modules", ".git"] },
    audit: { enabled: true, retentionDays: 90, commandCapture: "fingerprint-only" },
    destructive: { allowStop: false, allowRemove: false },
    hostExecution: { allow: false },
    ...overrides,
  };
}

function fakeTargetStore(snapshotStatus: string = "selected-valid"): { store: TargetStore; bound: ExecutionContext } {
  const ctx: ExecutionContext = {
    workspaceKey: "/ws/project-a",
    candidateId: "abc123",
    candidateName: "project-a",
    boundAt: "2026-08-31T09:47:28.000Z",
  };
  return {
    store: {
      bind: () => ctx,
      snapshot: () => ({ status: snapshotStatus, workspaceKey: undefined, candidateId: undefined, detail: undefined }),
    } as unknown as TargetStore,
    bound: ctx,
  };
}

/** A store whose bind() refuses the way the real one does for a non-selectable status. */
function refusingTargetStore(snapshotStatus: string, error: RuntimeError): TargetStore {
  return {
    bind: () => {
      throw error;
    },
    snapshot: () => ({ status: snapshotStatus, workspaceKey: undefined, candidateId: undefined, detail: undefined }),
  } as unknown as TargetStore;
}

interface ExecCall {
  workspace: string;
  containerId: string;
  cmd: string;
  args: readonly string[];
  options: Record<string, unknown>;
}

function fakeDevcontainer(results: ExecResult[]): { adapter: DevcontainerAdapter; calls: ExecCall[]; up: ReturnType<typeof vi.fn>; build: ReturnType<typeof vi.fn> } {
  const calls: ExecCall[] = [];
  const up = vi.fn(async (): Promise<UpResult> => {
    return { containerId: "up123", remoteUser: "vscode" };
  });
  const build = vi.fn(async (): Promise<BuildResult> => {
    return { imageName: "img:tag" };
  });
  const adapter: DevcontainerAdapter = {
    up,
    build,
    exec: vi.fn(async (workspace, containerId, cmd, args, options = {}) => {
      calls.push({ workspace, containerId, cmd, args, options });
      const next = results.shift();
      if (next === undefined) throw new Error("unexpected exec call");
      return next;
    }),
  };
  return { adapter, calls, up, build };
}

function fakeDockerLifecycle(): { adapter: DockerLifecycleAdapter; calls: Array<{ action: "stop" | "remove"; container: DockerContainer }> } {
  const calls: Array<{ action: "stop" | "remove"; container: DockerContainer }> = [];
  const adapter: DockerLifecycleAdapter = {
    logs: vi.fn(),
    stop: vi.fn(async (container: DockerContainer, confirmation?: LifecycleConfirmation): Promise<LifecycleResult> => {
      calls.push({ action: "stop", container });
      return confirmation === undefined
        ? { status: "confirmation-required" as const, action: "stop" as const, containerId: container.id, containerName: container.name, instruction: "confirm" }
        : { status: "done" as const, action: "stop" as const, containerId: container.id };
    }),
    remove: vi.fn(async (container: DockerContainer, confirmation?: LifecycleConfirmation): Promise<LifecycleResult> => {
      calls.push({ action: "remove", container });
      return confirmation === undefined
        ? { status: "confirmation-required" as const, action: "remove" as const, containerId: container.id, containerName: container.name, instruction: "confirm" }
        : { status: "done" as const, action: "remove" as const, containerId: container.id };
    }),
  };
  return { adapter, calls };
}

function makeService(
  parts: { devcontainer?: DevcontainerAdapter; dockerLifecycle?: DockerLifecycleAdapter; config?: EffectiveConfig; audit?: AuditWriter; autoSelect?: (workspace: string) => Promise<void>; snapshotStatus?: string; targetStore?: TargetStore } = {},
) {
  const devcontainer = parts.devcontainer ?? fakeDevcontainer([]).adapter;
  const dockerLifecycle = parts.dockerLifecycle ?? fakeDockerLifecycle().adapter;
  const audit: AuditWriter = {
    write: vi.fn(),
    prune: vi.fn(),
  };
  const store =
    parts.targetStore !== undefined
      ? { store: parts.targetStore, bound: fakeTargetStore().bound }
      : fakeTargetStore(parts.snapshotStatus ?? "selected-valid");
  const service = new ExecutionService({
    config: parts.config ?? makeConfig(),
    targetStore: store.store,
    devcontainer,
    dockerLifecycle,
    audit: parts.audit ?? audit,
    ...(parts.autoSelect !== undefined ? { autoSelect: parts.autoSelect } : {}),
  });
  return { service, audit: parts.audit ?? audit, store };
}

const container: DockerContainer = {
  id: "abc123",
  name: "project-a",
  state: "running",
  status: "Up 5 minutes",
  image: "devcontainer:latest",
  created: "2026-08-31T09:00:00.000Z",
  labels: {},
};

const execOk: ExecResult = { exitCode: 0, signal: null, durationMs: 12, truncated: false, stdout: "ok", stderr: "" };

describe("ExecutionService.exec", () => {
  it("freezes policy, binds the target, filters env, and returns the outcome with output", async () => {
    const { adapter, calls } = fakeDevcontainer([{ ...execOk, stdout: "line1\nline2" }]);
    const { service, audit } = makeService({ devcontainer: adapter });
    const outcome = await service.exec({
      operation: "container-exec",
      initiator: "tool",
      workspace: "/ws/project-a",
      cmd: "ls",
      args: ["-la"],
      environment: { FOO: "bar" },
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.candidateId).toBe("abc123");
    expect(outcome.policyAuthorized).toBe(true);
    expect(outcome.stdout).toBe("line1\nline2");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.containerId).toBe("abc123");
    expect(calls[0]!.options.remoteEnv).toEqual({ FOO: "bar" });
    // Audit: one record, fingerprint only, no environment values.
    const record = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0]![0] as AuditRecord;
    expect(record.version).toBe(1);
    expect(record.operation).toBe("container-exec");
    expect(record.policyAuthorized).toBe(true);
    expect(record.commandFingerprint).toBeTypeOf("string");
    expect(record.commandText).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain("FOO=bar");
  });

  it("throws policy-denied before touching the adapter when environment is denied", async () => {
    const { adapter, calls } = fakeDevcontainer([execOk]);
    const { service } = makeService({ devcontainer: adapter });
    await expect(
      service.exec({
        operation: "container-exec",
        initiator: "tool",
        workspace: "/ws/project-a",
        cmd: "ls",
        args: [],
        environment: { SECRET_KEY: "leak" },
      }),
    ).rejects.toMatchObject({ kind: "policy-denied" });
    expect(calls).toHaveLength(0);
  });

  it("throws policy-denied for stop/remove when destructive grants are off", async () => {
    const { adapter, calls } = fakeDockerLifecycle();
    const { service } = makeService({ dockerLifecycle: adapter });
    await expect(
      service.lifecycle({ operation: "stop", initiator: "tool", workspace: "/ws/project-a", container, confirmation: undefined }),
    ).rejects.toMatchObject({ kind: "policy-denied" });
    expect(calls).toHaveLength(0);
  });

  it("audits a DENIED attempt before throwing", async () => {
    const { adapter } = fakeDockerLifecycle();
    const { service, audit } = makeService({ dockerLifecycle: adapter });
    await expect(
      service.lifecycle({ operation: "stop", initiator: "tool", workspace: "/ws/project-a", container, confirmation: undefined }),
    ).rejects.toMatchObject({ kind: "policy-denied" });
    const record = (audit.write as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as AuditRecord;
    expect(record.policyAuthorized).toBe(false);
    expect(record.policyDenialReason).toBe("destructive-operation-disabled");
  });

  it("pins the exact field set of a refusal record (characterization)", async () => {
    const { adapter } = fakeDockerLifecycle();
    const { service, audit } = makeService({ dockerLifecycle: adapter });
    await expect(
      service.lifecycle({ operation: "stop", initiator: "tool", workspace: "/ws/project-a", container, confirmation: undefined }),
    ).rejects.toMatchObject({ kind: "policy-denied" });

    const record = (audit.write as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as AuditRecord;

    // A refusal is written by the same builder as every other record, so its
    // field set must not drift: exactly these keys, no command identity (a
    // refusal carries no argv), no duration or exit accounting.
    expect(record).toEqual({
      version: 1,
      at: expect.any(String),
      operation: "stop",
      initiator: "tool",
      workspace: "/ws/project-a",
      policyAuthorized: false,
      policyDenialReason: "destructive-operation-disabled",
      outputTruncated: false,
      commandCapture: "fingerprint-only",
    });
  });

  it("executes from a cwd outside the target and records which cwd asked (AC-8)", async () => {
    const { adapter, calls } = fakeDevcontainer([execOk]);
    const { service, audit } = makeService({ devcontainer: adapter });
    // A request from a workspace that is not itself a DevContainer project is the
    // explicit-selection workflow: stand in a plain repository and drive the target.
    // (The refusal of a cwd that IS another project is pinned in
    // execution-routing.test.ts, where the probe is injectable.)
    await service.exec({ operation: "container-exec", initiator: "tool", workspace: "/ws/other", cmd: "ls", args: [] });
    expect(calls[0]!.workspace).toBe("/ws/project-a");
    const record = (audit.write as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as AuditRecord;
    expect(record.workspace).toBe("/ws/project-a");
    expect(record.requestedCwd).toBe("/ws/other");
  });

  it("sends the BOUND target workspace to the CLI, not the caller workspace", async () => {
    const { adapter, calls } = fakeDevcontainer([execOk]);
    const { service } = makeService({ devcontainer: adapter });
    await service.exec({ operation: "container-exec", initiator: "tool", workspace: "/ws/project-a/sub", cmd: "ls", args: [] });
    expect(calls[0]!.workspace).toBe("/ws/project-a");
  });

  it("audits an adapter failure for up instead of losing it", async () => {
    const throwing: DevcontainerAdapter = {
      up: vi.fn(async () => {
        throw new RuntimeError({ kind: "daemon-unavailable", message: "no daemon" });
      }),
      build: vi.fn(),
      exec: vi.fn(),
    };
    const { service, audit } = makeService({ devcontainer: throwing });
    await expect(
      service.up({ operation: "up", initiator: "slash-command", workspace: "/ws/project-a" }),
    ).rejects.toMatchObject({ kind: "daemon-unavailable" });
    const record = (audit.write as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as AuditRecord;
    expect(record.operation).toBe("up");
    expect(record.errorSummary).toBe("no daemon");
  });

  it("carries a nonzero container-side exit in the outcome (never throws)", async () => {
    const { adapter } = fakeDevcontainer([{ ...execOk, exitCode: 42 }]);
    const { service } = makeService({ devcontainer: adapter });
    const outcome = await service.exec({
      operation: "container-exec",
      initiator: "tool",
      workspace: "/ws/project-a",
      cmd: "exit",
      args: ["42"],
    });
    expect(outcome.exitCode).toBe(42);
  });

  it("records an error summary and rethrows adapter failures", async () => {
    const throwing: DevcontainerAdapter = {
      up: vi.fn(),
      build: vi.fn(),
      exec: vi.fn(async () => {
        throw new RuntimeError({ kind: "target-stopped", message: "gone" });
      }),
    };
    const { service, audit } = makeService({ devcontainer: throwing });
    await expect(
      service.exec({ operation: "container-exec", initiator: "tool", workspace: "/ws/project-a", cmd: "ls", args: [] }),
    ).rejects.toMatchObject({ kind: "target-stopped" });
    const record = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0]![0] as AuditRecord;
    expect(record.errorSummary).toBe("gone");
    expect(record.exitCode).toBeNull();
  });

  it("audits a pre-spawn target refusal and rethrows the typed error", async () => {
    const refusal = new RuntimeError({
      kind: "no-candidate",
      message: "No DevContainer target is selected.",
      remedy: "Run /devcontainer list then /devcontainer use <workspace>.",
    });
    const { service, audit } = makeService({ targetStore: refusingTargetStore("none", refusal) });

    await expect(
      service.exec({ operation: "container-exec", initiator: "tool", workspace: "/ws/project-a", cmd: "ls", args: [] }),
    ).rejects.toMatchObject({ kind: "no-candidate" });

    const record = (audit.write as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as AuditRecord;
    expect(record).toMatchObject({
      operation: "container-exec",
      initiator: "tool",
      workspace: "/ws/project-a",
      policyAuthorized: true,
      outputTruncated: false,
    });
    expect(record.errorSummary).toContain("No DevContainer target is selected.");
  });

  it("records the transient refresh refusal with its own kind", async () => {
    const refusal = new RuntimeError({
      kind: "target-refreshing",
      message: "Target state is refreshing; retry the operation.",
    });
    const { service, audit } = makeService({ targetStore: refusingTargetStore("refreshing", refusal) });

    await expect(
      service.exec({ operation: "container-exec", initiator: "tool", workspace: "/ws/project-a", cmd: "ls", args: [] }),
    ).rejects.toMatchObject({ kind: "target-refreshing" });

    const record = (audit.write as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as AuditRecord;
    expect(record.errorSummary).toContain("refreshing");
  });

  it("omits --remote-env entirely when no environment is requested", async () => {
    const { adapter, calls } = fakeDevcontainer([execOk]);
    const { service } = makeService({ devcontainer: adapter });
    await service.exec({ operation: "container-exec", initiator: "tool", workspace: "/ws/project-a", cmd: "ls", args: [] });
    expect(calls[0]!.options.remoteEnv).toBeUndefined();
  });

  it("invokes autoSelect before bind when no target is selected", async () => {
    const { adapter, calls } = fakeDevcontainer([execOk]);
    const autoSelect = vi.fn(async () => undefined);
    const { service } = makeService({ devcontainer: adapter, autoSelect, snapshotStatus: "none" });
    await service.exec({ operation: "container-exec", initiator: "tool", workspace: "/ws/project-a", cmd: "ls", args: [] });
    expect(autoSelect).toHaveBeenCalledWith("/ws/project-a");
  });

  it("skips autoSelect when a target is already selected", async () => {
    const { adapter, calls } = fakeDevcontainer([execOk]);
    const autoSelect = vi.fn(async () => undefined);
    const { service } = makeService({ devcontainer: adapter, autoSelect, snapshotStatus: "selected-valid" });
    await service.exec({ operation: "container-exec", initiator: "tool", workspace: "/ws/project-a", cmd: "ls", args: [] });
    expect(autoSelect).not.toHaveBeenCalled();
  });

  it("does not auto-select for up/build (explicit workspace operations)", async () => {
    const autoSelect = vi.fn(async () => undefined);
    const { adapter, up } = fakeDevcontainer([execOk]);
    const { service } = makeService({ devcontainer: adapter, autoSelect, snapshotStatus: "none" });
    await service.up({ operation: "up", initiator: "slash-command", workspace: "/ws/project-a" });
    expect(autoSelect).not.toHaveBeenCalled();
  });
});

describe("ExecutionService.up/build", () => {
  it("up freezes policy, calls the adapter, audits targetId, and returns container identity", async () => {
    const { adapter, up } = fakeDevcontainer([execOk]);
    const { service, audit } = makeService({ devcontainer: adapter });
    const outcome = await service.up({ operation: "up", initiator: "slash-command", workspace: "/ws/project-a" });
    expect(up).toHaveBeenCalledTimes(1);
    expect(outcome.candidateId).toBe("up123");
    expect(outcome.remoteUser).toBe("vscode");
    expect(outcome.policyAuthorized).toBe(true);
    const record = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0]![0] as AuditRecord;
    expect(record.operation).toBe("up");
    expect(record.targetId).toBe("up123");
    expect(record.workspace).toBe("/ws/project-a");
  });

  it("build passes optional flags and audits the image name", async () => {
    const { adapter, build } = fakeDevcontainer([execOk]);
    const { service, audit } = makeService({ devcontainer: adapter });
    const outcome = await service.build({ operation: "build", initiator: "tool", workspace: "/ws/project-a", noCache: true, imageName: "img:tag" });
    expect(build).toHaveBeenCalledWith(
      "/ws/project-a",
      expect.objectContaining({ noCache: true, imageName: "img:tag" }),
    );
    expect(outcome.imageName).toBe("img:tag");
    const record = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0]![0] as AuditRecord;
    expect(record.operation).toBe("build");
  });
});

describe("ExecutionService.lifecycle", () => {
  it("requires confirmation when none is provided (noninteractive cannot bypass)", async () => {
    const { adapter, calls } = fakeDockerLifecycle();
    const { service } = makeService({ dockerLifecycle: adapter, config: makeConfig({ destructive: { allowStop: true, allowRemove: false } }) });
    const result = await service.lifecycle({
      operation: "stop",
      initiator: "tool",
      workspace: "/ws/project-a",
      container,
      confirmation: undefined,
    });
    expect(result.status).toBe("confirmation-required");
    expect(calls).toHaveLength(1);
  });

  it("performs a confirmed stop and audits it", async () => {
    const { adapter, calls } = fakeDockerLifecycle();
    const { service, audit } = makeService({
      dockerLifecycle: adapter,
      config: makeConfig({ destructive: { allowStop: true, allowRemove: false } }),
    });
    const confirmation: LifecycleConfirmation = { token: "fresh", action: "stop", containerId: "abc123" };
    const result = await service.lifecycle({ operation: "stop", initiator: "tool", workspace: "/ws/project-a", container, confirmation });
    expect(result.status).toBe("done");
    expect(calls).toHaveLength(1);
    const record = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0]![0] as AuditRecord;
    expect(record.operation).toBe("stop");
    expect(record.targetId).toBe("abc123");
    expect(record.exitCode).toBe(0);
  });
});

describe("bound container identity (L3-07)", () => {
  // `makeService`'s fake store binds container `abc123` for workspace `/ws/project-a`; anything else
  // names a container the service did not authorize.
  const recordList = (audit: AuditWriter): AuditRecord[] =>
    (audit.write as unknown as { mock: { calls: [AuditRecord][] } }).mock.calls.map(([record]) => record);

  /** The fake lifecycle answers `logs` with a bounded empty read, like the real adapter does. */
  const lifecycle = (): DockerLifecycleAdapter => ({ ...fakeDockerLifecycle().adapter, logs: vi.fn(async () => ({ exitCode: 0, output: "log-line", truncated: false })) });

  it("refuses a logs request for a container that is not the bound target", async () => {
    const { service, audit } = makeService({ dockerLifecycle: lifecycle() });

    await expect(
      service.logs({ initiator: "slash-command", workspace: "/ws/project-a", containerId: "sibling" }),
    ).rejects.toMatchObject({ kind: "policy-denied" });

    // Refused before Docker runs, and the trail never records the caller's identity as the target.
    const records = recordList(audit);
    expect(records.every((record) => record.targetId !== "sibling")).toBe(true);
    expect(records.some((record) => record.errorSummary?.includes("bound target"))).toBe(true);
  });

  it("acts on the bound container and records the bound identity", async () => {
    const { service, audit } = makeService({ dockerLifecycle: lifecycle() });

    await service.logs({ initiator: "slash-command", workspace: "/ws/project-a", containerId: "abc123" });

    const records = recordList(audit);
    expect(records.at(-1)?.targetId).toBe("abc123");
    expect(records.at(-1)?.operation).toBe("logs");
  });

  it("refuses a stop request for a container that is not the bound target, before the adapter runs", async () => {
    const { service, audit } = makeService({ dockerLifecycle: lifecycle() });
    const sibling: DockerContainer = { ...container, id: "sibling", name: "sibling" };

    await expect(
      service.lifecycle({
        operation: "stop",
        initiator: "slash-command",
        workspace: "/ws/project-a",
        container: sibling,
        confirmation: { token: "t", action: "stop", containerId: "sibling" },
      }),
    ).rejects.toMatchObject({ kind: "policy-denied" });

    expect(recordList(audit).some((record) => record.targetId === "sibling")).toBe(false);
  });

  it("still runs the lifecycle operation for the bound container", async () => {
    const { service } = makeService({
      dockerLifecycle: lifecycle(),
      config: makeConfig({ destructive: { allowStop: true, allowRemove: false } }),
    });

    const result = await service.lifecycle({
      operation: "stop",
      initiator: "slash-command",
      workspace: "/ws/project-a",
      container,
      confirmation: { token: "t", action: "stop", containerId: "abc123" },
    });

    expect(result.status).toBe("done");
  });
});
