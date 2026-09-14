/**
 * Tool-output presentation matching Pi's built-in bash tool.
 *
 * `devcontainer_exec` / `devcontainer_host_exec` return captured command
 * output to the LLM through the tool `content` channel. Pi's own bash tool
 * handles large output by truncating to a byte AND line budget (whichever is
 * hit first), persisting the full output to a temp file, and telling the LLM
 * exactly what was dropped and where the full output lives. This module
 * reproduces that contract without importing Pi, so `src/` stays
 * Pi-dependency-free and unit-testable:
 *
 *  - keep the TAIL of the output (errors / final results land at the end, the
 *    same choice Pi's bash tool makes);
 *  - when truncated, write the full output to a system temp file and return
 *    it in the result so the LLM can `read` it for the dropped head;
 *  - append a `[Showing lines X-Y of N ... Full output: <path>]` notice so the
 *    LLM is never silently reasoning from a partial view.
 *
 * The LLM decides which end it needs: default view is the tail; the full file
 * is always reachable via the reported path.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
export const TOOL_OUTPUT_MAX_BYTES = 50 * 1024;
export const TOOL_OUTPUT_MAX_LINES = 2000;
/** Human-readable byte size (e.g. "50KB", "1.2MB"), matching Pi's formatSize. */
export function formatToolSize(bytes) {
    if (bytes < 1024)
        return `${bytes}B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
/**
 * Format captured command output for LLM consumption.
 *
 * @param output combined stdout (callers choose stdout-or-stderr precedence)
 * @param opts maxBytes / maxLines budgets
 * @returns the tail to show, plus full-output path when truncated
 */
export function formatToolOutput(output, opts = {}) {
    const maxBytes = opts.maxBytes ?? TOOL_OUTPUT_MAX_BYTES;
    const maxLines = opts.maxLines ?? TOOL_OUTPUT_MAX_LINES;
    const prefix = opts.prefix ?? "";
    if (output.length === 0) {
        return { text: prefix, truncated: false };
    }
    const allLines = output.split("\n");
    const totalLines = allLines.length;
    const totalBytes = Buffer.byteLength(output, "utf8");
    // Neither budget exceeded: return as-is.
    if (allLines.length <= maxLines && totalBytes <= maxBytes) {
        return { text: prefix.length > 0 ? `${prefix}\n${output}` : output, truncated: false };
    }
    // Truncate to the tail within both budgets. Prefer a whole-line boundary;
    // walk back from the end accumulating lines until either budget would be
    // exceeded by adding the next (older) line.
    const kept = [];
    let keptBytes = 0;
    for (let i = allLines.length - 1; i >= 0; i--) {
        const line = allLines[i] ?? "";
        const lineBytes = Buffer.byteLength(line, "utf8") + 1; // + newline
        if (kept.length + 1 > maxLines || keptBytes + lineBytes > maxBytes)
            break;
        kept.unshift(line);
        keptBytes += lineBytes;
    }
    if (kept.length === 0) {
        // A single oversized line: keep a hard byte slice of it so the LLM sees
        // something rather than nothing, and save the full line for `read`.
        const fullOutputPath = persistFullOutput(output);
        const slice = output.slice(0, maxBytes);
        return {
            text: `${prefix.length > 0 ? `${prefix}\n` : ""}${slice}\n[Output truncated: showing first ${formatToolSize(maxBytes)} of a single ${formatToolSize(totalBytes)} line. Full output: ${fullOutputPath}]`,
            truncated: true,
            fullOutputPath,
        };
    }
    const fullOutputPath = persistFullOutput(output);
    const keptText = kept.join("\n");
    const startLine = totalLines - kept.length + 1;
    const endLine = totalLines;
    const notice = `\n[Showing lines ${startLine}-${endLine} of ${totalLines} (${formatToolSize(totalBytes)} total, kept ${formatToolSize(keptBytes)}). Full output: ${fullOutputPath}]`;
    return {
        text: `${prefix.length > 0 ? `${prefix}\n` : ""}${keptText}${notice}`,
        truncated: true,
        fullOutputPath,
    };
}
/** Write full output to a fresh system temp file; returns its path. */
export function persistFullOutput(output) {
    const dir = mkdtempSync(join(tmpdir(), "pi-devcontainer-manager-"));
    const file = join(dir, "full-output.txt");
    writeFileSync(file, output, "utf8");
    return file;
}
//# sourceMappingURL=tool-output.js.map