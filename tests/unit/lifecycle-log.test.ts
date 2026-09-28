import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LifecycleLogWriter, defaultLifecycleLogDirectory } from "../../src/lifecycle-log.js";

const makeWriter = (directory = mkdtempSync(join(tmpdir(), "lifecycle-log-")), maxBytes = 10 * 1024 * 1024) =>
  new LifecycleLogWriter({
    directory,
    maxBytes,
    now: () => new Date("2026-09-28T14:31:10.123Z"),
    randomSuffix: () => "opaque",
  });

describe("LifecycleLogWriter", () => {
  it("writes a protected raw dual-stream transcript with an opaque filename", () => {
    const directory = mkdtempSync(join(tmpdir(), "lifecycle-log-"));
    const writer = makeWriter(directory);
    const run = writer.start({ operation: "up", workspacePath: "/host/workspace" });
    run.setCommand(["devcontainer", "up"]);

    run.stderr(Buffer.from("registry-token=raw-secret\n"));
    run.stdout(Buffer.from('{"outcome":"success"}\n'));
    run.finish({ state: "completed", exitCode: 0, durationMs: 12, outputTruncated: false });

    expect(run.path).toMatch(/up-opaque\.log$/);
    expect(run.path).not.toContain("workspace");
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(run.path!).mode & 0o777).toBe(0o600);
    const log = readFileSync(run.path!, "utf8");
    expect(log).toContain("workspace: /host/workspace");
    expect(log).toContain('command: ["devcontainer","up"]');
    expect(log).toContain("--- stderr ---\nregistry-token=raw-secret");
    expect(log).toContain("--- stdout ---\n{\"outcome\":\"success\"}");
    expect(log).toContain("exitCode: 0");
    expect(writer.latestRun()).toMatchObject({ operation: "up", outcome: { exitCode: 0 }, path: run.path });
  });

  it("caps process output once, appends a marker, and still finalizes", () => {
    const writer = makeWriter(mkdtempSync(join(tmpdir(), "lifecycle-log-")), 4);
    const run = writer.start({ operation: "build", workspacePath: "/ws" });

    run.stdout(Buffer.from("abcdef"));
    run.stderr(Buffer.from("ignored"));
    run.finish({ state: "failed", exitCode: 1, durationMs: 5, outputTruncated: false });

    const log = readFileSync(run.path!, "utf8");
    expect(log).toContain("abcd");
    expect(log.match(/lifecycle log output truncated/g)).toHaveLength(1);
    expect(log).toContain("exitCode: 1");
    expect(writer.latestRun()).toMatchObject({ outcome: { outputTruncated: true, exitCode: 1 } });
  });

  it("prunes only expired lifecycle log files", () => {
    const directory = mkdtempSync(join(tmpdir(), "lifecycle-log-"));
    const writer = makeWriter(directory);
    const old = join(directory, "2020-01-01T00-00-00.000Z-up-old.log");
    const keep = join(directory, "note.txt");
    writeFileSync(old, "old");
    writeFileSync(keep, "keep");
    utimesSync(old, new Date("2020-01-01"), new Date("2020-01-01"));

    writer.start({ operation: "remove", workspacePath: "/ws" });

    expect(() => statSync(old)).toThrow();
    expect(readFileSync(keep, "utf8")).toBe("keep");
  });

  it("finds the newest retained log after a session reload", () => {
    const directory = mkdtempSync(join(tmpdir(), "lifecycle-log-"));
    const writer = makeWriter(directory);
    const run = writer.start({ operation: "build", workspacePath: "/ws" });
    run.finish({ state: "completed", exitCode: 0, durationMs: 1 });

    const reloaded = new LifecycleLogWriter({ directory });
    expect(reloaded.latestRun()).toMatchObject({ operation: "build", path: run.path, persisted: true });
  });

  it("returns an unavailable run rather than blocking an operation when its directory cannot be created", () => {
    const directory = join(mkdtempSync(join(tmpdir(), "lifecycle-log-")), "not-a-directory");
    writeFileSync(directory, "file");
    const writer = makeWriter(directory);
    const run = writer.start({ operation: "setup", workspacePath: "/ws" });

    run.stdout(Buffer.from("npm output"));
    run.finish({ state: "failed", exitCode: 1, durationMs: 1, outputTruncated: false, error: "npm failed" });

    expect(run.path).toBeUndefined();
    expect(run.warning).toMatch(/diagnostic log/i);
    expect(writer.latestWarning()).toMatch(/diagnostic log/i);
  });

  it("reports a failed run once, so a slash-command failure reaches the agent", () => {
    // `/devcontainer up` output goes to the operator UI, NOT the model. This is the channel that makes the
    // model learn about the failure on its next turn — and it must report exactly once, or a single failure
    // would be re-injected into every subsequent turn's system prompt.
    const writer = makeWriter();
    const run = writer.start({ operation: "up", workspacePath: "/ws" });
    run.finish({ state: "failed", exitCode: 1, durationMs: 7, outputTruncated: false, error: "build failed" });

    expect(writer.takeFailure()).toMatchObject({ operation: "up", state: "failed", path: run.path, error: "build failed" });
    expect(writer.takeFailure()).toBeUndefined();
  });

  it("does not report a successful run as a failure", () => {
    const writer = makeWriter();
    writer.start({ operation: "up", workspacePath: "/ws" }).finish({ state: "completed", exitCode: 0 });

    expect(writer.takeFailure()).toBeUndefined();
  });

  it("reports a refused or cancelled run too (those are failures the agent must see)", () => {
    for (const state of ["denied", "cancelled"] as const) {
      const writer = makeWriter();
      writer.start({ operation: "remove", workspacePath: "/ws" }).finish({ state });
      expect(writer.takeFailure()).toMatchObject({ operation: "remove", state });
    }
  });

  it("reports a failure even when no transcript could be written", () => {
    // Losing the file must not lose the report: the agent still needs to know the last lifecycle operation
    // failed, and that there is nothing local to read.
    const directory = join(mkdtempSync(join(tmpdir(), "lifecycle-log-")), "not-a-directory");
    writeFileSync(directory, "file");
    const writer = makeWriter(directory);
    writer.start({ operation: "up", workspacePath: "/ws" }).finish({ state: "failed", exitCode: 1 });

    expect(writer.takeFailure()).toMatchObject({ operation: "up", state: "failed" });
    expect(writer.takeFailure()).toBeUndefined();
  });

  it("keeps only the newest failure, so a stale one cannot resurface", () => {
    const writer = makeWriter();
    writer.start({ operation: "up", workspacePath: "/ws" }).finish({ state: "failed", exitCode: 1 });
    writer.start({ operation: "build", workspacePath: "/ws" }).finish({ state: "failed", exitCode: 2 });

    expect(writer.takeFailure()).toMatchObject({ operation: "build" });
    expect(writer.takeFailure()).toBeUndefined();
  });

  it("defaults to the Pi session project's private .pi namespace", () => {
    expect(defaultLifecycleLogDirectory("/work/project"))
      .toBe("/work/project/.pi/devcontainer-manager/lifecycle-logs");
  });
});
