/**
 * Unit tests for the audited host escape hatch.
 *
 * These pin the properties that make the surface GOVERNED, and they exist because the independent
 * review of the granted-by-default change found that nothing tested them: the audit record a host run
 * writes, the record a refusal writes, and the container-path guard that stands between a
 * container-only path and the host. With the escape hatch granted by default, a silently missing
 * record or a silently skipped guard is the difference between a governed surface and an unguarded
 * shell.
 */
import { describe, expect, it } from "vitest";
import { createAuditedHostRunner } from "../../src/host-runner.js";
import type { AuditRecord, EffectiveConfig } from "../../src/types.js";
import type { ProcessRunner, ProcessRunnerOptions } from "../../src/runtime/process-runner.js";
import type { PathMapping } from "../../src/path-mapper.js";

function makeConfig(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
  return {
    version: 1,
    dockerPath: "docker",
    devcontainerPath: "devcontainer",
    routeMode: "container-required",
    allowedWorkspaceRoots: ["/ws"],
    environmentAllowlist: [],
    maxTimeoutSeconds: 900,
    maxOutputBytes: 50 * 1024,
    discovery: { maxDepth: 3, excludedDirectories: [".git"] },
    audit: { enabled: true, retentionDays: 90, commandCapture: "fingerprint-only" },
    destructive: { allowStop: false, allowRemove: false },
    hostExecution: { allow: true },
    ...overrides,
  };
}

function harness(
  options: {
    config?: Partial<EffectiveConfig>;
    mapping?: PathMapping;
    workspaceKey?: string;
    exec?: ProcessRunner["exec"];
  } = {},
) {
  const records: AuditRecord[] = [];
  const calls: { file: string; args: readonly string[]; options: ProcessRunnerOptions }[] = [];
  const runner: ProcessRunner = {
    async exec(file, args, execOptions) {
      calls.push({ file, args, options: execOptions });
      if (options.exec !== undefined) return options.exec(file, args, execOptions);
      execOptions.onData?.(Buffer.from("host-out\n", "utf8"));
      execOptions.onStderr?.(Buffer.from("host-err\n", "utf8"));
      return { exitCode: 0, signal: null, durationMs: 1, truncated: false };
    },
  };
  const host = createAuditedHostRunner({
    runner,
    config: makeConfig(options.config),
    audit: { write: (record) => void records.push(record) },
    sessionWorkspace: "/ws/project",
    env: { PATH: "/usr/bin" },
    targetStoreWorkspaceKey: () => options.workspaceKey,
    guardMappingFor: async () => options.mapping,
    clock: () => "2026-09-16T00:00:00.000Z",
  });
  return { host, records, calls };
}

describe("createAuditedHostRunner — the governed properties", () => {
  it("audits a successful host run under the documented operation and initiator", async () => {
    const { host, records, calls } = harness();

    const result = await host.run(["hostname"]);

    expect(calls[0]?.file).toBe("hostname");
    expect(calls[0]?.args).toEqual([]);
    expect(result).toMatchObject({ exitCode: 0, stdout: "host-out\n", stderr: "host-err\n" });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      operation: "host-exec",
      initiator: "host-escape",
      policyAuthorized: true,
      exitCode: 0,
      outputTruncated: false,
      commandCapture: "fingerprint-only",
    });
    // The fingerprint, not the text, is what a default capture mode records.
    expect(records[0]?.commandText).toBeUndefined();
    expect(records[0]?.commandFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("audits a refusal and never spawns when the configuration withholds host execution", async () => {
    const { host, records, calls } = harness({ config: { hostExecution: { allow: false } } });

    await expect(host.run(["hostname"])).rejects.toMatchObject({ kind: "policy-denied" });

    expect(calls).toHaveLength(0);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      operation: "host-exec",
      initiator: "host-escape",
      policyAuthorized: false,
      policyDenialReason: "host-execution-disabled",
    });
  });

  it("refuses a container-only path on the host and records which path it was", async () => {
    const { host, records, calls } = harness({
      mapping: { hostPath: "/ws/project", containerPath: "/app" },
      workspaceKey: "/ws/project",
    });

    await expect(host.run(["cat", "/app/src/index.ts"])).rejects.toMatchObject({
      kind: "policy-denied",
      message: expect.stringContaining("/app/src/index.ts"),
    });

    // The guard is the only thing between a container path and the host shell, so it must refuse
    // BEFORE spawning and leave the same kind of record a policy denial leaves.
    expect(calls).toHaveLength(0);
    expect(records[0]).toMatchObject({ policyAuthorized: false, policyDenialReason: "container-path-on-host" });
  });

  it("lets a host path through when a mapping exists", async () => {
    const { host, calls } = harness({
      mapping: { hostPath: "/ws/project", containerPath: "/app" },
      workspaceKey: "/ws/project",
    });

    await host.run(["cat", "/ws/project/src/index.ts"]);

    expect(calls).toHaveLength(1);
  });

  it("documents the guard's limit: with no mapping it cannot run and does not refuse", async () => {
    // A configuration that declares neither workspaceFolder nor workspaceMount yields no mapping, so
    // there is nothing to compare an argv against. The facade reports that through the discovery
    // diagnostics; this test keeps the limit explicit instead of leaving it to be rediscovered.
    const { host, records, calls } = harness({ workspaceKey: "/ws/project" });

    await host.run(["cat", "/app/src/index.ts"]);

    expect(calls).toHaveLength(1);
    expect(records[0]).toMatchObject({ policyAuthorized: true });
  });

  it("does not consult the guard when nothing is selected", async () => {
    const { host, calls } = harness({ mapping: { hostPath: "/ws/project", containerPath: "/app" } });

    await host.run(["cat", "/app/src/index.ts"]);

    expect(calls).toHaveLength(1);
  });

  it("audits a failed or timed-out host run instead of losing the attempt", async () => {
    const failure = new Error("Process timed out after 900000ms");
    const { host, records } = harness({ exec: async () => Promise.reject(failure) });

    await expect(host.run(["sleep", "10"])).rejects.toBe(failure);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ policyAuthorized: true, outputTruncated: false });
    expect(records[0]?.errorSummary).toContain("timed out");
  });

  it("bounds the run by the configured ceiling and clamps a larger request", async () => {
    const ceiling = harness({ config: { maxTimeoutSeconds: 5 } });
    await ceiling.host.run(["sleep", "1"], { timeoutMs: 60_000 });
    expect(ceiling.calls[0]?.options.timeoutMs).toBe(5_000);

    const omitted = harness({ config: { maxTimeoutSeconds: 5 } });
    await omitted.host.run(["sleep", "1"]);
    expect(omitted.calls[0]?.options.timeoutMs).toBe(5_000);
  });

  it("transports argv literally, with no shell in between", async () => {
    const { host, calls } = harness();

    await host.run(["printf", "%s", "a b; rm -rf /"]);

    expect(calls[0]?.file).toBe("printf");
    expect(calls[0]?.args).toEqual(["%s", "a b; rm -rf /"]);
  });

  it("rejects an empty argv before touching policy or the host", async () => {
    const { host, calls, records } = harness();

    await expect(host.run([])).rejects.toMatchObject({ kind: "no-candidate" });

    expect(calls).toHaveLength(0);
    expect(records).toHaveLength(0);
  });
});
