import { describe, expect, it } from "vitest";
import {
  buildPathMapping,
  expandLocalWorkspaceFolder,
  hostToContainer,
  parseWorkspaceMount,
  readConfigFacts,
} from "../../src/path-mapper.js";

describe("parseWorkspaceMount", () => {
  it("parses source/target/type", () => {
    const m = parseWorkspaceMount("source=${localWorkspaceFolder},target=/app,type=bind");
    expect(m.source).toBe("${localWorkspaceFolder}");
    expect(m.target).toBe("/app");
    expect(m.type).toBe("bind");
  });

  it("returns empty for absent mount", () => {
    expect(parseWorkspaceMount(undefined)).toEqual({});
    expect(parseWorkspaceMount("")).toEqual({});
  });
});

describe("expandLocalWorkspaceFolder", () => {
  it("expands the variable to the config dir", () => {
    expect(expandLocalWorkspaceFolder("${localWorkspaceFolder}", "/data/w")).toBe("/data/w");
    expect(expandLocalWorkspaceFolder("$localWorkspaceFolder", "/data/w")).toBe("/data/w");
  });
});

describe("buildPathMapping", () => {
  it("prefers workspaceMount source->target", () => {
    const m = buildPathMapping("/data/w/proj", "/workspaces/x", "source=${localWorkspaceFolder},target=/app,type=bind");
    expect(m).toEqual({ hostPath: "/data/w/proj", containerPath: "/app" });
  });

  it("falls back to workspaceFolder with config dir as host side", () => {
    const m = buildPathMapping("/data/w/proj", "/workspaces/proj", undefined);
    expect(m).toEqual({ hostPath: "/data/w/proj", containerPath: "/workspaces/proj" });
  });

  it("returns undefined when nothing is declared (no guessing)", () => {
    expect(buildPathMapping("/data/w/proj", undefined, undefined)).toBeUndefined();
    expect(buildPathMapping("/data/w/proj", undefined, "source=/x,target=/y,type=volume")).toBeUndefined();
  });
});

describe("hostToContainer", () => {
  const m = { hostPath: "/data/w/proj", containerPath: "/app" };
  it("maps exact and nested host paths", () => {
    expect(hostToContainer("/data/w/proj", m)).toBe("/app");
    expect(hostToContainer("/data/w/proj/src/main.ts", m)).toBe("/app/src/main.ts");
  });
  it("returns undefined for paths outside the mapping", () => {
    expect(hostToContainer("/data/w/other", m)).toBeUndefined();
    expect(hostToContainer("/data/w/proj2", m)).toBeUndefined();
  });
  it("returns undefined without a mapping", () => {
    expect(hostToContainer("/data/w/proj", undefined)).toBeUndefined();
  });
});

describe("readMappingFromText", () => {
  it("derives the mapping from a commented config with trailing commas", () => {
    const read = readConfigFacts(
      "/ws/proj",
      `{
  // the workspace mount decides what the agent sees
  "workspaceMount": "source=\${localWorkspaceFolder},target=/app,type=bind",
  "runArgs": ["--init",],
}`,
    );

    expect(read).toEqual({ kind: "ok", facts: { mapping: { hostPath: "/ws/proj", containerPath: "/app" } } });
  });

  it("still derives the mapping when a string value contains a comment marker", () => {
    // The L0-02 regression: the old regex preprocessor treated this `//` as a comment, truncated
    // the document, and made the mapping disappear — which silently disabled the host guard.
    const read = readConfigFacts(
      "/ws/proj",
      `{
  "remoteEnv": { "REGISTRY": "https://registry.example.com//v2" },
  "postCreateCommand": "bash // bootstrap",
  "workspaceFolder": "/workspace"
}`,
    );

    expect(read).toEqual({ kind: "ok", facts: { mapping: { hostPath: "/ws/proj", containerPath: "/workspace" } } });
  });

  it("reports a config that parses but declares no mapping or mounts", () => {
    expect(readConfigFacts("/ws/proj", '{"image": "ubuntu"}')).toEqual({ kind: "ok", facts: {} });
  });

  it("reports an unparsable config instead of passing it off as 'no mapping'", () => {
    const read = readConfigFacts("/ws/proj", '{ "workspaceFolder": }');

    expect(read.kind).toBe("unparsable");
    if (read.kind === "unparsable") expect(read.detail.length).toBeGreaterThan(0);
  });
});

describe("container-only mounts (L1-05)", () => {
  it("lists the container targets the host cannot see, excluding the workspace mount", () => {
    const read = readConfigFacts(
      "/ws/proj",
      `{
  "workspaceMount": "source=\${localWorkspaceFolder},target=/app,type=bind",
  "mounts": [
    "source=proj-cache,target=/cache,type=volume",
    "source=\${localWorkspaceFolder}/data,target=/app/data,type=bind",
    "source=proj-secrets,target=/run/secrets,type=volume",
    "source=proj-cache,target=/cache,type=volume"
  ]
}`,
    );

    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    // `/app/data` lives under the workspace mount, so the host sees it through the bind mount;
    // `/cache` is duplicated in the file and must appear once.
    expect(read.facts.containerOnlyMounts).toEqual(["/cache", "/run/secrets"]);
  });

  it("omits the mount facts entirely when the config declares none", () => {
    const read = readConfigFacts("/ws/proj", '{"workspaceFolder": "/workspace"}');

    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.facts.containerOnlyMounts).toBeUndefined();
  });

  it("skips malformed mount entries instead of failing the whole read", () => {
    const read = readConfigFacts(
      "/ws/proj",
      '{"mounts": ["not-a-mount-spec", "source=x,target=relative/path,type=volume", "source=y,target=/ok,type=volume"]}',
    );

    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.facts.containerOnlyMounts).toEqual(["/ok"]);
  });
});
