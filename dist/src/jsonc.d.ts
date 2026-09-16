/**
 * A string-safe JSONC reader for DevContainer configurations.
 *
 * DevContainer configs are JSON with comments in practice, so they need preprocessing before
 * `JSON.parse`. The previous preprocessing was three regular expressions, one of which decided
 * that `//` starts a comment whenever the preceding character was not `:`, `"`, `'` or `\` — so a
 * `//` inside an ordinary string value (`"url": "https://host//path"`, `"postCreateCommand":
 * "bash // note"`) truncated the document. The config stopped parsing, the derived host<->container
 * mapping disappeared, and the host container-path guard that depends on that mapping silently
 * stopped evaluating: a fail-open in a safety check (review finding L0-02).
 *
 * This scanner walks the text once, tracking string state (including `\` escapes) so comment
 * markers inside strings stay literal, removing `//` and block comments outside strings, and
 * dropping a comma whose next significant token is `}` or `]`. Text that is still not valid JSON
 * throws, which lets the caller report an unparsable configuration instead of treating it as a
 * configuration that declares no mapping.
 */
/** Remove comments and trailing commas without touching string contents. */
export declare function stripJsonc(text: string): string;
/** Parse JSONC text; throws for anything that is not valid JSON once comments are removed. */
export declare function parseJsonc(text: string): unknown;
//# sourceMappingURL=jsonc.d.ts.map