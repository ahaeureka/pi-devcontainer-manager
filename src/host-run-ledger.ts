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

export function createHostRunLedger(options: { limit?: number } = {}): HostRunLedger {
  const limit = Math.max(1, options.limit ?? 5);
  let count = 0;
  const recent: string[] = [];
  let firstRunNoted = false;

  const remember = (argv: readonly string[]): void => {
    count += 1;
    recent.push(argv.join(" "));
    while (recent.length > limit) recent.shift();
  };

  return {
    record: remember,
    noteFirstRun: (argv) => {
      const first = !firstRunNoted;
      firstRunNoted = true;
      remember(argv);
      return first;
    },
    count: () => count,
    recent: () => [...recent],
    summary: () => {
      if (count === 0) return "no host commands in this session";
      const plural = count === 1 ? "host command" : "host commands";
      return `${count} ${plural} this session — most recent: ${recent.join(" | ")}`;
    },
  };
}
