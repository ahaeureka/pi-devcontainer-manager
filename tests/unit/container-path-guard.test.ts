/**
 * Tests for the structured container-path guard used on the explicit HOST
 * surface (audit finding H1/M10 companion).
 *
 * The guard runs on literal argv (no shell parsing), so it is a RELIABLE check:
 * it catches an argv that targets a path which exists only inside the container,
 * where host execution would silently do the wrong thing.
 */
import { describe, expect, it } from "vitest";
import { findContainerPath, hostToContainer, parseWorkspaceMount, buildPathMapping } from "../../src/path-mapper.js";

describe("findContainerPath", () => {
  it("flags the container path itself and paths beneath it", () => {
    expect(findContainerPath(["ls", "-la", "/app"], "/app")).toBe("/app");
    expect(findContainerPath(["cat", "/app/src/index.ts"], "/app")).toBe("/app/src/index.ts");
    expect(findContainerPath(["/app/.models/weights.bin"], "/app")).toBe("/app/.models/weights.bin");
  });

  it("ignores host paths and non-path tokens", () => {
    expect(findContainerPath(["git", "status"], "/app")).toBeUndefined();
    expect(findContainerPath(["cat", "/etc/hosts"], "/app")).toBeUndefined();
    expect(findContainerPath(["echo", "app"], "/app")).toBeUndefined();
    expect(findContainerPath(["cat", "/application/x"], "/app")).toBeUndefined();
  });

  it("normalizes trailing slashes on the container path", () => {
    expect(findContainerPath(["ls", "/app/x"], "/app/")).toBe("/app/x");
  });

  it("returns undefined for an empty container path", () => {
    expect(findContainerPath(["ls", "/app"], "")).toBeUndefined();
  });
});

describe("path mapping feeds the guard", () => {
  it("derives the container path from workspaceMount", () => {
    const mapping = buildPathMapping(
      "/data/work/proj",
      "/app",
      "source=${localWorkspaceFolder},target=/app,type=bind",
    );
    expect(mapping).toEqual({ hostPath: "/data/work/proj", containerPath: "/app" });
    expect(findContainerPath(["npm", "test", "--prefix", "/app"], mapping!.containerPath)).toBe("/app");
  });

  it("parses a mount string defensively", () => {
    expect(parseWorkspaceMount("source=/h,target=/c,type=bind")).toEqual({ source: "/h", target: "/c", type: "bind" });
    expect(parseWorkspaceMount(undefined)).toEqual({});
  });

  it("maps a host path into the container tree", () => {
    const mapping = { hostPath: "/host/proj", containerPath: "/app" };
    expect(hostToContainer("/host/proj/src/a.ts", mapping)).toBe("/app/src/a.ts");
    expect(hostToContainer("/elsewhere/a.ts", mapping)).toBeUndefined();
  });
});
