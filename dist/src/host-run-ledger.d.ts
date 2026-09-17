/**
 * A bounded, session-scoped ledger of host runs.
 *
 * The assessment found that nothing told the operator "this session has run six host commands" — the
 * only signal was the audit file, which nobody reads mid-session. The audit trail stays the
 * authoritative record; this is the summary that makes drift visible while it happens
 * (command-routing assessment §4.1, option b).
 *
 * It is deliberately a ledger and NOT a second record: no timestamps, no output, no identity — just
 * count and recency, bounded so a long session cannot grow it without limit.
 */
export interface HostRunLedger {
    /** Count one host run and remember its argv. */
    record(argv: readonly string[]): void;
    /** True the FIRST time this session runs a host command; false afterwards (for a one-shot notice). */
    noteFirstRun(argv: readonly string[]): boolean;
    /** How many host commands this session has run. */
    count(): number;
    /** The most recent commands, oldest first, bounded by the configured limit. */
    recent(): readonly string[];
    /** One operator-facing line for `/devcontainer status`. */
    summary(): string;
}
export declare function createHostRunLedger(options?: {
    limit?: number;
}): HostRunLedger;
//# sourceMappingURL=host-run-ledger.d.ts.map