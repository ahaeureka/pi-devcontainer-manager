import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { RuntimeError } from "./errors.js";
import { isWithinWorkspace } from "./workspace-path.js";
const SECRET_NAME = /(?:^|_)(?:api[_-]?key|token|secret|password|credential|auth|bearer)(?:$|_)/i;
const PI_NAME = /^PI_/i;
export function evaluatePolicy(config, input, now = () => new Date()) {
    let denialReason;
    if (input.workspace && !isWorkspaceAllowed(input.workspace, config.allowedWorkspaceRoots)) {
        denialReason = "workspace-not-allowed";
    }
    else if ((input.operation === "stop" && !config.destructive.allowStop) ||
        (input.operation === "remove" && !config.destructive.allowRemove)) {
        denialReason = "destructive-operation-disabled";
    }
    else if (input.operation === "host-exec" && !config.hostExecution.allow) {
        denialReason = "host-execution-disabled";
    }
    else if (input.requestedEnvironment &&
        Object.keys(input.requestedEnvironment).some((name) => !isEnvironmentAllowed(name, config.environmentAllowlist))) {
        denialReason = "environment-variable-denied";
    }
    return Object.freeze({
        effectiveConfig: config,
        input: Object.freeze({
            ...input,
            ...(input.requestedEnvironment ? { requestedEnvironment: Object.freeze({ ...input.requestedEnvironment }) } : {}),
        }),
        authorized: denialReason === undefined,
        ...(denialReason ? { denialReason } : {}),
        createdAt: now().toISOString(),
    });
}
/**
 * Workspace containment, delegated to the single owner (review finding L5-01).
 *
 * The realpath-aware comparison and its fallback for a path that does not exist live in
 * `workspace-path.ts`; this function only applies it to the configured roots.
 */
export function isWorkspaceAllowed(workspace, roots) {
    if (!isAbsolute(workspace) || roots.length === 0)
        return false;
    return roots.some((root) => isWithinWorkspace(root, workspace));
}
export function isEnvironmentAllowed(name, allowlist) {
    return !PI_NAME.test(name) && !SECRET_NAME.test(name) && allowlist.includes(name);
}
export function buildChildEnvironment(requested, allowlist, baseline = {}) {
    const result = {};
    for (const [name, value] of Object.entries(baseline)) {
        if (typeof value === "string" && isEnvironmentAllowed(name, allowlist))
            result[name] = value;
    }
    for (const [name, value] of Object.entries(requested ?? {})) {
        if (!isEnvironmentAllowed(name, allowlist)) {
            throw new RuntimeError({
                kind: "policy-denied",
                message: `Environment variable is not allowed: ${name}`,
                remedy: "Add the variable name to environmentAllowlist or drop it from the request.",
            });
        }
        result[name] = value;
    }
    return result;
}
export function commandFingerprint(parts) {
    return createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex");
}
/**
 * Audit command identity for one invocation.
 *
 * Single-sourced so every audited surface (the extension's host-exec and setup paths, the
 * execution service, the extracted setup install) derives fingerprint/plaintext the same way:
 * `none` records nothing, `fingerprint-only` records the fingerprint, `redacted-text` also
 * records the joined command text (the audit writer redacts it on the way out).
 */
export function commandIdentity(parts, capture) {
    if (capture === "none")
        return {};
    const nonEmpty = parts.filter((part) => part.length > 0);
    if (nonEmpty.length === 0)
        return {};
    const fingerprint = commandFingerprint(nonEmpty);
    if (capture === "fingerprint-only")
        return { commandFingerprint: fingerprint };
    return { commandFingerprint: fingerprint, commandText: nonEmpty.join(" ") };
}
/**
 * Best-effort credential scrubbing for audit command text.
 *
 * This is deliberately conservative and layered, but it is NOT a guarantee:
 * `audit.commandCapture` defaults to `fingerprint-only`, and plaintext capture
 * should be treated as sensitive even after redaction. Covered here:
 *  - `Bearer`/`Basic`/`Token` authentication schemes (header values)
 *  - `key: value` / `key=value` for secret-looking names (quoted or bare)
 *  - `--secret-flag value` / `--secret-flag=value`
 *  - credentials embedded in URLs (`scheme://user:pass@host`)
 */
const SECRET_KEY = "(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|passwd|pwd|pass|sig|credential|credentials|authorization|auth)";
export function redactText(text) {
    let out = text;
    // 1. Auth schemes: "Bearer <token>" / "Basic <b64>" / "Token <t>".
    out = out.replace(/\b(Bearer|Basic|Token)(\s+)("[^"]*"|'[^']*'|\S+)/gi, (_match, scheme, space, value) => {
        // Consume the WHOLE value, not just the prefix that happens to match a
        // character class: a value containing `,` `;` `:` or non-ASCII characters
        // used to be redacted only up to that character, leaving the credential's
        // tail in the audit file.
        const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : "";
        return `${scheme}${space}${quote}[REDACTED]${quote}`;
    });
    // 2. key: value / key=value (quoted or bare token).
    out = out.replace(new RegExp(`(${SECRET_KEY})(\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s"']+)`, "gi"), "$1$2[REDACTED]");
    // 3. --secret-flag value / --secret-flag=value.
    out = out.replace(new RegExp(`(--?${SECRET_KEY})(\\s*=\\s*|\\s+)("[^"]*"|'[^']*'|[^\\s"']+)`, "gi"), "$1$2[REDACTED]");
    // 4. Credentials embedded in URLs: scheme://user:pass@host.
    //
    // The user class excludes `/` and the password class allows `@`, so userinfo is consumed up to the LAST `@`
    // before a `/` (`postgres://alice:p@ss@host/db` used to keep `ss@host`). A password CONTAINING a slash is
    // indistinguishable from a path and is documented as out of scope in `docs/security.md` — which is why the
    // in-session rendering (`displayProgram`) is enforced independently of this rule.
    out = out.replace(/(\w+:\/\/)[^\s/]*@/g, "$1[REDACTED]@");
    return out;
}
/**
 * Render an argv as the PROGRAM it names, for operator-facing text.
 *
 * This is the only thing the in-session visibility shows, so it is enforced here rather than assumed:
 * basename of `argv[0]`, redacted with the audit rules (a program name CAN be credential-shaped —
 * `argv[0]="Authorization: Bearer sk-live-…"` was reproduced by adversarial review), capped so a
 * pathological argument cannot flood the operator channel or the status block, and never blank.
 */
