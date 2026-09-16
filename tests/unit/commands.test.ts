/**
 * Unit tests for the namespaced command UX (`/devcontainer ...`, Slice 6).
 *
 * The commands are the operator-facing surface: list/status (registry +
 * selection), use (selection persisted), up/build (execution service),
 * stop/remove (policy-gated, per-action confirmation token, never bypassed),
 * logs, and host-exec (explicit, policy-gated escape hatch).
 */
import { describe, expect, it, vi } from "vitest";
import {
  createCommandHandlers,
  displayCommandResult,
  reconcileSelection,
  type CommandContextLike,
  type CommandServices,
} from "../../src/commands.js";
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
          configPath: target.candidate?.configPath,

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
      logs: vi.fn(async () => ({ exitCode: 0, output: "log-line", truncated: false })),
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
    hasUI: true,
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

  it("leaves the configuration unset for the CLI default-lookup form", async () => {
    const { handlers, targetStore } = makeServices();
    const ctx = makeCtx();
    await handlers["use"]!("project-a", ctx);
    const selection = targetStore.select.mock.calls[0]![0] as { candidate?: { configPath?: string } };
    // `.devcontainer/devcontainer.json` is resolved by the CLI itself, so argv
    // must stay exactly as it is today.
    expect(selection.candidate?.configPath).toBeUndefined();
  });

  it("carries the named configuration when the workspace has no default-lookup form", async () => {
    const namedPath = "/ws/project-a/.devcontainer/python/devcontainer.json";
    const named: RegistryEntry = {
      ...entry,
      configPath: namedPath,
      configKind: ".devcontainer/<name>/devcontainer.json",
      configCandidates: [{ configPath: namedPath, configKind: ".devcontainer/<name>/devcontainer.json" }],
    };
    const { handlers, targetStore } = makeServices({
      registry: vi.fn(async () => ({ entries: [named], diagnostics: [] })),
    });
    const ctx = makeCtx();
    await handlers["use"]!("project-a", ctx);
    const selection = targetStore.select.mock.calls[0]![0] as { candidate?: { configPath?: string } };
    expect(selection.candidate?.configPath).toBe(namedPath);
  });

  it("selects a configuration named with --config", async () => {
    const defaultPath = "/ws/project-a/.devcontainer/devcontainer.json";
    const pythonPath = "/ws/project-a/.devcontainer/python/devcontainer.json";
    const multi: RegistryEntry = {
      ...entry,
      configPath: defaultPath,
      configCandidates: [
        { configPath: defaultPath, configKind: ".devcontainer/devcontainer.json" },
        { configPath: pythonPath, configKind: ".devcontainer/<name>/devcontainer.json" },
      ],
    };
    const { handlers, targetStore } = makeServices({
      registry: vi.fn(async () => ({ entries: [multi], diagnostics: [] })),
    });
    const ctx = makeCtx();
    const result = await handlers["use"]!("project-a --config python", ctx);
    const selection = targetStore.select.mock.calls[0]![0] as { candidate?: { configPath?: string } };
    expect(selection.candidate?.configPath).toBe(pythonPath);
    expect(result.text).toContain("Selected `/ws/project-a`");
  });

  it("names the available configurations when --config does not match", async () => {
    const defaultPath = "/ws/project-a/.devcontainer/devcontainer.json";
    const pythonPath = "/ws/project-a/.devcontainer/python/devcontainer.json";
    const multi: RegistryEntry = {
      ...entry,
      configPath: defaultPath,
      configCandidates: [
        { configPath: defaultPath, configKind: ".devcontainer/devcontainer.json" },
        { configPath: pythonPath, configKind: ".devcontainer/<name>/devcontainer.json" },
      ],
    };
    const { handlers, targetStore } = makeServices({
      registry: vi.fn(async () => ({ entries: [multi], diagnostics: [] })),
    });
    const ctx = makeCtx();
    const result = await handlers["use"]!("project-a --config nope", ctx);
    expect(result.text).toContain("[no-candidate]");
    expect(result.text).toContain("python");
    expect(targetStore.select).not.toHaveBeenCalled();
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

  it("refuses stop without an interactive UI (hasUI=false), never relying on confirm's silent default", async () => {
    const { handlers, execution } = makeServices({
      config: makeConfig({ destructive: { allowStop: true, allowRemove: false } }),
    });
    const ctx = makeCtx({ hasUI: false });
    const result = await handlers["stop"]!("", ctx);
    expect(result.text).toContain("[confirmation-required]");
    expect(result.text).toContain("not available in this mode");
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(execution.lifecycle).not.toHaveBeenCalled();
  });
});

