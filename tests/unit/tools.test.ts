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
import { Compile } from "typebox/compile";
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

  it("rejects a non-positive timeout at the boundary and keeps fractional timeouts legal", () => {
    // Pi validates tool arguments with TypeBox's compiler, so the schema IS the contract.
    const check = Compile(devcontainerExecParams);
    expect(check.Check({ argv: ["ls"] })).toBe(true);
    expect(check.Check({ argv: ["ls"], timeoutSeconds: 0 })).toBe(false);
    expect(check.Check({ argv: ["ls"], timeoutSeconds: -1 })).toBe(false);
    expect(check.Check({ argv: ["ls"], timeoutSeconds: 0.5 })).toBe(true);
    expect(check.Check({ argv: ["ls"], timeoutSeconds: 900 })).toBe(true);
  });

  it("applies the same positive-timeout contract to the host escape hatch", () => {
    const check = Compile(devcontainerHostExecParams);
    expect(check.Check({ argv: ["df"] })).toBe(true);
    expect(check.Check({ argv: ["df"], timeoutSeconds: 0 })).toBe(false);
    expect(check.Check({ argv: ["df"], timeoutSeconds: 2 })).toBe(true);
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

  it("floors a sub-millisecond timeout instead of aborting at 0 ms", async () => {
    // `exclusiveMinimum: 0` cannot express a millisecond floor, so `0.0004` passed the schema
    // and still became `setTimeout(..., 0)` — an immediate abort reported as a timeout.
    vi.useFakeTimers();
    try {
      const execution = { exec: vi.fn(() => new Promise<ExecOutcome>(() => undefined)) } as unknown as ExecutionService;
      const tool = createDevcontainerExecTool(makeOptions({ execution }));
      const promise = tool.execute("t1", { argv: ["sleep", "1"], timeoutSeconds: 0.0004 }, undefined, undefined, { cwd: "/session" });
      let settled = false;
      void promise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(promise).rejects.toMatchObject({ kind: "timeout" });
      await expect(promise).rejects.toThrow(/1ms/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws on nonzero container-side exit with output appended (service never throws)", async () => {
    const { execution } = execWith(okOutcome({ exitCode: 2, stdout: "boom\n" }));
    const tool = createDevcontainerExecTool(makeOptions({ execution }));
    const promise = tool.execute("t1", { argv: ["false"] }, undefined, undefined, { cwd: "/session" });
    await expect(promise).rejects.toMatchObject({ kind: "unexpected", exitCode: 2 });
    await expect(promise).rejects.toThrow(/exit 2/);
    await expect(promise).rejects.toThrow(/boom/);
  });

  it("keeps stderr when the command also wrote stdout (mixed streams)", async () => {
    const { execution } = execWith(okOutcome({ stdout: "out\n", stderr: "warn\n" }));
    const tool = createDevcontainerExecTool(makeOptions({ execution }));

    const result = await tool.execute("t1", { argv: ["ls"] }, undefined, undefined, { cwd: "/session" });

    expect(result.content[0]!.text).toContain("out\n");
    expect(result.content[0]!.text).toContain("--- stderr ---");
    expect(result.content[0]!.text).toContain("warn\n");
  });

  it("includes stderr in the nonzero-exit error as well", async () => {
    const { execution } = execWith(okOutcome({ exitCode: 2, stdout: "boom\n", stderr: "detail\n" }));
    const tool = createDevcontainerExecTool(makeOptions({ execution }));

    const promise = tool.execute("t1", { argv: ["false"] }, undefined, undefined, { cwd: "/session" });

    await expect(promise).rejects.toThrow(/boom/);
    await expect(promise).rejects.toThrow(/--- stderr ---/);
    await expect(promise).rejects.toThrow(/detail/);
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

  it("keeps stderr in the host result when both streams produced output", async () => {
    const hostRunner = {
      run: vi.fn(async () => ({ exitCode: 0, signal: null, stdout: "host-out\n", stderr: "host-warn\n", truncated: false })),
    };
    const tool = createDevcontainerHostExecTool(makeOptions({ hostExecutionAllowed: true, hostRunner }));

    const result = await tool.execute("t1", { argv: ["hostname"] }, undefined, undefined, { cwd: "/session" });

    expect(result.content[0]!.text).toContain("host-out");
    expect(result.content[0]!.text).toContain("--- stderr ---");
    expect(result.content[0]!.text).toContain("host-warn");
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

describe("execution-route prompt metadata", () => {
  // These assertions pin the routing guidance the agent sees, so a future edit
  // cannot silently weaken "what runs where" semantics.
  it("devcontainer_exec advertises container-environment execution", () => {
    const tool = createDevcontainerExecTool(makeOptions({ execution: { exec: vi.fn() } as unknown as ExecutionService }));
    expect(tool.promptSnippet).toContain("selected DevContainer");
    const joined = (tool.promptGuidelines ?? []).join("\n");
    expect(joined).toContain("container environment");
    expect(joined).toContain("never host administration");
    expect(joined).toContain("target-stopped");
    expect(joined).toContain("/devcontainer up");
  });

  it("devcontainer_host_exec is framed as host-only administration", () => {
    const tool = createDevcontainerHostExecTool(makeOptions({ hostExecutionAllowed: true }));
    expect(tool.promptSnippet).toContain("HOST");
    const joined = (tool.promptGuidelines ?? []).join("\n");
    expect(joined).toContain("HOST, not in the container");
    expect(joined).toContain("host administration");
    expect(joined).toContain("docker itself");
    expect(joined).toContain("bind mount");
  });
});

describe("host-exec denial remedy (AC-4)", () => {
  it("names the configuration as the cause instead of pointing at a knob that is already on", async () => {
    const tool = createDevcontainerHostExecTool(makeOptions({ hostExecutionAllowed: false }));

    const error = await tool
      .execute("t1", { argv: ["hostname"] }, undefined, undefined, { cwd: "/session" })
      .then(() => undefined, (caught: unknown) => caught as { remedy?: string; message: string });

    expect(error?.message).toContain("disabled by policy");
    // The default GRANTS host execution, so the only remaining cause is a configuration deny — the
    // remedy has to say so, name both layers, and not tell the operator to enable something that is
    // already enabled.
    expect(error?.remedy).toContain("hostExecution.allow: false");
    expect(error?.remedy).toContain("project");
    expect(error?.remedy).toContain("global");
    expect(error?.remedy).toContain("/reload");
    expect(error?.remedy).not.toContain("allow=true");
  });
});

describe("devcontainer_host_exec — a withheld attempt is reported", () => {
  it("reports the attempt when configuration withholds host execution", async () => {
    const attempts: string[] = [];
    const tool = createDevcontainerHostExecTool(
      makeOptions({ hostExecutionAllowed: false, onWithheldHostAttempt: (program) => void attempts.push(program) }),
    );

    await expect(
      (tool.execute as unknown as (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>)(
        "call-1",
        { argv: ["systemctl", "restart", "docker"] },
        undefined,
      ),
    ).rejects.toMatchObject({ kind: "policy-denied" });

    // The agent's surface matters most here: without this, a withheld configuration left the operator
    // with "no host commands this session" while the agent kept trying (adversarial review).
    // The program name only: the visibility renders and stores no command text.
    expect(attempts).toEqual(["systemctl"]);
  });
});
