/**
 * The reverse routing guard and the host-run visibility (command-routing assessment §4.1/§4.2).
 *
 * The forward direction is already guarded (a host surface refuses a container-only path). This file
 * pins the two things the assessment found missing on the other side: a container-surface request that
 * names the HOST workspace path is refused when the mapping sends that path somewhere else, and the
 * operator can see host runs without reading the audit log.
 */
import { describe, expect, it } from "vitest";
import { detectHostPathOnContainerSurface } from "../../src/routing-guard.js";
import { createHostRunLedger } from "../../src/host-run-ledger.js";
import { displayProgram } from "../../src/policy.js";
import { createAuditedHostRunner } from "../../src/host-runner.js";
import type { AuditRecord, EffectiveConfig } from "../../src/types.js";

function makeConfig(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
  return {
    version: 1, dockerPath: "docker", devcontainerPath: "devcontainer", routeMode: "container-required",
    allowedWorkspaceRoots: ["/ws"], environmentAllowlist: [], maxTimeoutSeconds: 900, maxOutputBytes: 1024,
    discovery: { maxDepth: 3, excludedDirectories: [".git"] },
    audit: { enabled: true, retentionDays: 90, commandCapture: "fingerprint-only" },
    destructive: { allowStop: false, allowRemove: false }, hostExecution: { allow: true },
    ...overrides,
  };
}

describe("detectHostPathOnContainerSurface", () => {
  const mapping = { hostPath: "/host/proj", containerPath: "/workspaces/proj" };

  it("flags an argv element that IS the host workspace path", () => {
    expect(detectHostPathOnContainerSurface(["cat", "/host/proj/README.md"], mapping)).toBe("/host/proj/README.md");
  });

  it("flags the host path itself", () => {
    expect(detectHostPathOnContainerSurface(["ls", "/host/proj"], mapping)).toBe("/host/proj");
  });

  it("ignores a path that merely shares a prefix as a string", () => {
    // `/host/project-other` is NOT beneath `/host/proj` as a path segment.
    expect(detectHostPathOnContainerSurface(["cat", "/host/project-other/x"], mapping)).toBeUndefined();
  });

  it("ignores anything that is not an absolute path equal to or beneath the host path", () => {
    expect(detectHostPathOnContainerSurface(["npm", "--prefix=/usr", "test"], mapping)).toBeUndefined();
    expect(detectHostPathOnContainerSurface(["grep", "host/proj", "file"], mapping)).toBeUndefined();
  });

  it("ignores a flag VALUE that is not the host path", () => {
    expect(detectHostPathOnContainerSurface(["npm", "run", "--", "build"], mapping)).toBeUndefined();
  });

  it("says nothing when there is no mapping", () => {
    expect(detectHostPathOnContainerSurface(["cat", "/host/proj/x"], undefined)).toBeUndefined();
  });

  it("says nothing for a path the configuration makes visible in the container at its own path", () => {
    // A `mounts` entry with source == target makes the path the SAME file on both sides, so refusing
    // it would break the mirror-mount idiom (found by the adversarial review of this change).
    expect(
      detectHostPathOnContainerSurface(["cat", "/data/work/proj/README.md"], {
        hostPath: "/data/work/proj",
        containerPath: "/workspaces/proj",
        containerVisiblePaths: ["/data/work/proj"],
      }),
    ).toBeUndefined();
  });

  it("never refuses the container's own path space when it is NESTED under the host path", () => {
    // The workspace mounted at a subdirectory of the host path: `/host/proj/container/x` is the
    // container's own workspace, so a request for it is legitimate.
    expect(
      detectHostPathOnContainerSurface(["cat", "/host/proj/container/x"], {
        hostPath: "/host/proj",
        containerPath: "/host/proj/container",
      }),
    ).toBeUndefined();
  });

  it("exempts only the container's own workspace when it is nested under the host path", () => {
    const mapping = { hostPath: "/data/work/proj", containerPath: "/data/work/proj/sub" };
    // The container's workspace is legitimate …
    expect(detectHostPathOnContainerSurface(["cat", "/data/work/proj/sub/x"], mapping)).toBeUndefined();
    // … but a sibling HOST file is not: the exemption is the container space, not the host space
    // (adversarial review of the routing hardening).
    expect(detectHostPathOnContainerSurface(["cat", "/data/work/proj/README.md"], mapping)).toBe("/data/work/proj/README.md");
  });

  it("refuses when the container path is an ANCESTOR of the host path", () => {
    // The workspace mounted at a shallower container path: every host-path request then names a
    // different file inside the container, so the blanket container-space exemption must not swallow it
    // (found by the second adversarial pass).
    expect(
      detectHostPathOnContainerSurface(["cat", "/data/work/proj/README.md"], {
        hostPath: "/data/work/proj",
        containerPath: "/data",
      }),
    ).toBe("/data/work/proj/README.md");
  });

  it("expands ${localWorkspaceFolder} in a same-path mount", () => {
    // A mirror mount written with the variable must still be recognised as "same file on both sides".
    expect(
      detectHostPathOnContainerSurface(["cat", "/data/work/proj/README.md"], {
        hostPath: "/data/work/proj",
        containerPath: "/workspaces/proj",
        containerVisiblePaths: ["${localWorkspaceFolder}"],
      }),
    ).toBeUndefined();
  });

  it("says nothing when the mapping mounts the host path at the same path", () => {
    // There the host path IS the container path, so using it is correct.
    expect(detectHostPathOnContainerSurface(["cat", "/ws/x"], { hostPath: "/ws", containerPath: "/ws" })).toBeUndefined();
  });
});

