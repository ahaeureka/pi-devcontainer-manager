import { describe, expect, it } from "vitest";
import { resolveUserBash } from "../../extensions/index.js";

describe("resolveUserBash (user_bash fail-closed contract)", () => {
  it("returns a failing result when the runtime is not initialized (never host fallback)", () => {
    const resolved = resolveUserBash(undefined);
    // Must NOT return undefined (Pi would fall through to host local bash) and
    // must NOT be a throw (emitUserBash swallows handler errors -> host bash).
    expect("result" in resolved).toBe(true);
    if ("result" in resolved) {
      expect(resolved.result.exitCode).toBe(1);
      expect(resolved.result.cancelled).toBe(false);
      expect(resolved.result.output).toContain("not initialized");
    }
    expect("operations" in resolved).toBe(false);
  });

  it("returns the routed operations when the runtime is ready", () => {
    const bashOperations = { exec: async () => ({ exitCode: 0 }) };
    const resolved = resolveUserBash({
      bashOperations,
    } as never);
    expect("operations" in resolved).toBe(true);
    if ("operations" in resolved) {
      expect(resolved.operations).toBe(bashOperations);
    }
  });
});
