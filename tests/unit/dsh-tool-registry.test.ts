/**
 * The real dsh tool pipeline, end to end and model-free.
 *
 * Mounting the actual `ToolRegistry` (from `@deepseek-ai/dsh-tools`, with `dsh-system-prompt` supplying
 * the service it injects) proves three things a fake cannot: our `defineTool` schema is accepted by
 * dsh's own validator, the tool is discoverable in its catalog, and `ctx.tools.execute()` runs our
 * `createCommandHandlers` path and returns the rendered text. It is also the only surface ACP can use,
 * since ACP composes no command consumer.
 */
import { Context } from "@deepseek-ai/cordis";
import ToolsPlugin from "@deepseek-ai/dsh-tools";
import SystemPromptPlugin from "@deepseek-ai/dsh-system-prompt";
import { describe, expect, it } from "vitest";
import { createDevcontainerTool } from "../../extensions/dsh/tools.js";
import { DEFAULTS } from "../../src/config.js";
import type { ExecutionService } from "../../src/execution-service.js";
import { TargetStore } from "../../src/target-store.js";
import type { DshRuntime } from "../../extensions/dsh/runtime.js";

function runtime(): DshRuntime {
  const registry = async () => ({ entries: [] as const, diagnostics: [] as const });
  return {
    config: DEFAULTS,
    diagnostics: [],
    targetStore: new TargetStore({}),
    execution: { exec: async () => Promise.reject(new Error("not used")) } as unknown as ExecutionService,
    host: {} as DshRuntime["host"],
    registry,
    refresh: registry,
  };
}

async function mount() {
  const ctx = new Context();
  ctx.plugin(SystemPromptPlugin);
  ctx.plugin(ToolsPlugin);
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (ctx.tools === undefined) throw new Error("ToolRegistry did not mount");
  ctx.tools.register(createDevcontainerTool(runtime(), { workspace: "/workspace" }));
  return ctx;
}

describe("devcontainer tool in the real dsh ToolRegistry", () => {
  it("is advertised with its parameter schema", async () => {
    const ctx = await mount();
    const schemas = ctx.tools.schemas();
    const devcontainer = schemas.find((schema) => schema.name === "devcontainer");
    expect(devcontainer).toBeDefined();
    expect(JSON.stringify(devcontainer)).toContain("\"verb\"");
  });

  it("executes through ctx.tools.execute and returns the rendered text", async () => {
    const ctx = await mount();
    const result = await ctx.tools.execute({
      callId: "call-1" as never,
      name: "devcontainer",
      arguments: { verb: "status" },
      signal: new AbortController().signal,
    });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.content)).toContain("DevContainer target");
  });

  it("reports a refusal as an error result", async () => {
    const ctx = await mount();
    const result = await ctx.tools.execute({
      callId: "call-2" as never,
      name: "devcontainer",
      arguments: { verb: "frobnicate" },
      signal: new AbortController().signal,
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("unknown-verb");
  });
});
