import type { ChildProcessByStdio } from "node:child_process";
import { type SpawnErrorSpec } from "./spawn-error.js";
export interface ProcessResult {
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly durationMs: number;
    readonly truncated: boolean;
}
export interface ProcessRunnerOptions {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly maxOutputBytes?: number;
    readonly onData?: (chunk: Buffer) => void;
    readonly onStderr?: (chunk: Buffer) => void;
    readonly onSpawn?: (child: SpawnedChild) => void;
}
export interface ProcessRunner {
    exec(file: string, args: readonly string[], options: ProcessRunnerOptions): Promise<ProcessResult>;
}
/**
 * Options for one bounded adapter invocation: the runner's own options minus
 * the ones this helper owns, plus the tool-specific spawn-error mapping.
 */
export interface BoundedRunOptions {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly maxOutputBytes: number;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly onData?: (chunk: Buffer) => void;
    readonly onStderr?: (chunk: Buffer) => void;
    /** How a failure to start this executable is reported to the operator. */
    readonly spawnError: SpawnErrorSpec;
}
/**
 * Fallback byte cap for one captured stream when the caller supplies none.
 *
 * Production always supplies `config.maxOutputBytes` (the adapters are wired
 * with it in `extensions/index.ts`), so this is the single documented fallback
 * rather than a layered policy — the adapters used to carry five literals of
 * three different sizes (50, 64 and 256 KiB) that disagreed with each other.
 */
export declare const DEFAULT_MAX_OUTPUT_BYTES: number;
/** `docker logs` is expected to return far more context than a lifecycle command. */
export declare const LOGS_MAX_OUTPUT_BYTES: number;
export type SpawnedChild = ChildProcessByStdio<null, import("node:stream").Readable, import("node:stream").Readable>;
/**
 * Kill the child AND its descendant processes.
 *
 * Children are spawned as their own process group (`detached: true` on POSIX),
 * so a shell/CLI that forks background work cannot outlive a timeout or
 * cancellation. Without a process group, `child.kill()` only signals the
 * immediate process and descendants keep running while the operation is
 * already reported as cancelled. Windows has no process-group signalling via
 * negative pid; fall back to a direct kill there.
 */
export declare function killProcessTree(child: SpawnedChild): void;
export declare class NodeProcessRunner implements ProcessRunner {
    exec(file: string, args: readonly string[], options: ProcessRunnerOptions): Promise<ProcessResult>;
}
/**
 * Run one bounded child process on behalf of a runtime adapter.
 *
 * Each adapter used to assemble this option block on its own and translate
 * spawn failures with a private copy of the same two-case branch, which is why
 * every call site also needed a compile-time-only `unreachable` throw after its
 * `catch`. Here the option block has one owner and a spawn failure is mapped
 * before it leaves the call, so the adapters carry neither.
 */
export declare function runBounded(runner: ProcessRunner, file: string, args: readonly string[], options: BoundedRunOptions): Promise<ProcessResult>;
//# sourceMappingURL=process-runner.d.ts.map