describe("the visibility renders NO command text at all", () => {
  it("names the program in the one-shot notice and stores nothing else", async () => {
    const notices: string[] = [];
    const ledger = createHostRunLedger({ limit: 5 });
    const host = createAuditedHostRunner({
      runner: {
        async exec() {
          return { exitCode: 0, signal: null, durationMs: 1, truncated: false, stdout: "", stderr: "" };
        },
      },
      config: makeConfig(),
      audit: { write: () => undefined },
      sessionWorkspace: "/ws",
      env: { PATH: "/usr/bin" },
      targetStoreWorkspaceKey: () => undefined,
      guardMappingFor: async () => undefined,
      ledger,
      onFirstHostRun: (program) => void notices.push(program),
    });

    // Every shape that made five earlier versions leak: a two-element flag value, a standalone scheme
    // element, and a header split across elements. The contraction makes them all moot: no argv text is
    // rendered or stored anywhere, so there is no redaction rule that can be wrong.
    await host.run(["mysql", "-u", "root", "--password", "s3cr3t-value"]);
    await host.run(["curl", "-H", "Authorization: Bearer", "eyJhbGciOiJIUzI1NiJ9.SECRET"]);
    await host.run(["curl", "-H", "Bearer", "Bearer sk-live-TKN"]);

    expect(notices).toEqual(["mysql"]);
    expect(ledger.recent()).toEqual(["mysql", "curl", "curl"]);
    expect(ledger.count()).toBe(3);
    expect(JSON.stringify(ledger.recent())).not.toContain("s3cr3t");
    expect(JSON.stringify(ledger.recent())).not.toContain("SECRET");
  });

  it("counts a refused attempt too, and still announces only the first", async () => {
    const notices: string[] = [];
    const ledger = createHostRunLedger({ limit: 5 });
    const records: AuditRecord[] = [];
    const host = createAuditedHostRunner({
      runner: { async exec() { return { exitCode: 0, signal: null, durationMs: 1, truncated: false, stdout: "", stderr: "" }; } },
      config: makeConfig({ hostExecution: { allow: false } }),
      audit: { write: (record) => void records.push(record) },
      sessionWorkspace: "/ws",
      env: { PATH: "/usr/bin" },
      targetStoreWorkspaceKey: () => undefined,
      guardMappingFor: async () => undefined,
      ledger,
      onFirstHostRun: (program) => void notices.push(program),
    });

    await expect(host.run(["systemctl", "restart", "docker"])).rejects.toMatchObject({ kind: "policy-denied" });
    await expect(host.run(["systemctl", "restart", "docker"])).rejects.toMatchObject({ kind: "policy-denied" });

    expect(ledger.count()).toBe(2);
    expect(notices).toEqual(["systemctl"]);
    expect(ledger.recent()).toEqual(["systemctl", "systemctl"]);
    expect(records.every((record) => record.policyAuthorized === false)).toBe(true);
  });

  it("stores nothing when the capture policy is `none`", () => {
    const ledger = createHostRunLedger({ limit: 5 });
    ledger.setCapture("none");
    ledger.record(["docker", "ps"]);

    expect(ledger.recent()).toEqual([]);
    expect(ledger.summary()).toContain("not recorded");
    expect(ledger.count()).toBe(1);
  });
});

