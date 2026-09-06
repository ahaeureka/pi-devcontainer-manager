import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlAuditWriter } from "../../src/audit.js";

const record = {
  version: 1 as const,
  at: "2026-08-31T00:00:00.000Z",
  operation: "container-exec" as const,
  initiator: "tool" as const,
  policyAuthorized: true,
  outputTruncated: false,
  commandCapture: "fingerprint-only" as const,
  commandFingerprint: "abc",
  errorSummary: "token=secret",
};

describe("JsonlAuditWriter", () => {
  it("redacts and writes restricted JSONL", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    const writer = new JsonlAuditWriter(dir);
    writer.write(record);
    const file = join(dir, "2026-08-31.jsonl");
    expect(readFileSync(file, "utf8")).toContain("[REDACTED]");
    expect(readFileSync(file, "utf8")).not.toContain("token=secret");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("prunes expired JSONL files", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    const old = join(dir, "old.jsonl");
    writeFileSync(old, "{}\n");
    utimesSync(old, new Date("2020-01-01"), new Date("2020-01-01"));
    new JsonlAuditWriter(dir, 90).prune(new Date("2026-08-31"));
    expect(() => statSync(old)).toThrow();
  });
});
