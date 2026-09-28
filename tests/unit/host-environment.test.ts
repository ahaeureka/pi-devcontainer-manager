/**
 * The host child environment INHERITS Pi's environment (a deliberate, documented reversal).
 *
 * It used to compose a minimal set — `PATH`, `HOME`, `XDG_STATE_HOME` and the proxy variables — and
 * withhold everything else. That cost real usability: a `devcontainer.json` whose `build.args.USERNAME`
 * is `${localEnv:USER}` produced an empty `--build-arg USERNAME=`, an `initializeCommand` running
 * `id -u "$USER"` wrote a blank `.env`, and a `build.options` entry of `--ssh default` failed outright
 * with `ERROR: invalid empty ssh agent socket`, because `SSH_AUTH_SOCK` was withheld.
 *
 * These tests pin the INHERITANCE, including the exposure it accepts, so the decision is not silently
 * "fixed" back into a name allowlist later. The countermeasures that DO bound host execution
 * (policy gate, audit fingerprint, container-side allowlist) are asserted in their own suites.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { composeHostEnvironment } from "../../src/host-environment.js";

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

  it("inherits identity variables the host tooling depends on", () => {
    // The concrete regression this reversal fixes: a project script deriving the user from `$USER`.
    const env = composeHostEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/work",
      USER: "work",
      LOGNAME: "work",
      USERNAME: "work",
    });

    expect(env.USER).toBe("work");
    expect(env.LOGNAME).toBe("work");
    expect(env.USERNAME).toBe("work");
  });

  it("inherits SSH_AUTH_SOCK so `--ssh default` builds work", () => {
    // `docker buildx --ssh default` fails with "invalid empty ssh agent socket" when this is absent.
    expect(composeHostEnvironment({ PATH: "/usr/bin", SSH_AUTH_SOCK: "/home/work/.ssh/agent.sock" }).SSH_AUTH_SOCK).toBe(
      "/home/work/.ssh/agent.sock",
    );
  });

  it("inherits locale, proxy spellings and daemon endpoints unchanged", () => {
    const env = composeHostEnvironment({
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      HTTPS_PROXY: "http://127.0.0.1:1083",
      https_proxy: "http://127.0.0.1:1083",
      NO_PROXY: "localhost,127.0.0.1",
      ALL_PROXY: "socks5://127.0.0.1:1080",
      DOCKER_HOST: "tcp://10.0.0.5:2375",
      XDG_STATE_HOME: "/state",
    });

    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:1083");
    expect(env.https_proxy).toBe("http://127.0.0.1:1083");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1");
    expect(env.ALL_PROXY).toBe("socks5://127.0.0.1:1080");
    expect(env.DOCKER_HOST).toBe("tcp://10.0.0.5:2375");
    expect(env.XDG_STATE_HOME).toBe("/state");
  });

  it("inherits credential-shaped variables too — the accepted consequence", () => {
    // This is the documented exposure, asserted so it cannot be mistaken for an oversight: bounding
    // host execution belongs to the policy gate and the audit trail, not to this function. If this
    // test ever fails because a filter was reintroduced, that is a decision change — update
    // docs/security.md and this test together, deliberately.
    const env = composeHostEnvironment({
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-secret",
      GITHUB_TOKEN: "ghp_secret",
      PI_SESSION_ID: "s-1",
    });

    expect(env.OPENAI_API_KEY).toBe("sk-secret");
    expect(env.GITHUB_TOKEN).toBe("ghp_secret");
    expect(env.PI_SESSION_ID).toBe("s-1");
  });

  it("drops keys whose value is undefined rather than forwarding an empty one", () => {
    const env = composeHostEnvironment({ PATH: "/usr/bin", HOME: "/home/op", UNSET_ONE: undefined });

    expect("UNSET_ONE" in env).toBe(false);
  });

  it("passes an explicitly empty variable through (it was legitimately set to empty)", () => {
    const env = composeHostEnvironment({ PATH: "/usr/bin", HTTPS_PROXY: "" });

    expect(env.HTTPS_PROXY).toBe("");
  });
});

describe("the host child environment has one definition", () => {
  const source = readFileSync(new URL("../../extensions/index.ts", import.meta.url), "utf8");

  it("the extension composes it through composeHostEnvironment", () => {
    expect(source).toContain("composeHostEnvironment(process.env)");
  });

  it("no call site builds its own host environment", () => {
    // The facade has no injection point of its own, so the wiring is asserted against the source:
    // one definition is what keeps "what does a host child see?" from drifting between call sites.
    expect(source).not.toMatch(/PATH:\s*process\.env\.PATH/);
    expect(source).not.toMatch(/HOME:\s*process\.env\.HOME/);
  });
});
