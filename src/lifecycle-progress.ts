/**
 * Operator-facing progress notices for long lifecycle operations.
 *
 * `/devcontainer up|build|rebuild` render their result only when the handler returns, so a fifteen-minute build shows
 * a blank screen — the operator cannot tell "slow" from "stalled". These notices close that gap WITHOUT streaming
 * captured output: the raw transcript is secret-bearing and never reaches a UI, so the notice reports only
 * elapsed time, log size, and how long ago the log last grew. That last number is the useful one: a live build keeps
 * advancing it, a hung step (a dead apt connection was the real case) leaves it climbing.
 */
export interface LifecycleProgressFacts {
  readonly operation: string;
  readonly workspace: string;
  readonly elapsedMs: number;
  /** Transcript path, when one could be written. Shown only in the stalled branch, where it is the next step. */
  readonly logPath?: string;
  readonly logBytes?: number;
  /** Milliseconds since the transcript last grew; absent when there is no transcript to measure. */
  readonly idleMs?: number;
}

/** An operation whose transcript has not grown for this long is reported as possibly stalled. */
export const STALL_THRESHOLD_MS = 120_000;

export function describeLifecycleProgress(facts: LifecycleProgressFacts): string {
  const head = `\`${facts.operation}\` still running for ${facts.workspace} — ${formatDuration(facts.elapsedMs)} elapsed`;
  if (facts.idleMs === undefined) {
    return `${head} (no operation log available to report progress from).`;
  }
  const idle = `no new output for ${formatDuration(facts.idleMs)}`;
  const size = facts.logBytes !== undefined ? `, log ${formatBytes(facts.logBytes)}` : "";
  if (facts.idleMs >= STALL_THRESHOLD_MS) {
    const where = facts.logPath !== undefined ? ` Inspect ${facts.logPath} for the last step.` : "";
    return `${head}${size}. It may be stalled: ${idle}.${where} Nothing is lost if you let it run.`;
  }
  return `${head}${size}; last output ${formatDuration(facts.idleMs)} ago.`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
