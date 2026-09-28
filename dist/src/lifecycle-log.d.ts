import type { OperationKind } from "./types.js";
export declare const DEFAULT_LIFECYCLE_LOG_RETENTION_DAYS = 14;
export declare const DEFAULT_LIFECYCLE_LOG_MAX_BYTES: number;
export type LifecycleLogOperation = Extract<OperationKind, "up" | "build" | "rebuild" | "setup" | "stop" | "remove">;
export interface LifecycleLogMetadata {
    readonly operation: LifecycleLogOperation;
    readonly path: string;
    readonly startedAt: string;
    readonly completedAt?: string;
    readonly outcome?: LifecycleLogOutcome;
    readonly warning?: string;
    /** True when metadata is reconstructed from a prior session's file name. */
    readonly persisted?: true;
}
export interface LifecycleLogOutcome {
    readonly state: "completed" | "failed" | "denied" | "cancelled";
    readonly exitCode?: number | null;
    readonly durationMs?: number;
    readonly error?: string;
    readonly outputTruncated?: boolean;
}
export interface LifecycleLogStart {
    readonly operation: LifecycleLogOperation;
    readonly workspacePath: string;
}
/**
 * The most recent lifecycle failure, as the agent needs it.
 *
 * `/devcontainer up|build|rebuild|stop|remove|setup` results are rendered into the OPERATOR UI, not the model
 * context, so a slash-command failure would otherwise be invisible to the agent. The writer keeps the newest
 * failed run here and the facade folds it into the next turn's execution-context block.
 */
export interface LifecycleLogFailure {
    readonly operation: LifecycleLogOperation;
    readonly state: LifecycleLogOutcome["state"];
    /** Transcript path, when one could be written. */
    readonly path?: string;
    readonly error?: string;
}
export interface LifecycleLogRun {
    readonly path?: string;
    readonly warning?: string;
    setCommand(argv: readonly string[]): void;
    stdout(chunk: string | Uint8Array): void;
    stderr(chunk: string | Uint8Array): void;
    note(message: string): void;
    finish(outcome: LifecycleLogOutcome): void;
}
export interface LifecycleLogWriterOptions {
    /** Pi session cwd; determines the project-local default when no directory is supplied. */
    readonly workspacePath?: string;
    readonly directory?: string;
    readonly retentionDays?: number;
    readonly maxBytes?: number;
    readonly now?: () => Date;
    readonly randomSuffix?: () => string;
}
/**
 * Returns the project-local, operator-owned directory for raw lifecycle diagnostics.
 * The session cwd is explicit in production; `process.cwd()` keeps direct library use local too.
 */
export declare function defaultLifecycleLogDirectory(workspacePath?: string): string;
/**
 * Writes raw diagnostic transcripts for lifecycle operations. Failures in this
 * best-effort writer never alter the operation it observes.
 */
export declare class LifecycleLogWriter {
    private latest?;
    private lastWarning?;
    private lastFailure?;
    private readonly directory;
    private readonly retentionDays;
    private readonly maxBytes;
    private readonly now;
    private readonly randomSuffix;
    constructor(options?: LifecycleLogWriterOptions);
    start(input: LifecycleLogStart): LifecycleLogRun;
    /**
     * Take the newest unreported lifecycle failure, clearing it.
     *
     * Take-and-clear is the contract: the facade injects the result into the next turn's system prompt, and a
     * failure that stayed queued would be re-injected every turn for the rest of the session.
     */
    takeFailure(): LifecycleLogFailure | undefined;
    private recordFailure;
    latestRun(): LifecycleLogMetadata | undefined;
    latestWarning(): string | undefined;
    private prune;
}
//# sourceMappingURL=lifecycle-log.d.ts.map