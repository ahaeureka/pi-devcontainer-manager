/**
 * Workspace identity and containment have exactly one owner (review finding L5-01).
 *
 * "Is this the workspace we authorized?" used to be answered three ways with different fallbacks —
 * `policy` resolved `realpath` and compared with `relative`, `workspace-path` compared lexical
 * prefixes, and the execution service compared canonical keys inline — so a symlinked or
 * case-differing path could pass one check and fail another. These tests pin the single answer,
 * including the cases where the three disagreed.
 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalWorkspaceKey, isWithinWorkspace, resolveRealPath } from "../../src/workspace-path.js";

const root = mkdtempSync(join(tmpdir(), "ws-path-"));
const inside = join(root, "repo", "app");
const sibling = join(root, "repo", "application");
mkdirSync(inside, { recursive: true });
mkdirSync(sibling, { recursive: true });
const link = join(root, "link-to-app");
symlinkSync(inside, link);
const escaped = join(root, "escape");
symlinkSync(root, escaped);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("isWithinWorkspace", () => {
  it("accepts the root itself and a path beneath it", () => {
    expect(isWithinWorkspace(join(root, "repo"), inside)).toBe(true);
    expect(isWithinWorkspace(join(root, "repo"), join(root, "repo"))).toBe(true);
  });

  it("rejects a sibling whose name merely starts with the root's name", () => {
    // The lexical prefix check accepted this; a containment test must not.
    expect(isWithinWorkspace(inside, sibling)).toBe(false);
    expect(isWithinWorkspace("/repo/app", "/repo/application")).toBe(false);
  });

  it("accepts a symlink that resolves inside the root and rejects one that escapes it", () => {
    expect(isWithinWorkspace(join(root, "repo"), link)).toBe(true);
    // `/escape -> /` — a lexical check on the symlink's own path would say "inside".
    expect(isWithinWorkspace(join(root, "repo"), escaped)).toBe(false);
  });

  it("falls back to the lexical form for a path that does not exist yet", () => {
    const future = join(root, "repo", "not-created-yet");
    expect(isWithinWorkspace(join(root, "repo"), future)).toBe(true);
    expect(isWithinWorkspace(join(root, "repo"), join(root, "other", "not-created"))).toBe(false);
  });

  it("ignores a trailing slash", () => {
    expect(isWithinWorkspace(`${join(root, "repo")}/`, inside)).toBe(true);
    expect(isWithinWorkspace(join(root, "repo"), `${inside}/`)).toBe(true);
  });

  it("folds case on win32 only", () => {
    expect(isWithinWorkspace("/Repo", "/repo/app", "win32")).toBe(true);
    expect(isWithinWorkspace("/Repo", "/repo/app", "linux")).toBe(false);
  });

  it("treats the filesystem root as containing every absolute path", () => {
    // `allowedWorkspaceRoots: ["/"]` is the natural "allow everything" value; a prefix test that
    // builds `"//"` from it silently denied every workspace (the review caught this).
    expect(isWithinWorkspace("/", "/tmp")).toBe(true);
    expect(isWithinWorkspace("/", root)).toBe(true);
    expect(isWithinWorkspace("/", "/")).toBe(true);
  });

  it("refuses a relative path on either side", () => {
    expect(isWithinWorkspace("repo", inside)).toBe(false);
    expect(isWithinWorkspace(root, "repo/app")).toBe(false);
  });
});

describe("canonicalWorkspaceKey", () => {
  it("is the lexical identity used for registry keys and CLI argv", () => {
    expect(canonicalWorkspaceKey(inside)).toBe(inside);
    expect(canonicalWorkspaceKey(`${inside}/`)).toBe(inside);
    // It does NOT resolve symlinks — the registry key must stay the path the operator typed, while
    // containment is the realpath-aware question.
    expect(canonicalWorkspaceKey(link)).toBe(link);
    expect(canonicalWorkspaceKey("/Repo/App", "win32")).toBe("/repo/app");
  });

  it("and resolveRealPath is the realpath-aware form, falling back when nothing resolves", () => {
    expect(resolveRealPath(link)).toBe(inside);
    const missing = join(root, "nope");
    expect(resolveRealPath(missing)).toBe(missing);
  });
});
