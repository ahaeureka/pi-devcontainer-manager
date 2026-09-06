/**
 * Unit tests for the namespaced command UX (`/devcontainer ...`, Slice 6).
 *
 * The commands are the operator-facing surface: list/status (registry +
 * selection), use (selection persisted), up/build (execution service),
 * stop/remove (policy-gated, per-action confirmation token, never bypassed),
 * logs, and host-exec (explicit, policy-gated escape hatch).
 */
import { describe, expect, it, vi } from "vitest";
import { createCommandHandlers, type CommandContextLike, type CommandServices } from "../../src/commands.js";
import { RuntimeError } from "../../src/errors.js";
import type { EffectiveConfig } from "../../src/types.js";
import type { RegistryEntry } from "../../src/types.js";
import type { ExecutionService, LifecycleServiceResult, UpBuildOutcome } from "../../src/execution-service.js";
import type { TargetStore, TargetStoreSnapshot } from "../../src/target-store.js";
import type { DockerContainer } from "../../src/runtime/docker-adapter.js";
import type { SelectionRecord } from "../../src/selection-state.js";

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

const entry: RegistryEntry = {
  workspacePath: "/ws/project-a",
  configPath: "/ws/project-a/.devcontainer/devcontainer.json",
  configKind: ".devcontainer/devcontainer.json",
  discoveredFrom: "both",
  containerId: "abc123456789",
  containerState: "running",
};

const container: DockerContainer = {
  id: "abc123456789",
  name: "abc123456789",
  state: "running",
  status: "selected-valid",
  image: "",
  created: "",
  labels: {},
};

function makeServices(overrides: Partial<CommandServices> = {}): CommandServices & { handlers: ReturnType<typeof createCommandHandlers> } {
  const snapshot: TargetStoreSnapshot = {
    status: "selected-valid",
    workspaceKey: "/ws/project-a",
    candidateId: "abc123456789",
    detail: undefined,
  };
  const base: CommandServices = {
    config: makeConfig(),
    targetStore: {
      snapshot: vi.fn(() => snapshot),
      select: vi.fn(async (target) => {
        Object.assign(snapshot, {
          status: target.status,
          workspaceKey: target.workspaceKey,
          candidateId: target.candidate?.id,

        });
      }),
      bind: vi.fn(),
      clear: vi.fn(),
      beginRefresh: vi.fn(),
      endRefresh: vi.fn(),
    } as unknown as TargetStore,
    execution: {
      exec: vi.fn(),
      up: vi.fn(async (): Promise<UpBuildOutcome> => ({ operation: "up", workspaceKey: "/ws/project-a", candidateId: "up123", remoteUser: "vscode", policyAuthorized: true })),
      build: vi.fn(async (): Promise<UpBuildOutcome> => ({ operation: "build", workspaceKey: "/ws/project-a", imageName: "img:tag", policyAuthorized: true })),
      lifecycle: vi.fn(async (): Promise<LifecycleServiceResult> => ({ status: "done", action: "stop", containerId: "abc123456789" })),
    } as unknown as ExecutionService,
    registry: vi.fn(async () => ({ entries: [entry], diagnostics: [] })),
    refreshRegistry: vi.fn(async () => ({ entries: [entry], diagnostics: [] })),
    logs: vi.fn(async () => ({ exitCode: 0, output: "log-line", truncated: false })),
    hostRunner: {
      run: vi.fn(async () => ({ exitCode: 0, signal: null, stdout: "host-out", stderr: "", truncated: false })),
    },
    generateToken: vi.fn(() => "fresh-token"),
    ...overrides,
  };
  const handlers = createCommandHandlers(base);
  return { handlers, ...base };
}

function makeCtx(overrides: Partial<CommandContextLike> = {}): CommandContextLike & { ui: { select: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> }; persisted: SelectionRecord[] } {
  const persisted: SelectionRecord[] = [];
  const ui = {
    select: vi.fn(async () => undefined),
    confirm: vi.fn(async () => true),
    notify: vi.fn(),
  };
  const ctx: CommandContextLike = {
    cwd: "/ws/project-a",
    ui,
    persistSelection: (record) => persisted.push(record),
    restoreSelection: () => undefined,
    ...overrides,
  };
  return { ...ctx, ui, persisted };
}

