/**
 * Pi compatibility guard.
 *
 * The dsh work touched shared code (`src/`) and the Pi entry's auto-adoption, so this file pins what
 * "Pi still works" means without a running agent:
 *
 *  1. the entry loads against a stub `ExtensionAPI` and registers its surfaces (one command, its tools,
 *     the five session hooks) — a broken import or a throw in `activate` would surface here;
 *  2. the Pi path imports NOTHING from `@deepseek-ai/*` (the dsh packages are optional peers that a Pi
 *     user does not have installed) — asserted over the source of the entry and every `src/` module;
 *  3. the shared adoption rule behaves identically for Pi's `exact` scope after the refactor (the
 *     regression risk of moving Pi's inline matcher into `src/target-adoption.ts`).
 *
 * The real end-to-end check stays manual (`pi -p "run whoami"` in a fixture project), because a stub
 * cannot prove the container is actually reached.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import activate from "../../extensions/index.js";
import { resolveTargetAdoption } from "../../src/target-adoption.js";

interface StubSurfaces {
  readonly hooks: string[];
  readonly commands: string[];
  readonly tools: string[];
}

function stubApi(): { api: Parameters<typeof activate>[0]; surfaces: StubSurfaces } {
  const surfaces: StubSurfaces = { hooks: [], commands: [], tools: [] };
  const api = {
    on: (name: string) => {
      surfaces.hooks.push(name);
      return () => undefined;
    },
    registerTool: (definition: { name: string }) => {
      surfaces.tools.push(definition.name);
    },
    registerCommand: (name: string) => {
      surfaces.commands.push(name);
    },
    appendEntry: () => undefined,
  } as unknown as Parameters<typeof activate>[0];
  return { api, surfaces };
}

describe("Pi entry (compatibility with the Pi agent)", () => {
  it("loads against the ExtensionAPI and registers its surfaces", () => {
    const { api, surfaces } = stubApi();
    expect(() => activate(api)).not.toThrow();
    // The command and the hooks are registered at load; the TOOLS are activation-gated (they appear
    // once `session_start` decides this workspace is a DevContainer project), so asserting them here
    // would only encode the stub, not the behaviour.
    expect(surfaces.commands).toEqual(["devcontainer"]);
    expect(surfaces.hooks).toEqual(
      expect.arrayContaining(["session_start", "session_shutdown", "before_agent_start", "tool_call", "user_bash"]),
    );
    const source = readFileSync(new URL("../../extensions/index.ts", import.meta.url), "utf8");
    // The surfaces a Pi user depends on must still be registered somewhere in the entry.
    expect(source).toContain('"devcontainer_exec"');
    expect(source).toContain('"devcontainer_host_exec"');
    expect(source).toContain("registerTool(");
  });

  it("imports nothing from @deepseek-ai on the Pi path", () => {
    const entry = readFileSync(new URL("../../extensions/index.ts", import.meta.url), "utf8");
    expect(entry).not.toContain("@deepseek-ai/");
    for (const file of readdirSync(new URL("../../src/", import.meta.url))) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf8");
      expect(source, `${file} must stay harness-free`).not.toContain("@deepseek-ai/");
    }
  });

  it("keeps Pi's exact adoption scope after moving the rule into src/", () => {
    const entries = [
      { workspacePath: "/p/a", containerCandidates: [{ id: "c1", state: "running" }], ambiguous: false },
      { workspacePath: "/p/a/sub", containerCandidates: [{ id: "c2", state: "running" }], ambiguous: false },
    ] as never;
    const exact = resolveTargetAdoption({
      requestWorkspace: "/p/a",
      snapshot: { status: "none", workspaceKey: undefined, candidateId: undefined, detail: undefined },
      entries,
      scope: "exact",
    });
    // A prefix match must NOT adopt when the cwd is the parent (Pi would otherwise reroute the session).
    expect(exact?.workspaceKey).toBe("/p/a");
    const prefixOnly = resolveTargetAdoption({
      requestWorkspace: "/p",
      snapshot: { status: "none", workspaceKey: undefined, candidateId: undefined, detail: undefined },
      entries,
      scope: "exact",
    });
    expect(prefixOnly).toBeUndefined();
  });


});
