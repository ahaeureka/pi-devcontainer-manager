/**
 * Hardening tests for workspace authorization and audit redaction.
 *
 * - `isWorkspaceAllowed` must compare filesystem IDENTITY (realpath), not just
 *   lexical containment: a symlink beneath an allowed root that points outside
 *   it must be denied (audit finding H2).
 * - `redactText` is best-effort but must cover the common credential forms that
 *   previously survived (Authorization headers, --flag values, URL userinfo).
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isWorkspaceAllowed, redactText } from "../../src/policy.js";

describe("isWorkspaceAllowed (filesystem identity)", () => {
  it("denies a symlink beneath an allowed root that resolves outside it", () => {
    const base = mkdtempSync(join(tmpdir(), "pi-dcm-policy-"));
    try {
      const allowed = join(base, "allowed");
      const outside = join(base, "outside");
      mkdirSync(allowed);
      mkdirSync(outside);
      const link = join(allowed, "link");
      symlinkSync(outside, link, "dir");

      const roots = [allowed];
      // Lexically below the root, physically outside it.
      expect(isWorkspaceAllowed(link, roots)).toBe(false);
      // A real child of the root (even one that does not exist yet) is allowed.
      expect(isWorkspaceAllowed(join(allowed, "sub"), roots)).toBe(true);
      // The root itself is allowed.
      expect(isWorkspaceAllowed(allowed, roots)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("still rejects paths outside every root and non-absolute paths", () => {
    expect(isWorkspaceAllowed("/nope/x", ["/repo"])).toBe(false);
    expect(isWorkspaceAllowed("relative/path", ["/repo"])).toBe(false);
    expect(isWorkspaceAllowed("/repo/x", [])).toBe(false);
  });
});

describe("redactText", () => {
  it("redacts Authorization bearer/basic values entirely", () => {
    const out = redactText("curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc' https://x");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9.abc");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts key=value and key: value secret assignments", () => {
    expect(redactText("API_TOKEN=abc123")).not.toContain("abc123");
    expect(redactText("password: hunter2")).not.toContain("hunter2");
  });

  it("redacts secret-bearing long flags", () => {
    expect(redactText("deploy --password s3cr3t --token=xyz")).not.toContain("s3cr3t");
    expect(redactText("deploy --password s3cr3t --token=xyz")).not.toContain("xyz");
  });

  it("redacts credentials embedded in URLs", () => {
    const out = redactText("git clone https://user:ghp_secret@github.com/org/repo.git");
    expect(out).not.toContain("ghp_secret");
    expect(out).toContain("[REDACTED]@github.com");
  });

  it("leaves ordinary command text intact", () => {
    expect(redactText("npm test -- --watch")).toBe("npm test -- --watch");
  });
});
