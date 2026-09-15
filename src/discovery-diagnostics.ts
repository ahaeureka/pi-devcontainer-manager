/**
 * Collected discovery diagnostics.
 *
 * Host discovery and Docker parsing already produce diagnostics — an unreadable directory, a
 * symlink that escapes the allowed root, `maxDepth` pruning (the traversal code says "surface it
 * once instead of silently stopping"), a Docker candidate without its
 * `devcontainer.local_folder` label, or a `docker ps` record that could not be parsed — but every
 * production caller destructured only `entries`, so a degraded scan was indistinguishable from an
 * empty one.
 *
 * The sink is the seam that makes surfacing them testable and safe:
 *
 *  - `add()` queues lines, ignoring blanks and anything already queued or already reported;
 *  - `drain()` hands back the queued lines and marks them reported, so each distinct diagnostic
 *    reaches the operator at most once per session even though the registry is re-read on every
 *    command.
 *
 * Reporting is the caller's job (the command dispatch, which has a UI); the activation probe must
 * stay silent, so it only ever contributes to the queue.
 */
export interface DiagnosticSink {
  /** Queue lines, ignoring blanks and duplicates already queued or reported. */
  add(lines: Iterable<string>): void;
  /** Return the un-reported lines in insertion order and mark them reported. */
  drain(): string[];
}

/**
 * Deliver everything the sink has queued to an operator-visible channel.
 *
 * Reporting is deliberately NOT the sink's job: the activation probe also feeds it and must stay
 * silent, while the command dispatch owns the UI. Returning the count lets the caller log or test
 * how much was surfaced without re-querying the sink.
 */
export function reportDiscoveryDiagnostics(sink: DiagnosticSink, notify: (line: string) => void): number {
  const lines = sink.drain();
  for (const line of lines) notify(line);
  return lines.length;
}
export function createDiagnosticSink(): DiagnosticSink {
  const reported = new Set<string>();
  const queued = new Set<string>();
  const pending: string[] = [];

  return {
    add(lines) {
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || reported.has(trimmed) || queued.has(trimmed)) continue;
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
