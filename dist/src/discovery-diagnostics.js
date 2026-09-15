export function createDiagnosticSink() {
    const reported = new Set();
    const queued = new Set();
    const pending = [];
    return {
        add(lines) {
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.length === 0 || reported.has(trimmed) || queued.has(trimmed))
                    continue;
                queued.add(trimmed);
                pending.push(trimmed);
            }
        },
        drain() {
            const out = pending.splice(0, pending.length);
            for (const line of out) {
                queued.delete(line);
                reported.add(line);
            }
            return out;
        },
    };
}
//# sourceMappingURL=discovery-diagnostics.js.map