/**
 * Unit tests for the Docker lifecycle adapter.
 *
 * Focus: the adapter owns the second half of the destructive gate (a fresh
 * confirmation naming the exact action and container) and must report a failed
 * `docker stop`/`docker rm` as a DOCKER failure — it used to reuse the Dev
 * Containers CLI's kind, so a docker fault read as a devcontainer-CLI fault.
 */
import { describe, expect, it } from "vitest";
import { errorKindOf } from "../../src/errors.js";
import type { ProcessResult, ProcessRunner } from "../../src/runtime/process-runner.js";
import {
  NodeDockerLifecycleAdapter,
  type LifecycleConfirmation,
} from "../../src/runtime/docker-lifecycle.js";
import type { DockerContainer } from "../../src/runtime/docker-adapter.js";

const container: DockerContainer = {
  id: "a".repeat(64),
  name: "proj-a",
  state: "running",
  status: "Up 2 minutes",
  image: "vsc-proj-a:latest",
  created: "2026-09-15T00:00:00.000Z",
  labels: {},
};

const confirmationFor = (action: "stop" | "remove"): LifecycleConfirmation => ({
  token: "fresh-token",
  action,
  containerId: container.id,
});

function runner(handler: () => Partial<ProcessResult>): ProcessRunner {
  return {
    async exec() {
      return { exitCode: 0, signal: null, durationMs: 1, truncated: false, stdout: "", stderr: "", ...handler() };
    },
  };
}

const adapter = (r: ProcessRunner): NodeDockerLifecycleAdapter =>
  new NodeDockerLifecycleAdapter(r, { dockerPath: "/usr/bin/docker", env: { PATH: "/usr/bin" }, cwd: "/ws" });

describe("NodeDockerLifecycleAdapter.remove", () => {
  it("reports a docker failure under a Docker-specific kind and carries the exit code", async () => {
    try {
      await adapter(runner(() => ({ exitCode: 1 }))).remove(container, confirmationFor("remove"));
      expect.unreachable();
    } catch (error) {
      expect(errorKindOf(error)).toBe("docker-cli-failure");
      expect((error as { exitCode?: number | null }).exitCode).toBe(1);
    }
  });

  it("carries what docker said when a destructive call fails", async () => {
    // The failure path captured neither stream and reported only the exit code, so the actual
    // reason ('Error response from daemon: ...') never reached the operator.
    const r: ProcessRunner = {
      async exec(_file, _args, _options) {
        // The boundary supplies the streams now (L5-03): the fake returns them instead of streaming.
        return {
          exitCode: 1,
          signal: null,
          durationMs: 1,
          truncated: false,
          stdout: "",
          stderr: "Error response from daemon: container is not running\n",
        };
      },
    };

    try {
      await adapter(r).remove(container, confirmationFor("remove"));
      expect.unreachable();
    } catch (error) {
      expect(errorKindOf(error)).toBe("docker-cli-failure");
      expect((error as Error).message).toContain("container is not running");
    }
  });

  it("reports a successful remove as done", async () => {
    const result = await adapter(runner(() => ({}))).remove(container, confirmationFor("remove"));

    expect(result).toMatchObject({ status: "done", action: "remove", containerId: container.id });
  });
});

describe("NodeDockerLifecycleAdapter confirmation gate", () => {
  it("never spawns without a matching confirmation", async () => {
    let spawned = 0;
    const counting: ProcessRunner = {
      async exec() {
        spawned += 1;
        return { exitCode: 0, signal: null, durationMs: 1, truncated: false };
      },
    };

    const result = await adapter(counting).remove(container, undefined);

    expect(result.status).toBe("confirmation-required");
    expect(spawned).toBe(0);
  });

  it("never spawns when the confirmation names another container", async () => {
    let spawned = 0;
    const counting: ProcessRunner = {
      async exec() {
        spawned += 1;
        return { exitCode: 0, signal: null, durationMs: 1, truncated: false };
      },
    };

    const result = await adapter(counting).stop(container, {
      token: "fresh-token",
      action: "stop",
      containerId: "b".repeat(64),
    });

    expect(result.status).toBe("confirmation-required");
    expect(spawned).toBe(0);
  });
});

describe("NodeDockerLifecycleAdapter.logs", () => {
  it("rejects an empty container id", async () => {
    await expect(adapter(runner(() => ({}))).logs("")).rejects.toMatchObject({ kind: "no-candidate" });
  });

  it("returns the bounded output of docker logs", async () => {
    const r: ProcessRunner = {
      async exec(_file, args) {
        expect(args).toEqual(["logs", "--tail", "200", container.id]);
        return { exitCode: 0, signal: null, durationMs: 1, truncated: false };
      },
    };

    await expect(adapter(r).logs(container.id)).resolves.toEqual({ exitCode: 0, output: "", truncated: false });
  });

  it("keeps the container's stderr half of docker logs", async () => {
    // `docker logs` writes the container's stdout to the CLI's stdout and its stderr to the
    // CLI's stderr, and this adapter only ever captured onData — so half the log stream was
    // silently discarded with no fallback and no label.
    const r: ProcessRunner = {
      async exec(_file, _args, options) {
        // The boundary captures both streams because no callbacks were supplied (L5-03).
        return {
          exitCode: 0,
          signal: null,
          durationMs: 1,
          truncated: false,
          stdout: "container out\n",
          stderr: "container err\n",
        };
      },
    };

    const result = await adapter(r).logs(container.id);

    expect(result.output).toContain("container out");
    expect(result.output).toContain("--- stderr ---");
    expect(result.output).toContain("container err");
  });
});
