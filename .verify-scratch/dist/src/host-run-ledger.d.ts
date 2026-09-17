/**
 * A bounded, session-scoped ledger of host runs.
 *
 * The assessment found that nothing told the operator "this session has run six host commands" — the
 * only signal was the audit file, which nobody reads mid-session. The audit trail stays the
 * authoritative record; this is the summary that makes drift visible while it happens
 * (command-routing assessment §4.1, option b).
 *
 * It is deliberately a ledger and NOT a second record: no timestamps, no output, no identity, and no
 * command text — just a count and the PROGRAM names, bounded so a long session cannot grow it without
 * limit. (It used to remember redacted command lines; the redaction turned out to be the source of
 * every defect five adversarial passes found in this feature, and naming the program gives an operator
 * the drift signal while the single enforced `displayProgram` keeps a credential out of it — a program name
 * CAN be credential-shaped, which is why the rendering is enforced rather than assumed.)
 */
export interface HostRunLedger {
    /** Count one host ATTEMPT (a refusal counts: nothing ran) and remember the PROGRAM it named. */
    record(argv: readonly string[]): void;
    /** True the FIRST time this session runs a host command; false afterwards (for a one-shot notice). */
    noteFirstRun(argv: readonly string[]): boolean;
    /** How many host commands this session has run. */
    count(): number;
    /** The most recent PROGRAM names, oldest first, bounded by the configured limit. */
    recent(): readonly string[];
    /** One operator-facing line for `/devcontainer status`. */
    summary(): string;
    /** Start a new session: the summary and the one-shot notice are per session, not per process. */
    reset(): void;
}
export declare function createHostRunLedger(options?: {
    limit?: number;
}): HostRunLedger;
//# sourceMappingURL=host-run-ledger.d.ts.map