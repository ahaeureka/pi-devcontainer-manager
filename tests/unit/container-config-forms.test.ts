import { describe, expect, it } from "vitest";
import { NodeDevcontainerAdapter } from "../../src/runtime/devcontainer-adapter.js";
import {
  buildWorkspaceRegistry,
  discoverHostConfigs,
  kindFor,
  workspacePathFor,
  type DirectoryTraversal,
} from "../../src/runtime/host-discovery.js";
import type {
  ProcessResult,
  ProcessRunner,
  ProcessRunnerOptions,
} from "../../src/runtime/process-runner.js";

/**
 * Config-form contract (AC-1 / AC-2).
 *
 * The Dev Containers CLI (0.88.0) resolves two forms by default —
 * `.devcontainer/devcontainer.json`, then `.devcontainer.json` — and a *named*
 * configuration `.devcontainer/<name>/devcontainer.json` only when it is given
 * `--config <path>`. Verified with:
 *
 *   devcontainer read-configuration --workspace-folder <dir>
 *
 * These tests pin the extension's side of that contract. The real-CLI leg lives
 * in the capability-gated integration suite.
 */

const discovery = { maxDepth: 3, excludedDirectories: ["node_modules", ".git", ".pi", "dist", "build"] } as const;

/**
 * Minimal in-memory tree. `stat`/`readdir` answer for the directory structure
 * implied by the given absolute file paths, so tests never touch the real FS.
 */
function fakeTraversal(files: readonly string[]): DirectoryTraversal {
  const fileSet = new Set(files);
  const directories = new Set<string>(["/"]);
  for (const file of files) {
    const parts = file.split("/").filter((part) => part.length > 0);
    // Ancestor directories only — the last segment is the file itself, and
    // treating it as a directory would make the walker skip it as hidden.
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
    stat: (path) => ({
      isDirectory: () => directories.has(path),
      isFile: () => fileSet.has(path),
    }),
    realpath: (path) => path,
  };
}

function discover(files: readonly string[], sessionCwd = "/repo") {
  return discoverHostConfigs({
    sessionCwd,
    allowedWorkspaceRoots: [],
    discovery,
    traversal: fakeTraversal(files),
  });
}

describe("discoverHostConfigs — configuration forms", () => {
  it("still discovers the three forms the CLI resolves natively", () => {
    const local = discover(["/repo/.devcontainer/devcontainer.json"]);
    expect(local.projects.map((project) => project.configPath)).toEqual([
      "/repo/.devcontainer/devcontainer.json",
    ]);
    expect(local.projects[0]?.workspacePath).toBe("/repo");

    const dotfile = discover(["/repo/.devcontainer.json"]);
    expect(dotfile.projects[0]?.workspacePath).toBe("/repo");

    const root = discover(["/repo/devcontainer.json"]);
    expect(root.projects[0]?.workspacePath).toBe("/repo");
  });

  it("discovers a named configuration inside .devcontainer/<name>/", () => {
    const { projects } = discover([
      "/repo/.devcontainer/python/devcontainer.json",
      "/repo/.devcontainer/node/devcontainer.json",
    ]);
    expect(projects.map((project) => project.configPath).sort()).toEqual([
      "/repo/.devcontainer/node/devcontainer.json",
      "/repo/.devcontainer/python/devcontainer.json",
    ]);
    // A named configuration belongs to the folder that owns .devcontainer/.
    for (const project of projects) {
      expect(project.workspacePath).toBe("/repo");
      expect(project.configKind).toBe(".devcontainer/<name>/devcontainer.json");
    }
  });

  it("does not leak .devcontainer internals as workspaces", () => {
    const { projects } = discover([
      "/repo/.devcontainer/devcontainer.json",
      "/repo/.devcontainer/python/devcontainer.json",
    ]);
    expect(projects.map((project) => project.workspacePath)).toEqual(["/repo", "/repo"]);
  });
});

describe("kindFor / workspacePathFor — named configurations", () => {
  it("classifies .devcontainer/<name>/devcontainer.json as a named configuration", () => {
    expect(kindFor("/repo/.devcontainer/python/devcontainer.json")).toBe(
      ".devcontainer/<name>/devcontainer.json",
    );
  });

  it("keeps the existing classifications", () => {
    expect(kindFor("/repo/.devcontainer/devcontainer.json")).toBe(".devcontainer/devcontainer.json");
    expect(kindFor("/repo/.devcontainer.json")).toBe("root/.devcontainer.json");
    expect(kindFor("/repo/devcontainer.json")).toBe("root/devcontainer.json");
  });

  it("maps a named configuration to the workspace that owns .devcontainer/", () => {
    expect(workspacePathFor("/repo/.devcontainer/python/devcontainer.json")).toBe("/repo");
    expect(workspacePathFor("/repo/.devcontainer/devcontainer.json")).toBe("/repo");
    expect(workspacePathFor("/repo/.devcontainer.json")).toBe("/repo");
    expect(workspacePathFor("/repo/devcontainer.json")).toBe("/repo");
  });
});

