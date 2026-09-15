/**
 * Unit tests for the string-safe JSONC reader (review finding L0-02).
 *
 * DevContainer configurations are JSON-with-comments in practice, and the previous
 * preprocessor decided what a comment was with a regex that only looked at the character
 * before `//`. A `//` inside an ordinary string value (`"https://host//path"`, `"bash //
 * note"`) therefore truncated the document, the config stopped parsing, the derived mapping
 * disappeared, and the host container-path guard silently stopped evaluating — a fail-open
 * the review called out. These tests pin the string-safety.
 */
import { describe, expect, it } from "vitest";
import { parseJsonc, stripJsonc } from "../../src/jsonc.js";

describe("stripJsonc", () => {
  it("removes line and block comments outside strings", () => {
    const text = `{
  // a line comment
  "image": "ubuntu", /* an inline block */
  "runArgs": ["--init"] // trailing
}`;

    expect(stripJsonc(text)).not.toContain("a line comment");
    expect(stripJsonc(text)).not.toContain("an inline block");
    expect(JSON.parse(stripJsonc(text))).toEqual({ image: "ubuntu", runArgs: ["--init"] });
  });

  it("leaves comment markers inside string values alone", () => {
    const text = `{
  "url": "https://example.com//x",
  "postCreateCommand": "bash // install",
  "glob": "src/*/*.ts",
  "block": "/* not a comment */"
}`;

    const parsed = parseJsonc(text) as Record<string, unknown>;

    expect(parsed.url).toBe("https://example.com//x");
    expect(parsed.postCreateCommand).toBe("bash // install");
    expect(parsed.glob).toBe("src/*/*.ts");
    expect(parsed.block).toBe("/* not a comment */");
  });

  it("respects escaped quotes and backslashes inside strings", () => {
    const text = String.raw`{"a": "he said \"// still a string\"", "b": "back\\slash // x"}`;

    const parsed = parseJsonc(text) as Record<string, unknown>;

    expect(parsed.a).toBe('he said "// still a string"');
    expect(parsed.b).toBe("back\\slash // x");
  });

  it("drops trailing commas, including when a comment sits between", () => {
    const text = `{
  "a": [1, 2, /* tail */],
  "b": { "c": 3, },
}`;

    expect(parseJsonc(text)).toEqual({ a: [1, 2], b: { c: 3 } });
  });

  it("tolerates a leading byte-order mark", () => {
    expect(parseJsonc("\uFEFF{\"a\": 1}")).toEqual({ a: 1 });
  });

  it("throws on input that is still not valid JSON, so the caller can report it", () => {
    expect(() => parseJsonc("{ \"a\": }")).toThrow();
  });
});
