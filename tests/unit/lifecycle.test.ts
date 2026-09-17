/**
 * The session lifecycle has one owner (review finding L0-04).
 *
 * `session_start` is asynchronous: it probes for a running container, reconciles a restored selection
 * and discovers the registry — all awaits. A start that resumes after a reload, a second start or a
 * shutdown used to assign the shared runtime anyway and register surfaces from an activation decision
 * that had already been superseded, so a stale start could overwrite a newer session's runtime and
 * register tools whose callbacks dereference a runtime that no longer exists. These tests pin the
 * ownership rule the facade now checks after every await; the facade's own wiring is smoke-covered.
 */
import { describe, expect, it } from "vitest";
import { createLifecycleGuard } from "../../src/lifecycle.js";

describe("createLifecycleGuard", () => {
  it("reports the newest generation as current", () => {
    const guard = createLifecycleGuard();

    const first = guard.begin();

    expect(guard.isCurrent(first)).toBe(true);
    expect(guard.current()).toBe(first);
  });

  it("supersedes an in-flight generation when another start begins", () => {
    const guard = createLifecycleGuard();
    const inFlight = guard.begin();

    const second = guard.begin();

    // The first start's post-await checks all report stale, so it assigns nothing and registers
    // nothing; the second owns the surface.
    expect(guard.isCurrent(inFlight)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
    expect(second).toBeGreaterThan(inFlight);
  });

  it("invalidates everything in flight on shutdown", () => {
    const guard = createLifecycleGuard();
    const generation = guard.begin();

    guard.invalidate();

    expect(guard.isCurrent(generation)).toBe(false);
    // A later start is current again: invalidation must not be sticky, or the extension could never
    // re-engage after a reload (the direction the review warns about).
    const next = guard.begin();
    expect(guard.isCurrent(next)).toBe(true);
  });

  it("never reports an unknown or older generation as current", () => {
    const guard = createLifecycleGuard();
    const first = guard.begin();
    guard.begin();

    expect(guard.isCurrent(first - 1)).toBe(false);
    expect(guard.isCurrent(first + 99)).toBe(false);
  });
});

describe("the surface mutation point", () => {
  it("applies a surface change only while the generation is current", () => {
    const guard = createLifecycleGuard();
    const applied: string[] = [];
    const generation = guard.begin();

    expect(guard.ifCurrent(generation, () => void applied.push("runtime"))).toBe(true);
    expect(applied).toEqual(["runtime"]);
  });

  it("applies NOTHING for a superseded generation", () => {
    // This is AC-1's actual claim. The facade routes every surface mutation (runtime assignment,
    // tool registration, bash replacement) through this call, so a superseded start applying nothing
    // is a property of this unit rather than of a call site someone can forget.
    const guard = createLifecycleGuard();
    const applied: string[] = [];
    const inFlight = guard.begin();
    guard.begin(); // a second start supersedes the first

    expect(guard.ifCurrent(inFlight, () => void applied.push("runtime"))).toBe(false);
    expect(applied).toEqual([]);
  });

  it("applies nothing after a shutdown, and applies again for the next start", () => {
    const guard = createLifecycleGuard();
    const applied: string[] = [];
    const generation = guard.begin();
    guard.invalidate();

    expect(guard.ifCurrent(generation, () => void applied.push("stale"))).toBe(false);

    const next = guard.begin();
    expect(guard.ifCurrent(next, () => void applied.push("fresh"))).toBe(true);
    expect(applied).toEqual(["fresh"]);
  });
});
