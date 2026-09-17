import { describe, expect, it } from "vitest";
import { NodeDockerAdapter, type DockerContainer } from "../../src/runtime/docker-adapter.js";
import type { ProcessRunner } from "../../src/runtime/process-runner.js";
import { RuntimeError } from "../../src/errors.js";

function fakeRunner(respond: (args: readonly string[]) => { stdout: string; exitCode?: number }): ProcessRunner {
  return {
    async exec(file, args, options) {
      const response = respond(args);
      // The process boundary carries its bounded streams now (L5-03): a fake that used to push into
      // a callback supplies the fields instead, unless the caller asked to stream.
      const out = Buffer.from(response.stdout, "utf8");
      if (options.onData !== undefined) options.onData(out);
      return {
        exitCode: response.exitCode ?? 0,
        signal: null,
        durationMs: 1,
        truncated: false,
        ...(options.onData === undefined ? { stdout: response.stdout } : {}),
        ...(options.onStderr === undefined ? { stderr: (response as { stderr?: string }).stderr ?? "" } : {}),
      };
    },
  };
}

const psDefault = {
  ID: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
  Names: "/proj-a",
  State: "running",
  Status: "Up 2 hours",
  Image: "vsc-devcontainer-proj-a:latest",
  CreatedAt: "2026-08-30 10:00:00 +0800 CST",
  Labels: "devcontainer.local_folder=/data/work/proj-a,devcontainer.config_file=/data/work/proj-a/.devcontainer/devcontainer.json",
};

/** Emit one container in the 7-line minimal template format + blank line. */
const psRecord = (overrides: Partial<Record<string, string>> = {}): string =>
  [
    "ID", "Names", "State", "Status", "Image", "CreatedAt", "Labels",
  ]
    .map((k) => JSON.stringify((overrides as Record<string, string>)[k] ?? (psDefault as Record<string, string>)[k] ?? ""))
    .join("\n") + "\n\n";

function adapter(runner: ProcessRunner): NodeDockerAdapter {
  return new NodeDockerAdapter(runner, {
    dockerPath: "/usr/bin/docker",
    env: { PATH: process.env.PATH ?? "" },
    cwd: "/data/work",
  });
}

describe("NodeDockerAdapter.listDevContainers", () => {
  it("parses all-container JSON lines and extracts devcontainer labels", async () => {
    let seenArgs: readonly string[] = [];
    const runner = fakeRunner((args) => {
      seenArgs = args;
      return { stdout: psRecord() };
    });
    const result = await adapter(runner).listDevContainers();
    expect(seenArgs.slice(0, 5)).toEqual(["ps", "--all", "--no-trunc", "--format",
      "{{json .ID}}\n{{json .Names}}\n{{json .State}}\n{{json .Status}}\n{{json .Image}}\n{{json .CreatedAt}}\n{{json .Labels}}\n"]);
    const container = result.containers[0] as DockerContainer;
    expect(container.id).toHaveLength(64);
    expect(container.name).toBe("/proj-a");
    expect(container.state).toBe("running");
    expect(container.localFolder).toBe("/data/work/proj-a");
    expect(container.workspaceKey).toBe("/data/work/proj-a");
    expect(container.labels["devcontainer.config_file"]).toContain("devcontainer.json");
    expect(result.errors).toEqual([]);
  });

  it("returns zero candidates for an empty listing", async () => {
    const runner = fakeRunner(() => ({ stdout: "" }));
    const result = await adapter(runner).listDevContainers();
    expect(result.containers).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("retains duplicate workspace labels as separate candidates", async () => {
    const runner = fakeRunner(() => ({
      stdout: `${psRecord({ ID: "a".repeat(64), Names: "/proj-a-old" })}${psRecord({ ID: "b".repeat(64), Names: "/proj-a" })}`,
    }));
    const result = await adapter(runner).listDevContainers();
    expect(result.containers).toHaveLength(2);
    expect(result.containers[0]?.workspaceKey).toBe(result.containers[1]?.workspaceKey);
    expect(result.containers[0]?.name).not.toBe(result.containers[1]?.name);
  });

  it("collects unparseable lines into errors without failing discovery", async () => {
    const runner = fakeRunner(() => ({
      stdout: `${psRecord()}\nnot-json\n`,
    }));
    const result = await adapter(runner).listDevContainers();
    expect(result.containers).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("unparseable");
  });

  it("treats a container without devcontainer.local_folder as candidate without workspaceKey", async () => {
    const runner = fakeRunner(() => ({
      stdout: psRecord({ Labels: "com.example.other=1" }),
    }));
    const result = await adapter(runner).listDevContainers();
    expect(result.containers).toHaveLength(1);
    expect(result.containers[0]?.localFolder).toBeUndefined();
    expect(result.containers[0]?.workspaceKey).toBeUndefined();
  });

  it("parses a stopped candidate with its state and status", async () => {
    const runner = fakeRunner(() => ({
      stdout: psRecord({ State: "exited", Status: "Exited (0) 5 minutes ago" }),
    }));
    const result = await adapter(runner).listDevContainers();
    expect(result.containers).toHaveLength(1);
    expect(result.containers[0]?.state).toBe("exited");
    expect(result.containers[0]?.status).toBe("Exited (0) 5 minutes ago");
    expect(result.containers[0]?.localFolder).toBe("/data/work/proj-a");
  });

  it("throws daemon-unavailable when docker ps exits nonzero", async () => {
    const runner = fakeRunner(() => ({ stdout: "Cannot connect to the Docker daemon\n", exitCode: 1 }));
    await expect(adapter(runner).listDevContainers()).rejects.toMatchObject({
      kind: "daemon-unavailable",
      exitCode: 1,
    });
  });

  it("maps executable-missing to daemon-unavailable with remedy", async () => {
    const runner: ProcessRunner = {
      async exec() {
        throw new RuntimeError({ kind: "executable-missing", message: "ENOENT" });
      },
    };
    await expect(adapter(runner).listDevContainers()).rejects.toMatchObject({
      kind: "daemon-unavailable",
    });
  });
});

describe("NodeDockerAdapter.inspectContainer", () => {
  it("parses a single-container inspect result", async () => {
    const inspectJson = JSON.stringify({
      Id: "c".repeat(64),
      Name: "/proj-a",
      State: { Status: "running", Running: true },
      Config: { Image: "vsc-devcontainer-proj-a:latest", Labels: { "devcontainer.local_folder": "/data/work/proj-a" } },
      Created: "2026-08-30T10:00:00.000Z",
    });
    const runner = fakeRunner(() => ({ stdout: `${inspectJson}\n` }));
    const result = await adapter(runner).inspectContainer("c".repeat(64));
    expect(result.container).toBeDefined();
    expect(result.container?.state).toBe("running");
    expect(result.container?.name).toBe("proj-a");
    expect(result.container?.localFolder).toBe("/data/work/proj-a");
  });

  it("rejects an empty container ID", async () => {
    await expect(adapter(fakeRunner(() => ({ stdout: "" }))).inspectContainer("")).rejects.toMatchObject({
      kind: "no-candidate",
    });
  });

  it("returns undefined container with errors on unparseable inspect output", async () => {
    const runner = fakeRunner(() => ({ stdout: "garbage\n" }));
    const result = await adapter(runner).inspectContainer("abc");
    expect(result.container).toBeUndefined();
    expect(result.errors).toHaveLength(1);
  });
});
