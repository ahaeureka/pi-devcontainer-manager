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
    /**
     * Adopt the session's capture policy.
     *
     * `none` means no command identity is recorded ANYWHERE, so the summary may keep counting attempts
     * but must not retain their text — otherwise the ledger becomes the one place the operator can read
     * what the policy declined to record.
     */
    setCapture(mode: "none" | "fingerprint-only" | "redacted-text"): void;
}
export declare function createHostRunLedger(options?: {
    limit?: number;
    capture?: "none" | "fingerprint-only" | "redacted-text";
}): HostRunLedger;
//# sourceMappingURL=host-run-ledger.d.ts.map