describe("/devcontainer list + status", () => {
  it("renders the selection and registry rows", async () => {
    const { handlers } = makeServices();
    const ctx = makeCtx();
    const result = await handlers["list"]!("", ctx);
    expect(result.text).toContain("**DevContainer target:** selected-valid");
    expect(result.text).toContain("**Registry (1):**");
    expect(result.text).toContain("/ws/project-a");
  });

  it("status reuses the same rendering", async () => {
    const { handlers } = makeServices();
    const ctx = makeCtx();
    const result = await handlers["status"]!("", ctx);
    expect(result.text).toContain("**DevContainer target:**");
  });
});

describe("/devcontainer use", () => {
  it("selects a single match and persists the selection record", async () => {
    const { handlers, targetStore } = makeServices();
    const ctx = makeCtx();
    const result = await handlers["use"]!("project-a", ctx);
    expect(result.text).toContain("Selected `/ws/project-a`");
    expect(targetStore.select).toHaveBeenCalledWith(
      expect.objectContaining({ status: "selected-valid", workspaceKey: "/ws/project-a" }),
    );
    expect(ctx.persisted).toHaveLength(1);
    expect(ctx.persisted[0]!.workspaceKey).toBe("/ws/project-a");
  });

  it("persists config-only selection intent (End-State use project-b flow)", async () => {
    const { containerId: _cid, containerState: _cstate, ...configOnly } = entry;
    const configOnlyEntry: RegistryEntry = {
      ...configOnly,
      workspacePath: "/ws/project-b",
      configPath: "/ws/project-b/.devcontainer/devcontainer.json",
    };
    const { handlers, targetStore } = makeServices({
      registry: vi.fn(async () => ({ entries: [configOnlyEntry], diagnostics: [] })),
    });
    const ctx = makeCtx();
    await handlers["use"]!("project-b", ctx);
    expect(targetStore.select).toHaveBeenCalledWith(
      expect.objectContaining({ status: "selected-stopped", workspaceKey: "/ws/project-b" }),
    );
    expect(ctx.persisted).toHaveLength(1);
    expect(ctx.persisted[0]!.workspaceKey).toBe("/ws/project-b");
    expect(ctx.persisted[0]!.candidateId).toBeUndefined();
  });

  it("returns no-candidate when nothing matches", async () => {
    const { handlers, targetStore } = makeServices();
    const ctx = makeCtx();
    const result = await handlers["use"]!("missing", ctx);
    expect(result.text).toContain("[no-candidate]");
    expect(targetStore.select).not.toHaveBeenCalled();
  });

  it("asks via ui.select when multiple candidates match", async () => {
    const entryB: RegistryEntry = {
      ...entry,
      workspacePath: "/ws/project-b",
      configPath: "/ws/project-b/.devcontainer/devcontainer.json",
    };
    const { handlers } = makeServices({ registry: vi.fn(async () => ({ entries: [entry, entryB], diagnostics: [] })) });
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValueOnce("/ws/project-b [running]");
    const result = await handlers["use"]!("", ctx);
    expect(ctx.ui.select).toHaveBeenCalled();
    expect(result.text).toContain("Selected `/ws/project-b`");
  });

  it("reports cancellation when ui.select returns undefined", async () => {
    const entryB: RegistryEntry = {
      ...entry,
      workspacePath: "/ws/project-b",
      configPath: "/ws/project-b/.devcontainer/devcontainer.json",
    };
    const { handlers } = makeServices({ registry: vi.fn(async () => ({ entries: [entry, entryB], diagnostics: [] })) });
    const ctx = makeCtx();
    const result = await handlers["use"]!("", ctx);
    expect(result.text).toBe("Selection cancelled.");
  });
});

describe("/devcontainer up + build", () => {
  it("up targets the cwd by default and renders the container identity", async () => {
    const { handlers, execution } = makeServices();
    const ctx = makeCtx();
    const result = await handlers["up"]!("", ctx);
    expect(execution.up).toHaveBeenCalledWith(expect.objectContaining({ operation: "up", initiator: "slash-command" }));
    expect(result.text).toContain("Up: /ws/project-a → `up123`");
    expect(result.text).toContain("remote user: vscode");
  });

  it("build renders the image name", async () => {
    const { handlers, execution } = makeServices();
    const ctx = makeCtx();
    const result = await handlers["build"]!("", ctx);
    expect(execution.build).toHaveBeenCalledWith(expect.objectContaining({ operation: "build" }));
    expect(result.text).toContain("Build: /ws/project-a → img:tag");
  });

  it("describes typed failures from the execution service", async () => {
    const execution = {
      up: vi.fn(async () => {
        throw new RuntimeError({ kind: "no-candidate", message: "no matching config" });
      }),
    } as unknown as ExecutionService;
    const { handlers } = makeServices({ execution });
    const ctx = makeCtx();
    const result = await handlers["up"]!("", ctx);
    expect(result.text).toContain("[no-candidate]");
  });
});

