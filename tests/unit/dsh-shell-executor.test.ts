/**
 * The dsh `ctx.shell` provider.
 *
 * These tests pin the two contracts the port rests on: `resolve()` applies this extension's own
 * deadlines/caps (never a caller's uncapped number), and `execute()` runs the command through the
 * SHARED execution service rather than spawning anything itself — which is what keeps target
 * validation, policy, audit and the routing guard in force on the dsh side.
 *
 * The handle is deliberately a settled one (batch API underneath): `readOutput()` yields the captured
 * output exactly once, and `kill()` reports "nothing to kill" instead of pretending to own a process.
 */
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it, vi } from "vitest";
import { DevcontainerShellExecutor } from "../../extensions/dsh/executor.js";
import { RuntimeError } from "../../src/errors.js";
import type { ExecOutcome, ExecRequest, ExecutionService } from "../../src/execution-service.js";

function outcome(overrides: Partial<ExecOutcome> = {}): ExecOutcome {
  return {
    operation: "routed-bash",
    workspaceKey: "/workspace/project",
    candidateId: "abc123",
    candidateName: "project",
    exitCode: 0,
    signal: null,
    durationMs: 1,
    truncated: false,
    policyAuthorized: true,
    stdout: "hello\n",
    stderr: "",
    ...overrides,
  };
}

function harness(workspace = "/workspace/project") {
  const calls: ExecRequest[] = [];
  const state: { outcome?: ExecOutcome; error?: unknown } = { outcome: outcome() };
  const service = {
    exec: vi.fn(async (request: ExecRequest) => {
      calls.push(request);
      if (state.error !== undefined) throw state.error;
      return state.outcome ?? outcome();
    }),
  } as unknown as ExecutionService;
  const ctx = new Context();
  const executor = new DevcontainerShellExecutor(ctx, {
    execution: service,
    workspace,
    timeoutMs: 1_000,
    maxTimeoutMs: 5_000,
    maxOutputBytes: 100,
  });
  return { executor, calls, state, ctx };
}

describe("DevcontainerShellExecutor.resolve", () => {
  it("fills the default deadline and workdir from the plugin configuration", () => {
    const { executor } = harness();
    const spec = executor.resolve({ command: "pwd" });
    expect(spec.workdir).toBe("/workspace/project");
    expect(spec.timeoutMs).toBe(1_000);
    expect(spec.onExpiry).toBe("kill");
    expect(spec.stdoutMaxBytes).toBe(100);
  });

  it("caps a caller's deadline and capture budget instead of trusting them", () => {
    const { executor } = harness();
    const spec = executor.resolve({ command: "pwd", timeoutMs: 60_000, stdoutMaxBytes: 5_000 });
    expect(spec.timeoutMs).toBe(5_000);
    expect(spec.stdoutMaxBytes).toBe(100);
  });

  it("keeps a caller's onExpiry policy and non-absolute workdirs fall back to the workspace", () => {
    const { executor } = harness();
    expect(executor.resolve({ command: "pwd", onExpiry: "none" }).onExpiry).toBe("none");
    expect(executor.resolve({ command: "pwd", workdir: "relative/dir" }).workdir).toBe("/workspace/project");
  });
});

describe("DevcontainerShellExecutor.execute", () => {
  it("routes through the shared execution service as a routed bash call", async () => {
    const { executor, calls } = harness();
    await executor.execute(executor.resolve({ command: "echo hi" }));
    expect(calls).toHaveLength(1);
    const [request] = calls;
    expect(request?.operation).toBe("routed-bash");
    expect(request?.workspace).toBe("/workspace/project");
    expect(request?.cmd).toBe("/bin/sh");
    expect(request?.args).toEqual(["-lc", "echo hi"]);
  });

  it("delivers dsh's declared environment verbatim on the explicit channel", async () => {
    const { executor, calls } = harness();
    await executor.execute(
      executor.resolve({ command: "env", env: { CLAUDE_PROJECT_DIR: "/p" }, dshEnv: { DSH_CALL_ID: "c1" } }),
    );
    // `explicitEnvironment` bypasses `environmentAllowlist`: these are values the harness declared for
    // this command, not ambient state the allowlist governs (see `ExecRequest.explicitEnvironment`).
    expect(calls[0]?.explicitEnvironment).toEqual({ CLAUDE_PROJECT_DIR: "/p", DSH_CALL_ID: "c1" });
    expect(calls[0]?.environment).toBeUndefined();
  });

  it("returns a settled handle whose output is readable exactly once", async () => {
    const { executor, state } = harness();
    state.outcome = outcome({ stdout: "out", stderr: "err" });
    const handle = await executor.execute(executor.resolve({ command: "x" }));
    expect(handle.status).toBe("completed");
    expect(handle.exitCode).toBe(0);
    const first = handle.readOutput();
    expect(first.delta).toContain("out");
    expect(first.delta).toContain("err");
    expect(handle.readOutput().delta).toBe("");
    // Offset readers do not consume the readOutput cursor.
    expect(handle.observed.stdout.readFrom(0).text).toBe("out");
    expect(handle.observed.stdout.readFrom(2).text).toBe("t");
    expect(handle.kill()).toBe(false);
    const result = await handle.result();
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
  });

  it("classifies a deadline as timedOut on a killed handle", async () => {
    const { executor, state } = harness();
    state.error = new RuntimeError({ kind: "timeout", message: "Command timed out after 1s" });
    const handle = await executor.execute(executor.resolve({ command: "sleep 10" }));
    expect(handle.status).toBe("killed");
    const result = await handle.result();
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
  });

  it("classifies a caller abort as aborted rather than as an infrastructure failure", async () => {
    const { executor, state } = harness();
    const controller = new AbortController();
    controller.abort();
    state.error = new Error("aborted");
    const handle = await executor.execute(executor.resolve({ command: "x", signal: controller.signal }));
    expect(handle.status).toBe("killed");
    expect((await handle.result()).aborted).toBe(true);
  });

  it("propagates a policy denial: a refusal is preparation failure, not a tool result", async () => {
    const { executor, state } = harness();
    state.error = new RuntimeError({ kind: "policy-denied", message: "not allowed" });
    await expect(executor.execute(executor.resolve({ command: "x" }))).rejects.toThrow("not allowed");
  });
});
