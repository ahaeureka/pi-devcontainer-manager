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
export declare const STALL_THRESHOLD_MS = 120000;
export declare function describeLifecycleProgress(facts: LifecycleProgressFacts): string;
//# sourceMappingURL=lifecycle-progress.d.ts.map