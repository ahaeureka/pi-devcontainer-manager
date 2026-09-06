import { describe, expect, it } from "vitest";
import { NodeCapabilityService, type CapabilityDiagnostic } from "../../src/runtime/capabilities.js";
import type { ProcessRunner, ProcessResult } from "../../src/runtime/process-runner.js";

interface FakeExecCall {
  file: string;
  args: readonly string[];
}

class FakeRunner implements ProcessRunner {
  public calls: FakeExecCall[] = [];
  private responses: Array<{ result: ProcessResult | undefined; error: unknown }> = [];

  public queue(result: ProcessResult | undefined, error?: unknown): void {
    this.responses.push({ result, error });
  }

  public async exec(file: string, args: readonly string[]): Promise<ProcessResult> {
    this.calls.push({ file, args });
    const next = this.responses.shift();
    if (next?.error !== undefined) throw next.error;
    return next?.result ?? { exitCode: 0, signal: null, durationMs: 1, truncated: false };
  }
}

describe("NodeCapabilityService", () => {
  it("reports unsupported platform", async () => {
    const runner = new FakeRunner();
    const service = new NodeCapabilityService(runner, {
      dockerPath: "/usr/bin/docker",
      devcontainerPath: "/usr/bin/devcontainer",
      platform: "win32",
    });
    const state = await service.check();
    expect(state.platformSupported).toBe(false);

    const diag = await service.diagnose();
    expect(diag.kind).toBe("unsupported-platform");
  });

  it("reports docker executable missing", async () => {
    const runner = new FakeRunner();
    runner.queue(undefined, Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const service = new NodeCapabilityService(runner, {
      dockerPath: "/usr/bin/docker",
      devcontainerPath: "/usr/bin/devcontainer",
      platform: "linux",
    });
    const diag = await service.diagnose();
    expect(diag.kind).toBe("docker-executable-missing");
  });

  it("reports daemon unreachable when docker info fails", async () => {
    const runner = new FakeRunner();
    runner.queue({ exitCode: 0, signal: null, durationMs: 1, truncated: false }); // docker --version ok
    runner.queue({ exitCode: 1, signal: null, durationMs: 1, truncated: false }); // docker info fail
    const service = new NodeCapabilityService(runner, {
      dockerPath: "/usr/bin/docker",
      devcontainerPath: "/usr/bin/devcontainer",
      platform: "linux",
    });
    const diag = await service.diagnose();
    expect(diag.kind).toBe("docker-daemon-unreachable");
  });

  it("reports devcontainer executable missing", async () => {
    const runner = new FakeRunner();
    runner.queue({ exitCode: 0, signal: null, durationMs: 1, truncated: false }); // docker --version
    runner.queue({ exitCode: 0, signal: null, durationMs: 1, truncated: false }); // docker info ok
    runner.queue(undefined, Object.assign(new Error("ENOENT"), { code: "ENOENT" })); // devcontainer missing
    const service = new NodeCapabilityService(runner, {
      dockerPath: "/usr/bin/docker",
      devcontainerPath: "/usr/bin/devcontainer",
      platform: "linux",
    });
    const diag = await service.diagnose();
    expect(diag.kind).toBe("devcontainer-executable-missing");
  });

  it("reports ok when all capabilities pass", async () => {
    const runner = new FakeRunner();
    runner.queue({ exitCode: 0, signal: null, durationMs: 1, truncated: false }); // docker --version
    runner.queue({ exitCode: 0, signal: null, durationMs: 1, truncated: false }); // docker info ok
    runner.queue({ exitCode: 0, signal: null, durationMs: 1, truncated: false }); // devcontainer --version
    const service = new NodeCapabilityService(runner, {
      dockerPath: "/usr/bin/docker",
      devcontainerPath: "/usr/bin/devcontainer",
      platform: "linux",
    });
    const state = await service.check();
    expect(state.dockerExecutablePresent).toBe(true);
    expect(state.dockerDaemonReachable).toBe(true);
    expect(state.devcontainerExecutablePresent).toBe(true);

    const diag = await service.diagnose();
    expect(diag.kind).toBe("ok");
  });

  it("does not probe the daemon when docker is absent", async () => {
    const runner = new FakeRunner();
    runner.queue(undefined, Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const service = new NodeCapabilityService(runner, {
      dockerPath: "/usr/bin/docker",
      devcontainerPath: "/usr/bin/devcontainer",
      platform: "linux",
    });
    const state = await service.check();
    expect(state.dockerDaemonReachable).toBe(false);
    expect(runner.calls.some((c) => c.args.includes("info"))).toBe(false); // no docker info probe
  });
});
