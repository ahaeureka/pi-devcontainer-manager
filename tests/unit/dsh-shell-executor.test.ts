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

describe("per-workspace activation (host delegation)", () => {
  const delegateRun = (): { delegate: import("@deepseek-ai/dsh-shell").ShellExecutor; seen: string[] } => {
    const seen: string[] = [];
    const delegate = {
      resolve: (request: { command: string }) => {
        seen.push(`resolve:${request.command}`);
        return { command: request.command, workdir: "/host", timeoutMs: 1, onExpiry: "kill", stdoutMaxBytes: 1 };
      },
      execute: async (spec: { command: string }) => {
        seen.push(`execute:${spec.command}`);
        return {
          status: "completed",
          exitCode: 0,
          signal: null,
          done: Promise.resolve(),
          readOutput: () => ({ delta: "host output", lossy: false }),
          observed: { stdout: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) }, stderr: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) } },
          kill: () => false,
          result: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1, stdout: { text: "host output", truncated: false }, stderr: { text: "", truncated: false } }),
        };
      },
    } as unknown as import("@deepseek-ai/dsh-shell").ShellExecutor;
    return { delegate, seen };
  };

  it("hands an UNMANAGED workspace to the host executor instead of refusing", async () => {
    const calls: ExecRequest[] = [];
    const service = {
      exec: vi.fn(async (request: ExecRequest) => {
        calls.push(request);
        return outcome();
      }),
    } as unknown as ExecutionService;
    const { delegate, seen } = delegateRun();
    const executor = new DevcontainerShellExecutor(new Context(), {
      execution: service,
      workspace: "/plain/project",
      isManaged: () => false,
      hostExecutor: () => delegate,
    });
    const handle = await executor.execute(executor.resolve({ command: "pwd" }));
    expect(seen).toEqual(["resolve:pwd", "execute:pwd"]);
    expect(calls).toHaveLength(0);
    expect(handle.readOutput().delta).toBe("host output");
  });

  it("keeps a MANAGED workspace on the container path (delegation is not a fallback)", async () => {
    const calls: ExecRequest[] = [];
    const service = {
      exec: vi.fn(async (request: ExecRequest) => {
        calls.push(request);
        return outcome();
      }),
    } as unknown as ExecutionService;
    const { delegate, seen } = delegateRun();
    const executor = new DevcontainerShellExecutor(new Context(), {
      execution: service,
      workspace: "/ws/project",
      isManaged: () => true,
      hostExecutor: () => delegate,
    });
    await executor.execute(executor.resolve({ command: "pwd" }));
    expect(seen).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("uses the workspace's own devcontainer config as the default activation rule", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const plain = mkdtempSync(join(tmpdir(), "plain-"));
    const managed = mkdtempSync(join(tmpdir(), "managed-"));
    mkdirSync(join(managed, ".devcontainer"));
    writeFileSync(join(managed, ".devcontainer", "devcontainer.json"), "{}");

    const { delegate, seen } = delegateRun();
    const executor = new DevcontainerShellExecutor(new Context(), {
      execution: { exec: async () => outcome() } as unknown as ExecutionService,
      workspace: plain,
      hostExecutor: () => delegate,
    });
    await executor.execute(executor.resolve({ command: "pwd" }));
    expect(seen).toEqual(["resolve:pwd", "execute:pwd"]);

    const managedExecutor = new DevcontainerShellExecutor(new Context(), {
      execution: { exec: async () => outcome() } as unknown as ExecutionService,
      workspace: managed,
      hostExecutor: () => delegate,
    });
    await managedExecutor.execute(managedExecutor.resolve({ command: "pwd" }));
    // Still only the plain workspace's delegation: the managed one never touched the delegate.
    expect(seen).toHaveLength(2);
  });
});

describe("target adoption before a container-side command", () => {
  it("calls ensureTarget with the resolved workdir on the container path", async () => {
    const seen: string[] = [];
    const executor = new DevcontainerShellExecutor(new Context(), {
      execution: { exec: async () => outcome() } as unknown as ExecutionService,
      workspace: "/ws/project",
      isManaged: () => true,
      hostExecutor: () => undefined,
      ensureTarget: async (workspace: string) => {
        seen.push(workspace);
      },
    });
    await executor.execute(executor.resolve({ command: "pwd" }));
    expect(seen).toEqual(["/ws/project"]);
  });

  it("does NOT pay for adoption on the delegated host path", async () => {
    const seen: string[] = [];
    const delegate = {
      resolve: (request: { command: string }) => ({ ...request, workdir: "/host", timeoutMs: 1, onExpiry: "kill", stdoutMaxBytes: 1 }),
      execute: async () => ({
        status: "completed",
        exitCode: 0,
        signal: null,
        done: Promise.resolve(),
        readOutput: () => ({ delta: "", lossy: false }),
        observed: { stdout: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) }, stderr: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) } },
        kill: () => false,
        result: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1, stdout: { text: "", truncated: false }, stderr: { text: "", truncated: false } }),
      }),
    } as unknown as import("@deepseek-ai/dsh-shell").ShellExecutor;
    const executor = new DevcontainerShellExecutor(new Context(), {
      execution: { exec: async () => outcome() } as unknown as ExecutionService,
      workspace: "/plain/project",
      isManaged: () => false,
      hostExecutor: () => delegate,
      ensureTarget: async (workspace: string) => {
        seen.push(workspace);
      },
    });
    await executor.execute(executor.resolve({ command: "pwd" }));
    expect(seen).toEqual([]);
  });
});

describe("host executor module resolution", () => {
  it("loads an absolute path and reports every base it tried for a missing specifier", async () => {
    const { loadExecutorModule } = await import("../../extensions/dsh/host-executor.js");
    const path = await import("node:path");
    const url = await import("node:url");
    // An absolute path is the operator's escape hatch (`hostExecutorModule`), so it must work without
    // touching any resolver base.
    const resolved = await loadExecutorModule(
      path.resolve("node_modules", "@deepseek-ai", "dsh-shell", "lib", "index.js"),
    );
    expect(Object.keys(resolved).length).toBeGreaterThan(0);
    expect(url.pathToFileURL("x").protocol).toBe("file:");
    await expect(loadExecutorModule("@example/definitely-not-installed")).rejects.toThrow(
      /cannot resolve @example\/definitely-not-installed \(tried: /,
    );
  });
});
