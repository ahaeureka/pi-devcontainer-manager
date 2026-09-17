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
import { redactCommandLine, redactText } from "../../src/policy.js";
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

describe("the notice and the ledger agree on redaction", () => {
  it("a host runner with a ledger announces a REDACTED first attempt, once", async () => {
    const notices: string[] = [];
    const ledger = createHostRunLedger({ limit: 5 });
    const records: AuditRecord[] = [];
    const host = createAuditedHostRunner({
      runner: {
        async exec() {
          return { exitCode: 0, signal: null, durationMs: 1, truncated: false, stdout: "", stderr: "" };
        },
      },
      config: makeConfig(),
      audit: { write: (record) => void records.push(record) },
      sessionWorkspace: "/ws",
      env: { PATH: "/usr/bin" },
      targetStoreWorkspaceKey: () => undefined,
      guardMappingFor: async () => undefined,
      ledger,
      onFirstHostRun: (rendered) => void notices.push(rendered),
    });

    // The counterexample must be the FIRST run: the notice fires once, so a second run never renders it
    // (the review-node pass caught exactly that in the previous version of this test).
    await host.run(["mysql", "-u", "root", "--password", "s3cr3t-value"]);
    await host.run(["curl", "-H", "Authorization: Bearer sk-live-abcdef123456", "https://e.test"]);

    // The notice is the operator-facing rendering: it must not be the one place a credential appears
    // in plaintext while the ledger and the audit trail redact it (adversarial review of the routing
    // hardening).
    expect(notices).toHaveLength(1);
    // The notice renders the FIRST run — the two-element flag-with-value secret.
    expect(notices[0]).not.toContain("s3cr3t-value");
    expect(notices[0]).toContain("[REDACTED]");
    expect(ledger.recent().join(" ")).not.toContain("s3cr3t-value");
    expect(ledger.recent().join(" ")).not.toContain("sk-live-abcdef123456");
    expect(records[0]?.commandText).toBeUndefined();
    // The ledger and the notice share the audit trail's rule: join, then redact.
    expect(ledger.recent().join(" ")).not.toContain("s3cr3t-value");
    expect(ledger.count()).toBe(2);
  });

  it("counts a refused attempt too, and still announces only the first", async () => {
    const notices: unknown[] = [];
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
      onFirstHostRun: (rendered) => void notices.push(rendered),
    });

    await expect(host.run(["hostname"])).rejects.toMatchObject({ kind: "policy-denied" });
    await expect(host.run(["hostname"])).rejects.toMatchObject({ kind: "policy-denied" });

    // A refused attempt is what the operator needs to see; it is counted, announced once, and recorded
    // as a denial.
    expect(ledger.count()).toBe(2);
    expect(notices).toHaveLength(1);
    expect(records.every((record) => record.policyAuthorized === false)).toBe(true);
  });
});

describe("redactCommandLine — both idioms", () => {
  it("hides a scheme value that is an element on its own AND a flag-with-value pair", () => {
    // Joined-only redaction pairs the value token with the NEXT element's scheme word and orphans that
    // element's own value (the verify-node pass): ["curl","-H","Bearer","Bearer sk-live-T"] joined is
    // `curl -H Bearer Bearer sk-live-T`, and rule 1 then eats only the first pair.
    expect(redactCommandLine(["curl", "-H", "Bearer", "Bearer sk-live-TKN"])).not.toContain("sk-live-TKN");
    // The element pass must not consume a scheme word that belongs to the NEXT element: rule 2 would
    // rewrite "Authorization: Bearer" and orphan the token that follows (adversarial review).
    expect(redactCommandLine(["curl", "-H", "Authorization: Bearer", "eyJhbGciOiJIUzI1NiJ9.SECRET"])).not.toContain(
      "eyJhbGciOiJIUzI1NiJ9.SECRET",
    );
    // Element-only redaction misses the flag-with-value idiom.
    expect(redactCommandLine(["mysql", "-u", "root", "--password", "s3cr3t-value"])).not.toContain("s3cr3t-value");
    // Neither pass may hide something it should not.
    expect(redactCommandLine(["echo", "hello", "world"])).toBe("echo hello world");
  });
});

describe("createHostRunLedger — redaction", () => {
  it("redacts the JOINED command line, so a flag-with-value secret is hidden too", () => {
    // The audit trail joins the argv and then redacts, so its flag-with-value rules see `--password
    // s3cr3t` as one string. Redacting each element separately lost that and printed the secret in the
    // operator notice (verify-node adversarial pass).
    const ledger = createHostRunLedger();
    const argv = ["mysql", "-u", "root", "--password", "s3cr3t-value"];

    expect(redactText(argv.join(" "))).not.toContain("s3cr3t-value");

    ledger.record(argv);
    expect(ledger.recent().join(" ")).not.toContain("s3cr3t-value");
  });

  it("never stores a credential verbatim", () => {
    const ledger = createHostRunLedger();
    ledger.record(["curl", "-H", "authorization: Bearer sk-live-abcdef123456", "https://example.test"]);

    // The summary is rendered to the operator; it must not become a plaintext copy of what the audit
    // trail captures by fingerprint only.
    expect(ledger.recent().join(" ")).not.toContain("sk-live-abcdef123456");
    expect(ledger.recent().join(" ")).toContain("[REDACTED]");
  });
});

describe("createHostRunLedger — capture policy", () => {
  it("keeps no command text when the session's capture policy is `none`", () => {
    const ledger = createHostRunLedger({ limit: 5 });
    ledger.setCapture("none");
    ledger.record(["systemctl", "restart", "my-private-service"]);

    // The audit record for the same call carries neither fingerprint nor text, so the summary must not
    // become the one place the operator can read what the policy declined to record.
    expect(ledger.recent()).toEqual([]);
    expect(ledger.summary()).toContain("not recorded");
    expect(ledger.count()).toBe(1);
  });
});

describe("the notice claims only what is true", () => {
  it("says the audit is disabled when enabled:false, and does not claim a record", async () => {
    const notices: string[] = [];
    const host = createAuditedHostRunner({
      runner: { async exec() { return { exitCode: 0, signal: null, durationMs: 1, truncated: false, stdout: "", stderr: "" }; } },
      config: makeConfig({ audit: { enabled: false, retentionDays: 90, commandCapture: "fingerprint-only" } }),
      audit: { write: () => undefined },
      sessionWorkspace: "/ws",
      env: { PATH: "/usr/bin" },
      targetStoreWorkspaceKey: () => undefined,
      guardMappingFor: async () => undefined,
      ledger: createHostRunLedger(),
      onFirstHostRun: (rendered) => void notices.push(rendered),
    });

    await host.run(["systemctl", "restart", "docker"]);

    // The runner hands over the rendering; the CALLER decides the claim, so this asserts the fact the
    // caller needs: the rendered command, with the secret hidden.
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("systemctl restart docker");
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
    expect(ledger.recent()).toEqual(["systemctl status docker", "hostname"]);
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
    expect(ledger.summary()).toContain("docker ps");
  });
});
