/**
 * Unit tests for the Dev Containers CLI adapter (Slice 5).
 *
 * The CLI is never executed: a fake {@link ProcessRunner} records the exact
 * argv/environment handed to it and returns scripted {@link ProcessResult}s.
 * Assertions pin the verified 0.88.0 contract:
 * - `up`/`build` parse the single JSON document (trailing space tolerated);
 * - `exec` always passes `-- <cmd> [args...]` and `--remote-env` at most once;
 * - structural failures (container missing, daemon unreachable, not running)
 *   become typed `RuntimeError`s; container-side exit codes are carried in
 *   the result, never thrown.
 */
import { describe, expect, it } from "vitest";
import { NodeDevcontainerAdapter } from "../../src/runtime/devcontainer-adapter.js";
import { RuntimeError } from "../../src/errors.js";
import type { ProcessResult, ProcessRunner, ProcessRunnerOptions } from "../../src/runtime/process-runner.js";

interface CallRecord {
  file: string;
  args: readonly string[];
  options: ProcessRunnerOptions;
}

function fakeRunner(results: ProcessResult[], onCall?: (call: CallRecord) => void): { runner: ProcessRunner; calls: CallRecord[] } {
  const calls: CallRecord[] = [];
  const runner: ProcessRunner = {
    exec(file, args, options) {
      const call: CallRecord = { file, args, options };
      calls.push(call);
      onCall?.(call);
      const next = results.shift();
      if (next === undefined) {
        return Promise.reject(new Error("unexpected runner call"));
      }
      return Promise.resolve(next);
    },
  };
  return { runner, calls };
}

function makeAdapter(runner: ProcessRunner, extra: Partial<{ devcontainerPath: string; cwd: string }> = {}) {
  return new NodeDevcontainerAdapter(runner, {
    devcontainerPath: extra.devcontainerPath ?? "devcontainer",
    env: { PATH: "/usr/bin" },
    cwd: extra.cwd ?? "/ws",
  });
}

/**
 * A scripted run. `stdout`/`stderr` are the fields the process boundary now supplies (L5-03); the
 * fake used to emit bytes through the `onData` callback it was handed.
 */
const ok = (exitCode: number, stdout = "", stderr = ""): ProcessResult => ({
  exitCode,
  signal: null,
  durationMs: 5,
  truncated: false,
  stdout,
  stderr,
});

