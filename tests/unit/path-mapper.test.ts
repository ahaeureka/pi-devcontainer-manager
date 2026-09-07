import { describe, expect, it } from "vitest";
import {
  buildPathMapping,
  expandLocalWorkspaceFolder,
  hostToContainer,
  parseWorkspaceMount,
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
