export function createHostRunLedger(options = {}) {
    const limit = Math.max(1, options.limit ?? 5);
    let count = 0;
    const recent = [];
    let firstRunNoted = false;
    const remember = (argv) => {
        count += 1;
        recent.push(argv.join(" "));
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
            const plural = count === 1 ? "host command" : "host commands";
            return `${count} ${plural} this session — most recent: ${recent.join(" | ")}`;
        },
    };
}
//# sourceMappingURL=host-run-ledger.js.map