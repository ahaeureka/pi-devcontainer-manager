/**
 * Unit tests for the routed bash operations (Slice 6).
 *
 * The router implements Pi's `BashOperations` shape against the shared
 * execution service: raw shell text is wrapped in `/bin/sh -lc`, the timeout
 * is converted from seconds to milliseconds, the environment is reduced to
 * the allowlist, and the captured stdout/stderr is replayed through Pi's
 * `onData` callback AFTER the command settles. There is no silent host
 * fallback: typed errors propagate to the caller.
 */
import { describe, expect, it, vi } from "vitest";
import { createRoutedBashOperations } from "../../src/bash-router.js";
import { RuntimeError } from "../../src/errors.js";
import type { ExecOutcome, ExecRequest, ExecutionService } from "../../src/execution-service.js";

function fakeExecution(): {
  service: ExecutionService;
  calls: ExecRequest[];
  respond: (outcome: ExecOutcome) => void;
  fail: (error: unknown) => void;
} {
  const calls: ExecRequest[] = [];
  const state: { respond: (o: ExecOutcome) => void; fail: (e: unknown) => void } = {
    respond: () => undefined,
    fail: () => undefined,
  };
  const service = {
    exec: vi.fn((request: ExecRequest): Promise<ExecOutcome> => {
      calls.push(request);
      return new Promise<ExecOutcome>((resolve, reject) => {
        state.respond = resolve;
        state.fail = reject;
      });
    }),
  } as unknown as ExecutionService;
  return {
    service,
    calls,
    respond: (outcome) => state.respond(outcome),
    fail: (error) => state.fail(error),
  };
}

function makeRouter(overrides: Partial<Parameters<typeof createRoutedBashOperations>[0]> = {}) {
  const execution = fakeExecution();
  const router = createRoutedBashOperations({
    execution: execution.service,
    sessionWorkspace: "/session",
    initiator: "routed-bash",
    environmentAllowlist: ["FOO", "BAR"],
    ...overrides,
  });
  return { router, execution };
}

const okOutcome = (overrides: Partial<ExecOutcome> = {}): ExecOutcome => ({
  operation: "routed-bash",
  workspaceKey: "ws-project-a",
  candidateId: "abc123456789",
  candidateName: "project-a",
  exitCode: 0,
  signal: null,
  durationMs: 5,
  truncated: false,
  policyAuthorized: true,
  stdout: "",
  stderr: "",
  ...overrides,
});

