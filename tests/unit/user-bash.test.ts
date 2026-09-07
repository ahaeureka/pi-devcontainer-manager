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

  it("uses the full guidance message for `!` (in-context)", () => {
    const resolved = resolveUserBash(undefined, { command: "ls", cwd: "/w", excludeFromContext: false });
    expect("result" in resolved).toBe(true);
    if ("result" in resolved) {
      expect(resolved.result.output).toContain("DevContainer runtime is not initialized");
      expect(resolved.result.output).toContain("/reload");
    }
  });

  it("uses a terse message for `!!` (excluded from context)", () => {
    const resolved = resolveUserBash(undefined, { command: "ls", cwd: "/w", excludeFromContext: true });
    expect("result" in resolved).toBe(true);
    if ("result" in resolved) {
      expect(resolved.result.output).toContain("runtime not initialized");
      expect(resolved.result.output).not.toContain("DevContainer runtime is not initialized");
    }
  });

  it("still routes when runtime is ready regardless of excludeFromContext", () => {
    const bashOperations = { exec: async () => ({ exitCode: 0 }) };
    for (const excludeFromContext of [false, true]) {
      const resolved = resolveUserBash({ bashOperations } as never, { command: "ls", cwd: "/w", excludeFromContext });
      expect("operations" in resolved).toBe(true);
      if ("operations" in resolved) expect(resolved.operations).toBe(bashOperations);
    }
  });
});