export function displayProgram(argv) {
    // `argv[0]` is not guaranteed to be a bare program name: a caller may hand over the whole command line as
    // one string, and rendering that would store command text. Take the FIRST ASCII-whitespace-delimited token.
    // (ASCII only: U+00A0 and U+FEFF are matched by `\s`, so a credential-shaped token could be split before
    // its `@host` tail and the tail rendered — adversarial review.)
    const first = argv[0]?.trim().split(/[ \t\n\r\f\v]+/)[0];
    if (first === undefined || first.length === 0)
        return "(no command)";
    // Strip control and format characters FIRST (C0/C1/DEL/Cf): a U+202E in a name can visually reorder the
    // notice the operator is asked to trust, and stripping first means the structural rules below see the
    // real text.
    const cleaned = first.replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}]/gu, "");
    if (cleaned.length === 0)
        return "(no command)";
    // Redact with the audit rules before any slicing: a URL-shaped name keeps its credentials in the part a
    // basename would keep, and the rules need the scheme prefix to see them.
    const redacted = redactText(cleaned);
    // Then reduce to a NAME, conservatively — a whitelist, not a list of known-bad shapes (four adversarial
    // passes each found the next shape a blacklist missed):
    //   * a URL renders its HOST: the authority between `://` and the first `/`, with any userinfo (before its
    //     last `@`) dropped;
    //   * everything else renders the LAST path segment — splitting on `\` as well as `/`, so a Windows drive
    //     letter is a separator, not userinfo;
    //   * and whatever remains is truncated at the first `:` or `@`, because `alice:hunter2` (a DSN pair with no
    //     host) and `alice:hunter2@host` must never render the password. A port or an IPv6 literal is lost with
    //     it: a program NAME is the signal an operator needs, and no credential can survive this rule.
    const schemeLess = !redacted.includes("://");
    const afterScheme = schemeLess ? redacted : (redacted.split("://")[1] ?? "");
    const withoutUserinfo = schemeLess
        ? // Strip a QUERY or FRAGMENT first: a scheme-less URL is a URL, and a query is where a signed URL carries
            // its credential (`bucket.s3.amazonaws.com/key?X-Amz-Signature=…`) — adversarial review.
            (() => {
                const bare = afterScheme.split(/[?#]/)[0] ?? "";
                // `[user[:pass]@]host` with no scheme renders the HOST, mirroring the URL branch: the credential can
                // sit in the user position (a token-in-URL), and the host is the name an operator needs.
                const afterAt = bare.includes("@") && !bare.split("@").pop()?.includes("/") ? (bare.split("@").pop() ?? bare) : bare;
                // Otherwise a path: the LAST segment is the name, and an `@` in a DIRECTORY is not userinfo
                // (`/opt/app@2/dist/bin/tool` is `tool`, `/usr/lib/node_modules/@babel/cli/bin/babel.js` is `babel.js`).
                return (afterAt.split(/[\\/]/).pop() ?? afterAt);
            })()
        : // A URL: the AUTHORITY (up to its first `/`), with userinfo — the part before the authority's last
            // `@` — dropped. An `@` later in the path is not userinfo and must not become the name.
            (() => {
                // The authority ends at `/`, `?` OR `#`: a QUERY is the canonical place a URL carries a credential
                // (`https://host?p=hunter2`, a presigned URL's `X-Amz-Signature=…`), and it used to be rendered
                // verbatim into the ledger and the status block (adversarial review).
                const authority = afterScheme.split(/[/?#]/)[0] ?? "";
                return authority.includes("@") ? (authority.split("@").pop() ?? "") : authority;
            })();
    const withoutPort = /^(\[[^\]]*\])(?::[0-9]+)?$/.exec(withoutUserinfo)?.[1] ?? withoutUserinfo;
    const unwrapped = /^\[([^\]]*)\]$/.exec(withoutPort);
    const bounded = unwrapped !== null && /^[0-9a-fA-F:.]+$/.test(unwrapped[1] ?? "")
        ? // A real bracketed IPv6 literal is kept (it carries no credential), and nothing else is exempt: the
            // old `[^\]]*` pattern returned ANY bracket-wrapped token verbatim, including `[alice:hunter2@host]`.
            withoutUserinfo
        : ((unwrapped?.[1] ?? withoutPort).split(/[:@]/)[0] ?? "");
    const name = bounded.trim();
    if (name.length === 0)
        return "(no command)";
    return Array.from(name).slice(0, 64).join("");
}
//# sourceMappingURL=policy.js.map