interface CallRecord {
  file: string;
  args: readonly string[];
  options: ProcessRunnerOptions;
}

function fakeRunner(results: ProcessResult[]): { runner: ProcessRunner; calls: CallRecord[] } {
  const calls: CallRecord[] = [];
  const runner: ProcessRunner = {
    exec(file, args, options) {
      calls.push({ file, args, options });
      const next = results.shift();
      if (next === undefined) return Promise.reject(new Error("unexpected runner call"));
      return Promise.resolve(next);
    },
  };
  return { runner, calls };
}

function makeAdapter(runner: ProcessRunner) {
  return new NodeDevcontainerAdapter(runner, { devcontainerPath: "devcontainer", env: { PATH: "/usr/bin" }, cwd: "/ws" });
}

const ok = (exitCode: number): ProcessResult => ({ exitCode, signal: null, durationMs: 5, truncated: false });

/**
 * AC-2: a *named* configuration is only resolvable when the CLI is told which
 * one to use. `up`, `build`, and `exec` must therefore carry `--config <path>`
 * — and must keep the zero-flag argv when the workspace uses the default lookup.
 */
describe("adapter argv — named configuration", () => {
  function adapterEmitting(stdout: string) {
    const { runner, calls } = fakeRunner([ok(0), ok(0)]);
    const adapter = makeAdapter(runner);
    const original = runner.exec.bind(runner);
    let first = true;
    (runner as unknown as { exec: ProcessRunner["exec"] }).exec = (file, args, options) => {
      // Only the first call is assumed to print a JSON document.
      if (first) options.onData?.(Buffer.from(stdout));
      first = false;
      return original(file, args, options);
    };
    return { adapter, calls };
  }

  it("adds --config to up when a named configuration is selected", async () => {
    const { adapter, calls } = adapterEmitting('{"outcome":"success","containerId":"c1"}\n ');
    const configPath = "/ws/.devcontainer/python/devcontainer.json";
    await adapter.up("/ws", { configPath });
    expect(calls[0]!.args).toEqual(["up", "--workspace-folder", "/ws", "--config", configPath]);
  });

  it("adds --config to build and to exec, keeping it before the -- separator", async () => {
    const { adapter, calls } = adapterEmitting('{"outcome":"success","imageName":"i:t"}\n ');
    const configPath = "/ws/.devcontainer/node/devcontainer.json";
    await adapter.build("/ws", { configPath });
    await adapter.exec("/ws", "c1", "npm", ["test"], { configPath });
    expect(calls[0]!.args).toEqual(["build", "--workspace-folder", "/ws", "--config", configPath]);
    expect(calls[1]!.args).toEqual([
      "exec",
      "--workspace-folder", "/ws",
      "--container-id", "c1",
      "--config", configPath,
      "--", "npm", "test",
    ]);
  });

  it("keeps the zero-flag argv when no configuration is selected", async () => {
    const { adapter, calls } = adapterEmitting('{"outcome":"success","containerId":"c1"}\n ');
    await adapter.up("/ws");
    expect(calls[0]!.args).toEqual(["up", "--workspace-folder", "/ws"]);
  });
});

/**
 * AC-2: one workspace can own several configurations (an unnamed default plus
 * any number of named ones). The registry keeps them all so the operator can
 * pick one, with the CLI's own default-lookup form as the primary entry.
 */
describe("buildWorkspaceRegistry — configuration candidates", () => {
  function registry(files: readonly string[]) {
    return buildWorkspaceRegistry({
      options: { sessionCwd: "/repo", allowedWorkspaceRoots: [], discovery, traversal: fakeTraversal(files) },
      dockerCandidates: [],
    });
  }

  it("records every configuration of a workspace, default lookup first", () => {
    const { entries } = registry([
      "/repo/.devcontainer/devcontainer.json",
      "/repo/.devcontainer/python/devcontainer.json",
      "/repo/.devcontainer/node/devcontainer.json",
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.configPath).toBe("/repo/.devcontainer/devcontainer.json");
    expect(entries[0]?.configCandidates?.map((candidate) => candidate.configPath)).toEqual([
      "/repo/.devcontainer/devcontainer.json",
      "/repo/.devcontainer/node/devcontainer.json",
      "/repo/.devcontainer/python/devcontainer.json",
    ]);
  });

  it("still lists named configurations when the workspace has no unnamed one", () => {
    const { entries } = registry([
      "/repo/.devcontainer/python/devcontainer.json",
      "/repo/.devcontainer/node/devcontainer.json",
    ]);
    expect(entries[0]?.configCandidates?.map((candidate) => candidate.configPath)).toEqual([
      "/repo/.devcontainer/node/devcontainer.json",
      "/repo/.devcontainer/python/devcontainer.json",
    ]);
    expect(entries[0]?.configCandidates?.every((candidate) => candidate.configKind === ".devcontainer/<name>/devcontainer.json")).toBe(true);
  });
});
