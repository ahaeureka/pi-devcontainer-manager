/**
 * Unit tests for the execution-context block injected into the system prompt.
 *
 * The block is how the agent learns the FACTS (host<->container mapping, which
 * surfaces exist) so it can choose the right environment itself. It is
 * presentation only — it must never fabricate a mapping or a target.
 */
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
