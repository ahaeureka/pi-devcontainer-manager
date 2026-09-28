/**
 * The self-heal rule, tested without Docker.
 *
 * The deterministic half of the report's reproduction (`design.md` §4): drive the store to `selected-stopped`,
 * change ONLY what discovery returns, and assert the parked selection is (or is not) re-derived. The Docker half
 * lives in `tests/integration`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveTargetRepair } from "../../src/target-repair.js";
import { candidate, configEntry, containerOnlyEntry } from "./fixtures/registry-entry.js";
import type { TargetStoreSnapshot } from "../../src/target-store.js";

const WS = "/ws/project-a";

/** A parked selection: the store resolved before any container existed. */
const parked = (overrides: Partial<TargetStoreSnapshot> = {}): TargetStoreSnapshot => ({
  status: "selected-stopped",
  workspaceKey: WS,
  candidateId: "old-container",
  detail: `Target ${WS} is not running; run /devcontainer up.`,
  ...overrides,
});

describe("resolveTargetRepair", () => {
  it("adopts a container that appeared after the selection was parked", () => {
    const repair = resolveTargetRepair({
      snapshot: parked(),
      requestWorkspace: WS,
      entries: [configEntry({ workspacePath: WS, containers: [candidate("appeared", "running")] })],
    });

    expect(repair).toMatchObject({
      status: "selected-valid",
      workspaceKey: WS,
      candidate: { id: "appeared", state: "running" },
    });
  });

  it("does NOT resurrect an operator-stopped target (the §5 invariant)", () => {
    // `/devcontainer stop` leaves an exited candidate, and stop/remove never write the store — so the only
    // thing that can distinguish intent from reality here is the container's own state.
    expect(
      resolveTargetRepair({
        snapshot: parked(),
        requestWorkspace: WS,
        entries: [configEntry({ workspacePath: WS, containers: [candidate("stopped-by-operator", "exited")] })],
      }),
    ).toBeUndefined();
  });

  it("does not let Docker's listing order decide an ambiguous workspace", () => {
    expect(
      resolveTargetRepair({
        snapshot: parked(),
        requestWorkspace: WS,
        entries: [
          configEntry({
            workspacePath: WS,
            containers: [candidate("first", "running"), candidate("second", "running")],
            ambiguous: true,
          }),
        ],
      }),
    ).toBeUndefined();
  });

  it("refuses to guess when two running candidates exist even if the entry is not flagged ambiguous", () => {
    // Defence in depth: the rule must not depend on discovery having flagged the entry.
    expect(
      resolveTargetRepair({
        snapshot: parked(),
        requestWorkspace: WS,
        entries: [configEntry({ workspacePath: WS, containers: [candidate("a", "running"), candidate("b", "running")] })],
      }),
    ).toBeUndefined();
  });

  it("does not repair a selection that is not reality-derived", () => {
    for (const status of ["none", "selected-valid", "selected-ambiguous", "selected-policy-denied", "refreshing"] as const) {
      expect(
        resolveTargetRepair({
          snapshot: parked({ status }),
          requestWorkspace: WS,
          entries: [configEntry({ workspacePath: WS, containers: [candidate("running-one", "running")] })],
        }),
      ).toBeUndefined();
    }
  });

  it("repairs a selection whose container disappeared entirely", () => {
    const repair = resolveTargetRepair({
      snapshot: parked({ status: "selected-missing" }),
      requestWorkspace: WS,
      entries: [configEntry({ workspacePath: WS, containers: [candidate("recreated", "running")] })],
    });

    expect(repair).toMatchObject({ status: "selected-valid", candidate: { id: "recreated" } });
  });

  it("leaves the store alone when the workspace is still absent from the registry", () => {
    expect(
      resolveTargetRepair({ snapshot: parked(), requestWorkspace: WS, entries: [configEntry({ workspacePath: "/ws/other" })] }),
    ).toBeUndefined();
  });

  it("never retargets when the caller is operating on a different workspace", () => {
    // The parked selection is not what the request is about, so repairing it would redirect an operation.
    expect(
      resolveTargetRepair({
        snapshot: parked(),
        requestWorkspace: "/ws/plain-repo",
        entries: [configEntry({ workspacePath: WS, containers: [candidate("running-one", "running")] })],
      }),
    ).toBeUndefined();
  });

  it("adopts a container-only workspace too (the label alone is the identity)", () => {
    const repair = resolveTargetRepair({
      snapshot: parked(),
      requestWorkspace: WS,
      entries: [containerOnlyEntry({ workspacePath: WS, containers: [candidate("labelled", "running")] })],
    });

    expect(repair).toMatchObject({ status: "selected-valid", candidate: { id: "labelled" } });
  });

  it("carries the operator's selected configuration across the repair", () => {
    const repair = resolveTargetRepair({
      snapshot: parked({ configPath: `${WS}/.devcontainer/python/devcontainer.json` }),
      requestWorkspace: WS,
      entries: [
        configEntry({
          workspacePath: WS,
          configCandidates: [
            { configPath: `${WS}/.devcontainer/node/devcontainer.json`, configKind: ".devcontainer/devcontainer.json" },
            { configPath: `${WS}/.devcontainer/python/devcontainer.json`, configKind: ".devcontainer/devcontainer.json" },
          ],
          containers: [candidate("running-one", "running")],
        }),
      ],
    });

    expect(repair?.candidate?.configPath).toBe(`${WS}/.devcontainer/python/devcontainer.json`);
  });

  it("drops a configuration that no longer exists instead of sending it to the CLI", () => {
    const repair = resolveTargetRepair({
      snapshot: parked({ configPath: `${WS}/.devcontainer/removed/devcontainer.json` }),
      requestWorkspace: WS,
      entries: [configEntry({ workspacePath: WS, containers: [candidate("running-one", "running")] })],
    });

    expect(repair).toMatchObject({ status: "selected-valid" });
    expect(repair?.candidate?.configPath).not.toBe(`${WS}/.devcontainer/removed/devcontainer.json`);
  });

  it("repairs from a subdirectory request (the parked workspace contains it)", () => {
    const repair = resolveTargetRepair({
      snapshot: parked(),
      requestWorkspace: `${WS}/packages/app`,
      entries: [configEntry({ workspacePath: WS, containers: [candidate("running-one", "running")] })],
    });

    expect(repair).toMatchObject({ status: "selected-valid", candidate: { id: "running-one" } });
  });
});

describe("the facade wires the repair into the live path", () => {
  // The Pi hooks have no unit harness in this repo, so the wiring is asserted against the source (the same
  // approach the execution-context and host-environment suites already use).
  const source = readFileSync(new URL("../../extensions/index.ts", import.meta.url), "utf8");

  it("calls the repair rule from the auto-selection hook", () => {
    expect(source).toContain("resolveTargetRepair({");
    expect(source).toContain("requestWorkspace: workspace");
  });

  it("re-derives only parked statuses, and commits through the store", () => {
    expect(source).toMatch(/parked\.status === "selected-stopped" \|\| parked\.status === "selected-missing"/);
    expect(source).toMatch(/if \(repair !== undefined\) await targetStore\.select\(repair\)/);
  });

  it("uses the cached registry read, so a retried refusal does not re-run discovery per call", () => {
    expect(source).toMatch(/const \{ entries \} = await registryForRead\(\);\n      const repair/);
  });
});