describe("/devcontainer stop + remove", () => {
  it("confirms, generates a fresh token, and runs the lifecycle operation", async () => {
    const { handlers, execution } = makeServices({
      config: makeConfig({ destructive: { allowStop: true, allowRemove: false } }),
    });
    const ctx = makeCtx();
    const result = await handlers["stop"]!("", ctx);
    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      "Confirm stop",
      expect.stringContaining("abc123456789"),
      undefined,
    );
    expect(execution.lifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "stop",
        container,
        confirmation: { token: "fresh-token", action: "stop", containerId: "abc123456789" },
      }),
    );
    expect(result.text).toContain("stop done");
  });

  it("does nothing when the operator declines confirmation", async () => {
    const { handlers, execution } = makeServices({
      config: makeConfig({ destructive: { allowStop: true, allowRemove: false } }),
    });
    const ctx = makeCtx();
    ctx.ui.confirm.mockResolvedValueOnce(false);
    const result = await handlers["stop"]!("", ctx);
    expect(result.text).toBe("stop cancelled.");
    expect(execution.lifecycle).not.toHaveBeenCalled();
  });

  it("renders confirmation-required when the adapter demands it", async () => {
    const execution = {
      lifecycle: vi.fn(async (): Promise<LifecycleServiceResult> => ({
        status: "confirmation-required",
        action: "remove",
        containerId: "abc123456789",
        containerName: "project-a",
        instruction: "confirm again",
      })),
    } as unknown as ExecutionService;
    const { handlers } = makeServices({
      execution,
      config: makeConfig({ destructive: { allowStop: true, allowRemove: true } }),
    });
    const ctx = makeCtx();
    const result = await handlers["remove"]!("", ctx);
    expect(result.text).toContain("[confirmation-required]");
  });
});

describe("/devcontainer logs", () => {
  it("resolves the current selection and returns bounded log output", async () => {
    const { handlers, logs } = makeServices();
    const ctx = makeCtx();
    const result = await handlers["logs"]!("", ctx);
    expect(logs).toHaveBeenCalledWith(container, { tail: 100 });
    expect(result.text).toBe("log-line");
  });

  it("parses --tail", async () => {
    const { handlers, logs } = makeServices();
    const ctx = makeCtx();
    await handlers["logs"]!("--tail 25", ctx);
    expect(logs).toHaveBeenCalledWith(container, { tail: 25 });
  });

  it("returns a typed message when no target is resolvable", async () => {
    const { handlers } = makeServices({
      targetStore: {
        snapshot: vi.fn(() => ({ status: "none", workspaceKey: undefined, candidateId: undefined, detail: undefined })),
      } as unknown as TargetStore,
    });
    const ctx = makeCtx();
    const result = await handlers["logs"]!("", ctx);
    expect(result.text).toContain("[none]");
  });
});

describe("/devcontainer host-exec", () => {
  it("denies by policy without invoking the host runner", async () => {
    const hostRunner = { run: vi.fn() };
    const { handlers } = makeServices({ hostRunner });
    const ctx = makeCtx();
    const result = await handlers["host-exec"]!("rm -rf /", ctx);
    expect(result.text).toContain("[policy-denied]");
    expect(hostRunner.run).not.toHaveBeenCalled();
  });

  it("runs argv on the host when allowed", async () => {
    const { handlers, hostRunner } = makeServices({ config: makeConfig({ hostExecution: { allow: true } }) });
    const ctx = makeCtx();
    const result = await handlers["host-exec"]!("hostname", ctx);
    expect(hostRunner!.run).toHaveBeenCalledWith(["hostname"], undefined);
    expect(result.text).toBe("host-out");
  });

  it("preserves quoted arguments via parseArgv", async () => {
    const { handlers, hostRunner } = makeServices({ config: makeConfig({ hostExecution: { allow: true } }) });
    const ctx = makeCtx();
    await handlers["host-exec"]!("printf \"hello world\"", ctx);
    expect(hostRunner!.run).toHaveBeenCalledWith(["printf", "hello world"], undefined);
  });
});
