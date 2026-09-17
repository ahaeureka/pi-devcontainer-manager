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
    // The password class allows `/`: a password containing a slash used to stop the match at it and leave the
    // credential in the text (`https://alice:/hunter2@host` was returned unchanged), which matters because the
    // in-session visibility renders `redactText`'s output (adversarial review).
    out = out.replace(/(\w+:\/\/)[^/\s:@]+:[^\s@]*@/g, "$1[REDACTED]@");
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
    const first = argv[0];
    if (first === undefined)
        return "(no command)";
    // Redact BEFORE the basename: a URL-shaped program name keeps its credentials in the part the basename
    // would keep (`postgres://alice:s3cretpw@host` -> `alice:s3cretpw@host`), and the audit rules need the
    // scheme prefix to see them. A URL-shaped name is then rendered as its HOST only — a program name is a
    // word, and after redaction the remaining userinfo has no value worth showing (adversarial review).
    const redactedWhole = redactText(first);
    const base = redactedWhole.includes("://")
        ? (redactedWhole.split("://")[1]?.split("/")[0] ?? redactedWhole.split("://")[1] ?? "(no command)")
        : (redactedWhole.split("/").pop() ?? redactedWhole);
    const redacted = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (redacted.length === 0)
        return "(no command)";
    return redacted.slice(0, 64);
}
//# sourceMappingURL=policy.js.map