/**
 * dsh plugin-structure conformance (`extensions/dsh/index.ts`).
 *
 * The dsh guidelines are explicit: a plugin exports `name` / `inject` / `Config`; a SERVICE PROVIDER is
 * a class plugin that `ctx.plugin()`s, not something constructed inside another `apply`; consumers
 * declare what they need with `inject` so the loader waits. This file asserts that structure against
 * the REAL services (`tools`, `systemPrompt`, and a command registry), because the failure mode is
 * silent: everything keeps working as closures until the day a profile drops one surface.
 */
import { readFileSync } from "node:fs";
import { Context } from "@deepseek-ai/cordis";
import SystemPromptPlugin, { renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import ToolsPlugin from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";
import * as entry from "../../extensions/dsh/index.js";
import { DevcontainerShellProvider, ShellProviderSchema } from "../../extensions/dsh/shell.js";
import { commandPlugin } from "../../extensions/dsh/command.js";
import { promptPlugin } from "../../extensions/dsh/prompt.js";
import { toolPlugin } from "../../extensions/dsh/tools.js";
import { DshRuntimeService } from "../../extensions/dsh/runtime.js";

const config = { workspace: "/tmp/dsh-composition-test", globalConfigPath: "/nonexistent.json" };

async function compose(options: { withCommands?: boolean } = {}) {
  const ctx = new Context();
  ctx.plugin(SystemPromptPlugin);
  ctx.plugin(ToolsPlugin);
  const registered: { name: string }[] = [];
  if (options.withCommands === true) {
    ctx.provide("commands", {
      register: (definition: { name: string }) => {
        registered.push(definition);
        return () => undefined;
      },
    });
  }
  await entry.apply(ctx, config);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { ctx, registered };
}

describe("plugin metadata (what the loader reads)", () => {
  it("exports name and a validated Config", () => {
    expect(entry.name).toBeTypeOf("string");
    expect(entry.Config).toBeDefined();
    // Schemastery: validation is the loader's job, so the schema must be a real standard-schema.
    const parsed = entry.Config({ activation: "always" } as never) as { activation: string };
    expect(parsed.activation).toBe("always");
  });

  it("declares inject on every consumer and on the provider", () => {
    expect(toolPlugin.inject).toContain("tools");
    expect(commandPlugin.inject).toContain("commands");
    expect(promptPlugin.inject).toContain("systemPrompt");
    expect(DevcontainerShellProvider.inject).toEqual(["devcontainerRuntime"]);
    // The runtime service depends on nothing (it only composes `src/`), so its inject is empty.
    expect(DshRuntimeService.inject).toEqual([]);
  });

  it("validates the provider's own config instead of inheriting the entry's", () => {
    expect(ShellProviderSchema({ hostFallback: "refuse" } as never)).toMatchObject({ hostFallback: "refuse" });
  });

  it("no longer wires surfaces by closure: the entry composes plugins only", () => {
    const source = readFileSync(new URL("../../extensions/dsh/index.ts", import.meta.url), "utf8");
    // A regression to the closure style would reintroduce these.
    expect(source).not.toContain('ctx.get("tools"');
    expect(source).not.toContain("ctx.inject([");
    expect(source).not.toMatch(/new DevcontainerShellExecutor/);
    expect(source).toContain("ctx.plugin(");
  });
});

describe("real composition", () => {
  it("provides ctx.shell through the class plugin", async () => {
    const { ctx } = await compose();
    expect(ctx.shell).toBeInstanceOf(DevcontainerShellProvider);
  });

  it("registers the tool in the real ToolRegistry", async () => {
    const { ctx } = await compose();
    const names = ctx.tools.schemas().map((schema) => schema.name);
    expect(names).toContain("devcontainer");
  });

  it("contributes the prompt section to the real SystemPrompt", async () => {
    const { ctx } = await compose();
    const prompt = ctx.get("systemPrompt") as { assemble(): Promise<unknown> };
    expect(renderPrompt((await prompt.assemble()) as never)).toContain("## DevContainer execution context");
  });

  it("registers the command when a command registry exists", async () => {
    const { registered } = await compose({ withCommands: true });
    expect(registered.map((definition) => definition.name)).toContain("devcontainer");
  });

  it("stays loaded without a command registry (no mandatory surface)", async () => {
    const { ctx } = await compose();
    // A missing registry parks only the command plugin; the shell provider and the tool are separate
    // fibers, which is the whole reason for the split.
    expect(ctx.shell).toBeInstanceOf(DevcontainerShellProvider);
    expect(ctx.tools.schemas().map((schema) => schema.name)).toContain("devcontainer");
  });
});
