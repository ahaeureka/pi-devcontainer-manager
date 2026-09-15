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
/** Index of the next non-whitespace character at or after `from`, or `text.length`. */
function skipWhitespace(text, from) {
    let i = from;
    while (i < text.length && /\s/.test(text[i]))
        i += 1;
    return i;
}
/**
 * Index just past a comment starting at `from`, or `undefined` when there is none.
 *
 * Used by the trailing-comma lookahead, which must see past `[1, /* c *\/]` as well as `[1, ]`.
 */
function skipComment(text, from) {
    if (text[from] !== "/")
        return undefined;
    const next = text[from + 1];
    if (next === "/") {
        let i = from + 2;
        while (i < text.length && text[i] !== "\n")
            i += 1;
        return i;
    }
    if (next === "*") {
        let i = from + 2;
        while (i < text.length && !(text[i] === "*" && text[i + 1] === "/"))
            i += 1;
        return i + 2 > text.length ? text.length : i + 2;
    }
    return undefined;
}
/** Remove comments and trailing commas without touching string contents. */
export function stripJsonc(text) {
    // A byte-order mark is legal in files but not in JSON text.
    const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    let out = "";
    let i = 0;
    while (i < input.length) {
        const ch = input[i];
        if (ch === '"') {
            out += ch;
            i += 1;
            while (i < input.length) {
                const inner = input[i];
                out += inner;
                i += 1;
                if (inner === "\\" && i < input.length) {
                    out += input[i];
                    i += 1;
                    continue;
                }
                if (inner === '"')
                    break;
            }
            continue;
        }
        const afterComment = skipComment(input, i);
        if (afterComment !== undefined) {
            i = afterComment;
            continue;
        }
        if (ch === ",") {
            // Look past whitespace AND comments: `[1, /* tail */]` is valid JSONC.
            let j = skipWhitespace(input, i + 1);
            for (;;) {
                const pastComment = skipComment(input, j);
                if (pastComment === undefined)
                    break;
                j = skipWhitespace(input, pastComment);
            }
            if (input[j] === "}" || input[j] === "]") {
                i += 1;
                continue;
            }
        }
        out += ch;
        i += 1;
    }
    return out;
}
/** Parse JSONC text; throws for anything that is not valid JSON once comments are removed. */
export function parseJsonc(text) {
    return JSON.parse(stripJsonc(text));
}
//# sourceMappingURL=jsonc.js.map