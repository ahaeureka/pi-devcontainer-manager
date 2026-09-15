import { spawn } from "node:child_process";
import { RuntimeError } from "../errors.js";
import { mapSpawnError } from "./spawn-error.js";
/**
 * Fallback byte cap for one captured stream when the caller supplies none.
 *
 * Production always supplies `config.maxOutputBytes` (the adapters are wired
 * with it in `extensions/index.ts`), so this is the single documented fallback
 * rather than a layered policy — the adapters used to carry five literals of
 * three different sizes (50, 64 and 256 KiB) that disagreed with each other.
 */
export const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024;
/** `docker logs` is expected to return far more context than a lifecycle command. */
export const LOGS_MAX_OUTPUT_BYTES = 256 * 1024;
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
export function killProcessTree(child) {
    const pid = child.pid;
    if (pid !== undefined && process.platform !== "win32") {
        try {
            process.kill(-pid, "SIGKILL");
            return;
        }
        catch {
            /* group already gone or not permitted; fall through to direct kill */
        }
    }
    child.kill("SIGKILL");
}
export class NodeProcessRunner {
    async exec(file, args, options) {
        const startedAt = process.hrtime.bigint();
        const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
        const stdout = options.onData ?? (() => undefined);
        const stderr = options.onStderr ?? (() => undefined);
        let child;
        try {
            child = spawn(file, [...args], {
                cwd: options.cwd,
                env: { ...options.env },
                shell: false,
                stdio: ["ignore", "pipe", "pipe"],
                // Own process group so timeout/cancel can terminate descendants too.
                detached: process.platform !== "win32",
            });
        }
        catch (error) {
            throw toSpawnError(file, error);
        }
        options.onSpawn?.(child);
        return await new Promise((resolve, reject) => {
            // Bounded output: each stream is independently capped at `maxOutput`, so
            // captured memory is at most 2x the configured limit and NEITHER stream
            // can exhaust the extension process. `truncated` reflects either stream.
            let stdoutBytes = 0;
            let stderrBytes = 0;
            let truncated = false;
            let timer;
            let settled = false;
            const cleanup = () => {
                if (timer !== undefined)
                    clearTimeout(timer);
            };
            const finish = (result) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                resolve(result);
            };
            const fail = (error) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                reject(error);
            };
            child.on("error", (error) => {
                fail(toSpawnError(file, error));
            });
            child.stdout.on("data", (chunk) => {
                if (stdoutBytes >= maxOutput) {
                    truncated = true;
                    return;
                }
                const remaining = maxOutput - stdoutBytes;
                if (chunk.length > remaining) {
                    stdout(chunk.subarray(0, remaining));
                    stdoutBytes = maxOutput;
                    truncated = true;
                }
                else {
                    stdout(chunk);
                    stdoutBytes += chunk.length;
                }
            });
            child.stderr.on("data", (chunk) => {
                if (stderrBytes >= maxOutput) {
                    truncated = true;
                    return;
                }
                const remaining = maxOutput - stderrBytes;
                if (chunk.length > remaining) {
                    stderr(chunk.subarray(0, remaining));
                    stderrBytes = maxOutput;
                    truncated = true;
                }
                else {
                    stderr(chunk);
                    stderrBytes += chunk.length;
                }
            });
            const onAbort = () => {
                if (settled)
                    return;
                cleanup();
                killProcessTree(child);
                fail(new RuntimeError({ kind: "cancelled", message: "Process cancelled" }));
            };
            if (options.signal !== undefined) {
                if (options.signal.aborted) {
                    killProcessTree(child);
                    fail(new RuntimeError({ kind: "cancelled", message: "Process cancelled" }));
                    return;
                }
                options.signal.addEventListener("abort", onAbort, { once: true });
            }
            if (options.timeoutMs !== undefined) {
                timer = setTimeout(() => {
                    if (settled)
                        return;
                    killProcessTree(child);
                    fail(new RuntimeError({ kind: "timeout", message: `Process timed out after ${options.timeoutMs}ms` }));
                }, options.timeoutMs);
            }
            child.on("close", (code, signal) => {
                if (options.signal !== undefined) {
                    options.signal.removeEventListener("abort", onAbort);
                }
                finish({
                    exitCode: code,
                    signal,
                    durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
                    truncated,
                });
            });
        });
    }
}
/**
 * Classify a failed spawn into the process-boundary kinds the adapters translate.
 *
 * Every branch names the errno. Anything that was not ENOENT/EACCES/EPERM used to collapse
 * into `Failed to spawn: <file>`, which made a host-side transport fault indistinguishable
 * from a missing binary: on 2026-09-15 a dead AppImage FUSE mount sitting in PATH made glibc's
 * `execvp` abort the whole lookup with ENOTCONN, and the operator was told only
 * `Failed to spawn: devcontainer` while the container was up and the CLI was installed.
 * ENOTCONN now says what it is and what to do about it.
 */
export function toSpawnError(file, error) {
    const cause = error;
    const code = typeof cause.code === "string" && cause.code.length > 0 ? cause.code : undefined;
    const named = code !== undefined ? `${file} (${code})` : file;
    if (code === "ENOENT") {
        return new RuntimeError({
            kind: "executable-missing",
            message: `Executable not found: ${named}`,
            cause: error,
            remedy: "Install the executable or set its path in configuration.",
        });
    }
    if (code === "EACCES" || code === "EPERM") {
        return new RuntimeError({
            kind: "spawn-permission-denied",
            message: `Permission denied spawning: ${named}`,
            cause: error,
            remedy: "Check executable permissions and operator privileges.",
        });
    }
    if (code === "ENOTCONN") {
        return new RuntimeError({
            kind: "unexpected",
            message: `Failed to spawn: ${named} — the host cannot traverse part of PATH`,
            cause: error,
            remedy: "A filesystem mount that PATH points into is disconnected (a stale AppImage /tmp/.mount_* entry does this), which fails the executable search before it reaches the binary. Unmount it (`fusermount3 -u <dir>`) or drop it from PATH, then retry: `env node --version` reproduces the failure.",
        });
    }
    return new RuntimeError({
        kind: "unexpected",
        message: `Failed to spawn: ${named}`,
        cause: error,
    });
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
export async function runBounded(runner, file, args, options) {
    try {
        return await runner.exec(file, [...args], {
            cwd: options.cwd,
            env: { ...options.env },
            maxOutputBytes: options.maxOutputBytes,
            timeoutMs: options.timeoutMs,
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
            ...(options.onData !== undefined ? { onData: options.onData } : {}),
            ...(options.onStderr !== undefined ? { onStderr: options.onStderr } : {}),
        });
    }
    catch (error) {
        throw mapSpawnError(error, options.spawnError);
    }
}
//# sourceMappingURL=process-runner.js.map