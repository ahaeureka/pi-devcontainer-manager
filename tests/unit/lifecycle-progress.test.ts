/**
 * The progress notice exists so a long build is not a blank screen. What it must never do is print captured output:
 * the transcript is secret-bearing, so only numbers and the path are allowed through.
 */
import { describe, expect, it } from "vitest";
import { STALL_THRESHOLD_MS, describeLifecycleProgress } from "../../src/lifecycle-progress.js";

const base = { operation: "up", workspace: "/ws/project-a" };

describe("describeLifecycleProgress", () => {
  it("reports a live operation with elapsed time, log size and recent output", () => {
    const text = describeLifecycleProgress({ ...base, elapsedMs: 150_000, logPath: "/ws/.pi/x.log", logBytes: 30_720, idleMs: 8_000 });

    expect(text).toContain("`up` still running for /ws/project-a");
    expect(text).toContain("2m30s elapsed");
    expect(text).toContain("log 30 KB");
    expect(text).toContain("last output 8s ago");
    expect(text).not.toMatch(/stalled/i);
  });

  it("flags a possibly stalled operation and names the log to inspect", () => {
    const text = describeLifecycleProgress({
      ...base,
      elapsedMs: 900_000,
      logPath: "/ws/.pi/x.log",
      logBytes: 87_810,
      idleMs: STALL_THRESHOLD_MS + 60_000,
    });

    expect(text).toMatch(/may be stalled/i);
    expect(text).toContain("no new output for 3m");
    expect(text).toContain("/ws/.pi/x.log");
    // Reassurance matters: the operator should not kill a slow build on this notice alone.
    expect(text).toMatch(/nothing is lost/i);
  });

  it("says so plainly when there is no log to measure", () => {
    const text = describeLifecycleProgress({ ...base, elapsedMs: 5_000 });

    expect(text).toContain("no operation log available");
    expect(text).not.toMatch(/stalled/i);
  });

  it("formats hours without losing the minute part", () => {
    expect(describeLifecycleProgress({ ...base, elapsedMs: 3_780_000, logBytes: 2048, idleMs: 1_000 })).toContain("1h03m elapsed");
  });

  it("never echoes captured output — it has no channel for it", () => {
    // The formatter's input carries no log content at all; this pins that the shape stays that way.
    const samples = [
      { ...base, elapsedMs: 1_000, logBytes: 1, idleMs: 0 },
      { ...base, elapsedMs: 1_000, logPath: "/a.log", logBytes: 9_999_999, idleMs: 999_999 },
    ].map(describeLifecycleProgress).join("\n");

    expect(samples).not.toContain("sk-");
    expect(samples.toLowerCase()).not.toContain("password");
  });
});
