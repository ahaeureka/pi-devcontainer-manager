import { describe, expect, it } from "vitest";
import type { DiscoveryConfig } from "../../src/types.js";
import type { DockerContainer } from "../../src/runtime/docker-adapter.js";
import {
  buildWorkspaceRegistry,
  discoverHostConfigs,
  kindFor,
  mapContainerState,
  workspaceRootsFor,
  type DirectoryTraversal,
} from "../../src/runtime/host-discovery.js";

/**
 * In-memory fake filesystem for deterministic, filesystem-free tests.
 * `dirs` and `files` are sets of absolute paths (always "/"-rooted test
 * paths). `symlinks` maps a link path to its target for realpath identity.
 * stat on an unknown path throws (mirrors node:fs), which exercises the
 * diagnostic branches.
 */
interface FakeFs {
  dirs: Set<string>;
  files: Set<string>;
  symlinks: Map<string, string>;
}

function fakeTraversal(fs: FakeFs): DirectoryTraversal {
  return {
    readdir(path) {
      const names: string[] = [];
      for (const dir of fs.dirs) {
        if (dir.startsWith(`${path}/`) && dir.indexOf("/", path.length + 1) === -1) {
          names.push(dir.slice(path.length + 1));
        }
      }
      for (const file of fs.files) {
        if (file.startsWith(`${path}/`) && file.indexOf("/", path.length + 1) === -1) {
          names.push(file.slice(path.length + 1));
        }
      }
      if (!fs.dirs.has(path)) throw new Error(`ENOENT: no such directory '${path}'`);
      return names;
    },
    stat(path) {
      if (fs.dirs.has(path)) return { isDirectory: () => true, isFile: () => false };
      if (fs.files.has(path)) return { isDirectory: () => false, isFile: () => true };
      throw new Error(`ENOENT: no such file or directory '${path}'`);
    },
    realpath(path) {
      const resolved = fs.symlinks.get(path);
      if (resolved !== undefined) return resolved;
      // Realpath of a nested path that passes through a symlinked ancestor:
      // resolve the longest matching symlink prefix, otherwise identity.
      let best: string | undefined;
      for (const link of fs.symlinks.keys()) {
        if (path === link || path.startsWith(`${link}/`)) {
          if (best === undefined || link.length > best.length) best = link;
        }
      }
      if (best === undefined) return path;
      return `${fs.symlinks.get(best)}${path.slice(best.length)}`;
    },
  };
}

function fsTree(): FakeFs {
  return { dirs: new Set(), files: new Set(), symlinks: new Map() };
}

function addDir(fs: FakeFs, path: string): void {
  fs.dirs.add(path);
}

function addFile(fs: FakeFs, path: string): void {
  fs.files.add(path);
  // ensure all ancestor directories exist
  let parent = path.slice(0, path.lastIndexOf("/"));
  while (parent) {
    fs.dirs.add(parent);
    const next = parent.lastIndexOf("/");
    if (next === -1) break;
    parent = parent.slice(0, next);
  }
}

const DEFAULT_DISCOVERY: DiscoveryConfig = {
  maxDepth: 3,
  excludedDirectories: ["node_modules", ".git", ".pi", "dist", "build"],
};

function dockerCandidate(overrides: Partial<DockerContainer> & { workspaceKey: string }): DockerContainer {
  const base: DockerContainer = {
    id: "c1",
    name: "container-1",
    state: "running",
    status: "Up 2 hours",
    image: "ghcr.io/devcontainers/universal:latest",
    created: "2026-08-01T00:00:00Z",
    labels: { "devcontainer.local_folder": overrides.workspaceKey },
    localFolder: overrides.workspaceKey,
    workspaceKey: overrides.workspaceKey,
  };
  return { ...base, ...overrides };
}

describe("mapContainerState", () => {
  it("maps the four known states directly", () => {
    expect(mapContainerState("running")).toBe("running");
    expect(mapContainerState("exited")).toBe("exited");
    expect(mapContainerState("created")).toBe("created");
    expect(mapContainerState("paused")).toBe("paused");
  });

  it("collapses unknown and transient states to unknown", () => {
    expect(mapContainerState("restarting")).toBe("unknown");
    expect(mapContainerState("dead")).toBe("unknown");
    expect(mapContainerState("bogus")).toBe("unknown");
  });

  it("maps empty or absent state to undefined", () => {
    expect(mapContainerState("")).toBeUndefined();
    expect(mapContainerState(undefined)).toBeUndefined();
  });
});

describe("kindFor", () => {
  it("classifies the three locked forms", () => {
    expect(kindFor("/work/a/.devcontainer/devcontainer.json")).toBe(".devcontainer/devcontainer.json");
    expect(kindFor("/work/a/.devcontainer.json")).toBe("root/.devcontainer.json");
    expect(kindFor("/work/a/devcontainer.json")).toBe("root/devcontainer.json");
  });

  it("classifies by parent basename, not path depth", () => {
    expect(kindFor("/work/deep/.devcontainer/devcontainer.json")).toBe(".devcontainer/devcontainer.json");
  });
});

