/**
 * The dsh prompt contribution (`extensions/dsh/prompt.ts`).
 *
 * dsh injects tool SCHEMAS but never the reason to call them, so without a section the agent only
 * learns about containers when a command is refused. These tests mount the REAL `SystemPrompt` service
 * and assert the section (a) registers without a name/order clash, (b) survives assembly, and (c) is
 * re-evaluated per assembly — the text must report the target the runtime holds NOW, not at load.
 */
import { Context } from "@deepseek-ai/cordis";
import SystemPromptPlugin, { renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import { describe, expect, it } from "vitest";
import { devcontainerPromptText, registerPromptSection, SECTION_NAME } from "../../extensions/dsh/prompt.js";
import { DEFAULTS } from "../../src/config.js";
import type { ExecutionService } from "../../src/execution-service.js";
import { TargetStore } from "../../src/target-store.js";
import type { DshRuntime } from "../../extensions/dsh/runtime.js";

function runtime(): DshRuntime {
  const registry = async () => ({ entries: [] as const, diagnostics: [] as const });
  return {
    workspace: "/workspace",
    config: DEFAULTS,
    diagnostics: [],
    targetStore: new TargetStore({}),
    execution: { exec: async () => Promise.reject(new Error("not used")) } as unknown as ExecutionService,
    host: {} as DshRuntime["host"],
    registry,
    refresh: registry,
    autoSelect: async () => undefined,
    setAutoSelection: () => undefined,
  };
}

describe("devcontainer prompt text", () => {
  it("names the workspace and the refusal-to-remedy mapping when nothing is selected", () => {
    const text = devcontainerPromptText(runtime(), { workspace: "/ws/project" });
    expect(text).toContain("## DevContainer execution context");
    expect(text).toContain("Target: none selected (workspace `/ws/project`)");
    expect(text).toContain("No DevContainer target is selected.");
    expect(text).toContain("devcontainer up");
    // The two operational traps the agent otherwise re-learns by failing:
    expect(text).toContain("selected-ambiguous");
    expect(text).toContain("does NOT apply configuration changes");
  });

  it("reports the CURRENT target rather than a snapshot taken at registration", async () => {
    const rt = runtime();
    const store = rt.targetStore;
    // `select()` derives `candidateId` from the candidate itself (a bare id in the selection is dropped),
    // so the fixture mirrors what `selectionFor` produces.
    await store.select({
      status: "selected-valid",
      workspaceKey: "/ws/project",
      candidate: {
        id: "abcdef123456789",
        name: "project",
        workspaceKey: "/ws/project",
        state: "running",
        status: "running",
      },
    });
    const text = devcontainerPromptText(rt, { workspace: "/ws/project" });
    // Only the verified id is rendered, truncated; no invented container name.
    expect(text).toContain("Target: container abcdef123456 — selected-valid");
    expect(text).not.toContain("abcdef123456789");
  });
});

describe("registerPromptSection against the real SystemPrompt service", () => {
  it("registers a section that assembly renders", async () => {
    const ctx = new Context();
    ctx.plugin(SystemPromptPlugin);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const prompt = ctx.get("systemPrompt") as { assemble(): Promise<{ sections: unknown[] }> };
    const before = await prompt.assemble();
    registerPromptSection(ctx, runtime(), { workspace: "/ws/project" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const after = await prompt.assemble();
    expect(after.sections.length).toBeGreaterThan(before.sections.length);
    // The section NAME is registry metadata; `renderPrompt` emits text only. Assert both: the name is
    // in the assembly, the text is in the rendered prompt.
    expect(JSON.stringify(after)).toContain(SECTION_NAME);
    const text = renderPrompt(after as never);
    expect(text).toContain("## DevContainer execution context");
  });

  it("does not throw when the prompt service is absent", () => {
    const ctx = new Context();
    expect(() => registerPromptSection(ctx, runtime(), { workspace: "/ws" })).not.toThrow();
  });
});
