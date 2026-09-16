import { describe, expect, it } from "vitest";
import { compileConfig } from "../../src/config.js";
import { buildChildEnvironment, evaluatePolicy, isEnvironmentAllowed, isWorkspaceAllowed } from "../../src/policy.js";

describe("policy", () => {
  const config = compileConfig({
    allowedWorkspaceRoots: ["/repo"],
    environmentAllowlist: ["LANG", "TZ"],
    destructive: { allowStop: true },
  });

  it("requires a workspace below a configured root", () => {
    expect(isWorkspaceAllowed("/repo/app", config.allowedWorkspaceRoots)).toBe(true);
    expect(isWorkspaceAllowed("/other", config.allowedWorkspaceRoots)).toBe(false);
  });

  it("rejects Pi and secret environment names and throws on request", () => {
    expect(isEnvironmentAllowed("PI_SESSION_ID", config.environmentAllowlist)).toBe(false);
    expect(isEnvironmentAllowed("API_TOKEN", config.environmentAllowlist)).toBe(false);
    expect(() => buildChildEnvironment({ LANG: "C", PI_SESSION_ID: "secret" }, config.environmentAllowlist)).toThrow("not allowed");
  });

  it("snapshots destructive denial", () => {
    const snapshot = evaluatePolicy(config, { operation: "remove", initiator: "tool" });
    expect(snapshot.authorized).toBe(false);
    expect(snapshot.denialReason).toBe("destructive-operation-disabled");
  });

  it("requires host-execution policy grant", () => {
    // Host execution is granted by DEFAULT (the shipped posture) and withheld only by a
    // configuration, so both sides of the gate are asserted explicitly here rather than leaning on
    // the default.
    const granted = evaluatePolicy(
      compileConfig({ hostExecution: { allow: true } }),
      { operation: "host-exec", initiator: "host-escape" },
    );
    expect(granted.authorized).toBe(true);
    const denied = evaluatePolicy(
      compileConfig({ hostExecution: { allow: false } }),
      { operation: "host-exec", initiator: "host-escape" },
    );
    expect(denied.authorized).toBe(false);
    expect(denied.denialReason).toBe("host-execution-disabled");
  });
});
