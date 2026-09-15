import { describe, expect, it } from "vitest";
import { RuntimeError, errorKindOf, isRuntimeError } from "../../src/errors.js";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  LOGS_MAX_OUTPUT_BYTES,
  NodeProcessRunner,
  runBounded,
  type ProcessResult,
  type ProcessRunner,
  type ProcessRunnerOptions,
  type SpawnedChild,
  toSpawnError,
} from "../../src/runtime/process-runner.js";

function collect(onData?: (chunk: Buffer) => void) {
  return { onData };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("NodeProcessRunner", () => {
  const runner = new NodeProcessRunner();

  it("returns exit code 0 for a successful command", async () => {
    const result = await runner.exec("node", ["-e", "process.exit(0)"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns nonzero exit code", async () => {
    const result = await runner.exec("node", ["-e", "process.exit(7)"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.exitCode).toBe(7);
  });

  it("throws executable-missing for an unknown executable", async () => {
    await expect(
      runner.exec("/definitely/not/a/real/executable", [], { cwd: process.cwd(), env: {} }),
    ).rejects.toMatchObject({ kind: "executable-missing" });
  });

  it("throws spawn-permission-denied for a non-executable file", async () => {
    await expect(
      runner.exec("/etc/hostname", [], { cwd: process.cwd(), env: {} }),
    ).rejects.toMatchObject({ kind: "spawn-permission-denied" });
  });

  it("streams stdout chunks via onData", async () => {
    const chunks: Buffer[] = [];
    const result = await runner.exec("node", ["-e", "process.stdout.write('hello')"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      onData: (chunk) => chunks.push(chunk),
    });
    expect(result.exitCode).toBe(0);
    expect(Buffer.concat(chunks).toString("utf8")).toBe("hello");
  });

  it("truncates output past maxOutputBytes but keeps draining", async () => {
    const chunks: Buffer[] = [];
    const result = await runner.exec("node", ["-e", "process.stdout.write('x'.repeat(100))"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      maxOutputBytes: 10,
      onData: (chunk) => chunks.push(chunk),
    });
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    const total = Buffer.concat(chunks).length;
    expect(total).toBeLessThanOrEqual(10);
  });

  it("rejects with timeout when a process runs too long", async () => {
    await expect(
      runner.exec("node", ["-e", "setTimeout(() => {}, 5000)"], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("rejects with cancelled when the abort signal fires", async () => {
    const controller = new AbortController();
    const promise = runner.exec("node", ["-e", "setTimeout(() => {}, 5000)"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      signal: controller.signal,
    });
    await sleep(20);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("immediately rejects with cancelled when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runner.exec("node", ["-e", "process.exit(0)"], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("forwards stderr via onStderr", async () => {
    const chunks: Buffer[] = [];
    await runner.exec("node", ["-e", "process.stderr.write('boom')"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      onStderr: (chunk) => chunks.push(chunk),
    });
    expect(Buffer.concat(chunks).toString("utf8")).toBe("boom");
  });

  it("bounds stderr at maxOutputBytes and reports truncated", async () => {
    const chunks: Buffer[] = [];
    const result = await runner.exec("node", ["-e", "process.stderr.write('y'.repeat(100))"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      maxOutputBytes: 10,
      onStderr: (chunk) => chunks.push(chunk),
    });
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(Buffer.concat(chunks).length).toBeLessThanOrEqual(10);
  });

  it("bounds stdout and stderr independently", async () => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const result = await runner.exec(
      "node",
      ["-e", "process.stdout.write('a'.repeat(50)); process.stderr.write('b'.repeat(50))"],
      {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        maxOutputBytes: 10,
        onData: (chunk) => out.push(chunk),
        onStderr: (chunk) => err.push(chunk),
      },
    );
    expect(result.truncated).toBe(true);
    expect(Buffer.concat(out).length).toBeLessThanOrEqual(10);
    expect(Buffer.concat(err).length).toBeLessThanOrEqual(10);
  });

  it("reports child termination with null exit code and the signal", async () => {
    let child: SpawnedChild | undefined;
    const promise = runner.exec("node", ["-e", "setTimeout(() => {}, 5000)"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      onSpawn: (c) => {
        child = c;
      },
    });
    await sleep(30);
    child?.kill("SIGTERM");
    const result = await promise;
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGTERM");
  });

  it("interleaves stdout and stderr via both callbacks", async () => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    await runner.exec(
      "node",
      ["-e", "process.stdout.write('a'); process.stderr.write('b'); process.stdout.write('c')"],
      {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        onData: (chunk) => stdoutChunks.push(chunk),
        onStderr: (chunk) => stderrChunks.push(chunk),
      },
    );
    expect(Buffer.concat(stdoutChunks).toString("utf8")).toBe("ac");
    expect(Buffer.concat(stderrChunks).toString("utf8")).toBe("b");
  });
});

describe("RuntimeError", () => {
  it("classifies kinds and preserves remedies", () => {
    const error = new RuntimeError({
      kind: "daemon-unavailable",
      message: "daemon down",
      remedy: "Start Docker Desktop.",
    });
    expect(error.kind).toBe("daemon-unavailable");
    expect(error.remedy).toBe("Start Docker Desktop.");
    expect(isRuntimeError(error)).toBe(true);
    expect(errorKindOf(error)).toBe("daemon-unavailable");
    expect(errorKindOf(new Error("plain"))).toBe("unexpected");
  });
});

describe("runBounded", () => {
  const spawnError = {
    missingKind: "daemon-unavailable" as const,
    missingMessage: "Docker executable is unavailable.",
    missingRemedy: "Install Docker or set dockerPath in configuration.",
    permissionMessage: "Docker spawn was denied.",
    permissionRemedy: "Check operator privileges for the Docker executable.",
  };
  const base = { cwd: "/ws", env: { PATH: "/usr/bin" }, maxOutputBytes: 4096, timeoutMs: 30_000, spawnError };

  it("forwards the caller's bounded options to the runner", async () => {
    const seen: ProcessRunnerOptions[] = [];
    const runner: ProcessRunner = {
      async exec(_file, _args, options) {
        seen.push(options);
        return { exitCode: 0, signal: null, durationMs: 1, truncated: false };
      },
    };
    const onData = () => undefined;
    const controller = new AbortController();

    const result = await runBounded(runner, "/usr/bin/docker", ["ps"], {
      ...base,
      signal: controller.signal,
      onData,
    });

    expect(result.exitCode).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      cwd: "/ws",
      env: { PATH: "/usr/bin" },
      maxOutputBytes: 4096,
      timeoutMs: 30_000,
    });
    expect(seen[0]?.signal).toBe(controller.signal);
    expect(seen[0]?.onData).toBe(onData);
  });

  it("maps a spawn failure through the caller's spec", async () => {
    const runner: ProcessRunner = {
      async exec() {
        throw new RuntimeError({ kind: "executable-missing", message: "ENOENT" });
      },
    };

    await expect(runBounded(runner, "/usr/bin/docker", ["ps"], base)).rejects.toMatchObject({
      kind: "daemon-unavailable",
      remedy: spawnError.missingRemedy,
    });
  });

  it("rethrows non-spawn failures unchanged", async () => {
    const timeout = new RuntimeError({ kind: "timeout", message: "Process timed out after 30ms" });
    const runner: ProcessRunner = {
      async exec() {
        throw timeout;
      },
    };

    await expect(runBounded(runner, "/usr/bin/docker", ["ps"], base)).rejects.toBe(timeout);
  });
});

describe("bounded output defaults", () => {
  it("exports one default cap plus a larger, explicitly named logs cap", () => {
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBe(50 * 1024);
    expect(LOGS_MAX_OUTPUT_BYTES).toBe(256 * 1024);
  });
});

describe("toSpawnError", () => {
  const errno = (code: string, message = `spawn failed: ${code}`) =>
    Object.assign(new Error(message), { code });

  it("names the errno for a code it does not special-case", () => {
    const mapped = toSpawnError("devcontainer", errno("EMFILE")) as RuntimeError;

    expect(mapped.message).toContain("devcontainer");
    expect(mapped.message).toContain("EMFILE");
  });

  it("explains ENOTCONN as a PATH-transport fault with a remedy, not a missing binary", () => {
    const mapped = toSpawnError("devcontainer", errno("ENOTCONN")) as RuntimeError;

    // The 2026-09-15 host incident: a dead AppImage FUSE mount in PATH made glibc execvp
    // abort the whole lookup, and the operator was told only "Failed to spawn" — which reads
    // as a missing CLI. Naming the errno and the actual cause is the whole point of the fix.
    expect(mapped.kind).toBe("unexpected");
    expect(mapped.message).toContain("ENOTCONN");
    expect(mapped.message).toContain("devcontainer");
    expect(mapped.remedy).toBeTruthy();
    expect(mapped.remedy).toMatch(/PATH|mount/i);
  });

  it("keeps the two process-boundary kinds and adds the errno to their text", () => {
    const missing = toSpawnError("docker", errno("ENOENT")) as RuntimeError;
    const denied = toSpawnError("docker", errno("EACCES")) as RuntimeError;

    expect(missing.kind).toBe("executable-missing");
    expect(missing.message).toContain("ENOENT");
    expect(denied.kind).toBe("spawn-permission-denied");
    expect(denied.message).toContain("EACCES");
  });

  it("still reports the file when the failure carries no errno at all", () => {
    const mapped = toSpawnError("kubectl", new Error("boom")) as RuntimeError;

    expect(mapped.message).toContain("kubectl");
    expect(mapped.kind).toBe("unexpected");
  });
});