describe("displayProgram — the visibility's only rendering", () => {
  it("redacts a credential-shaped argv[0], caps a long one, and never returns blank", () => {
    // A program name CAN be credential-shaped (adversarial review built this exact argv):
    expect(displayProgram(["Authorization: Bearer sk-live-abcdef123456"])).not.toContain("sk-live-abcdef123456");
    // A pathological argument must not flood the operator channel or the status block:
    expect(displayProgram([`/${"x".repeat(5000)}`]).length).toBeLessThanOrEqual(64);
    // An empty argv[0] renders as a name, not as blank space:
    expect(displayProgram([""])).toBe("(no command)");
    expect(displayProgram([])).toBe("(no command)");
    // And an ordinary program keeps its basename:
    expect(displayProgram(["/usr/bin/docker", "ps"])).toBe("docker");
  });
});

describe("createHostRunLedger — no command text", () => {
  it("never stores a credential, because it never stores a command line", () => {
    const ledger = createHostRunLedger();
    ledger.record(["curl", "-H", "authorization: Bearer sk-live-abcdef123456", "https://example.test"]);

    expect(ledger.recent()).toEqual(["curl"]);
    expect(JSON.stringify(ledger)).not.toContain("sk-live-abcdef123456");
  });
});

describe("createHostRunLedger", () => {
  it("counts host runs and remembers the most recent ones", () => {
    const ledger = createHostRunLedger({ limit: 2 });

    expect(ledger.summary()).toBe("no host commands in this session");
    ledger.record(["docker", "ps"]);
    ledger.record(["systemctl", "status", "docker"]);
    ledger.record(["hostname"]);

    expect(ledger.count()).toBe(3);
    // Bounded: only the newest `limit` commands are kept, oldest first for reading.
    expect(ledger.recent()).toEqual(["systemctl", "hostname"]);
  });

  it("is per SESSION: reset() clears the count, the recent list and the one-shot flag", () => {
    const ledger = createHostRunLedger({ limit: 5 });
    ledger.noteFirstRun(["hostname"]);
    ledger.noteFirstRun(["hostname"]);

    ledger.reset();

    // A second session in the same process must not inherit the first one's summary.
    expect(ledger.count()).toBe(0);
    expect(ledger.recent()).toEqual([]);
    expect(ledger.noteFirstRun(["hostname"])).toBe(true);
  });

  it("reports the first run exactly once per session", () => {
    const ledger = createHostRunLedger({ limit: 5 });

    expect(ledger.noteFirstRun(["hostname"])).toBe(true);
    expect(ledger.noteFirstRun(["hostname"])).toBe(false);
    expect(ledger.count()).toBe(2);
  });

  it("summarises count and recency for the status surface", () => {
    const ledger = createHostRunLedger({ limit: 3 });
    ledger.record(["docker", "ps"]);

    expect(ledger.summary()).toContain("1 host command attempt");
    expect(ledger.summary()).toContain("docker");
  });
});