describe("createRoutedBashOperations.exec", () => {
  it("wraps shell text in /bin/sh -lc and forwards it to the execution service", async () => {
    const { router, execution } = makeRouter();
    const pending = router.exec("npm test", "/ws/project-a", { onData: () => undefined });
    expect(execution.calls).toHaveLength(1);
    const request = execution.calls[0]!;
    expect(request.cmd).toBe("/bin/sh");
    expect(request.args).toEqual(["-lc", "npm test"]);
    expect(request.operation).toBe("routed-bash");
    expect(request.initiator).toBe("routed-bash");
    expect(request.workspace).toBe("/ws/project-a");
    execution.respond(okOutcome());
    await expect(pending).resolves.toMatchObject({ exitCode: 0 });
  });

  it("maps the user-bash initiator for the `!`/`!!` surface", async () => {
    const { router, execution } = makeRouter({ initiator: "user-bash" });
    const pending = router.exec("ls", "/ws/project-a", { onData: () => undefined });
    expect(execution.calls[0]!.operation).toBe("user-bash");
    expect(execution.calls[0]!.initiator).toBe("user-bash");
    execution.respond(okOutcome({ operation: "user-bash" }));
    await pending;
  });

  it("converts the Pi timeout (seconds) into an enforced timeout (typed timeout error)", async () => {
    const { router, execution } = makeRouter();
    const pending = router.exec("sleep 1", "/ws/project-a", { onData: () => undefined, timeout: 1 });
    // Timeout is NOT forwarded to the service (the locked service drops it);
    // the router enforces it by aborting the request's signal.
    expect(execution.calls[0]!.timeoutMs).toBeUndefined();
    expect(execution.calls[0]!.signal).toBeDefined();
    await expect(pending).rejects.toMatchObject({ kind: "timeout" });
  });

  it("does not create an abort signal when no timeout is provided", async () => {
    const { router, execution } = makeRouter();
    const pending = router.exec("ls", "/ws/project-a", { onData: () => undefined });
    expect(execution.calls[0]!.timeoutMs).toBeUndefined();
    expect(execution.calls[0]!.signal).toBeUndefined();
    execution.respond(okOutcome());
    await pending;
  });

  it("forwards the abort signal", async () => {
    const { router, execution } = makeRouter();
    const signal = new AbortController().signal;
    const pending = router.exec("ls", "/ws/project-a", { onData: () => undefined, signal });
    expect(execution.calls[0]!.signal).toBe(signal);
    execution.respond(okOutcome());
    await pending;
  });

  it("sanitizes the inherited environment down to the allowlist", async () => {
    const { router, execution } = makeRouter();
    const pending = router.exec("env", "/ws/project-a", {
      onData: () => undefined,
      env: { FOO: "kept", BAR: "kept", PI_SESSION_ID: "secret", API_KEY: "leak", PATH: "/usr/bin" },
    });
    expect(execution.calls[0]!.environment).toEqual({ FOO: "kept", BAR: "kept" });
    execution.respond(okOutcome());
    await pending;
  });

  it("sends no environment object when nothing survives sanitization", async () => {
    const { router, execution } = makeRouter();
    const pending = router.exec("env", "/ws/project-a", {
      onData: () => undefined,
      env: { PI_SESSION_ID: "secret", API_KEY: "leak" },
    });
    expect(execution.calls[0]!.environment).toBeUndefined();
    execution.respond(okOutcome());
    await pending;
  });

  it("falls back to the session workspace when the reported cwd is not absolute", async () => {
    const { router, execution } = makeRouter();
    const pending = router.exec("pwd", ".", { onData: () => undefined });
    expect(execution.calls[0]!.workspace).toBe("/session");
    execution.respond(okOutcome());
    await pending;
  });

  it("replays captured stdout then stderr through onData after settle", async () => {
    const { router, execution } = makeRouter();
    const chunks: string[] = [];
    const pending = router.exec("cmd", "/ws/project-a", { onData: (chunk) => chunks.push(chunk.toString("utf8")) });
    execution.respond(okOutcome({ stdout: "out-1\nout-2", stderr: "err-1" }));
    await pending;
    expect(chunks).toEqual(["out-1\nout-2", "err-1"]);
  });

  it("returns the container-side exit code and truncation flag", async () => {
    const { router, execution } = makeRouter();
    const pending = router.exec("cmd", "/ws/project-a", { onData: () => undefined });
    execution.respond(okOutcome({ exitCode: 3, truncated: true }));
    await expect(pending).resolves.toEqual({ exitCode: 3, truncated: true });
  });

  it("propagates typed errors from the execution service (no silent host fallback)", async () => {
    const { router, execution } = makeRouter();
    const pending = router.exec("cmd", "/ws/project-a", { onData: () => undefined });
    execution.fail(new RuntimeError({ kind: "policy-denied", message: "denied" }));
    await expect(pending).rejects.toMatchObject({ kind: "policy-denied" });
  });

  it("does not call onData on a denied request (failure before any output)", async () => {
    const { router, execution } = makeRouter();
    const chunks: string[] = [];
    const pending = router.exec("cmd", "/ws/project-a", { onData: (chunk) => chunks.push(chunk.toString("utf8")) });
    execution.fail(new RuntimeError({ kind: "target-stopped", message: "stopped" }));
    await expect(pending).rejects.toMatchObject({ kind: "target-stopped" });
    expect(chunks).toHaveLength(0);
  });
});