describe("workspaceRootsFor", () => {
  it("always includes the session cwd before allowed roots", () => {
    const roots = workspaceRootsFor("/work/session", ["/work/a", "/work/b"], (p) => p);
    expect(roots).toEqual(["/work/session", "/work/a", "/work/b"]);
  });

  it("deduplicates symlinked roots via realpath", () => {
    const roots = workspaceRootsFor("/work/session", ["/link/a", "/work/a"], (p) =>
      p === "/link/a" ? "/work/a" : p,
    );
    expect(roots).toEqual(["/work/session", "/work/a"]);
  });

  it("deduplicates an allowed root equal to the session cwd", () => {
    const roots = workspaceRootsFor("/work/a", ["/work/a"], (p) => p);
    expect(roots).toEqual(["/work/a"]);
  });
});

describe("discoverHostConfigs", () => {
  it("finds the folder form and assigns the workspace to its parent", () => {
    const fs = fsTree();
    addFile(fs, "/work/a/.devcontainer/devcontainer.json");
    const { projects, diagnostics } = discoverHostConfigs({
      sessionCwd: "/work",
      allowedWorkspaceRoots: [],
      discovery: DEFAULT_DISCOVERY,
      traversal: fakeTraversal(fs),
    });
    expect(projects).toEqual([
      {
        workspacePath: "/work/a",
        configPath: "/work/a/.devcontainer/devcontainer.json",
        configKind: ".devcontainer/devcontainer.json",
      },
    ]);
    expect(diagnostics).toEqual([]);
  });

  it("finds both root-level forms", () => {
    const fs = fsTree();
    addFile(fs, "/work/a/devcontainer.json");
    addFile(fs, "/work/b/.devcontainer.json");
    const { projects } = discoverHostConfigs({
      sessionCwd: "/work",
      allowedWorkspaceRoots: [],
      discovery: DEFAULT_DISCOVERY,
      traversal: fakeTraversal(fs),
    });
    expect(projects).toHaveLength(2);
    const kinds = projects.map((p) => p.configKind).sort();
    expect(kinds).toEqual(["root/.devcontainer.json", "root/devcontainer.json"]);
  });

  it("respects maxDepth and emits a pruning diagnostic only when pruning occurs", () => {
    const fs = fsTree();
    addFile(fs, "/work/deep/l1/l2/l3/devcontainer.json");
    const shallow = discoverHostConfigs({
      sessionCwd: "/work",
      allowedWorkspaceRoots: [],
      discovery: { ...DEFAULT_DISCOVERY, maxDepth: 2 },
      traversal: fakeTraversal(fs),
    });
    expect(shallow.projects).toEqual([]);
    expect(shallow.diagnostics).toEqual(["max depth 2 reached; not traversing /work/deep/l1/l2"]);
  });

  it("never traverses excluded directories", () => {
    const fs = fsTree();
    addFile(fs, "/work/proj/node_modules/dep/devcontainer.json");
    addFile(fs, "/work/proj/.git/devcontainer.json");
    addFile(fs, "/work/proj/dist/devcontainer.json");
    addFile(fs, "/work/proj/build/devcontainer.json");
    addFile(fs, "/work/proj/.pi/devcontainer.json");
    const { projects, diagnostics } = discoverHostConfigs({
      sessionCwd: "/work",
      allowedWorkspaceRoots: [],
      discovery: DEFAULT_DISCOVERY,
      traversal: fakeTraversal(fs),
    });
    expect(projects).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("skips hidden directories but preserves .devcontainer", () => {
    const fs = fsTree();
    addFile(fs, "/work/.cache/devcontainer.json");
    addFile(fs, "/work/a/.devcontainer/devcontainer.json");
    const { projects } = discoverHostConfigs({
      sessionCwd: "/work",
      allowedWorkspaceRoots: [],
      discovery: DEFAULT_DISCOVERY,
      traversal: fakeTraversal(fs),
    });
    expect(projects.map((p) => p.workspacePath)).toEqual(["/work/a"]);
  });

  it("does not traverse directories that resolve outside the allowed root", () => {
    const fs = fsTree();
    addFile(fs, "/work/a/devcontainer.json");
    addFile(fs, "/work/escape/devcontainer.json");
    // /work/escape is a symlink to /elsewhere (outside the anchored root)
    fs.symlinks.set("/work/escape", "/elsewhere");
    const { projects, diagnostics } = discoverHostConfigs({
      sessionCwd: "/work",
      allowedWorkspaceRoots: [],
      discovery: DEFAULT_DISCOVERY,
      traversal: fakeTraversal(fs),
    });
    expect(projects.map((p) => p.workspacePath)).toEqual(["/work/a"]);
    expect(diagnostics.join("\n")).toContain("/work/escape");
  });

  it("emits diagnostics for unreadable directories and unstatable entries", () => {
    const fs = fsTree();
    addDir(fs, "/work/a");
    addFile(fs, "/work/b/devcontainer.json");
    const base = fakeTraversal(fs);
    const { projects, diagnostics } = discoverHostConfigs({
      sessionCwd: "/work",
      allowedWorkspaceRoots: [],
      discovery: DEFAULT_DISCOVERY,
      traversal: {
        ...base,
        readdir: (path) => {
          if (path === "/work/a") throw new Error("EACCES: permission denied");
          if (path === "/work/b") return ["devcontainer.json", "ghost.json"];
          return base.readdir(path);
        },
        stat: (path) => {
          if (path === "/work/b/ghost.json") throw new Error("ENOENT: ghost");
          return base.stat(path);
        },
      },
    });
    // the real config under /work/b is still found
    expect(projects.map((p) => p.workspacePath)).toEqual(["/work/b"]);
    expect(diagnostics.join("\n")).toContain("cannot read directory /work/a: EACCES: permission denied");
    expect(diagnostics.join("\n")).toContain("cannot stat /work/b/ghost.json: ENOENT: ghost");
  });

  it("deterministically enumerates directories in sorted order", () => {
    const fs = fsTree();
    addFile(fs, "/work/z/.devcontainer/devcontainer.json");
    addFile(fs, "/work/a/devcontainer.json");
    const { projects } = discoverHostConfigs({
      sessionCwd: "/work",
      allowedWorkspaceRoots: [],
      discovery: DEFAULT_DISCOVERY,
      traversal: fakeTraversal(fs),
    });
    expect(projects.map((p) => p.workspacePath)).toEqual(["/work/a", "/work/z"]);
  });
});

describe("buildWorkspaceRegistry", () => {
  function registry(
    fs: FakeFs,
    docker: readonly DockerContainer[],
    overrides: Partial<{ sessionCwd: string; discovery: DiscoveryConfig; roots: readonly string[] }> = {},
  ) {
    return buildWorkspaceRegistry({
      options: {
        sessionCwd: overrides.sessionCwd ?? "/work",
        allowedWorkspaceRoots: overrides.roots ?? [],
        discovery: overrides.discovery ?? DEFAULT_DISCOVERY,
        traversal: fakeTraversal(fs),
      },
      dockerCandidates: docker,
    });
  }

  it("marks host + docker entries as both with container id and state", () => {
    const fs = fsTree();
    addFile(fs, "/work/a/.devcontainer/devcontainer.json");
    const docker = [dockerCandidate({ id: "aa11", workspaceKey: "/work/a", state: "running" })];
    const result = registry(fs, docker);
    expect(result.entries).toEqual([
      {
        workspacePath: "/work/a",
        configPath: "/work/a/.devcontainer/devcontainer.json",
        configKind: ".devcontainer/devcontainer.json",
        discoveredFrom: "both",
        containerId: "aa11",
        containerState: "running",
        containerCandidates: [{ id: "aa11", state: "running" }],
        configCandidates: [
          {
            configPath: "/work/a/.devcontainer/devcontainer.json",
            configKind: ".devcontainer/devcontainer.json",
          },
        ],
      },
    ]);
    expect(result.configOnly).toEqual([]);
    expect(result.orphanDockerCandidates).toEqual([]);
  });

  it("keeps config-only projects as first-class entries", () => {
    const fs = fsTree();
    addFile(fs, "/work/a/devcontainer.json");
    const result = registry(fs, []);
    expect(result.entries).toEqual([
      {
        workspacePath: "/work/a",
        configPath: "/work/a/devcontainer.json",
        configKind: "root/devcontainer.json",
        discoveredFrom: "host-config",
        configCandidates: [
          { configPath: "/work/a/devcontainer.json", configKind: "root/devcontainer.json" },
        ],
      },
    ]);
    expect(result.configOnly).toEqual(["/work/a"]);
  });

  it("retains docker-only candidates as placeholder entries plus diagnostics candidates", () => {
    const fs = fsTree();
    addFile(fs, "/work/a/devcontainer.json");
    const docker = [dockerCandidate({ id: "dd22", workspaceKey: "/work/foreign", state: "exited" })];
    const result = registry(fs, docker);
    expect(result.entries).toHaveLength(2);
    const orphan = result.entries.find((e) => e.workspacePath === "/work/foreign");
    expect(orphan).toEqual({
      workspacePath: "/work/foreign",
      configPath: "",
      configKind: "root/devcontainer.json",
      discoveredFrom: "docker-label",
      containerId: "dd22",
      containerState: "exited",
    });
    expect(result.orphanDockerCandidates).toEqual([docker[0]]);
  });

  it("unifies symlinked roots with Docker label real paths", () => {
    const fs = fsTree();
    addFile(fs, "/work/real/a/.devcontainer/devcontainer.json");
    fs.symlinks.set("/link", "/work/real/a");
    const docker = [dockerCandidate({ workspaceKey: "/work/real/a", state: "running" })];
    const result = registry(fs, docker, { sessionCwd: "/link" });
    expect(result.entries).toEqual([
      {
        workspacePath: "/work/real/a",
        configPath: "/work/real/a/.devcontainer/devcontainer.json",
        configKind: ".devcontainer/devcontainer.json",
        discoveredFrom: "both",
        containerId: "c1",
        containerState: "running",
        containerCandidates: [{ id: "c1", state: "running" }],
        configCandidates: [
          {
            configPath: "/work/real/a/.devcontainer/devcontainer.json",
            configKind: ".devcontainer/devcontainer.json",
          },
        ],
      },
    ]);
    expect(result.configOnly).toEqual([]);
  });

  it("flags ambiguity when more than one container for a workspace is running", () => {
    const fs = fsTree();
    addFile(fs, "/work/a/.devcontainer/devcontainer.json");
    const docker = [
      dockerCandidate({ id: "aa11", workspaceKey: "/work/a", state: "running" }),
      dockerCandidate({ id: "aa12", workspaceKey: "/work/a", state: "running" }),
    ];
    const result = registry(fs, docker);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.ambiguous).toBe(true);
    expect(result.entries[0]?.containerCandidates).toEqual([
      { id: "aa11", state: "running" },
      { id: "aa12", state: "running" },
    ]);
  });

  it("does not flag ambiguity when only one container is running", () => {
    const fs = fsTree();
    addFile(fs, "/work/a/.devcontainer/devcontainer.json");
    const docker = [
      dockerCandidate({ id: "aa11", workspaceKey: "/work/a", state: "running" }),
      dockerCandidate({ id: "aa12", workspaceKey: "/work/a", state: "exited" }),
    ];
    const result = registry(fs, docker);
    expect(result.entries[0]?.ambiguous).toBeUndefined();
    expect(result.entries[0]?.containerCandidates).toHaveLength(2);
  });

  it("collapses duplicate Docker labels into a single entry without duplication", () => {
    const fs = fsTree();
    addFile(fs, "/work/a/.devcontainer/devcontainer.json");
    const docker = [
      dockerCandidate({ id: "aa11", workspaceKey: "/work/a" }),
      dockerCandidate({ id: "aa12", workspaceKey: "/work/a" }),
    ];
    const result = registry(fs, docker);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.discoveredFrom).toBe("both");
    expect(result.entries[0]?.containerId).toBe("aa11");
    // both duplicates are diagnostics material when no host config exists
    const fs2 = fsTree();
    const result2 = registry(fs2, docker);
    expect(result2.orphanDockerCandidates.map((c) => c.id)).toEqual(["aa11", "aa12"]);
    expect(result2.entries.filter((e) => e.discoveredFrom === "docker-label")).toHaveLength(1);
  });

  it("maps restarting to unknown and omits containerState for empty state", () => {
    const fs = fsTree();
    addFile(fs, "/work/a/.devcontainer/devcontainer.json");
    const result = registry(fs, [
      dockerCandidate({ id: "aa11", workspaceKey: "/work/a", state: "restarting" }),
      dockerCandidate({ id: "aa12", workspaceKey: "/work/b", state: "" }),
    ]);
    const both = result.entries.find((e) => e.workspacePath === "/work/a");
    expect(both?.containerState).toBe("unknown");
    const empty = result.entries.find((e) => e.workspacePath === "/work/b");
    expect(empty?.containerState).toBeUndefined();
    expect("containerState" in (empty ?? {})).toBe(false);
  });

  it("skips docker candidates without a local_folder label and emits a diagnostic", () => {
    const fs = fsTree();
    addFile(fs, "/work/a/devcontainer.json");
    const docker: DockerContainer[] = [
      { ...dockerCandidate({ workspaceKey: "/work/a" }), workspaceKey: undefined, localFolder: undefined } as unknown as DockerContainer,
    ];
    const result = registry(fs, docker);
    expect(result.entries).toHaveLength(1);
    expect(result.diagnostics.join("\n")).toContain("no devcontainer.local_folder label");
  });

  it("prefers folder form over dot-file and root forms within one workspace", () => {
    const fs = fsTree();
    addFile(fs, "/work/a/.devcontainer/devcontainer.json");
    addFile(fs, "/work/a/.devcontainer.json");
    addFile(fs, "/work/a/devcontainer.json");
    const result = registry(fs, []);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.configKind).toBe(".devcontainer/devcontainer.json");
  });
});
