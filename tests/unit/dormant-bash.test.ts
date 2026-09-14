import { describe, expect, it, vi } from "vitest";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { lazyBashOperations } from "../../extensions/index.js";
import { surfacesFor } from "../../src/activation.js";

/**
 * Dormancy wiring for the LLM-facing `bash` tool.
 *
 * Review finding on revision-8e6c0670: the dormant branch used to hand-roll a host shell
 * (`spawn(..., { shell: true, env: process.env })`), which diverged from Pi's built-in in
 * shell choice and in output accounting. It now delegates to Pi's own local bash
 * operations — `localBash` is injectable, so the delegation is asserted here instead of
 * being taken on faith.
 */

function result(output: string) {
  return { output, exitCode: 0, cancelled: false, truncated: false };
}

/** A runtime shaped like the entrypoint's own, carrying just what this wrapper reads. */
function runtime(active: boolean, exec: ReturnType<typeof vi.fn>) {
  return {
    activation: {
      decision: active
        ? { active: true, reason: "workspace-config" }
        : { active: false, reason: "no-evidence" },
    },
    bashOperations: { exec },
  } as never;
}

function localOperations(exec: ReturnType<typeof vi.fn>): BashOperations {
  return { exec } as unknown as BashOperations;
}

describe("lazyBashOperations", () => {
  it("routes to the container while the session is engaged", async () => {
    const containerExec = vi.fn(async () => result("container"));
    const localExec = vi.fn(async () => result("host"));
    const ops = lazyBashOperations(() => runtime(true, containerExec), localOperations(localExec));

    const outcome = await ops.exec("pwd", "/ws/project-a", undefined as never);

    expect(containerExec).toHaveBeenCalledTimes(1);
    expect(localExec).not.toHaveBeenCalled();
    expect(outcome.output).toBe("container");
  });

  it("delegates to Pi's local bash operations while dormant", async () => {
    const containerExec = vi.fn();
    const localExec = vi.fn(async () => result("host"));
    const ops = lazyBashOperations(() => runtime(false, containerExec), localOperations(localExec));

    const outcome = await ops.exec("pwd", "/repo-plain", undefined as never);

    expect(localExec).toHaveBeenCalledWith("pwd", "/repo-plain", undefined);
    expect(containerExec).not.toHaveBeenCalled();
    expect(outcome.output).toBe("host");
  });

  it("still fails closed before the runtime is composed (reload window)", async () => {
    const localExec = vi.fn(async () => result("host"));
    const ops = lazyBashOperations(() => undefined, localOperations(localExec));

    await expect(ops.exec("pwd", "/repo", undefined as never)).rejects.toThrow(/not initialized/i);
    expect(localExec).not.toHaveBeenCalled();
  });
});

/**
 * The dormancy contract for the surfaces the entrypoint registers, asserted directly
 * instead of being inferred from extension wiring that needs a live Pi runtime.
 */
describe("surfacesFor", () => {
  it("registers nothing while dormant, but keeps the command surface", () => {
    expect(surfacesFor({ active: false, reason: "no-evidence" })).toEqual({
      containerTools: false,
      bashReplacement: false,
      executionContext: false,
      commandSurface: true,
    });
  });

  it("registers every surface once engaged", () => {
    expect(surfacesFor({ active: true, reason: "workspace-config" })).toEqual({
      containerTools: true,
      bashReplacement: true,
      executionContext: true,
      commandSurface: true,
    });
  });
});
