import { describe, expect, it, vi } from "vitest";
import { decideActivation } from "../../src/activation.js";
import {
  compileConfig,
  describeConfigDiagnostics,
  loadConfigWithDiagnostics,
} from "../../src/config.js";
import { createCommandHandlers, type CommandContextLike, type CommandServices } from "../../src/commands.js";
import type { TargetStore } from "../../src/target-store.js";
import { workspaceHasConfig, type DirectoryTraversal } from "../../src/runtime/host-discovery.js";

/**
 * AC-3 / AC-4: activation has to be decided from evidence, per session, so the
 * extension can stand down completely in a workspace that is not a DevContainer
 * project instead of taking over `bash` and failing closed.
 *
 *   never > always > workspace configuration > running labelled container >
 *   explicit selection > dormant
 */

/** Minimal in-memory tree (ancestor directories only, files as leaves). */
function fakeTraversal(files: readonly string[]): DirectoryTraversal {
  const fileSet = new Set(files);
  const directories = new Set<string>(["/"]);
  for (const file of files) {
    const parts = file.split("/").filter((part) => part.length > 0);
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(`/${parts.slice(0, index).join("/")}`);
    }
  }
  const children = (path: string): string[] => {
    const prefix = path === "/" ? "/" : `${path}/`;
    const names = new Set<string>();
    for (const entry of [...directories, ...fileSet]) {
      if (!entry.startsWith(prefix)) continue;
      const rest = entry.slice(prefix.length);
      if (rest.length > 0 && !rest.includes("/")) names.add(rest);
    }
    return [...names];
  };
  return {
    readdir: (path) => children(path),
    stat: (path) => ({ isDirectory: () => directories.has(path), isFile: () => fileSet.has(path) }),
    realpath: (path) => path,
  };
}

describe("decideActivation", () => {
  const noEvidence = {
    workspaceHasConfig: false,
    workspaceHasRunningContainer: false,
    hasExplicitSelection: false,
  };

  it("lets `never` outrank every other signal", () => {
    const decision = decideActivation({
      activation: "never",
      workspaceHasConfig: true,
      workspaceHasRunningContainer: true,
      hasExplicitSelection: true,
    });
    expect(decision).toEqual({ active: false, reason: "config-never" });
  });

  it("activates on `always` without any local evidence", () => {
    expect(decideActivation({ activation: "always", ...noEvidence })).toEqual({
      active: true,
      reason: "config-always",
    });
  });

  it("activates because the workspace owns a configuration", () => {
    expect(decideActivation({ activation: "workspace", ...noEvidence, workspaceHasConfig: true })).toEqual({
      active: true,
      reason: "workspace-config",
    });
  });

  it("activates on a running labelled container when there is no configuration", () => {
    expect(
      decideActivation({ activation: "workspace", ...noEvidence, workspaceHasRunningContainer: true }),
    ).toEqual({ active: true, reason: "running-container" });
  });

  it("activates on an explicit selection", () => {
    expect(decideActivation({ activation: "workspace", ...noEvidence, hasExplicitSelection: true })).toEqual({
      active: true,
      reason: "explicit-selection",
    });
  });

  it("prefers the workspace configuration over the container signal", () => {
    expect(
      decideActivation({ activation: "workspace", ...noEvidence, workspaceHasConfig: true, workspaceHasRunningContainer: true }),
    ).toEqual({ active: true, reason: "workspace-config" });
  });

  it("stays dormant when nothing is found", () => {
    expect(decideActivation({ activation: "workspace", ...noEvidence })).toEqual({
      active: false,
      reason: "no-evidence",
    });
  });
});

describe("workspaceHasConfig", () => {
  it("recognizes every accepted form at the workspace root", () => {
    const forms = [
      ".devcontainer/devcontainer.json",
      ".devcontainer/python/devcontainer.json",
      ".devcontainer.json",
      "devcontainer.json",
    ];
    for (const relative of forms) {
      expect(workspaceHasConfig("/repo", fakeTraversal([`/repo/${relative}`])), relative).toBe(true);
    }
  });

  it("is false for a workspace without any configuration", () => {
    expect(workspaceHasConfig("/repo", fakeTraversal(["/repo/README.md", "/repo/src/index.ts"]))).toBe(false);
  });

  it("does not mistake a nested project's configuration for the workspace's own", () => {
    expect(workspaceHasConfig("/repo", fakeTraversal(["/repo/apps/web/.devcontainer/devcontainer.json"]))).toBe(false);
  });
});

describe("activation configuration", () => {
  it("defaults to workspace-scoped activation", () => {
    expect(compileConfig().activation).toBe("workspace");
  });

  it("lets a project override the global mode", () => {
    expect(compileConfig({ activation: "always" }, { activation: "never" }).activation).toBe("never");
    expect(compileConfig({}, { activation: "never" }).activation).toBe("never");
    expect(compileConfig({}, { activation: "always" }).activation).toBe("always");
  });

  it("rejects an unknown mode", () => {
    expect(() => compileConfig({ activation: "sometimes" as never })).toThrow("activation");
  });
});

/**
 * AC-7: two failures used to be invisible — a project file that is never read because
 * the project is untrusted, and a project value silently clamped by a host-protective
 * ceiling. Both must now be reported.
 */
