import { homedir } from "node:os";
/**
 * The proxy variables the Dev Containers CLI's HTTP client resolves, in both spellings.
 *
 * `proxy-from-env` (bundled into the CLI through the `proxy-agent` dependency) checks the lower-case
 * name first and the upper-case name second, so both are forwarded here: an operator who exports
 * only `HTTPS_PROXY` and one who exports only `https_proxy` must behave the same way.
 */
export const HOST_PROXY_VARIABLES = Object.freeze([
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
]);
/**
 * The environment for every HOST-side child this extension spawns.
 *
 * The docker CLI, the Dev Containers CLI, the lifecycle commands, the host runner and `npm` (in
 * `/devcontainer setup`) all get the environment this function composes — one definition, so "what
 * does a host child see?" has exactly one answer and cannot drift between call sites. It is composed
 * rather than inherited on purpose: Pi's own session environment is not handed over wholesale.
 *
 * Two groups pass through:
 *
 *  - `PATH` / `HOME` (plus `XDG_STATE_HOME` when set) — how the child resolves its executable and
 *    where it keeps its own caches.
 *  - the standard proxy variables, when the operator's session defines them.
 *
 * The proxy group is not a convenience. The Dev Containers CLI fetches Features over OCI with its own
 * HTTP client, which resolves its proxy from `process.env` (`proxy-agent` → `proxy-from-env`: the
 * `<scheme>_proxy`, `npm_config_<scheme>_proxy` and `all_proxy` names). Withholding those variables
 * makes that client connect directly, and on a host whose egress is only reliable through a proxy the
 * Feature download fails — `Failed to download package for ghcr.io/…` — and the BUILD fails with it.
 * A Feature's own proxy build args cannot help: this fetch happens before any Docker work starts.
 *
 * Values are passed through untouched and are never rendered anywhere. No diagnostic, system-prompt
 * block or audit record carries an environment value, because a proxy URL may embed credentials.
 *
 * Everything else is deliberately withheld. `environmentAllowlist` / `buildChildEnvironment` govern
 * the CONTAINER side, which is a boundary further out than this one; widening what a host child
 * inherits is the thing this module exists to prevent.
 *
 * @param source the environment to compose from (normally `process.env`)
 * @param homeFallback used when the source defines no `HOME`; injected so the fallback is testable
 */
export function composeHostEnvironment(source, homeFallback = homedir()) {
    // `PATH` and `HOME` are always present, even when empty in the source: a child without them fails
    // in ways that look like a missing tool rather than a missing variable, and the spawned executable
    // is resolved through this value.
    const env = {
        PATH: source.PATH ?? "",
        HOME: source.HOME ?? homeFallback,
    };
    // Empty means "not configured" for the rest: `proxy-from-env` reads an empty proxy as "no proxy",
    // so forwarding an empty string would add a setting that says nothing.
    for (const name of HOST_PROXY_VARIABLES) {
        const value = source[name];
        if (typeof value === "string" && value.length > 0)
            env[name] = value;
    }
    const stateHome = source.XDG_STATE_HOME;
    if (typeof stateHome === "string" && stateHome.length > 0)
        env.XDG_STATE_HOME = stateHome;
    return env;
}
//# sourceMappingURL=host-environment.js.map