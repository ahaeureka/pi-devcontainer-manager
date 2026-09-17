import { displayProgram } from "./policy.js";
export function createHostRunLedger(options = {}) {
    const limit = Math.max(1, options.limit ?? 5);
    let count = 0;
    const recent = [];
    let firstRunNoted = false;
    // The program NAME is not command text: it is one word, rendered by the enforced `displayProgram`, and the
    // audit policy that governs command CAPTURE does not withhold it. (It used to, which made the visibility
    // claim false under `commandCapture: "none"` — adversarial review.)
    let keepText = true;
    const remember = (argv) => {
        count += 1;
        {
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
        summary: () => {
            if (count === 0)
                return "no host commands in this session";
            const plural = count === 1 ? "host command attempt" : "host command attempts";
            return `${count} ${plural} this session — most recent: ${recent.join(" | ")}`;
        },
    };
}
//# sourceMappingURL=host-run-ledger.js.map