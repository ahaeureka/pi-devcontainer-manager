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
function redactArgv(argv) {
    // JOIN first, then redact — exactly what the audit trail does (`commandIdentity` joins and the
    // writer applies `redactText`). Redacting each element separately loses the flag-with-value rules,
    // which need the flag and its value in one string: `--password s3cr3t` as two arguments would be
    // redacted in the audit record and printed verbatim here (verify-node adversarial pass).
    return redactText(argv.join(" "));
}
export function createHostRunLedger(options = {}) {
    const limit = Math.max(1, options.limit ?? 5);
    let count = 0;
    const recent = [];
    let firstRunNoted = false;
    // A capture policy of `none` means no command identity is kept anywhere — including here, or the
    // ledger would become the one place the operator can read what the policy declined to record
    // (adversarial review of the routing hardening).
    let keepText = (options.capture ?? "fingerprint-only") !== "none";
    const remember = (argv) => {
        count += 1;
        if (keepText) {
            recent.push(redactArgv(argv));
            while (recent.length > limit)
                recent.shift();
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
            if (!keepText)
                recent.length = 0;
        },
        summary: () => {
            if (count === 0)
                return "no host commands in this session";
            if (!keepText) {
                return `${count} host command ${count === 1 ? "attempt" : "attempts"} this session (command text not recorded)`;
            }
            const plural = count === 1 ? "host command attempt" : "host command attempts";
            return `${count} ${plural} this session — most recent: ${recent.join(" | ")}`;
        },
    };
}
//# sourceMappingURL=host-run-ledger.js.map