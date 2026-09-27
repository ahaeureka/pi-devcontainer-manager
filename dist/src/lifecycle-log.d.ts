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
    readonly directory?: string;
    readonly retentionDays?: number;
    readonly maxBytes?: number;
    readonly now?: () => Date;
    readonly randomSuffix?: () => string;
    readonly platform?: NodeJS.Platform;
    readonly homeDirectory?: string;
    readonly environment?: NodeJS.ProcessEnv;
}
/**
 * Returns the private, operator-owned directory for raw lifecycle diagnostics.
 * This directory is deliberately separate from the structured audit JSONL.
 */
export declare function defaultLifecycleLogDirectory(environment?: NodeJS.ProcessEnv, homeDirectory?: string, platform?: NodeJS.Platform): string;
/**
 * Writes raw diagnostic transcripts for lifecycle operations. Failures in this
 * best-effort writer never alter the operation it observes.
 */
export declare class LifecycleLogWriter {
    private latest?;
    private lastWarning?;
    private readonly directory;
    private readonly retentionDays;
    private readonly maxBytes;
    private readonly now;
    private readonly randomSuffix;
    constructor(options?: LifecycleLogWriterOptions);
    start(input: LifecycleLogStart): LifecycleLogRun;
    latestRun(): LifecycleLogMetadata | undefined;
    latestWarning(): string | undefined;
    private prune;
}
//# sourceMappingURL=lifecycle-log.d.ts.map