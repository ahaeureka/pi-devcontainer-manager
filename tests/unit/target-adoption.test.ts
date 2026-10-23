/**
 * The adoption rule both entry points share (`src/target-adoption.ts`).
 *
 * These tests exist because "no target is selected" was the first thing every DevContainer user hit
 * under dsh: the rule decides whether a command silently adopts the workspace's container, and a wrong
 * decision reroutes commands into the wrong project. So: exact vs at-or-under scope, deepest-project
 * preference, ambiguity never decided by list order, and parked selections repaired only when reality
 * moved forward.
 */
import { describe, expect, it } from "vitest";
import { resolveTargetAdoption } from "../../src/target-adoption.js";
import type { TargetStoreSnapshot } from "../../src/target-store.js";
import type { RegistryEntry } from "../../src/types.js";

const NONE: TargetStoreSnapshot = { status: "none", workspaceKey: undefined, candidateId: undefined, detail: undefined };

function entry(workspacePath: string, overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    kind: "config",
    discoveredFrom: "host-config",
    workspacePath,
    containerCandidates: [{ id: "c1", state: "running", image: "img" }],
    ambiguous: false,
    configCandidates: [
      {
        path: `${workspacePath}/.devcontainer/devcontainer.json`,
        label: "devcontainer.json",
        form: "devcontainer-json",
      },
    ],
    primaryConfig: {
      path: `${workspacePath}/.devcontainer/devcontainer.json`,
      label: "devcontainer.json",
      form: "devcontainer-json",
    },
    ...overrides,
  } as unknown as RegistryEntry;
}

describe("resolveTargetAdoption", () => {
  it("adopts the project whose workspace IS the request (exact scope)", () => {
    const adoption = resolveTargetAdoption({
      requestWorkspace: "/p/a",
      snapshot: NONE,
      entries: [entry("/p/a"), entry("/p/ab")],
    });
    expect(adoption?.status).toBe("selected-valid");
    expect(adoption?.workspaceKey).toBe("/p/a");
  });

  it("does not adopt on a shared prefix in exact scope, but does at-or-under", () => {
    const entries = [entry("/p/a")];
    expect(resolveTargetAdoption({ requestWorkspace: "/p/a/sub", snapshot: NONE, entries })).toBeUndefined();
    const adopted = resolveTargetAdoption({
      requestWorkspace: "/p/a/sub",
      snapshot: NONE,
      entries,
      scope: "at-or-under",
    });
    expect(adopted?.workspaceKey).toBe("/p/a");
  });

  it("prefers the deepest project when one is nested inside another", () => {
    const entries = [entry("/p"), entry("/p/nested")];
    const adopted = resolveTargetAdoption({
      requestWorkspace: "/p/nested/sub",
      snapshot: NONE,
      entries,
      scope: "at-or-under",
    });
    expect(adopted?.workspaceKey).toBe("/p/nested");
  });

  it("never picks among ambiguous candidates by list order", () => {
    const entries = [
      entry("/p/a", {
        ambiguous: true,
        containerCandidates: [
          { id: "c1", state: "running", image: "img" },
          { id: "c2", state: "running", image: "img" },
        ],
      } as Partial<RegistryEntry>),
    ];
    const adopted = resolveTargetAdoption({ requestWorkspace: "/p/a", snapshot: NONE, entries });
    expect(adopted?.status).toBe("selected-ambiguous");
    expect(adopted?.candidate).toBeUndefined();
  });

  it("adopts nothing when the project is unknown", () => {
    expect(resolveTargetAdoption({ requestWorkspace: "/elsewhere", snapshot: NONE, entries: [entry("/p/a")] })).toBe(
      undefined,
    );
  });

  it("leaves a healthy selection alone", () => {
    const snapshot: TargetStoreSnapshot = {
      status: "selected-valid",
      workspaceKey: "/p/a",
      candidateId: "c1",
      candidateName: "proj",
      detail: undefined,
      configPath: undefined,
    } as unknown as TargetStoreSnapshot;
    expect(resolveTargetAdoption({ requestWorkspace: "/p/a", snapshot, entries: [entry("/p/a")] })).toBeUndefined();
  });
});
