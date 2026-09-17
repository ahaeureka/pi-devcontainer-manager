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
    return argv.map((element) => redactText(element)).join(" ");
}
export function createHostRunLedger(options = {}) {
    const limit = Math.max(1, options.limit ?? 5);
    let count = 0;
    const recent = [];
    let firstRunNoted = false;
    const remember = (argv) => {
        count += 1;
        recent.push(redactArgv(argv));
        while (recent.length > limit)
            recent.shift();
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
            if (count === 0)
                return "no host commands in this session";
            const plural = count === 1 ? "host command attempt" : "host command attempts";
            return `${count} ${plural} this session — most recent: ${recent.join(" | ")}`;
        },
    };
}
//# sourceMappingURL=host-run-ledger.js.map