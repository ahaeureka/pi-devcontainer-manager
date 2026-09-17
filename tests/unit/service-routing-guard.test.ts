import { describe, expect, it, vi } from "vitest";
import { ExecutionService } from "../../src/execution-service.js";
import { TargetStore } from "../../src/target-store.js";
import { RuntimeError } from "../../src/errors.js";
import type { DevcontainerAdapter } from "../../src/runtime/devcontainer-adapter.js";
import type { EffectiveConfig } from "../../src/types.js";

const config: EffectiveConfig = {
  version: 1, dockerPath: "docker", devcontainerPath: "devcontainer", routeMode: "container-required",
  allowedWorkspaceRoots: ["/host"], environmentAllowlist: [], maxTimeoutSeconds: 900, maxOutputBytes: 1024,
  discovery: { maxDepth: 3, excludedDirectories: [".git"] },
  audit: { enabled: true, retentionDays: 90, commandCapture: "fingerprint-only" },
  destructive: { allowStop: false, allowRemove: false }, hostExecution: { allow: true },
};

describe("reverse routing guard, through the service", () => {
  it("refuses a container exec that names the host workspace path", async () => {
    const store = new TargetStore({ clock: () => "x" });
    await store.select({ status: "selected-valid", workspaceKey: "/host/proj", candidate: { id: "c1", name: "c1", workspaceKey: "/host/proj", state: "running", status: "running" } });
    const exec = vi.fn();
    const service = new ExecutionService({
      config, targetStore: store,
      devcontainer: { exec } as unknown as DevcontainerAdapter,
      dockerLifecycle: { logs: vi.fn(), stop: vi.fn(), remove: vi.fn() } as never,
      audit: { write: vi.fn(), prune: vi.fn() },
      mappingFor: async () => ({ hostPath: "/host/proj", containerPath: "/workspaces/proj" }),
    });

    await expect(service.exec({ operation: "container-exec", initiator: "tool", workspace: "/host/proj", cmd: "cat", args: ["/host/proj/README.md"] }))
      .rejects.toMatchObject({ kind: "policy-denied", message: expect.stringContaining("/workspaces/proj") });
    expect(exec).not.toHaveBeenCalled();
  });

  it("lets the container path through", async () => {
    const store = new TargetStore({ clock: () => "x" });
    await store.select({ status: "selected-valid", workspaceKey: "/host/proj", candidate: { id: "c1", name: "c1", workspaceKey: "/host/proj", state: "running", status: "running" } });
    const exec = vi.fn(async () => ({ exitCode: 0, signal: null, durationMs: 1, truncated: false, stdout: "ok", stderr: "" }));
    const service = new ExecutionService({
      config, targetStore: store,
      devcontainer: { exec } as unknown as DevcontainerAdapter,
      dockerLifecycle: { logs: vi.fn(), stop: vi.fn(), remove: vi.fn() } as never,
      audit: { write: vi.fn(), prune: vi.fn() },
      mappingFor: async () => ({ hostPath: "/host/proj", containerPath: "/workspaces/proj" }),
    });

    const outcome = await service.exec({ operation: "container-exec", initiator: "tool", workspace: "/host/proj", cmd: "cat", args: ["/workspaces/proj/README.md"] });
    expect(outcome.exitCode).toBe(0);
  });
});
