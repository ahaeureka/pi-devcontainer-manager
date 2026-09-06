import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { RuntimeError } from "../errors.js";

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

const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024;

export type SpawnedChild = ChildProcessByStdio<null, import("node:stream").Readable, import("node:stream").Readable>;
export class NodeProcessRunner implements ProcessRunner {
  public async exec(
    file: string,
    args: readonly string[],
    options: ProcessRunnerOptions,
  ): Promise<ProcessResult> {
    const startedAt = process.hrtime.bigint();
    const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const stdout = options.onData ?? (() => undefined);
    const stderr = options.onStderr ?? (() => undefined);

    let child: SpawnedChild;
    try {
      child = spawn(file, [...args], {
        cwd: options.cwd,
        env: { ...options.env },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      throw toSpawnError(file, error);
    }

    options.onSpawn?.(child);

    return await new Promise<ProcessResult>((resolve, reject) => {
      let stdoutBytes = 0;
      let truncated = false;
      let timer: NodeJS.Timeout | undefined;
      let settled = false;

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
      };

      const finish = (result: ProcessResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      child.on("error", (error) => {
        fail(toSpawnError(file, error));
      });

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdoutBytes < maxOutput) {
          const remaining = maxOutput - stdoutBytes;
          if (chunk.length > remaining) {
            stdout(chunk.subarray(0, remaining));
            stdoutBytes = maxOutput;
            truncated = true;
          } else {
            stdout(chunk);
            stdoutBytes += chunk.length;
          }
        } else {
          truncated = true;
        }
      });

      child.stderr.on("data", (chunk: Buffer) => stderr(chunk));

      const onAbort = () => {
        if (settled) return;
        cleanup();
        child.kill("SIGKILL");
        fail(new RuntimeError({ kind: "cancelled", message: "Process cancelled" }));
      };

      if (options.signal !== undefined) {
        if (options.signal.aborted) {
          child.kill("SIGKILL");
          fail(new RuntimeError({ kind: "cancelled", message: "Process cancelled" }));
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (settled) return;
          child.kill("SIGKILL");
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

function toSpawnError(file: string, error: unknown): RuntimeError {
  const cause = error as NodeJS.ErrnoException;
  if (cause.code === "ENOENT") {
    return new RuntimeError({
      kind: "executable-missing",
      message: `Executable not found: ${file}`,
      cause: error,
      remedy: "Install the executable or set its path in configuration.",
    });
  }
  if (cause.code === "EACCES" || cause.code === "EPERM") {
    return new RuntimeError({
      kind: "spawn-permission-denied",
      message: `Permission denied spawning: ${file}`,
      cause: error,
      remedy: "Check executable permissions and operator privileges.",
    });
  }
  return new RuntimeError({
    kind: "unexpected",
    message: `Failed to spawn: ${file}`,
    cause: error,
  });
}
