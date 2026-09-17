/**
 * The union accessors are the sanctioned way to ask the two questions the old sentinel fields
 * answered by accident (review finding L4-04). They are small enough to look obvious and are exactly
 * the kind of code that silently rots, so the contract is pinned: a container-only entry has no
 * configuration, and the first candidate IS the primary.
 */
import { describe, expect, it } from "vitest";
import {
  configCandidatesOf,
  configPathOf,
  containerStateOf,
  primaryCandidate,
  primaryConfigOf,
} from "../../src/registry-entry.js";
import { candidate, configCandidate, configEntry, containerOnlyEntry } from "./fixtures/registry-entry.js";

const named = configCandidate("/ws/a/.devcontainer/python/devcontainer.json", ".devcontainer/<name>/devcontainer.json");

describe("registry entry accessors", () => {
  it("reads the primary candidate as the first element of the single identity collection", () => {
    const entry = configEntry({ workspacePath: "/ws/a", containers: [candidate("first", "exited"), candidate("second")] });

    expect(primaryCandidate(entry)?.id).toBe("first");
    expect(containerStateOf(entry)).toBe("exited");
  });

  it("reports no candidate (and no state) for a config-only workspace", () => {
    const entry = configEntry({ workspacePath: "/ws/a" });

    expect(primaryCandidate(entry)).toBeUndefined();
    expect(containerStateOf(entry)).toBeUndefined();
    expect(entry.ambiguous).toBe(false);
  });

  it("exposes every configuration and the primary one", () => {
    const entry = configEntry({ workspacePath: "/ws/a", configCandidates: [named], primaryIndex: 0 });

    expect(configCandidatesOf(entry)).toEqual([named]);
    expect(primaryConfigOf(entry)).toBe(named);
    expect(configPathOf(entry)).toBe(named.configPath);
  });

  it("answers the configuration questions with empty/undefined for a container-only entry", () => {
    // The variant IS the answer: there is no configuration path to invent, which is what the old
    // `configPath: ""` sentinel encoded and consumers had to remember to check.
    const entry = containerOnlyEntry({ workspacePath: "/ws/a", containers: [candidate("c1")] });

    expect(configCandidatesOf(entry)).toEqual([]);
    expect(primaryConfigOf(entry)).toBeUndefined();
    expect(configPathOf(entry)).toBeUndefined();
    expect(primaryCandidate(entry)?.id).toBe("c1");
  });
});
