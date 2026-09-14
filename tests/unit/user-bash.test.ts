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
    const engaged = { bashOperations, activation: { decision: { active: true, reason: "workspace-config" } } };
    for (const excludeFromContext of [false, true]) {
      const resolved = resolveUserBash(engaged as never, { command: "ls", cwd: "/w", excludeFromContext });
      expect("operations" in (resolved ?? {})).toBe(true);
      if (resolved !== undefined && "operations" in resolved) expect(resolved.operations).toBe(bashOperations);
    }
  });

  it("hands `!`/`!!` back to Pi's local bash while the session is dormant", () => {
    const dormant = {
      bashOperations: { exec: async () => ({ exitCode: 0 }) },
      activation: { decision: { active: false, reason: "no-evidence" } },
    };
    // Undefined is the CORRECT answer here: Pi runs the command with its own local
    // bash, which is exactly what dormancy means (AC-4). The unknown-runtime case
    // above must stay a hard stop, so the two paths are asserted separately.
    for (const excludeFromContext of [false, true]) {
      expect(resolveUserBash(dormant as never, { command: "ls", cwd: "/w", excludeFromContext })).toBeUndefined();
    }
  });
});