describe("NodeDevcontainerAdapter.up", () => {
  it("passes fixed argv and parses the JSON document (trailing space tolerated)", async () => {
    const { runner, calls } = fakeRunner([
      ok(0, '{"outcome":"success","containerId":"abc123","remoteUser":"vscode","remoteWorkspaceFolder":"/workspaces/p"}\n '),
    ]);
    const adapter = makeAdapter(runner);

    const result = await adapter.up("/ws/project-a", { dockerPath: "/usr/bin/docker" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["up", "--workspace-folder", "/ws/project-a", "--docker-path", "/usr/bin/docker"]);
    expect(result.containerId).toBe("abc123");
    expect(result.remoteUser).toBe("vscode");
    expect(result.remoteWorkspaceFolder).toBe("/workspaces/p");
  });

  it("maps error outcome to devcontainer-cli-failure", async () => {
    const { runner } = fakeRunner([ok(1, '{"outcome":"error","message":"config invalid","description":"x"}\n ')]);
    const adapter = makeAdapter(runner);
    await expect(adapter.up("/ws")).rejects.toThrowError(/config invalid/);
  });

  it("maps daemon-unreachable stderr to daemon-unavailable when no structured JSON is present", async () => {
    const { runner } = fakeRunner([ok(1, "", "Cannot connect to the Docker daemon at unix:///var/run/docker.sock")]);
    const adapter = makeAdapter(runner);
    await expect(adapter.up("/ws")).rejects.toMatchObject({ kind: "daemon-unavailable" });
  });

  it("prefers the structured error message over daemon stderr", async () => {
    const { runner } = fakeRunner([
      ok(1, '{"outcome":"error","message":"docker daemon is not running"}\n ', "Cannot connect to the Docker daemon at unix:///var/run/docker.sock"),
    ]);
    const adapter = makeAdapter(runner);
    await expect(adapter.up("/ws")).rejects.toMatchObject({ kind: "devcontainer-cli-failure", message: /docker daemon is not running/ });
  });
});

describe("NodeDevcontainerAdapter.build", () => {
  it("passes optional flags and parses imageName", async () => {
    const { runner, calls } = fakeRunner([ok(0, '{"outcome":"success","imageName":"devcontainer:p"}\n ')]);
    const adapter = makeAdapter(runner);
    const result = await adapter.build("/ws", { noCache: true, imageName: "img:tag" });
    expect(calls[0]!.args).toContain("--no-cache");
    expect(calls[0]!.args).toContain("--image-name");
    expect(result.imageName).toBe("devcontainer:p");
  });
});

describe("NodeDevcontainerAdapter.exec", () => {
  it("builds argv with flags before the -- separator and the container-side command after", async () => {
    const { runner, calls } = fakeRunner([{ ...ok(0), truncated: false }]);
    const adapter = makeAdapter(runner);
    await adapter.exec("/ws", "abc123", "npm", ["test", "--", "--watch"], {
      dockerPath: "/usr/bin/docker",
      remoteEnv: { FOO: "1" },
    });
    expect(calls[0]!.args).toEqual([
      "exec",
      "--workspace-folder", "/ws",
      "--container-id", "abc123",
      "--docker-path", "/usr/bin/docker",
      "--remote-env", "FOO=1",
      "--", "npm", "test", "--", "--watch",
    ]);
  });

  it("forwards EVERY requested variable as a repeated --remote-env flag", async () => {
    const { runner, calls } = fakeRunner([{ ...ok(0), truncated: false }]);
    const adapter = makeAdapter(runner);
    await adapter.exec("/ws", "abc123", "echo", ["hi"], { remoteEnv: { A: "1", B: "2", C: "3" } });
    const argv = calls[0]!.args;
    const envFlags = argv.reduce<string[]>((acc, token, index) => (token === "--remote-env" ? [...acc, argv[index + 1]!] : acc), []);
    expect(envFlags).toEqual(["A=1", "B=2", "C=3"]);
  });

  it("carries the container-side exit code instead of throwing", async () => {
    const { runner } = fakeRunner([{ exitCode: 42, signal: null, durationMs: 10, truncated: false }]);
    const adapter = makeAdapter(runner);
    const result = await adapter.exec("/ws", "abc123", "exit", ["42"]);
    expect(result.exitCode).toBe(42);
  });

  it("maps 'Dev container not found.' to target-stopped", async () => {
    const { runner } = fakeRunner([
      { exitCode: 1, signal: null, durationMs: 10, truncated: false, stdout: "", stderr: "Dev container not found. Run devcontainer up to create it." },
    ]);
    const adapter = makeAdapter(runner);
    await expect(adapter.exec("/ws", "abc123", "ls", [])).rejects.toMatchObject({ kind: "target-stopped" });
  });

  it("maps 'is not running' to target-stopped", async () => {
    const { runner } = fakeRunner([
      { exitCode: 1, signal: null, durationMs: 10, truncated: false, stdout: "", stderr: 'container "abc" is not running' },
    ]);
    const adapter = makeAdapter(runner);
    await expect(adapter.exec("/ws", "abc123", "ls", [])).rejects.toMatchObject({ kind: "target-stopped" });
  });

  it("remaps executable-missing to devcontainer-cli-failure", async () => {
    const runner: ProcessRunner = {
      exec() {
        return Promise.reject(new RuntimeError({ kind: "executable-missing", message: "ENOENT" }));
      },
    };
    const adapter = makeAdapter(runner);
    await expect(adapter.up("/ws")).rejects.toMatchObject({ kind: "devcontainer-cli-failure" });
  });

  it("passes the adapter signal to the runner", async () => {
    const { runner, calls } = fakeRunner([{ ...ok(0), truncated: false }]);
    const adapter = makeAdapter(runner);
    const controller = new AbortController();
    await adapter.exec("/ws", "abc123", "ls", [], { signal: controller.signal });
    expect(calls[0]!.options.signal).toBe(controller.signal);
  });

  it("propagates truncated: true when the runner caps output at the configured maxOutputBytes", async () => {
    // Review gap closed (plan review R2): the adapter unit suite never drove
    // a chunk past the configured cap, so truncated propagation from a capped
    // runner was unpinned. Fake runner resolves with truncated: true (the
    // runner-level cap it applies when maxOutputBytes is exceeded).
    const { runner } = fakeRunner([{ ...ok(0), truncated: true }]);
    const adapter = makeAdapter(runner);
    const result = await adapter.exec("/ws", "abc123", "cat", ["/large.bin"], {});
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeGreaterThanOrEqual(0);
  });
});