describe("describeConfigDiagnostics", () => {
  it("reports a project file that is ignored because the project is not trusted", () => {
    const diagnostics = describeConfigDiagnostics({}, {}, {
      projectTrusted: false,
      projectPath: "/ws/project-a/.pi/pi-devcontainer-manager.json",
      projectFileExists: true,
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("/ws/project-a/.pi/pi-devcontainer-manager.json");
    expect(diagnostics[0]).toContain("not trusted");
  });

  it("says nothing when an untrusted project has no configuration file", () => {
    expect(
      describeConfigDiagnostics({}, {}, { projectTrusted: false, projectPath: "/ws/project-a/.pi/x.json", projectFileExists: false }),
    ).toEqual([]);
  });

  it("reports a project value clamped by a ceiling, with requested and effective values", () => {
    const diagnostics = describeConfigDiagnostics(
      { allowedWorkspaceRoots: ["/ws"], maxTimeoutSeconds: 60 },
      { allowedWorkspaceRoots: ["/ws", "/elsewhere"], maxTimeoutSeconds: 600 },
      { projectTrusted: true },
    );
    expect(diagnostics.join("\n")).toContain("allowedWorkspaceRoots");
    expect(diagnostics.join("\n")).toContain("/elsewhere");
    expect(diagnostics.join("\n")).toContain("maxTimeoutSeconds");
    expect(diagnostics.join("\n")).toContain("600");
    expect(diagnostics.join("\n")).toContain("60");
  });

  it("says nothing when a project only narrows within the granted ceilings", () => {
    expect(
      describeConfigDiagnostics(
        { allowedWorkspaceRoots: ["/ws", "/other"], maxTimeoutSeconds: 900 },
        { allowedWorkspaceRoots: ["/ws"], maxTimeoutSeconds: 300 },
        { projectTrusted: true },
      ),
    ).toEqual([]);
  });
});

describe("loadConfigWithDiagnostics", () => {
  it("returns the effective config plus the ignored-file diagnostic", () => {
    const paths = { globalPath: "/missing/global.json", projectPath: "/ws/.pi/pi-devcontainer-manager.json" };
    const { config, diagnostics } = loadConfigWithDiagnostics(paths, {
      projectTrusted: false,
      // Path-aware: a reader that answers for every path would also populate the
      // global file, and this test is about the project file being ignored.
      readFile: (path: string) => {
        if (path === paths.projectPath) return "{\"activation\": \"never\"}";
        throw new Error("ENOENT");
      },
    });
    // The untrusted project's `never` must NOT take effect, and must be explained.
    expect(config.activation).toBe("workspace");
    expect(diagnostics.some((line) => line.includes("not trusted"))).toBe(true);
  });
});

/**
 * AC-5: the operator needs a way back to the host. `/devcontainer off` clears the
 * selection and returns the session to the dormant state.
 */
describe("/devcontainer off", () => {
  function services(targetStore: Partial<TargetStore>): CommandServices {
    return {
      config: compileConfig(),
      targetStore: { clear: vi.fn(async () => {}), ...targetStore } as unknown as TargetStore,
      execution: {} as never,
      registry: async () => ({ entries: [], diagnostics: [] }),
      refreshRegistry: async () => ({ entries: [], diagnostics: [] }),
      logs: async () => ({ exitCode: 0, output: "", truncated: false }),
    } as unknown as CommandServices;
  }

  const ctx = { cwd: "/ws/project-a", hasUI: true, ui: { select: vi.fn(), confirm: vi.fn(), notify: vi.fn() } } as unknown as CommandContextLike;

  it("clears the selection and tells the operator the host surfaces are back", async () => {
    const targetStore = { clear: vi.fn(async () => {}) } as Partial<TargetStore>;
    const handlers = createCommandHandlers(services(targetStore));
    const result = await handlers["off"]!("", ctx);
    expect(targetStore.clear).toHaveBeenCalledTimes(1);
    expect(result.text).toContain("host");
  });
});

describe("decideActivation with a persisted opt-out (L1-02)", () => {
  const dormantEvidence = {
    activation: "workspace" as const,
    workspaceHasConfig: false,
    workspaceHasRunningContainer: false,
    hasExplicitSelection: false,
  };

  it("stays dormant when the operator turned the extension off, even in a DevContainer workspace", () => {
    // `/devcontainer off` is persisted as an intent. Without this the reload would re-engage from
    // the workspace evidence and silently undo the opt-out.
    expect(
      decideActivation({
        ...dormantEvidence,
        workspaceHasConfig: true,
        workspaceHasRunningContainer: true,
        hasExplicitSelection: true,
        optedOut: true,
      }),
    ).toEqual({ active: false, reason: "opted-out" });
  });

  it("lets `always` outrank the opt-out (the operator's configuration says take over)", () => {
    expect(decideActivation({ ...dormantEvidence, activation: "always", optedOut: true })).toEqual({
      active: true,
      reason: "config-always",
    });
  });

  it("ignores the opt-out when it is not set", () => {
    expect(decideActivation({ ...dormantEvidence, workspaceHasConfig: true })).toEqual({
      active: true,
      reason: "workspace-config",
    });
  });
});
