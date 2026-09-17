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
 * the drift signal without a place a credential could ever be rendered.)
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
  /**
   * Adopt the session's capture policy.
   *
   * `none` means no command identity is recorded ANYWHERE, so the summary may keep counting attempts
   * but must not retain their text — otherwise the ledger becomes the one place the operator can read
   * what the policy declined to record.
   */
  setCapture(mode: "none" | "fingerprint-only" | "redacted-text"): void;
  /** Start a new session: the summary and the one-shot notice are per session, not per process. */
  reset(): void;
}

/** The program an argv names (`""` for an empty argv — nothing ran). */
function programOf(argv: readonly string[]): string {
  const first = argv[0];
  if (first === undefined) return "";
  const base = first.split("/").pop() ?? first;
  return base.slice(0, 64);
}

export function createHostRunLedger(options: { limit?: number; capture?: "none" | "fingerprint-only" | "redacted-text" } = {}): HostRunLedger {
  const limit = Math.max(1, options.limit ?? 5);
  let count = 0;
  const recent: string[] = [];
  let firstRunNoted = false;

  // A capture policy of `none` means no command identity is kept anywhere — including here, or the
  // ledger would become the one place the operator can read what the policy declined to record
  // (adversarial review of the routing hardening).
  let keepText = (options.capture ?? "fingerprint-only") !== "none";
  const remember = (argv: readonly string[]): void => {
    count += 1;
    if (keepText) {
      // The summary names the PROGRAM, never the command line. Ten adversarial passes over this
      // change found five credentials reachable through a rendered argv (and two of them through
      // fixes for the previous one), so the visibility keeps the signal an operator needs — how many
      // host commands, and which tools — and stores no command text at all. A program name cannot be
      // a credential, and the authoritative record is the audit trail, which keeps its own policy.
      recent.push(programOf(argv));
      while (recent.length > limit) recent.shift();
    }
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
    reset: () => {
      count = 0;
      recent.length = 0;
      firstRunNoted = false;
    },
    setCapture: (mode) => {
      keepText = mode !== "none";
      if (!keepText) recent.length = 0;
    },
    summary: () => {
      if (count === 0) return "no host commands in this session";
      if (!keepText) {
        return `${count} host command ${count === 1 ? "attempt" : "attempts"} this session (command text not recorded)`;
      }
      const plural = count === 1 ? "host command attempt" : "host command attempts";
      return `${count} ${plural} this session — most recent: ${recent.join(" | ")}`;
    },
  };
}
