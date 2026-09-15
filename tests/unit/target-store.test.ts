import { describe, expect, it } from "vitest";
import { TargetStore, type TargetCandidate } from "../../src/target-store.js";
import { errorKindOf } from "../../src/errors.js";

function candidate(overrides: Partial<TargetCandidate> = {}): TargetCandidate {
  return {
    id: "a".repeat(64),
    name: "proj-a",
    workspaceKey: "/data/work/proj-a",
    state: "running",
    status: "Up 2 hours",
    ...overrides,
  };
}

function store(): TargetStore {
  return new TargetStore({ clock: () => "2026-08-31T00:00:00.000Z" });
}

describe("TargetStore selection state machine", () => {
  it("starts in none state", () => {
    const s = store();
    expect(s.snapshot().status).toBe("none");
    expect(s.snapshot().candidateId).toBeUndefined();
  });

  it("selects a valid candidate", async () => {
    const s = store();
    await s.select({ status: "selected-valid", candidate: candidate(), workspaceKey: "/data/work/proj-a" });
    expect(s.snapshot().status).toBe("selected-valid");
    expect(s.snapshot().candidateId).toBe("a".repeat(64));
  });

  it("clear returns to none", async () => {
    const s = store();
    await s.select({ status: "selected-valid", candidate: candidate(), workspaceKey: "/data/work/proj-a" });
    await s.clear();
    expect(s.snapshot().status).toBe("none");
  });

  it("refresh transitions through refreshing then endRefresh commits", async () => {
    const s = store();
    await s.select({ status: "selected-valid", candidate: candidate(), workspaceKey: "/data/work/proj-a" });
    await s.beginRefresh();
    expect(s.snapshot().status).toBe("refreshing");
    await s.endRefresh({ status: "selected-stopped", candidate: candidate({ state: "exited" }), workspaceKey: "/data/work/proj-a", detail: "container exited" });
    expect(s.snapshot().status).toBe("selected-stopped");
    expect(s.snapshot().detail).toBe("container exited");
  });

  it("beginRefresh from none stays none", async () => {
    const s = store();
    await s.beginRefresh();
    expect(s.snapshot().status).toBe("none");
  });

  it("serializes concurrent selections so the last commit wins atomically", async () => {
    const s = store();
    const first = s.select({ status: "selected-valid", candidate: candidate({ id: "1".repeat(64), name: "one" }), workspaceKey: "/w/one" });
    const second = s.select({ status: "selected-valid", candidate: candidate({ id: "2".repeat(64), name: "two" }), workspaceKey: "/w/two" });
    await Promise.all([first, second]);
    expect(s.snapshot().workspaceKey).toBe("/w/two");
    expect(s.snapshot().candidateId).toBe("2".repeat(64));
  });
});

describe("TargetStore.bind", () => {
  it("binds an immutable execution context from a valid selection", async () => {
    const s = store();
    await s.select({ status: "selected-valid", candidate: candidate(), workspaceKey: "/data/work/proj-a" });
    const ctx = s.bind();
    expect(ctx.workspaceKey).toBe("/data/work/proj-a");
    expect(ctx.candidateId).toBe("a".repeat(64));
    expect(ctx.candidateName).toBe("proj-a");
    expect(ctx.boundAt).toBe("2026-08-31T00:00:00.000Z");
  });

  it("a later selection switch cannot change an already-bound context", async () => {
    const s = store();
    await s.select({ status: "selected-valid", candidate: candidate({ id: "1".repeat(64), name: "one" }), workspaceKey: "/w/one" });
    const ctx = s.bind();
    await s.select({ status: "selected-valid", candidate: candidate({ id: "2".repeat(64), name: "two" }), workspaceKey: "/w/two" });
    expect(ctx.workspaceKey).toBe("/w/one");
    expect(ctx.candidateId).toBe("1".repeat(64));
  });


  it("throws target-refreshing for the transient refresh state", async () => {
    const s = store();
    await s.select({ status: "selected-valid", candidate: candidate(), workspaceKey: "/w/one" });
    await s.beginRefresh();
    try {
      s.bind();
      expect.unreachable();
    } catch (error) {
      expect(errorKindOf(error)).toBe("target-refreshing");
    }
  });

  it("throws no-candidate for none", () => {
    const s = store();
    try {
      s.bind();
      expect.unreachable();
    } catch (error) {
      expect(errorKindOf(error)).toBe("no-candidate");
    }
  });

  it("throws ambiguous-candidate for ambiguous selection", async () => {
    const s = store();
    await s.select({ status: "selected-ambiguous", workspaceKey: "/w/dup", detail: "multiple candidates" });
    try {
      s.bind();
      expect.unreachable();
    } catch (error) {
      expect(errorKindOf(error)).toBe("ambiguous-candidate");
    }
  });

  it("throws target-stopped for missing selection", async () => {
    const s = store();
    await s.select({ status: "selected-missing", workspaceKey: "/w/gone", detail: "no container" });
    try {
      s.bind();
      expect.unreachable();
    } catch (error) {
      expect(errorKindOf(error)).toBe("target-stopped");
    }
  });

  it("throws target-stopped for stopped selection", async () => {
    const s = store();
    await s.select({ status: "selected-stopped", candidate: candidate({ state: "exited" }), workspaceKey: "/w/stop" });
    try {
      s.bind();
      expect.unreachable();
    } catch (error) {
      expect(errorKindOf(error)).toBe("target-stopped");
    }
  });

  it("throws policy-denied for policy-denied selection", async () => {
    const s = store();
    await s.select({ status: "selected-policy-denied", workspaceKey: "/w/deny", detail: "workspace not allowed" });
    try {
      s.bind();
      expect.unreachable();
    } catch (error) {
      expect(errorKindOf(error)).toBe("policy-denied");
    }
  });

  it("throws target-stopped when the valid candidate is not running", async () => {
    const s = store();
    await s.select({ status: "selected-valid", candidate: candidate({ state: "exited" }), workspaceKey: "/w/stop" });
    try {
      s.bind();
      expect.unreachable();
    } catch (error) {
      expect(errorKindOf(error)).toBe("target-stopped");
    }
  });
});
