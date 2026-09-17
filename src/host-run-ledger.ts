import { redactText } from "./policy.js";

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
/**
 * Redact one command line for the summary.
 *
 * The summary is rendered to the operator, and it must not become a plaintext copy of what the audit
 * trail deliberately captures by fingerprint only. `src/audit.ts` owns the redaction rules for
 * records; this applies the same rule set to the argv before it is remembered (the adversarial review
 * of this change demonstrated `curl -H "authorization: Bearer sk-live-…"` landing here verbatim).
 */
function redactArgv(argv: readonly string[]): string {
  return argv.map((element) => redactText(element)).join(" ");
}

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
      recent.push(redactArgv(argv));
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
    setCapture: (mode) => {
      keepText = mode !== "none";
      if (!keepText) recent.length = 0;
    },
    summary: () => {
      if (count === 0) return "no host commands in this session";
      if (!keepText) return `${count} host command ${count === 1 ? "attempt" : "attempts"} this session (command text not recorded)`.replace("command attempt this session", "command attempt this session");
      const plural = count === 1 ? "host command attempt" : "host command attempts";
      return `${count} ${plural} this session — most recent: ${recent.join(" | ")}`;
    },
  };
}
