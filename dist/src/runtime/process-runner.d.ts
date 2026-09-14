import type { ChildProcessByStdio } from "node:child_process";
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
//# sourceMappingURL=process-runner.d.ts.map