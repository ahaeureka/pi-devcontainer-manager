import { displayProgram } from "./policy.js";
export function createHostRunLedger(options = {}) {
    const limit = Math.max(1, options.limit ?? 5);
    let count = 0;
    const recent = [];
    let firstRunNoted = false;
    const remember = (argv) => {
        count += 1;
        // The summary names the PROGRAM, never the command line: many adversarial passes found credentials
        // reachable through a rendered argv (two of them through fixes for the previous one), so the visibility
        // keeps the signal an operator needs — how many host commands, and which tools — and stores no command
        // text at all. `displayProgram` is the enforced rendering; a program name can be credential-shaped.
        recent.push(displayProgram(argv));
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