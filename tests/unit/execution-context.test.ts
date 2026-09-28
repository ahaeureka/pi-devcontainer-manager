/**
 * Unit tests for the execution-context block injected into the system prompt.
 *
 * The block is how the agent learns the FACTS (host<->container mapping, which
 * surfaces exist) so it can choose the right environment itself. It is
 * presentation only — it must never fabricate a mapping or a target.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderExecutionContext } from "../../src/execution-context.js";

describe("renderExecutionContext", () => {
  it("returns undefined when there is no target and no mapping", () => {
    expect(renderExecutionContext({})).toBeUndefined();
  });

  it("returns undefined for an unselected target with no mapping", () => {
    expect(renderExecutionContext({ status: "none" })).toBeUndefined();
  });

  it("renders the host<->container mapping and the surface guidance", () => {
    const block = renderExecutionContext({
      candidateId: "abcdef0123456789",
      status: "selected-valid",
      mapping: { hostPath: "/data/work/proj", containerPath: "/app" },
    });
    expect(block).toBeDefined();
    expect(block).toContain("/data/work/proj");
    expect(block).toContain("/app");
    expect(block).toContain("devcontainer_host_exec");
    expect(block).toContain("devcontainer_exec");
    expect(block).toContain("INSIDE the container");
  });

  it("truncates the candidate id and includes the selection status", () => {
    const block = renderExecutionContext({ candidateId: "0123456789abcdef", status: "selected-valid" });
    expect(block).toContain("(0123456789ab)");
    expect(block).toContain("selected-valid");
  });

  it("lists container-only mounts when present", () => {
    const block = renderExecutionContext({
      candidateId: "c1",
      containerOnlyMounts: ["/app/.models", "cache-volume"],
    });
    expect(block).toContain("Container-only mounts");
    expect(block).toContain("/app/.models");
    expect(block).toContain("cache-volume");
  });

  it("omits the mounting line when no mapping is known", () => {
    const block = renderExecutionContext({ candidateId: "c1", status: "selected-stopped" });
    expect(block).toBeDefined();
    expect(block).not.toContain("Workspace mapping");
  });

  it("renders from a mapping even before a target is selected", () => {
    const block = renderExecutionContext({ mapping: { hostPath: "/h", containerPath: "/c" } });
    expect(block).toContain("/h");
    expect(block).toContain("/c");
  });
});

describe("renderExecutionContext — last lifecycle failure", () => {
  // `/devcontainer up|build|rebuild|stop|remove|setup` write their result to the OPERATOR UI, so the agent
  // otherwise never learns that the operation failed. This section is the channel that makes the agent
  // analyze the transcript on its next turn.
  it("renders a failed lifecycle operation even when NO target exists", () => {
    // The important case: a first `up` that fails leaves no container and no mapping, which is exactly when
    // the old "no target, no block" guard would have swallowed the failure.
    const block = renderExecutionContext({
      failure: { operation: "up", state: "failed", path: "/ws/.pi/devcontainer-manager/lifecycle-logs/2026-09-28T05-25-14.101Z-up-r2e7etga.log" },
    });

    expect(block).toBeDefined();
    expect(block).toContain("DevContainer lifecycle failure");
    expect(block).toContain("up");
    expect(block).toContain("failed");
    expect(block).toContain("/ws/.pi/devcontainer-manager/lifecycle-logs/2026-09-28T05-25-14.101Z-up-r2e7etga.log");
    expect(block).toMatch(/read|grep/i);
  });

  it("says the transcript is unavailable instead of naming a path that does not exist", () => {
    const block = renderExecutionContext({ failure: { operation: "build", state: "failed" } });

    expect(block).toContain("unavailable");
  });

  it("carries the recorded failure text, which is already the redacted operator value", () => {
    const block = renderExecutionContext({
      failure: { operation: "up", state: "failed", path: "/ws/.pi/lifecycle-logs/x-up-1.log", error: "exit 1" },
    });

    expect(block).toContain("exit 1");
  });

  it("does not mention a failure when there is none", () => {
    const block = renderExecutionContext({
      candidateId: "abcdef0123456789",
      status: "selected-valid",
    });

    expect(block).not.toContain("lifecycle failure");
  });
});

describe("the failure report is not gated on the activation decision", () => {
  // `before_agent_start` skips the context block while dormant (`surfacesFor(...).executionContext` is false).
  // The drain must NOT live behind that gate: a failure would stay queued and reappear several turns later as
  // a stale report. Asserted against the facade source because the Pi hook has no unit harness in this repo.
  const source = readFileSync(new URL("../../extensions/index.ts", import.meta.url), "utf8");

  it("drains the failure before the activation check", () => {
    const drain = source.indexOf("rt?.takeLifecycleFailure()");
    const gate = source.indexOf("surfacesFor(rt.activation.decision).executionContext");

    expect(drain).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(drain).toBeLessThan(gate);
  });

  it("injects the failure block even when the context block is skipped", () => {
    expect(source).toContain("renderExecutionContext({ failure })");
  });
});
