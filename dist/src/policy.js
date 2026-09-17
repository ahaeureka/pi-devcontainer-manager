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
const SECRET_KEY = "(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|passwd|credential|credentials|authorization|auth)";
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
    // one string (the free-text refusal path does), and rendering that would store command text — which this
    // visibility is not allowed to do. Take the first whitespace-delimited token, always.
    const first = argv[0]?.trim().split(/\s+/)[0];
    if (first === undefined || first.length === 0)
        return "(no command)";
    // Redact BEFORE the basename: a URL-shaped program name keeps its credentials in the part the basename
    // would keep (`postgres://alice:s3cretpw@host` -> `alice:s3cretpw@host`), and the audit rules need the
    // scheme prefix to see them. A URL-shaped name is then rendered as its HOST only — a program name is a
    // word, and after redaction the remaining userinfo has no value worth showing (adversarial review).
    const redactedWhole = redactText(first);
    // A URL-shaped name renders as its HOST only — never its userinfo. Taking the part before the first `/`
    // was not enough (`redis://:hunter2@cache:6379` has no slash and kept the password), so the userinfo is
    // dropped explicitly (adversarial review).
    // Render the HOST of whatever this token looks like, with or without a scheme. `alice:hunter2@host` is as
    // credential-shaped as `https://alice:hunter2@host`, and the `://` branch alone missed it (adversarial
    // review): the userinfo is the text before the LAST `@` of the token, and everything after it is the host.
    // With a scheme, the AUTHORITY is what sits between `://` and the first `/`, and its userinfo is what comes
    // before the LAST `@` INSIDE that authority — an `@` in a path or query is not userinfo and must not turn
    // the path into the "host". Without a scheme, a `user:pass@host`-shaped token still has its userinfo dropped.
    const hasScheme = redactedWhole.includes("://");
    const afterScheme = hasScheme ? (redactedWhole.split("://")[1] ?? "") : redactedWhole;
    const authority = afterScheme.split("/")[0] ?? "";
    // With a scheme the userinfo lives inside the authority; WITHOUT one there may be a path in front of it
    // (`./alice:hunter2@host`), so the `@` must be looked for in the WHOLE token — taking the last segment
    // verbatim rendered the credential (adversarial review).
    const base = authority.includes("@")
        ? (authority.split("@").pop() ?? "(no command)")
        : !hasScheme && afterScheme.includes("@")
            ? ((afterScheme.split("@").pop() ?? "").split("/")[0] ?? "(no command)")
            : hasScheme
                ? authority
                : (redactedWhole.split("/").pop() ?? redactedWhole);
    const redacted = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (redacted.length === 0)
        return "(no command)";
    return redacted.slice(0, 64);
}
//# sourceMappingURL=policy.js.map