export interface HostRunLedger {
    /** Count one host ATTEMPT (a refusal counts: nothing ran) and remember its redacted argv. */
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