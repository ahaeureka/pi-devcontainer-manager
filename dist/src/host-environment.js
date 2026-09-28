import { homedir } from "node:os";
/**
 * The environment for every HOST-side child this extension spawns.
 *
 * The docker CLI, the Dev Containers CLI, the lifecycle commands, the host runner and `npm` (in
 * `/devcontainer setup`) all get the environment this function returns — one definition, so "what
 * does a host child see?" has exactly one answer and cannot drift between call sites.
 *
 * ## Why this INHERITS (a deliberate, documented reversal)
 *
 * This function used to COMPOSE a minimal environment: `PATH`, `HOME`, `XDG_STATE_HOME` and the proxy
 * variables, with everything else withheld. That boundary cost real usability and could not be
 * maintained honestly:
 *
 *  - The withheld set is unbounded in practice. Any `initializeCommand`, `postCreateCommand` or
 *    wrapper script may depend on `USER` / `LOGNAME` (a `devcontainer.json` whose
 *    `build.args.USERNAME` is `${localEnv:USER}` produces an empty `--build-arg USERNAME=`, and an
 *    `initializeCommand` that runs `id -u "$USER"` writes a blank `.env`), on `LANG`, on a toolchain
 *    variable, or on `SSH_AUTH_SOCK` (a `build.options` entry of `--ssh default` fails outright with
 *    `ERROR: invalid empty ssh agent socket`).
 *  - A name list cannot separate "identity" from "credential": `USER` is not a secret while
 *    `SSH_AUTH_SOCK` is a capability, and examples like `GITHUB_TOKEN` vs `TOKEN_FILE` cut across any
 *    pattern rule.
 *  - The allowlist was itself a coupling to whatever project last failed, which is the opposite of a
 *    stable contract.
 *
 * So the host child now inherits Pi's environment unchanged. **The consequence is accepted and must
 * not be rediscovered as a bug:** a host command may be constructed by the model (`devcontainer_host_exec`,
 * `/devcontainer host-exec`), so an arbitrary host command can read whatever Pi's own process could
 * read, including provider credentials and `*_TOKEN` variables. That exposure is bounded by the
 * auditing layer, not by this function: every host execution writes an audit record
 * (`operation: "host-exec"`, `initiator: "host-escape"`) whose command identity is a SHA-256
 * fingerprint by default, and host execution can be withheld outright with
 * `hostExecution.allow: false` anywhere in the configuration layers.
 *
 * ## The asymmetry with the container side is intentional
 *
 * `environmentAllowlist` / `buildChildEnvironment` still govern the CONTAINER side, where names
 * resembling credentials are refused even when listed and everything else must be registered
 * explicitly. The container is a boundary further out, and its policy is unchanged. The host side is
 * therefore *more* permissive than the container side — chosen so that host tooling behaves exactly
 * as it does in a terminal, and documented in `docs/security.md`.
 *
 * @param source the environment to inherit (normally `process.env`)
 * @param homeFallback used when the source defines no `HOME`; injected so the fallback is testable
 */
export function composeHostEnvironment(source, homeFallback = homedir()) {
    const env = {};
    for (const [name, value] of Object.entries(source)) {
        // `undefined` values are dropped: a key present with no value is not the same as an unset key for
        // most tools, and Node's `spawn` rejects it.
        if (typeof value === "string")
            env[name] = value;
    }
    // `PATH` and `HOME` are always present, even when the source omits them: a child without them fails
    // in ways that look like a missing tool rather than a missing variable, and the spawned executable
    // is resolved through `PATH`.
    if (env.PATH === undefined)
        env.PATH = "";
    if (env.HOME === undefined)
        env.HOME = homeFallback;
    return env;
}
//# sourceMappingURL=host-environment.js.map