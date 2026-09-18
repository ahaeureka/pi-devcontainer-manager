import { describe, expect, it, vi } from "vitest";
import { createShortCache } from "../../src/short-cache.js";

describe("createShortCache", () => {
  it("loads once per key inside the window and re-loads after it", async () => {
    vi.useFakeTimers();
    try {
      const cache = createShortCache<number>({ ttlMs: 500 });
      const load = vi.fn(async () => 1);

      await cache.get("/ws", load);
      await cache.get("/ws", load);
      expect(load).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(600);
      await cache.get("/ws", load);
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keys per workspace, bounds its size, and is clearable", async () => {
    const cache = createShortCache<string>({ ttlMs: 10_000, limit: 2 });
    const load = (value: string) => async () => value;

    expect(await cache.get("a", load("a"))).toBe("a");
    expect(await cache.get("b", load("b"))).toBe("b");
    expect(await cache.get("c", load("c"))).toBe("c"); // evicts the oldest
    const reloaded = vi.fn(load("a-again"));
    expect(await cache.get("a", reloaded)).toBe("a-again");
    expect(reloaded).toHaveBeenCalledTimes(1);

    cache.clear();
    const afterClear = vi.fn(load("a-third"));
    expect(await cache.get("a", afterClear)).toBe("a-third");
    expect(afterClear).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failure as a success (the rejection is retried)", async () => {
    const cache = createShortCache<string>({ ttlMs: 10_000 });
    const failing = vi.fn(async () => {
      throw new Error("docker unavailable");
    });
    await expect(cache.get("/ws", failing)).rejects.toThrow("docker unavailable");
    const recovering = vi.fn(async () => "ok");
    expect(await cache.get("/ws", recovering)).toBe("ok");
    expect(recovering).toHaveBeenCalledTimes(1);
  });
});
