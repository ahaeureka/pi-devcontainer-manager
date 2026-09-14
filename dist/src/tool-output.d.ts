export declare const TOOL_OUTPUT_MAX_BYTES: number;
export declare const TOOL_OUTPUT_MAX_LINES = 2000;
export interface ToolOutputResult {
    /** Text to place in the tool `content` (may include the truncation notice). */
    readonly text: string;
    /** True when the returned text is a truncated tail and a full copy was saved. */
    readonly truncated: boolean;
    /** Absolute path to the full output, when truncated. */
    readonly fullOutputPath?: string;
}
/** Human-readable byte size (e.g. "50KB", "1.2MB"), matching Pi's formatSize. */
export declare function formatToolSize(bytes: number): string;
/**
 * Format captured command output for LLM consumption.
 *
 * @param output combined stdout (callers choose stdout-or-stderr precedence)
 * @param opts maxBytes / maxLines budgets
 * @returns the tail to show, plus full-output path when truncated
 */
export declare function formatToolOutput(output: string, opts?: {
    maxBytes?: number;
    maxLines?: number;
    prefix?: string;
}): ToolOutputResult;
/** Write full output to a fresh system temp file; returns its path. */
export declare function persistFullOutput(output: string): string;
//# sourceMappingURL=tool-output.d.ts.map