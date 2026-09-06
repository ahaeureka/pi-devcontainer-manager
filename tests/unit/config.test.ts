import { describe, expect, it } from "vitest";
import { compileConfig } from "../../src/config.js";

describe("compileConfig", () => {
  it("applies secure defaults", () => {
    const config = compileConfig();
    expect(config.routeMode).toBe("container-required");
    expect(config.audit.retentionDays).toBe(90);
    expect(config.allowedWorkspaceRoots).toEqual([]);
    expect(config.discovery.maxDepth).toBe(3);
  });

  it("does not let a project expand global roots, env allowlist, destructive, or host-exec grants", () => {
    const config = compileConfig(
      { allowedWorkspaceRoots: ["/repo"], environmentAllowlist: ["LANG", "TZ"], destructive: { allowStop: true }, hostExecution: { allow: true } },
      { allowedWorkspaceRoots: ["/repo", "/other"], environmentAllowlist: ["LANG", "AWS_SECRET_ACCESS_KEY"], destructive: { allowRemove: true }, hostExecution: { allow: true } },
    );
    expect(config.allowedWorkspaceRoots).toEqual(["/repo"]);
    expect(config.environmentAllowlist).toEqual(["LANG"]);
    expect(config.destructive).toEqual({ allowStop: true, allowRemove: false });
    expect(config.hostExecution.allow).toBe(true);
  });

  it("lets a project narrow global settings", () => {
    const config = compileConfig(
      { allowedWorkspaceRoots: ["/repo"], environmentAllowlist: ["LANG", "TZ"], audit: { retentionDays: 30, commandCapture: "redacted-text" }, discovery: { maxDepth: 5 } },
      { environmentAllowlist: ["LANG"], audit: { retentionDays: 7, commandCapture: "fingerprint-only" }, discovery: { maxDepth: 2 } },
    );
    expect(config.environmentAllowlist).toEqual(["LANG"]);
    expect(config.audit.retentionDays).toBe(7);
    expect(config.audit.commandCapture).toBe("fingerprint-only");
    expect(config.discovery.maxDepth).toBe(2);
  });

  it("rejects malformed configuration", () => {
    expect(() => compileConfig({ routeMode: "unsafe" as never })).toThrow("routeMode");
    expect(() => compileConfig({ discovery: { maxDepth: 0 } })).toThrow("maxDepth");
    expect(() => compileConfig({ audit: { commandCapture: "plaintext" as never } })).toThrow("commandCapture");
  });
});
