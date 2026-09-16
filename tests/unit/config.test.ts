import { describe, expect, it } from "vitest";
import { compileConfig, defaultAgentDirectory, defaultConfigPaths } from "../../src/config.js";

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

  it("rejects mistyped nested configuration instead of failing later", () => {
    expect(() => compileConfig({ discovery: { excludedDirectories: "node_modules" as never } })).toThrow("excludedDirectories");
    expect(() => compileConfig({ dockerPath: "" })).toThrow("dockerPath");
    expect(() => compileConfig({ devcontainerPath: 42 as never })).toThrow("devcontainerPath");
    expect(() => compileConfig({ audit: { enabled: "yes" as never } })).toThrow("audit.enabled");
    expect(() => compileConfig({ audit: { directory: "" } })).toThrow("audit.directory");
    expect(() => compileConfig({ destructive: { allowStop: "yes" as never } })).toThrow("destructive.allowStop");
    expect(() => compileConfig({ hostExecution: { allow: "yes" as never } })).toThrow("hostExecution.allow");
  });
});

describe("defaultConfigPaths", () => {
  it("follows Pi's config directory, honoring PI_CODING_AGENT_DIR", () => {
    expect(defaultAgentDirectory({}, "/home/me")).toBe("/home/me/.pi/agent");
    expect(defaultAgentDirectory({ PI_CODING_AGENT_DIR: "/data/work/pi" }, "/home/me")).toBe("/data/work/pi");
    // An empty override is not a usable directory: keep the default.
    expect(defaultAgentDirectory({ PI_CODING_AGENT_DIR: "" }, "/home/me")).toBe("/home/me/.pi/agent");
  });

  it("keeps the global config beside the extension auto-discovery folder", () => {
    expect(defaultConfigPaths("/work/project-a", { PI_CODING_AGENT_DIR: "/data/work/pi" }, "/home/me")).toEqual({
      globalPath: "/data/work/pi/extensions/pi-devcontainer-manager.json",
      projectPath: "/work/project-a/.pi/pi-devcontainer-manager.json",
    });
  });

  it("defaults to ~/.pi/agent when no override is set", () => {
    expect(defaultConfigPaths("/work/project-a", {}, "/home/me").globalPath).toBe(
      "/home/me/.pi/agent/extensions/pi-devcontainer-manager.json",
    );
  });
});

describe("hostExecution.allow (granted by default, withholdable)", () => {
  // The shipped posture is GRANT (product decision 2026-09-16). What matters just as much is that a
  // configuration can still withhold it — from either layer — and that nothing can widen a deny.
  const cases: { global?: boolean; project?: boolean; allow: boolean; why: string }[] = [
    { allow: true, why: "neither layer speaks: the shipped default grants it" },
    { global: true, allow: true, why: "the global file grants it" },
    { project: true, allow: true, why: "a project may also grant it" },
    { global: true, project: true, allow: true, why: "both grant it" },
    { global: false, allow: false, why: "the global file withholds it" },
    { project: false, allow: false, why: "the project file withholds it" },
    { global: true, project: false, allow: false, why: "a project deny wins over a global grant" },
    { global: false, project: true, allow: false, why: "a global deny cannot be widened by a project" },
  ];

  for (const testCase of cases) {
    it(`allow=${String(testCase.allow)} when global=${String(testCase.global)} and project=${String(testCase.project)} — ${testCase.why}`, () => {
      const config = compileConfig(
        testCase.global === undefined ? {} : { hostExecution: { allow: testCase.global } },
        testCase.project === undefined ? {} : { hostExecution: { allow: testCase.project } },
      );
      expect(config.hostExecution.allow).toBe(testCase.allow);
    });
  }

  it("grants host execution for a bare configuration, unlike every other gate", () => {
    const config = compileConfig();
    expect(config.hostExecution).toEqual({ allow: true });
    // The deny-by-default posture STAYS for the destructive operations and the roots allowlist; this
    // change is scoped to the host escape hatch and must not be read as a general loosening.
    expect(config.destructive).toEqual({ allowStop: false, allowRemove: false });
    expect(config.allowedWorkspaceRoots).toEqual([]);
    expect(config.environmentAllowlist).toEqual([]);
  });
});
