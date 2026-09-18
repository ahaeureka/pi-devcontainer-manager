import { describe, expect, it, vi } from "vitest";
import { ExecutionService } from "../../src/execution-service.js";
import { TargetStore, type ExecutionContext, type TargetSelection } from "../../src/target-store.js";
import type { AuditWriter } from "../../src/audit.js";
import type { EffectiveConfig } from "../../src/types.js";
import type {
  BuildResult,
  DevcontainerAdapter,
  ExecResult,
  UpResult,
} from "../../src/runtime/devcontainer-adapter.js";
import type { DockerLifecycleAdapter } from "../../src/runtime/docker-lifecycle.js";
import { testConfig } from "../fixtures/config.js";

/**
 * AC-2, wiring half: the configuration an operator selected must be the
 * configuration the CLI is told about. Two links are pinned here —
 *
 *   selection -> `TargetStore.bind()` -> frozen `ExecutionContext`
 *   `ExecutionContext` / `UpBuildRequest` -> the adapter's argv options
 *
 * The adapter's own argv shape (`--config <path>`) is pinned in
 * `container-config-forms.test.ts`.
 */

const CONFIG_PATH = "/ws/project-a/.devcontainer/python/devcontainer.json";

function makeConfig(): EffectiveConfig {
  return testConfig();
}

function auditStub(): AuditWriter {
  return { write: vi.fn(), prune: vi.fn() };
}

function lifecycleStub(): DockerLifecycleAdapter {
  return { logs: vi.fn(), stop: vi.fn(), remove: vi.fn() } as unknown as DockerLifecycleAdapter;
}

/** Bound context with an optional selected configuration. */
function storeBinding(configPath: string | undefined) {
  const base = {
    workspaceKey: "/ws/project-a",
    candidateId: "abc123",
    candidateName: "project-a",
    boundAt: "2026-08-31T09:47:28.000Z",
  };
  // Built through a variable so the optional field does not trip the
  // excess-property check before the type carries it.
  const context: ExecutionContext = configPath === undefined ? base : { ...base, configPath };
  const store = {
    bind: () => context,
    snapshot: () => ({ status: "selected-valid", workspaceKey: undefined, candidateId: undefined, detail: undefined }),
  } as unknown as TargetStore;
  return { store, context };
}

/** Records exactly which options each adapter entry point received. */
function adapterRecorder() {
  const execOptions: Array<Record<string, unknown>> = [];
  const upOptions: Array<Record<string, unknown>> = [];
  const buildOptions: Array<Record<string, unknown>> = [];
  const adapter: DevcontainerAdapter = {
    up: vi.fn(async (_workspace: string, options?: object): Promise<UpResult> => {
      upOptions.push((options ?? {}) as Record<string, unknown>);
      return { containerId: "c1" };
    }),
    build: vi.fn(async (_workspace: string, options?: object): Promise<BuildResult> => {
      buildOptions.push((options ?? {}) as Record<string, unknown>);
      return { imageName: "i:t" };
    }),
    exec: vi.fn(
      async (
        _workspace: string,
        _containerId: string,
        _cmd: string,
        _args: readonly string[],
        options?: object,
      ): Promise<ExecResult> => {
        execOptions.push((options ?? {}) as Record<string, unknown>);
        return { exitCode: 0, signal: null, durationMs: 1, truncated: false, stdout: "", stderr: "" };
      },
    ),
  };
  return { adapter, execOptions, upOptions, buildOptions };
}

function makeService(store: TargetStore, adapter: DevcontainerAdapter) {
  return new ExecutionService({
    config: makeConfig(),
    targetStore: store,
    devcontainer: adapter,
    dockerLifecycle: lifecycleStub(),
    audit: auditStub(),
  });
}

describe("selected configuration reaches the adapter", () => {
  it("carries the bound candidate's configPath into the exec options", async () => {
    const { store } = storeBinding(CONFIG_PATH);
    const { adapter, execOptions } = adapterRecorder();
    await makeService(store, adapter).exec({
      operation: "container-exec",
      initiator: "tool",
      workspace: "/ws/project-a",
      cmd: "npm",
      args: ["test"],
    });
    expect(execOptions[0]?.configPath).toBe(CONFIG_PATH);
  });

  it("omits configPath when the selection uses the CLI default lookup", async () => {
    const { store } = storeBinding(undefined);
    const { adapter, execOptions } = adapterRecorder();
    await makeService(store, adapter).exec({
      operation: "container-exec",
      initiator: "tool",
      workspace: "/ws/project-a",
      cmd: "npm",
      args: ["test"],
    });
    expect(execOptions[0]?.configPath).toBeUndefined();
  });

  it("passes an explicit configPath through up and build", async () => {
    const { store } = storeBinding(undefined);
    const { adapter, upOptions, buildOptions } = adapterRecorder();
    const service = makeService(store, adapter);
    // Held in a variable: `configPath` is not on `UpBuildRequest` until the
    // implementation lands, and a fresh literal would fail to compile.
    const upRequest = {
      operation: "up" as const,
      initiator: "slash-command" as const,
      workspace: "/ws/project-a",
      configPath: CONFIG_PATH,
    };
    await service.up(upRequest);
    await service.build({ ...upRequest, operation: "build" as const });
    expect(upOptions[0]?.configPath).toBe(CONFIG_PATH);
    expect(buildOptions[0]?.configPath).toBe(CONFIG_PATH);
  });
});

describe("TargetStore.bind — selected configuration", () => {
  function selection(configPath: string | undefined): TargetSelection {
    const base = {
      id: "abc123",
      name: "project-a",
      workspaceKey: "/ws/project-a",
      state: "running",
      status: "running",
    };
    return {
      status: "selected-valid",
      workspaceKey: "/ws/project-a",
      candidate: configPath === undefined ? base : { ...base, configPath },
    };
  }

  it("freezes the selected candidate's configPath into the execution context", async () => {
    const store = new TargetStore({ clock: () => "2026-08-31T09:47:28.000Z" });
    await store.select(selection(CONFIG_PATH));
    expect(store.bind().configPath).toBe(CONFIG_PATH);
  });

  it("leaves configPath unset when the candidate has none", async () => {
    const store = new TargetStore({ clock: () => "2026-08-31T09:47:28.000Z" });
    await store.select(selection(undefined));
    expect(store.bind().configPath).toBeUndefined();
  });
});
