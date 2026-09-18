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
import { displayProgram, redactText } from "../../src/policy.js";
import { isAtOrUnder, isSamePath } from "../../src/workspace-path.js";
import { findContainerPath, hostToContainer } from "../../src/path-mapper.js";
import { createAuditedHostRunner } from "../../src/host-runner.js";
import type { AuditRecord, EffectiveConfig } from "../../src/types.js";
import { testConfig } from "../fixtures/config.js";

function makeConfig(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
  return testConfig(overrides);
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

describe("displayProgram — one branch, no structure parsing", () => {
  it("renders a plain program word and nothing else", () => {
    // A program name is a single word: this is what the operator's drift signal is made of.
    expect(displayProgram(["docker"])).toBe("docker");
    expect(displayProgram(["systemctl"])).toBe("systemctl");
    expect(displayProgram(["python3.11"])).toBe("python3.11");
    expect(displayProgram(["docker", "ps", "-a"])).toBe("docker");
    expect(displayProgram(["docker ps -a"])).toBe("docker");
    // EVERYTHING with structure renders the placeholder — no path segment, host, query, fragment or userinfo is
    // rendered, because eleven adversarial passes each found a credential through a richer rule.
    for (const token of [
      "/usr/bin/docker",
      "./build.sh",
      "C:\\tools\\docker.exe",
      "https://alice:pw@host",
      "postgres://alice:hunter2:5432/db",
      "https://[sk-live-abc123]",
      "//hooks.slack.com/services/T000/B000/X9fQ",
      "//host://QZX9token",
      "https://host\\xoxb-1234-5678",
      "hooks.slack.com/services/T/X",
      "internal-host/hook/S3CR3T",
      "alice:hunter2@host",
      "token=\"Xy9Pq2Wm",
      "FOO=sk-live-abcdef",
      "Bearer\u200bsk-live-ABC123",
      "docker\u00a0|\u00a0systemctl",
      "-n",
      ".bashrc",
    ]) {
      const rendered = displayProgram([token]);
      expect(rendered).toBe("(no command)");
      expect(rendered).not.toContain("hunter2");
      expect(rendered).not.toContain("SECRET");
      expect(rendered).not.toContain("sk-live");
    }
    expect(displayProgram([])).toBe("(no command)");
    expect(displayProgram([""])).toBe("(no command)");
    expect(displayProgram(["   "])).toBe("(no command)");
    expect(displayProgram(["a".repeat(5000)])).toBe("(no command)");
    expect(displayProgram(["a".repeat(64)])).toHaveLength(64);
  });
});

describe("the visibility records no command text", () => {
  it("names the program in the one-shot notice and stores nothing else", async () => {
    const notices: string[] = [];
    const ledger = createHostRunLedger({ limit: 5 });
    const host = createAuditedHostRunner({
      runner: { async exec() { return { exitCode: 0, signal: null, durationMs: 1, truncated: false, stdout: "", stderr: "" }; } },
      config: makeConfig(),
      audit: { write: () => undefined },
      sessionWorkspace: "/ws",
      env: { PATH: "/usr/bin" },
      targetStoreWorkspaceKey: () => undefined,
      guardMappingFor: async () => undefined,
      ledger,
      onFirstHostRun: (program) => void notices.push(program),
    });

    // The credential shapes that broke five earlier versions are all moot now: only the program is rendered.
    await host.run(["mysql", "-u", "root", "--password", "s3cr3t-value"]);
    await host.run(["curl", "-H", "Authorization: Bearer", "eyJhbGciOiJIUzI1NiJ9.SECRET"]);
    await host.run(["./ghp_abc123@github.com"]);

    expect(notices).toEqual(["mysql"]);
    expect(ledger.recent()).toEqual(["mysql", "curl", "(no command)"]);
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
    expect(records.every((record) => record.policyAuthorized === false)).toBe(true);
  });

  it("audits and counts an attempt whose mapping read failed", async () => {
    const records: AuditRecord[] = [];
    const ledger = createHostRunLedger({ limit: 5 });
    const host = createAuditedHostRunner({
      runner: { async exec() { return { exitCode: 0, signal: null, durationMs: 1, truncated: false, stdout: "", stderr: "" }; } },
      config: makeConfig(),
      audit: { write: (record) => void records.push(record) },
      sessionWorkspace: "/ws",
      env: { PATH: "/usr/bin" },
      targetStoreWorkspaceKey: () => "/ws/project-a",
      guardMappingFor: async () => { throw new Error("Docker executable '/nonexistent/docker' is unavailable."); },
      ledger,
      onFirstHostRun: () => undefined,
    });

    await expect(host.run(["systemctl", "restart", "docker"])).rejects.toThrow("is unavailable");
    expect(records).toHaveLength(1);
    expect(records[0]?.errorSummary).toContain("is unavailable");
    expect(ledger.count()).toBe(1);
  });
});

describe("the guard's own comparisons use the shared predicate", () => {
  it("recognises an equivalent spelling of a same-path mapping instead of refusing", () => {
    // Adversarial review: the skip compared RAW spellings while every other comparison normalized, so a mapping
    // written `/host/proj/` -> `//host/proj` refused a legitimate host command.
    for (const mapping of [
      { hostPath: "/host/proj/", containerPath: "//host/proj" },
      { hostPath: "/host/proj", containerPath: "/host/./proj" },
      { hostPath: "/host//proj", containerPath: "/host/proj" },
    ]) {
      expect(detectHostPathOnContainerSurface(["cat", "/host/proj/README.md"], mapping)).toBeUndefined();
    }
    // A mapping that is genuinely NOT a same-path mount still refuses the host path.
    expect(
      detectHostPathOnContainerSurface(["cat", "/host/proj/README.md"], {
        hostPath: "/host/proj",
        containerPath: "/workspaces/proj",
      }),
    ).toBe("/host/proj/README.md");
  });
});

describe("the segment predicate is shared and complete", () => {
  it("handles root bases, trailing slashes, `.`, `..` and prefix-sharing siblings", () => {
    expect(isAtOrUnder("/etc/passwd", "/")).toBe(true);
    expect(isAtOrUnder("/data/ws/x", "/data/ws")).toBe(true);
    expect(isAtOrUnder("/data/ws2/x", "/data/ws")).toBe(false);
    expect(isAtOrUnder("//host/proj/x", "/host/proj")).toBe(true);
    expect(isAtOrUnder("/host/././proj/x", "/host/proj")).toBe(true);
    expect(isAtOrUnder("/host/proj/..", "/host/proj")).toBe(false);
    expect(isSamePath("/data/ws/", "/data/ws")).toBe(true);
    expect(isSamePath("/data/ws", "/data/wss")).toBe(false);
  });

  it("is what both guards use", () => {
    const mapping = { hostPath: "/", containerPath: "/workspaces/proj" };
    expect(detectHostPathOnContainerSurface(["cat", "/etc/passwd"], mapping)).toBe("/etc/passwd");
    expect(findContainerPath(["cat", "/etc/passwd"], "/")).toBe("/etc/passwd");
    expect(findContainerPath(["cat", "/etc/passwd"], "/tmp")).toBeUndefined();
  });

  it("hostToContainer keeps an explicit join boundary", () => {
    expect(hostToContainer("/data/work/proj", { hostPath: "/", containerPath: "/workspace" })).toBe("/workspace/data/work/proj");
    expect(hostToContainer("/data/work/proj", { hostPath: "/data/work//", containerPath: "/workspace" })).toBe("/workspace/proj");
    expect(hostToContainer("/data/work", { hostPath: "/data/work", containerPath: "/workspace" })).toBe("/workspace");
    expect(hostToContainer("/elsewhere/x", { hostPath: "/data/work", containerPath: "/workspace" })).toBeUndefined();
  });
});

describe("the host-run ledger itself", () => {
  it("counts attempts, names the programs, and keeps only the latest few", () => {
    const ledger = createHostRunLedger({ limit: 3 });
    expect(ledger.count()).toBe(0);
    expect(ledger.recent()).toEqual([]);
    expect(ledger.summary()).toBe("no host commands in this session");

    ledger.record(["docker", "ps"]);
    expect(ledger.summary()).toBe("1 host command attempt this session — most recent: docker");
    ledger.record(["/usr/bin/systemctl", "restart", "docker"]);
    expect(ledger.count()).toBe(2);
    expect(ledger.recent()).toEqual(["docker", "(no command)"]);
    expect(ledger.summary()).toBe("2 host command attempts this session — most recent: docker | (no command)");

    // The bounded list keeps the LATEST entries (oldest first within the window) and never grows past the limit.
    ledger.record(["curl", "-H", "Authorization: Bearer", "eyJhbGciOiJIUzI1NiJ9.SECRET"]);
    ledger.record(["python3.11", "-m", "http.server"]);
    expect(ledger.recent()).toEqual(["(no command)", "curl", "python3.11"]);
    expect(ledger.recent().length).toBe(3);
    expect(ledger.count()).toBe(4);

    // No entry ever carries command text: the flag value and its secret are gone.
    expect(JSON.stringify(ledger.recent())).not.toContain("SECRET");
    expect(JSON.stringify(ledger.recent())).not.toContain("eyJhbGciOiJIUzI1NiJ9");

    // A new session starts from zero, including the one-shot notice gate.
    ledger.reset();
    expect(ledger.count()).toBe(0);
    expect(ledger.recent()).toEqual([]);
    expect(ledger.summary()).toBe("no host commands in this session");
    expect(ledger.noteFirstRun(["docker"])).toBe(true);
  });

  it("counts every attempt (including a refusal) and announces only the first", () => {
    const ledger = createHostRunLedger({ limit: 5 });
    // `noteFirstRun` is the withheld path's entry point: it gates the notice AND counts the attempt.
    expect(ledger.noteFirstRun(["docker"])).toBe(true);
    expect(ledger.noteFirstRun(["docker"])).toBe(false);
    expect(ledger.noteFirstRun(["/usr/bin/docker"])).toBe(false);
    expect(ledger.count()).toBe(3);
    ledger.record(["docker"]);
    expect(ledger.count()).toBe(4);
    expect(ledger.recent()).toEqual(["docker", "docker", "(no command)", "docker"]);
  });
});
