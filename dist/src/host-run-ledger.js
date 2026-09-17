import { displayProgram } from "./policy.js";
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
            // The summary names the PROGRAM, never the command line. Ten adversarial passes over this
            // change found five credentials reachable through a rendered argv (and two of them through
            // fixes for the previous one), so the visibility keeps the signal an operator needs — how many
            // host commands, and which tools — and stores no command text at all. A program name cannot be
            // a credential, and the authoritative record is the audit trail, which keeps its own policy.
            recent.push(displayProgram(argv));
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