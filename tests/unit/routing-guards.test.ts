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

  it("says nothing when the mapping mounts the host path at the same path", () => {
    // There the host path IS the container path, so using it is correct.
    expect(detectHostPathOnContainerSurface(["cat", "/ws/x"], { hostPath: "/ws", containerPath: "/ws" })).toBeUndefined();
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

  it("reports the first run exactly once per session", () => {
    const ledger = createHostRunLedger({ limit: 5 });

    expect(ledger.noteFirstRun(["hostname"])).toBe(true);
    expect(ledger.noteFirstRun(["hostname"])).toBe(false);
    expect(ledger.count()).toBe(2);
  });

  it("summarises count and recency for the status surface", () => {
    const ledger = createHostRunLedger({ limit: 3 });
    ledger.record(["docker", "ps"]);

    expect(ledger.summary()).toContain("1 host command");
    expect(ledger.summary()).toContain("docker ps");
  });
});
