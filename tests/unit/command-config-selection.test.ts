import { describe, expect, it, vi, type Mock } from "vitest";
import {
  createCommandHandlers,
  selectionFor,
  type CommandContextLike,
  type CommandServices,
} from "../../src/commands.js";
import { compileConfig } from "../../src/config.js";
import type { RegistryEntry } from "../../src/types.js";
import type { TargetStore } from "../../src/target-store.js";

/**
 * Repair of the blocking review finding: `/devcontainer up` and `/devcontainer build`
 * never carried the selected `--config`, so a workspace whose only configuration is a
 * named `.devcontainer/<name>/devcontainer.json` (or the legacy root form) could be
 * discovered and selected but never started — the exact defect this change fixes.
 *
 * These tests drive the COMMAND HANDLERS, not the execution service: the previous
 * coverage drove `ExecutionService.up({ …, configPath })` with a hand-built request,
 * which pinned the seam while the wiring stayed missing.
 */

const DEFAULT_PATH = "/ws/project-a/.devcontainer/devcontainer.json";
const NAMED_PATH = "/ws/project-a/.devcontainer/python/devcontainer.json";

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    workspacePath: "/ws/project-a",
    configPath: DEFAULT_PATH,
    configKind: ".devcontainer/devcontainer.json",
    configCandidates: [
      { configPath: DEFAULT_PATH, configKind: ".devcontainer/devcontainer.json" },
      { configPath: NAMED_PATH, configKind: ".devcontainer/<name>/devcontainer.json" },
    ],
    ...overrides,
  } as unknown as RegistryEntry;
}

/** A workspace whose ONLY configuration is the named form. */
function namedOnlyEntry(): RegistryEntry {
  return makeEntry({
    configPath: NAMED_PATH,
    configKind: ".devcontainer/<name>/devcontainer.json",
    configCandidates: [{ configPath: NAMED_PATH, configKind: ".devcontainer/<name>/devcontainer.json" }],
  });
}

function makeServices(
  entries: RegistryEntry[],
  snapshot: Record<string, unknown> = {},
): { services: CommandServices; up: Mock; build: Mock } {
  const up = vi.fn(async () => ({
    operation: "up",
    workspaceKey: "/ws/project-a",
    candidateId: "c1",
    policyAuthorized: true,
  }));
  const build = vi.fn(async () => ({
    operation: "build",
    workspaceKey: "/ws/project-a",
    imageName: "img:tag",
    policyAuthorized: true,
  }));
  const services = {
    config: compileConfig(),
    targetStore: {
      snapshot: () => ({
        status: "selected-valid",
        workspaceKey: "/ws/project-a",
        candidateId: "c1",
        detail: undefined,
        ...snapshot,
      }),
      select: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    } as unknown as TargetStore,
    execution: { up, build } as never,
    registry: async () => ({ entries, diagnostics: [] }),
    refreshRegistry: async () => ({ entries, diagnostics: [] }),
    logs: async () => ({ exitCode: 0, output: "", truncated: false }),
  } as unknown as CommandServices;
  return { services, up, build };
}

function ctx(cwd = "/ws/project-a"): CommandContextLike {
  return {
    cwd,
    hasUI: true,
    ui: { select: vi.fn(async () => undefined), confirm: vi.fn(async () => true), notify: vi.fn() },
  } as unknown as CommandContextLike;
}

describe("/devcontainer up + build carry the selected configuration (AC-2)", () => {
  it("passes the named configuration for a workspace that has no default-lookup form", async () => {
    const { services, up } = makeServices([namedOnlyEntry()]);
    const handlers = createCommandHandlers(services);
    await handlers["up"]!("", ctx());
    expect(up).toHaveBeenCalledWith(expect.objectContaining({ operation: "up", configPath: NAMED_PATH }));
  });

  it("passes the named configuration to build as well", async () => {
    const { services, build } = makeServices([namedOnlyEntry()]);
    const handlers = createCommandHandlers(services);
    await handlers["build"]!("", ctx());
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ operation: "build", configPath: NAMED_PATH }));
  });

  it("keeps the flag-free argv for the default-lookup form", async () => {
    const { services, up } = makeServices([makeEntry()]);
    const handlers = createCommandHandlers(services);
    await handlers["up"]!("", ctx());
    expect(up).toHaveBeenCalledWith(expect.objectContaining({ operation: "up" }));
    expect(up.mock.calls[0]![0]).not.toHaveProperty("configPath");
  });

  it("honours an explicit `--config <name>` on up", async () => {
    const { services, up } = makeServices([makeEntry()]);
    const handlers = createCommandHandlers(services);
    await handlers["up"]!("--config python", ctx());
    expect(up).toHaveBeenCalledWith(expect.objectContaining({ configPath: NAMED_PATH }));
  });

  it("refuses an unknown `--config` on up without starting anything", async () => {
    const { services, up } = makeServices([makeEntry()]);
    const handlers = createCommandHandlers(services);
    const result = await handlers["up"]!("--config nope", ctx());
    expect(result.text).toContain("[no-candidate]");
    expect(result.text).toContain("python");
    expect(up).not.toHaveBeenCalled();
  });

  it("prefers the configuration the operator already selected for this workspace", async () => {
    const { services, up } = makeServices([makeEntry()], { configPath: NAMED_PATH });
    const handlers = createCommandHandlers(services);
    await handlers["up"]!("", ctx());
    expect(up).toHaveBeenCalledWith(expect.objectContaining({ configPath: NAMED_PATH }));
  });

  it("ignores a selected configuration belonging to a different workspace", async () => {
    const { services, up } = makeServices([makeEntry()], {
      workspaceKey: "/ws/project-b",
      configPath: NAMED_PATH,
    });
    const handlers = createCommandHandlers(services);
    await handlers["up"]!("", ctx());
    expect(up.mock.calls[0]![0]).not.toHaveProperty("configPath");
  });
});

/**
 * Major review finding: `selectionFor` accepted an unvalidated config path, so any
 * caller could hand the CLI an arbitrary `--config <path>`.
 */
describe("selectionFor only carries discovered configurations", () => {
  it("drops a path that is not among the workspace's candidates", () => {
    const selection = selectionFor(makeEntry(), "c1", "/etc/passwd");
    expect((selection.candidate as { configPath?: string } | undefined)?.configPath).toBeUndefined();
  });

  it("carries a path that is one of the workspace's candidates", () => {
    const selection = selectionFor(makeEntry(), "c1", NAMED_PATH);
    expect((selection.candidate as { configPath?: string } | undefined)?.configPath).toBe(NAMED_PATH);
  });
});
