/**
 * The reverse guard through the REAL ExecutionService (the adversarial pass found that no test
 * exercised `mappingFor` at all, which is how the guard's audit shape went unnoticed).
 */
import { describe, expect, it, vi } from "vitest";
import { ExecutionService } from "../../src/execution-service.js";
import { TargetStore } from "../../src/target-store.js";
import type { DevcontainerAdapter } from "../../src/runtime/devcontainer-adapter.js";
import type { AuditRecord, EffectiveConfig } from "../../src/types.js";

const config: EffectiveConfig = {
  version: 1, dockerPath: "docker", devcontainerPath: "devcontainer", routeMode: "container-required",
  allowedWorkspaceRoots: ["/host"], environmentAllowlist: [], maxTimeoutSeconds: 900, maxOutputBytes: 1024,
  discovery: { maxDepth: 3, excludedDirectories: [".git"] },
  audit: { enabled: true, retentionDays: 90, commandCapture: "fingerprint-only" },
  destructive: { allowStop: false, allowRemove: false }, hostExecution: { allow: true },
};

async function harness(options: {
  mapping?: { hostPath: string; containerPath: string; containerVisiblePaths?: readonly string[] };
  mappingFor?: () => Promise<never>;
  resolveContainerWorkspace?: (hostWorkspace: string) => Promise<string | undefined>;
} = {}) {
  const store = new TargetStore({ clock: () => "x" });
  await store.select({
    status: "selected-valid",
    workspaceKey: "/host/proj",
    candidate: { id: "c1", name: "c1", workspaceKey: "/host/proj", state: "running", status: "running" },
  });
  const exec = vi.fn(async () => ({ exitCode: 0, signal: null, durationMs: 1, truncated: false, stdout: "ok", stderr: "" }));
  const records: AuditRecord[] = [];
  const service = new ExecutionService({
    config,
    targetStore: store,
    devcontainer: { exec } as unknown as DevcontainerAdapter,
    dockerLifecycle: { logs: vi.fn(), stop: vi.fn(), remove: vi.fn() } as never,
    audit: { write: (record) => void records.push(record), prune: vi.fn() },
    ...(options.mappingFor !== undefined
      ? { mappingFor: options.mappingFor }
      : { mappingFor: async () => options.mapping ?? { hostPath: "/host/proj", containerPath: "/workspaces/proj" } }),
    ...(options.resolveContainerWorkspace !== undefined
      ? { resolveContainerWorkspace: options.resolveContainerWorkspace }
      : {}),
  });
  return { service, exec, records };
}

describe("reverse routing guard through the service", () => {
  it("refuses the host path and audits it AS a policy denial", async () => {
    const { service, exec, records } = await harness();

    await expect(
      service.exec({ operation: "container-exec", initiator: "tool", workspace: "/host/proj", cmd: "cat", args: ["/host/proj/README.md"] }),
    ).rejects.toMatchObject({ kind: "policy-denied", message: expect.stringContaining("/workspaces/proj") });

    expect(exec).not.toHaveBeenCalled();
    // Symmetric with the forward guard's `container-path-on-host`: the record must not claim the
    // operation was authorized.
    expect(records.at(-1)).toMatchObject({ policyAuthorized: false, policyDenialReason: "host-path-on-container" });
    // The symmetric forward guard fingerprints the argv, and so must this one: a refusal with no
    // command identity cannot be correlated with what the operator asked for.
    expect(records.at(-1)?.commandFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("lets the container path through", async () => {
    const { service, exec } = await harness();

    const outcome = await service.exec({ operation: "container-exec", initiator: "tool", workspace: "/host/proj", cmd: "cat", args: ["/workspaces/proj/README.md"] });

    expect(outcome.exitCode).toBe(0);
    expect(exec).toHaveBeenCalled();
  });

  it("exempts a same-path mount but not a target-only shadow", async () => {
    const same = await harness({ mapping: { hostPath: "/host/proj", containerPath: "/workspaces/proj", containerVisiblePaths: ["/host/proj"] } });
    await expect(
      same.service.exec({ operation: "container-exec", initiator: "tool", workspace: "/host/proj", cmd: "cat", args: ["/host/proj/x"] }),
    ).resolves.toMatchObject({ exitCode: 0 });

    const shadow = await harness({ mapping: { hostPath: "/host/proj", containerPath: "/workspaces/proj" } });
    await expect(
      shadow.service.exec({ operation: "container-exec", initiator: "tool", workspace: "/host/proj", cmd: "cat", args: ["/host/proj/x"] }),
    ).rejects.toMatchObject({ kind: "policy-denied" });
  });

  it("audits a mapping failure instead of letting it escape unrecorded", async () => {
    const { service, records } = await harness({ mappingFor: async () => { throw new Error("docker daemon unavailable"); } });

    await expect(
      service.exec({ operation: "container-exec", initiator: "tool", workspace: "/host/proj", cmd: "ls", args: [] }),
    ).rejects.toThrow("docker daemon unavailable");

    expect(records.at(-1)?.errorSummary).toContain("docker daemon unavailable");
  });
});

describe("one registry read per container exec", () => {
  it("reuses the guard's mapping for the presentation instead of resolving it twice", async () => {
    // Adversarial review: the guard read the mapping BEFORE the container command and the presentation hook
    // re-resolved it AFTER it, so the two reads were separated by the whole command — no TTL can bridge that.
    const calls: string[] = [];
    let presentationReads = 0;
    const { service } = await harness({
      mappingFor: (async () => {
        calls.push("mapping");
        return { hostPath: "/host/proj", containerPath: "/workspaces/proj" };
      }) as unknown as () => Promise<never>,
      resolveContainerWorkspace: async () => {
        presentationReads += 1;
        calls.push("presentation");
        return "/workspaces/proj-from-hook";
      },
    });

    const outcome = await service.exec({
      operation: "container-exec",
      initiator: "tool",
      workspace: "/host/proj",
      cmd: "echo",
      args: ["hi"],
    });

    // The mapping already answers the presentation question, so the hook is not consulted at all.
    expect(presentationReads).toBe(0);
    expect(calls).toEqual(["mapping"]);
    expect(outcome.workspaceKey).toBe("/workspaces/proj");
  });

  it("falls back to the presentation hook when the workspace declares no mapping", async () => {
    let presentationReads = 0;
    const { service } = await harness({
      mapping: undefined,
      mappingFor: (async () => undefined) as unknown as () => Promise<never>,
      resolveContainerWorkspace: async () => {
        presentationReads += 1;
        return "/workspaces/proj-from-hook";
      },
    });

    const outcome = await service.exec({
      operation: "container-exec",
      initiator: "tool",
      workspace: "/host/proj",
      cmd: "echo",
      args: ["hi"],
    });

    expect(presentationReads).toBe(1);
    expect(outcome.workspaceKey).toBe("/workspaces/proj-from-hook");
  });
});
