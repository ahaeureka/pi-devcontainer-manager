import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatToolOutput,
  persistFullOutput,
  TOOL_OUTPUT_MAX_BYTES,
  TOOL_OUTPUT_MAX_LINES,
  combineCommandOutput,
} from "../../src/tool-output.js";

describe("formatToolOutput", () => {
  it("passes small output through unchanged without a temp file", () => {
    const out = formatToolOutput("line1\nline2", { prefix: "sum" });
    expect(out.text).toBe("sum\nline1\nline2");
    expect(out.truncated).toBe(false);
    expect(out.fullOutputPath).toBeUndefined();
  });

  it("returns only the prefix when output is empty", () => {
    const out = formatToolOutput("", { prefix: "sum" });
    expect(out.text).toBe("sum");
    expect(out.truncated).toBe(false);
  });

  it("truncates by line count, keeps the tail, persists full output, and reports the path", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`);
    const out = formatToolOutput(lines.join("\n"), { maxBytes: 10 * 1024, maxLines: 3 });
    expect(out.truncated).toBe(true);
    expect(out.text).toContain("line-7");
    expect(out.text).toContain("line-9");
    expect(out.text).not.toContain("line-0");
    expect(out.text).toContain("[Showing lines 8-10 of 10");
    expect(out.fullOutputPath).toBeDefined();
    expect(existsSync(out.fullOutputPath!)).toBe(true);
    expect(readFileSync(out.fullOutputPath!, "utf8")).toBe(lines.join("\n"));
    // cleanup
    rmSync(dirname(out.fullOutputPath!), { recursive: true, force: true });
  });

  it("truncates by bytes when byte budget is hit first", () => {
    // 2000 lines each 100B would be far over a small byte budget
    const lines = Array.from({ length: 2000 }, () => "x".repeat(100));
    const out = formatToolOutput(lines.join("\n"), { maxBytes: 1024, maxLines: TOOL_OUTPUT_MAX_LINES });
    expect(out.truncated).toBe(true);
    expect(out.text).toContain("Full output:");
    expect(out.fullOutputPath).toBeDefined();
    rmSync(dirname(out.fullOutputPath!), { recursive: true, force: true });
  });

  it("does not truncate when under both budgets even if near the limits", () => {
    const lines = Array.from({ length: TOOL_OUTPUT_MAX_LINES }, (_, i) => `l${i}`);
    const out = formatToolOutput(lines.join("\n"));
    expect(out.truncated).toBe(false);
  });

  it("handles a single oversized line by keeping a byte slice and full output", () => {
    const big = "y".repeat(200 * 1024);
    const out = formatToolOutput(big, { maxBytes: 1024, maxLines: 2000 });
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThan(200 * 1024);
    expect(out.text).toContain("Full output:");
    expect(out.fullOutputPath).toBeDefined();
    expect(existsSync(out.fullOutputPath!)).toBe(true);
    rmSync(dirname(out.fullOutputPath!), { recursive: true, force: true });
  });
});

describe("combineCommandOutput", () => {
  it("returns an empty string when neither stream produced output", () => {
    expect(combineCommandOutput("", "")).toBe("");
  });

  it("passes a single stream through without adding a label", () => {
    expect(combineCommandOutput("out\n", "")).toBe("out\n");
    expect(combineCommandOutput("", "err\n")).toBe("err\n");
  });

  it("labels stderr after stdout when both streams produced output", () => {
    expect(combineCommandOutput("out\n", "err\n")).toBe("out\n\n--- stderr ---\nerr\n");
  });
});

describe("persistFullOutput", () => {
  it("writes to a readable temp file", () => {
    const p = persistFullOutput("hello world");
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("hello world");
    rmSync(dirname(p), { recursive: true, force: true });
  });
});