describe("/devcontainer logs", () => {
  it("resolves the current selection and returns bounded log output", async () => {
    const { handlers, execution } = makeServices();
    const ctx = makeCtx();
    const result = await handlers["logs"]!("", ctx);
    // Logs now go through the shared execution service (policy + audit).
    expect(execution.logs).toHaveBeenCalledWith(
      expect.objectContaining({ initiator: "slash-command", containerId: "abc123456789", tail: 100 }),
    );
    expect(result.text).toBe("log-line");
  });

  it("parses --tail", async () => {
    const { handlers, execution } = makeServices();
    const ctx = makeCtx();
    await handlers["logs"]!("--tail 25", ctx);
    expect(execution.logs).toHaveBeenCalledWith(expect.objectContaining({ tail: 25 }));
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

describe("displayCommandResult", () => {
  it("notifies the handler's rendered text", () => {
    const notify = vi.fn();

    displayCommandResult({ text: "**Registry (1):** /ws/project-a" }, notify);

    // Pi's command dispatcher ignores a handler's return value, so without this call the
    // operator saw nothing at all for `/devcontainer list` and friends.
    expect(notify).toHaveBeenCalledWith("**Registry (1):** /ws/project-a", "info");
  });

  it("stays silent for an empty result", () => {
    const notify = vi.fn();

    displayCommandResult({ text: "" }, notify);

    expect(notify).not.toHaveBeenCalled();
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

  it("keeps stderr when the host command also wrote stdout", async () => {
    // The tool surface stopped dropping stderr in this phase; the command surface kept the
    // old stdout-or-stderr ternary, so `/devcontainer host-exec` still hid half the output.
    const hostRunner = {
      run: vi.fn(async () => ({ exitCode: 0, signal: null, stdout: "host-out\n", stderr: "host-warn\n", truncated: false })),
    };
    const { handlers } = makeServices({ config: makeConfig({ hostExecution: { allow: true } }), hostRunner });

    const result = await handlers["host-exec"]!("hostname", makeCtx());

    expect(result.text).toContain("host-out");
    expect(result.text).toContain("--- stderr ---");
    expect(result.text).toContain("host-warn");
  });

  it("still reports stderr alone without a label", async () => {
    const hostRunner = {
      run: vi.fn(async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "only-stderr\n", truncated: false })),
    };
    const { handlers } = makeServices({ config: makeConfig({ hostExecution: { allow: true } }), hostRunner });

    const result = await handlers["host-exec"]!("hostname", makeCtx());

    expect(result.text).toBe("only-stderr\n");
  });
});

describe("/devcontainer setup", () => {
  it("confirms then installs the Dev Containers CLI globally", async () => {
    const setupCli = vi.fn(async () => ({ installed: true, version: "1.2.3" }));
    const { handlers } = makeServices({ setupCli } as never);
    const ctx = makeCtx();
    const result = await handlers["setup"]!("", ctx);
    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      "Install Dev Containers CLI",
      expect.stringContaining("npm install -g @devcontainers/cli"),
      undefined,
    );
    expect(setupCli).toHaveBeenCalledTimes(1);
    expect(result.text).toContain("Dev Containers CLI ready: 1.2.3");
  });

  it("refuses without interactive UI (hasUI=false)", async () => {
    const setupCli = vi.fn();
    const { handlers } = makeServices({ setupCli } as never);
    const ctx = makeCtx({ hasUI: false });
    const result = await handlers["setup"]!("", ctx);
    expect(result.text).toContain("[confirmation-required]");
    expect(setupCli).not.toHaveBeenCalled();
  });

  it("cancels when the operator declines confirmation", async () => {
    const setupCli = vi.fn();
    const { handlers } = makeServices({ setupCli } as never);
    const ctx = makeCtx();
    ctx.ui.confirm.mockResolvedValueOnce(false);
    const result = await handlers["setup"]!("", ctx);
    expect(result.text).toBe("setup cancelled.");
    expect(setupCli).not.toHaveBeenCalled();
  });

  it("reports install failure with the npm error", async () => {
    const setupCli = vi.fn(async () => ({ installed: false, version: undefined, error: "EACCES permission denied" }));
    const { handlers } = makeServices({ setupCli } as never);
    const ctx = makeCtx();
    const result = await handlers["setup"]!("", ctx);
    expect(result.text).toContain("[setup-failed]");
    expect(result.text).toContain("EACCES permission denied");
  });

  it("reports when setup is not wired", async () => {
    const { handlers } = makeServices();
    const ctx = makeCtx();
    const result = await handlers["setup"]!("", ctx);
    expect(result.text).toContain("[unexpected]");
  });
});

describe("reconcileSelection identity validation", () => {
  function harness(entries: RegistryEntry[]) {
    const selected: unknown[] = [];
    const persisted: unknown[] = [];
    const services = {
      registry: async () => ({ entries, diagnostics: [] }),
      targetStore: {
        select: async (target: unknown) => {
          selected.push(target);
        },
        snapshot: () => ({ status: "none", workspaceKey: undefined, candidateId: undefined, detail: undefined }),
      },
    } as unknown as Pick<CommandServices, "targetStore" | "registry">;
    const ctx = { persistSelection: (record: unknown) => void persisted.push(record) };
    return { services, ctx, selected, persisted };
  }

  const running = (over: Partial<RegistryEntry> = {}): RegistryEntry =>
    ({
      ...entry,
      containerState: "running",
      containerId: "current-container",
      containerCandidates: [{ id: "current-container", state: "running" }],
      ...over,
    }) as RegistryEntry;

  it("ignores a persisted candidate id the registry no longer offers", async () => {
    // L1-03: container ids are ephemeral across rebuilds, so a stale one must not be trusted —
    // the workspace's CURRENT candidate is resolved instead, and that is what gets persisted.
    const { services, ctx, selected, persisted } = harness([running()]);

    const result = await reconcileSelection(services, ctx, {
      workspaceKey: entry.workspacePath,
      candidateId: "stale-container-id",
    });

    expect(result.status).toBe("selected-valid");
    expect(result.candidate?.id).toBe("current-container");
    expect(selected).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ candidateId: "current-container" });
  });

  it("keeps a persisted id the registry still offers", async () => {
    const { services, ctx } = harness([
      running({
        containerId: "keep-me",
        containerCandidates: [
          { id: "keep-me", state: "running" },
          { id: "other", state: "exited" },
        ],
      }),
    ]);

    const result = await reconcileSelection(services, ctx, {
      workspaceKey: entry.workspacePath,
      candidateId: "keep-me",
    });

    expect(result.candidate?.id).toBe("keep-me");
  });

  it("still fails closed when a stale id cannot disambiguate two running containers", async () => {
    const { services, ctx } = harness([
      running({
        ambiguous: true,
        containerCandidates: [
          { id: "aa11", state: "running" },
          { id: "aa12", state: "running" },
        ],
      }),
    ]);

    const result = await reconcileSelection(services, ctx, {
      workspaceKey: entry.workspacePath,
      candidateId: "stale-container-id",
    });

    expect(result.status).toBe("selected-ambiguous");
  });
});

describe("CommandResult.target (L1-06)", () => {
  it("use reports the established target so the dispatcher may engage the container surfaces", async () => {
    const { handlers } = makeServices();
    const result = await handlers["use"]!("", makeCtx());

    expect(result.target).toMatchObject({ workspaceKey: "/ws/project-a" });
  });

  it("use reports no target when the operator cancels", async () => {
    const ctx = makeCtx({ ui: undefined });
    ctx.ui.select = vi.fn(async () => undefined);
    const multi = [
      { ...entry, workspacePath: "/ws/a" },
      { ...entry, workspacePath: "/ws/b" },
    ] as RegistryEntry[];
    const { handlers } = makeServices({ registry: vi.fn(async () => ({ entries: multi, diagnostics: [] })) });

    const result = await handlers["use"]!("", ctx);

    expect(result.text).toContain("cancelled");
    expect(result.target).toBeUndefined();
  });

  it("use reports no target when nothing matched", async () => {
    const { handlers } = makeServices();

    const result = await handlers["use"]!("does-not-exist", makeCtx());

    expect(result.text).toContain("[no-candidate]");
    expect(result.target).toBeUndefined();
  });

  it("use reports no target for an ambiguous workspace", async () => {
    const { handlers } = makeServices({
      registry: vi.fn(async () => ({
        entries: [
          {
            ...entry,
            ambiguous: true,
            containerCandidates: [
              { id: "aa11", state: "running" },
              { id: "aa12", state: "running" },
            ],
          },
        ],
        diagnostics: [],
      })),
    });

    const ctx = makeCtx();
    const result = await handlers["use"]!("", ctx);

    expect(result.text).toContain("[ambiguous-candidate]");
    expect(result.target).toBeUndefined();
    // A failed selection must not leave persisted evidence that engages the session after a reload.
    expect(ctx.persisted).toHaveLength(0);
  });
});

describe("/devcontainer up refresh (L2-01)", () => {
  it("refreshes the registry after a successful start and reconciles against it", async () => {
    const started: RegistryEntry = { ...entry, containerState: "running", containerId: "fresh123" };
    const refreshed = vi.fn(async () => ({ entries: [started], diagnostics: [] }));
    const { handlers } = makeServices({ refreshRegistry: refreshed });

    const result = await handlers["up"]!("", makeCtx());

    expect(refreshed).toHaveBeenCalledTimes(1);
    expect(result.text).toContain("selection: selected-valid");
    expect(result.target).toMatchObject({ workspaceKey: entry.workspacePath, candidateId: "fresh123" });
  });

  it("does not refresh when the start failed", async () => {
    const refreshed = vi.fn(async () => ({ entries: [entry], diagnostics: [] }));
    const { handlers } = makeServices({
      refreshRegistry: refreshed,
      execution: {
        up: vi.fn(async () => {
          throw new RuntimeError({ kind: "docker-cli-failure", message: "daemon unreachable" });
        }),
      } as unknown as ExecutionService,
    });

    const result = await handlers["up"]!("", makeCtx());

    expect(result.text).toContain("daemon unreachable");
    expect(refreshed).not.toHaveBeenCalled();
    expect(result.target).toBeUndefined();
  });
});

describe("persisted selection intent (L1-02 / L1-04)", () => {
  it("persists an opt-out tombstone when the operator turns the extension off", async () => {
    const { handlers, targetStore } = makeServices();
    const ctx = makeCtx();

    const result = await handlers["off"]!("", ctx);

    expect(targetStore.clear).toHaveBeenCalled();
    expect(result.text).toContain("host surfaces again");
    // Without the tombstone the append-only log still holds the earlier selection, so `/reload`
    // would silently undo the operator's opt-out.
    expect(ctx.persisted).toHaveLength(1);
    expect(ctx.persisted[0]).toMatchObject({ version: 2, state: "cleared" });
    expect(ctx.persisted[0]!.workspaceKey).toBeUndefined();
  });

  it("persists the selected configuration with the selection", async () => {
    const named: RegistryEntry = {
      ...entry,
      configPath: "/ws/project-a/.devcontainer/python/devcontainer.json",
      configKind: ".devcontainer/<name>/devcontainer.json",
      configCandidates: [
        {
          configPath: "/ws/project-a/.devcontainer/python/devcontainer.json",
          configKind: ".devcontainer/<name>/devcontainer.json",
        },
      ],
    };
    const { handlers } = makeServices({ registry: vi.fn(async () => ({ entries: [named], diagnostics: [] })) });
    const ctx = makeCtx();

    await handlers["use"]!("project-a", ctx);

    expect(ctx.persisted[0]).toMatchObject({
      state: "selected",
      configPath: "/ws/project-a/.devcontainer/python/devcontainer.json",
    });
  });
});

function reconcileHarness(entries: RegistryEntry[], seed?: { workspaceKey: string; configPath: string }) {
    const selected: unknown[] = [];
    const persisted: { configPath?: string }[] = [];
    const snapshot: Record<string, unknown> = {
      status: seed !== undefined ? "selected-valid" : "none",
      workspaceKey: seed?.workspaceKey,
      candidateId: undefined,
      detail: undefined,
      ...(seed !== undefined ? { configPath: seed.configPath } : {}),
    };
    const services = {
      registry: async () => ({ entries, diagnostics: [] }),
      targetStore: {
        select: async (target: unknown) => void selected.push(target),
        snapshot: () => snapshot,
      },
    } as unknown as Pick<CommandServices, "targetStore" | "registry">;
  const ctx = { persistSelection: (record: { configPath?: string }) => void persisted.push(record) };
  return { services, ctx, persisted, snapshot };
}

describe("reconcileSelection keeps the selected configuration (L1-04)", () => {
  const withConfig = (configPath: string): RegistryEntry =>
    ({
      ...entry,
      containerState: "running",
      containerId: "c1",
      containerCandidates: [{ id: "c1", state: "running" }],
      configPath,
      configKind: ".devcontainer/<name>/devcontainer.json",
      configCandidates: [{ configPath, configKind: ".devcontainer/<name>/devcontainer.json" }],
    }) as RegistryEntry;

  it("restores the configuration the operator had selected", async () => {
    const path = "/ws/project-a/.devcontainer/python/devcontainer.json";
    const { services, ctx, persisted } = reconcileHarness([withConfig(path)]);

    const result = await reconcileSelection(services, ctx, { workspaceKey: entry.workspacePath, configPath: path });

    expect(result.candidate?.configPath).toBe(path);
    expect(persisted[0]!.configPath).toBe(path);
  });

  it("drops a configuration the workspace no longer discovers", async () => {
    const { services, ctx, persisted } = reconcileHarness([withConfig("/ws/project-a/.devcontainer/python/devcontainer.json")]);

    const result = await reconcileSelection(services, ctx, {
      workspaceKey: entry.workspacePath,
      configPath: "/ws/project-a/.devcontainer/removed/devcontainer.json",
    });

    expect(result.candidate?.configPath).toBeUndefined();
    expect(persisted[0]!.configPath).toBeUndefined();
  });
});

describe("reconcileSelection preserves an already-selected configuration (L1-04 regression)", () => {
  const named = "/ws/project-a/.devcontainer/python/devcontainer.json";
  const entryWithBoth: RegistryEntry = {
    ...entry,
    containerState: "running",
    containerId: "c1",
    containerCandidates: [{ id: "c1", state: "running" }],
    configPath: "/ws/project-a/.devcontainer/devcontainer.json",
    configKind: ".devcontainer/devcontainer.json",
    configCandidates: [
      { configPath: "/ws/project-a/.devcontainer/devcontainer.json", configKind: ".devcontainer/devcontainer.json" },
      { configPath: named, configKind: ".devcontainer/<name>/devcontainer.json" },
    ],
  };

  it("keeps the configuration the session already selected when the caller passes no hint", async () => {
    // `/devcontainer up` and the `list` repair call reconcileSelection with only a workspace key.
    // Falling back to the discovered primary there silently reverted the operator's choice — and
    // re-persisted it — right after the `use`/`up` flow that recommends itself.
    const { services, ctx, persisted, snapshot } = reconcileHarness(
      [entryWithBoth],
      { workspaceKey: "/ws/project-a", configPath: named },
    );

    const result = await reconcileSelection(services, ctx, { workspaceKey: "/ws/project-a" });

    expect(result.candidate?.configPath).toBe(named);
    expect(snapshot.status).toBe("selected-valid");
    expect(persisted[0]!.configPath).toBe(named);
  });

  it("still prefers an explicit hint over the carried-over configuration", async () => {
    const primary = "/ws/project-a/.devcontainer/devcontainer.json";
    const { services, ctx } = reconcileHarness([entryWithBoth], { workspaceKey: "/ws/project-a", configPath: named });

    const result = await reconcileSelection(services, ctx, { workspaceKey: "/ws/project-a", configPath: primary });

    expect(result.candidate?.configPath).toBe(primary);
  });

  it("does not carry a configuration across workspaces", async () => {
    const { services, ctx } = reconcileHarness([entryWithBoth], { workspaceKey: "/ws/other", configPath: named });

    const result = await reconcileSelection(services, ctx, { workspaceKey: "/ws/project-a" });

    expect(result.candidate?.configPath).toBeUndefined();
  });
});

describe("/devcontainer host-exec denial remedy (AC-4)", () => {
  it("tells the operator which configuration is withholding host execution", async () => {
    const hostRunner = { run: vi.fn() };
    const { handlers } = makeServices({ hostRunner });

    const result = await handlers["host-exec"]!("hostname", makeCtx());

    expect(result.text).toContain("[policy-denied]");
    expect(result.text).toContain("hostExecution.allow: false");
    expect(result.text).toContain("project");
    expect(result.text).toContain("global");
    expect(result.text).not.toContain("allow=true");
    expect(hostRunner.run).not.toHaveBeenCalled();
  });
});
