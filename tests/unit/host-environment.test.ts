import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HOST_PROXY_VARIABLES, composeHostEnvironment } from "../../src/host-environment.js";

describe("composeHostEnvironment", () => {
  it("always carries PATH and HOME", () => {
    expect(composeHostEnvironment({ PATH: "/usr/bin", HOME: "/home/op" })).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/op",
    });
  });

  it("falls back to the home directory when the source defines no HOME", () => {
    expect(composeHostEnvironment({ PATH: "/usr/bin" }, "/fallback").HOME).toBe("/fallback");
    // PATH stays present even when the source has none: a child without it fails in a way that reads
    // as a missing tool rather than a missing variable.
    expect(composeHostEnvironment({}, "/fallback")).toEqual({ PATH: "", HOME: "/fallback" });
  });

  it("forwards the proxy variables the Dev Containers CLI resolves, in both spellings", () => {
    // `proxy-from-env` reads the lower-case name first and the upper-case name second, so an operator
    // who exports only one spelling must not be the one whose Feature download fails.
    const env = composeHostEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/op",
      HTTPS_PROXY: "http://127.0.0.1:1083",
      https_proxy: "http://127.0.0.1:1083",
      NO_PROXY: "localhost,127.0.0.1",
      ALL_PROXY: "socks5://127.0.0.1:1080",
    });
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:1083");
    expect(env.https_proxy).toBe("http://127.0.0.1:1083");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1");
    expect(env.ALL_PROXY).toBe("socks5://127.0.0.1:1080");
  });

  it("omits unset and empty variables instead of forwarding a setting that says nothing", () => {
    const env = composeHostEnvironment({ PATH: "/usr/bin", HOME: "/home/op", HTTPS_PROXY: "", XDG_STATE_HOME: "" });
    for (const name of HOST_PROXY_VARIABLES) expect(env[name]).toBeUndefined();
    expect(env.XDG_STATE_HOME).toBeUndefined();
  });

  it("forwards XDG_STATE_HOME when set", () => {
    expect(composeHostEnvironment({ XDG_STATE_HOME: "/state" }).XDG_STATE_HOME).toBe("/state");
  });

  it("withholds every other inherited variable", () => {
    // The posture this module exists to keep: the child gets what it needs to run, not the Pi session.
    // `DOCKER_HOST` is named because it is the closest call — a daemon on a non-default socket still
    // needs a deliberate decision here, not an inherited variable.
    const env = composeHostEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/op",
      PI_SESSION_ID: "s-1",
      OPENAI_API_KEY: "sk-secret",
      DOCKER_HOST: "tcp://10.0.0.5:2375",
      LANG: "en_US.UTF-8",
    });
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"]);
  });
});

describe("the host child environment has one definition", () => {
  const source = readFileSync(new URL("../../extensions/index.ts", import.meta.url), "utf8");

  it("the extension composes it through composeHostEnvironment", () => {
    expect(source).toContain("composeHostEnvironment(process.env)");
  });

  it("no call site builds its own host environment", () => {
    // The facade has no injection point of its own, so the wiring is asserted against the source: a
    // literal again here is how the Dev Containers CLI ended up without the operator's proxy.
    expect(source).not.toMatch(/PATH:\s*process\.env\.PATH/);
    expect(source).not.toMatch(/HOME:\s*process\.env\.HOME/);
  });
});
