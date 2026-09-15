/**
 * Deliver everything the sink has queued to an operator-visible channel.
 *
 * Reporting is deliberately NOT the sink's job: the activation probe also feeds it and must stay
 * silent, while the command dispatch owns the UI. Returning the count lets the caller log or test
 * how much was surfaced without re-querying the sink.
 */
export function reportDiscoveryDiagnostics(sink, notify) {
    const lines = sink.drain();
    for (const line of lines)
        notify(line);
    return lines.length;
}
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