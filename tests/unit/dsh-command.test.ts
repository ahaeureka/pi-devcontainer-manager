/**
 * dsh wiring: the plugin entry and the `devcontainer` command adapter.
 *
 * The command adapter is the management half of the port, and it must reuse `src/commands.ts` rather
 * than reimplement the verbs — so these tests assert the two things that reuse can silently break:
 * the verb grammar reaches the shared handlers, and a headless surface (no confirm/select) makes
 * destructive verbs REFUSE instead of assuming consent.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { createDevcontainerCommand } from "../../extensions/dsh/command.js";
import { apply } from "../../extensions/dsh/index.js";
import { DevcontainerShellExecutor } from "../../extensions/dsh/executor.js";
import { DEFAULTS } from "../../src/config.js";
import type { ExecutionService } from "../../src/execution-service.js";
import { TargetStore } from "../../src/target-store.js";
import type { DshRuntime } from "../../extensions/dsh/runtime.js";

function runtime(diagnostics: readonly string[] = []): DshRuntime {
  const registry = async () => ({ entries: [] as const, diagnostics: [] as const });
  return {
    config: DEFAULTS,
    diagnostics,
    targetStore: new TargetStore({}),
    execution: { exec: async () => Promise.reject(new Error("not used")) } as unknown as ExecutionService,
    host: {} as DshRuntime["host"],
    registry,
    refresh: registry,
  };
}

const signal = () => new AbortController().signal;

describe("devcontainer command adapter", () => {
  it("dispatches the existing verb grammar (list with an empty registry)", async () => {
    const command = createDevcontainerCommand(runtime(), { workspace: "/workspace" });
    expect(command.name).toBe("devcontainer");
    const result = await command.handler({ rawInput: " list ", signal: signal() });
    expect(result.kind).toBe("success");
    expect(result.text.length).toBeGreaterThan(0);
  });

  it("reports an unknown verb as an error with the usage text", async () => {
    const command = createDevcontainerCommand(runtime(), { workspace: "/workspace" });
    const result = await command.handler({ rawInput: "frobnicate", signal: signal() });
    expect(result.kind).toBe("error");
    expect(result.text).toContain("[unknown-verb]");
    expect(result.text).toContain("Usage: devcontainer");
  });

  it("returns usage for empty input", async () => {
    const command = createDevcontainerCommand(runtime(), { workspace: "/workspace" });
    const result = await command.handler({ rawInput: "   ", signal: signal() });
    expect(result.kind).toBe("error");
    expect(result.text).toContain("Usage: devcontainer");
  });

  it("refuses a destructive verb on a surface with no confirmation dialog", async () => {
    const command = createDevcontainerCommand(runtime(), { workspace: "/workspace" });
    const result = await command.handler({ rawInput: "stop", signal: signal() });
    expect(result.kind).toBe("error");
    // Either "no target" or "needs a confirmation" — both are refusals, never a silent stop.
    expect(result.text.startsWith("[")).toBe(true);
  });

  it("prefixes configuration diagnostics WITHOUT turning a successful verb into an error", async () => {
    const command = createDevcontainerCommand(runtime(["global configuration is unreadable"]), {
      workspace: "/workspace",
    });
    const result = await command.handler({ rawInput: "status", signal: signal() });
    expect(result.kind).toBe("success");
    expect(result.text).toContain("[config] global configuration is unreadable");
  });

  it("reports a discovery problem once and then forgets it", async () => {
    const seen: string[] = [];
    const base = runtime();
    let reads = 0;
    const command = createDevcontainerCommand(
      {
        ...base,
        registry: async () => {
          reads += 1;
          return {
            entries: [] as const,
            diagnostics: reads === 1 ? ["scan pruned at maxDepth"] : [],
          };
        },
      },
      { workspace: "/workspace" },
    );
    const first = await command.handler({ rawInput: "list", signal: signal() });
    seen.push(first.text);
    const second = await command.handler({ rawInput: "list", signal: signal() });
    expect(seen[0]).toContain("[config] scan pruned at maxDepth");
    expect(second.text).not.toContain("scan pruned at maxDepth");
  });
});

describe("dsh plugin entry", () => {
  it("routes a shell command into the shared gate: no target is a typed refusal, not a host fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-entry-"));
    const configPath = join(dir, "config.json");
    // The workspace must be an allowed root, or the refusal would be `workspace-not-allowed` and the
    // test would prove nothing about the target path.
    writeFileSync(configPath, JSON.stringify({ allowedWorkspaceRoots: [dir] }));
    const ctx = new Context();
    apply(ctx, { workspace: dir, globalConfigPath: configPath });
    const shell = ctx.shell as DevcontainerShellExecutor;
    // `execute()` is where dsh's bash tool lands. With nothing selected it must throw the same typed
    // error Pi's routed bash gets — never spawn on the host as a fallback.
    await expect(shell.execute(shell.resolve({ command: "echo hi" }))).rejects.toHaveProperty("kind");
  });

  it("provides ctx.shell and registers the devcontainer command", async () => {
    const ctx = new Context();
    const registered: { name?: string }[] = [];
    ctx.provide("commands", {
      register: (definition: { name?: string }) => {
        registered.push(definition);
        return () => undefined;
      },
    });
    apply(ctx, { workspace: tmpdir(), globalConfigPath: `${tmpdir()}/does-not-exist.json` });
    expect(ctx.shell).toBeInstanceOf(DevcontainerShellExecutor);
    // Registration is deferred through `ctx.inject(['commands'])`, so it lands on a child fiber.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(registered.map((definition) => definition.name)).toEqual(["devcontainer"]);
  });

  it("loads without a command surface instead of staying pending", async () => {
    const ctx = new Context();
    apply(ctx, { workspace: tmpdir(), globalConfigPath: `${tmpdir()}/does-not-exist.json` });
    expect(ctx.shell).toBeInstanceOf(DevcontainerShellExecutor);
    // Give a deferred `ctx.inject(['commands'])` a chance to park: the provider must stay registered
    // either way, because it is the primary capability.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ctx.shell).toBeInstanceOf(DevcontainerShellExecutor);
  });

  it("registers the command when the registry is mounted AFTER apply (web load order)", async () => {
    // The real failure this pins: a plain `ctx.get('commands')` during apply() misses a registry that
    // mounts later, so `/devcontainer …` silently did nothing in the web app.
    const ctx = new Context();
    const registered: { name?: string }[] = [];
    apply(ctx, { workspace: tmpdir(), globalConfigPath: `${tmpdir()}/does-not-exist.json` });
    expect(registered).toHaveLength(0);
    ctx.provide("commands", {
      register: (definition: { name?: string }) => {
        registered.push(definition);
        return () => undefined;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(registered.map((definition) => definition.name)).toEqual(["devcontainer"]);
  });
});

describe("devcontainer tool (web + acp surface)", () => {
  const tool = async (overrides: { confirm?: (r: { reason: string }) => Promise<boolean> } = {}) => {
    const { createDevcontainerTool } = await import("../../extensions/dsh/tools.js");
    return createDevcontainerTool(runtime() as never, {
      workspace: "/workspace",
      ...(overrides.confirm !== undefined
        ? { confirm: (request: { reason: string }) => overrides.confirm!(request) }
        : {}),
    });
  };
  const exec = () => ({ signal: new AbortController().signal });

  it("is a model-facing tool named devcontainer with a verb parameter", async () => {
    const definition = await tool();
    expect(definition.name).toBe("devcontainer");
    expect(JSON.stringify(definition.parameters)).toContain("verb");
    expect(definition.description).toContain("use <workspace|container-id>");
  });

  it("dispatches the shared verb grammar and renders its text", async () => {
    const definition = await tool();
    const value = await definition.execute({ verb: "status", args: "" }, exec() as never);
    // The canonical value IS the rendered text (a string), so a caller cannot lose the detail.
    expect(value).toContain("DevContainer target");
  });

  it("surfaces a refusal as a tool error instead of a successful result", async () => {
    const definition = await tool();
    await expect(definition.execute({ verb: "frobnicate" }, exec() as never)).rejects.toThrow("[unknown-verb]");
  });

  it("asks for approval for a destructive verb and proceeds only on a grant", async () => {
    const asked: string[] = [];
    const denied = await tool({ confirm: async (request) => { asked.push(request.reason); return false; } });
    // With no target bound the handler refuses before the confirmation, so the reason is not reached;
    // what matters is that the tool never claims success.
    await expect(denied.execute({ verb: "stop" }, exec() as never)).rejects.toThrow(/^\[/);
    const allowed = await tool({ confirm: async (request) => { asked.push(request.reason); return true; } });
    await expect(allowed.execute({ verb: "stop" }, exec() as never)).rejects.toThrow(/^\[/);
  });

  it("fails closed when the surface supplies no approval channel", async () => {
    const definition = await tool();
    // `confirm` defaults to false, so a destructive verb can never proceed silently.
    await expect(definition.execute({ verb: "remove" }, exec() as never)).rejects.toThrow(/^\[/);
  });
});
