/**
 * Unit tests for the Pi tool definitions (Slice 6).
 *
 * `devcontainer_exec` and `devcontainer_host_exec` are the two argv-based
 * tools; `devcontainer_status` is the read-only snapshot. These tests pin:
 * - the TypeBox parameter schemas (argv minItems 1, optional cwd/timeout);
 * - nonzero container-side exit → throw with output appended (Pi bash parity,
 *   service-level outcome never throws);
 * - the End-State result summary format (`workspace · shortId · exit N`);
 * - `devcontainer_host_exec` policy gate (denied → typed throw, no spawn) and
 *   the audited success path through the shared hostRunner.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createDevcontainerExecTool,
  createDevcontainerHostExecTool,
  createDevcontainerStatusTool,
  devcontainerExecParams,
  devcontainerHostExecParams,
  devcontainerStatusParams,
} from "../../src/tools.js";
import type { ToolOptions } from "../../src/tools.js";
import { RuntimeError } from "../../src/errors.js";
import type { ExecOutcome, ExecutionService } from "../../src/execution-service.js";

function makeOptions(overrides: Partial<ToolOptions> = {}): ToolOptions {
  return {
    execution: { exec: vi.fn() } as unknown as ExecutionService,
    sessionWorkspace: "/session",
    hostRunner: {
      run: vi.fn(async () => ({ exitCode: 0, signal: null, stdout: "host-out", stderr: "", truncated: false })),
    },
    hostExecutionAllowed: false,
    ...overrides,
  };
}

const okOutcome = (overrides: Partial<ExecOutcome> = {}): ExecOutcome => ({
  operation: "container-exec",
  workspaceKey: "ws-project-b",
  candidateId: "c77aabbccddeeff0011223344",
  candidateName: "project-b",
  exitCode: 0,
  signal: null,
  durationMs: 10,
  truncated: false,
  policyAuthorized: true,
  stdout: "",
  stderr: "",
  ...overrides,
});

function execWith(outcome: ExecOutcome): { execution: ExecutionService } {
  const execution = { exec: vi.fn(async () => outcome) } as unknown as ExecutionService;
  return { execution };
}

describe("devcontainerExecParams schema", () => {
  it("requires argv with at least one element and makes cwd/timeout optional", () => {
    expect(devcontainerExecParams.properties).toHaveProperty("argv");
    expect(devcontainerExecParams.properties?.argv).toMatchObject({ type: "array", minItems: 1, items: { type: "string" } });
    expect(devcontainerExecParams.properties?.cwd).toMatchObject({ type: "string" });
    expect(devcontainerExecParams.properties?.timeoutSeconds).toBeDefined();
    expect(devcontainerExecParams.required).toContain("argv");
  });

  it("devcontainer_host_exec also requires argv minItems 1", () => {
    expect(devcontainerHostExecParams.properties?.argv).toMatchObject({ type: "array", minItems: 1 });
  });

  it("devcontainer_status accepts no parameters", () => {
    expect(devcontainerStatusParams.properties).toEqual({});
  });
});

describe("createDevcontainerExecTool", () => {
  it("builds an argv request and returns the End-State summary with output", async () => {
    const { execution } = execWith(okOutcome({ stdout: "test passed\n" }));
    const tool = createDevcontainerExecTool(makeOptions({ execution }));
    const result = await tool.execute("t1", { argv: ["npm", "test"] }, undefined, undefined, { cwd: "/session" });
    expect(execution.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "container-exec",
        initiator: "tool",
        workspace: "/session",
        cmd: "npm",
        args: ["test"],
      }),
    );
    expect(result.content[0]!.text).toBe("ws-project-b · c77aabbccdde · exit 0\ntest passed\n");
    expect(result.details).toMatchObject({ workspaceKey: "ws-project-b", exitCode: 0, truncated: false });
  });

  it("uses the supplied cwd when provided (instead of the session workspace)", async () => {
    const { execution } = execWith(okOutcome());
    const tool = createDevcontainerExecTool(makeOptions({ execution }));
    await tool.execute("t1", { argv: ["ls"], cwd: "/ws/project-a" }, undefined, undefined, { cwd: "/session" });
    expect(execution.exec).toHaveBeenCalledWith(expect.objectContaining({ workspace: "/ws/project-a" }));
  });

  it("enforces timeoutSeconds with a linked abort signal (typed timeout error)", async () => {
    const execution = { exec: vi.fn(() => new Promise<ExecOutcome>(() => undefined)) } as unknown as ExecutionService;
    const tool = createDevcontainerExecTool(makeOptions({ execution }));
    const promise = tool.execute("t1", { argv: ["sleep", "1"], timeoutSeconds: 1 }, undefined, undefined, { cwd: "/session" });
    // The locked service drops request.timeoutMs; the tool owns the timeout
    // by aborting the request's signal. The fake never settles the promise,
    // so the enforced timer rejects with a typed timeout.
    const call = (execution.exec as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { timeoutMs?: number; signal?: AbortSignal };
    expect(call.timeoutMs).toBeUndefined();
    expect(call.signal).toBeDefined();
    await expect(promise).rejects.toMatchObject({ kind: "timeout" });
  });

  it("throws on nonzero container-side exit with output appended (service never throws)", async () => {
    const { execution } = execWith(okOutcome({ exitCode: 2, stdout: "boom\n" }));
    const tool = createDevcontainerExecTool(makeOptions({ execution }));
    const promise = tool.execute("t1", { argv: ["false"] }, undefined, undefined, { cwd: "/session" });
    await expect(promise).rejects.toMatchObject({ kind: "unexpected", exitCode: 2 });
    await expect(promise).rejects.toThrow(/exit 2/);
    await expect(promise).rejects.toThrow(/boom/);
  });

  it("forwards the abort signal and typed errors from the service", async () => {
    const execution = {
      exec: vi.fn(async () => {
        throw new RuntimeError({ kind: "target-stopped", message: "container stopped" });
      }),
    } as unknown as ExecutionService;
    const tool = createDevcontainerExecTool(makeOptions({ execution }));
    const signal = new AbortController().signal;
    const promise = tool.execute("t1", { argv: ["ls"] }, signal, undefined, { cwd: "/session" });
    await expect(promise).rejects.toMatchObject({ kind: "target-stopped" });
    expect(execution.exec).toHaveBeenCalledWith(expect.objectContaining({ signal }));
  });
});

describe("createDevcontainerStatusTool", () => {
  it("returns the provided summary and details", async () => {
    const status = () => ({ summary: "**DevContainer target:** none", details: { status: "none" } });
    const tool = createDevcontainerStatusTool(status);
    const result = await tool.execute("t1", {}, undefined, undefined, { cwd: "/session" });
    expect(result.content[0]!.text).toContain("**DevContainer target:** none");
    expect(result.details).toEqual({ status: "none" });
  });
});

describe("createDevcontainerHostExecTool", () => {
  it("throws policy-denied without spawning when host execution is disabled", async () => {
    const hostRunner = { run: vi.fn() };
    const tool = createDevcontainerHostExecTool(makeOptions({ hostExecutionAllowed: false, hostRunner }));
    const promise = tool.execute("t1", { argv: ["rm", "-rf", "/"] }, undefined, undefined, { cwd: "/session" });
    await expect(promise).rejects.toMatchObject({ kind: "policy-denied" });
    expect(hostRunner.run).not.toHaveBeenCalled();
  });

  it("runs through the shared hostRunner and renders captured output when allowed", async () => {
    const hostRunner = {
      run: vi.fn(async () => ({ exitCode: 0, signal: null, stdout: "host-out", stderr: "", truncated: false })),
    };
    const tool = createDevcontainerHostExecTool(makeOptions({ hostExecutionAllowed: true, hostRunner }));
    const result = await tool.execute("t1", { argv: ["hostname"] }, undefined, undefined, { cwd: "/session" });
    expect(hostRunner.run).toHaveBeenCalledWith(["hostname"], {});
    expect(result.content[0]!.text).toBe("host-out");
    expect(result.details).toMatchObject({ host: true, exitCode: 0 });
  });

  it("passes timeoutSeconds and the abort signal to the host runner", async () => {
    const hostRunner = {
      run: vi.fn(async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false })),
    };
    const tool = createDevcontainerHostExecTool(makeOptions({ hostExecutionAllowed: true, hostRunner }));
    const signal = new AbortController().signal;
    await tool.execute("t1", { argv: ["df"], timeoutSeconds: 5 }, signal, undefined, { cwd: "/session" });
    expect(hostRunner.run).toHaveBeenCalledWith(["df"], { timeoutMs: 5_000, signal });
  });

  it("propagates host runner failures", async () => {
    const hostRunner = {
      run: vi.fn(async () => {
        throw new RuntimeError({ kind: "executable-missing", message: "no such binary" });
      }),
    };
    const tool = createDevcontainerHostExecTool(makeOptions({ hostExecutionAllowed: true, hostRunner }));
    const promise = tool.execute("t1", { argv: ["nope"] }, undefined, undefined, { cwd: "/session" });
    await expect(promise).rejects.toMatchObject({ kind: "executable-missing" });
  });
});
