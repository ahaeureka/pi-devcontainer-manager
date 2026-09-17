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
    out = out.replace(new RegExp(`(${SECRET_KEY})(\\s*[=:]\\s*)("[^"]*"?|'[^']*'?|[^\\s"']+)`, "gi"), "$1$2[REDACTED]");
    // 3. --secret-flag value / --secret-flag=value.
    out = out.replace(new RegExp(`(--?${SECRET_KEY})(\\s*=\\s*|\\s+)("[^"]*"?|'[^']*'?|[^\\s"']+)`, "gi"), "$1$2[REDACTED]");
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
    // The rendering is deliberately CLOSED rather than clever. Eight adversarial passes each broke a heuristic
    // that tried to tell a program name from a credential, so the rule now only renders a name it can justify,
    // and `(no command)` otherwise. `argv[0]` may be a whole command line, so only its FIRST ASCII-whitespace
    // token is considered.
    const first = argv[0]?.trim().split(/[ \t\n\r\f\v]+/)[0];
    if (first === undefined || first.length === 0)
        return "(no command)";
    // Strip control, format, line-separator and space-separator characters: a U+202E can reorder the notice, and
    // a Unicode space (Zs) makes one entry read as several in the ` | `-joined summary.
    const token = first.replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/gu, "");
    if (token.length === 0)
        return "(no command)";
    const redacted = redactText(token);
    const classify = (value) => {
        // 1. A URL renders its HOST: with a scheme, or protocol-relative when its first segment looks like a host
        //    (a dot). Userinfo, query and fragment are dropped.
        const schemed = value.includes("://");
        const protocolRelative = value.startsWith("//") && (value.slice(2).split("/")[0] ?? "").includes(".");
        if (schemed || protocolRelative) {
            const rest = schemed ? (value.split("://")[1] ?? "") : value.slice(2);
            const authority = rest.split(/[/?#]/)[0] ?? "";
            const host = authority.includes("@") ? (authority.split("@").pop() ?? "") : authority;
            // After userinfo is dropped, what remains IS the host: rendering it is safe by construction.
            return host.length > 0 ? host : "(no command)";
        }
        // 2. A filesystem path (absolute, explicitly relative or Windows-drive) renders its LAST segment — but only
        //    when that segment is a plain name: a segment carrying `@` or `:` is the userinfo/user position a
        //    credential occupies (`./TOKEN@host`, `/tmp/user:pass`), so it is not rendered.
        const isPath = value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || /^[A-Za-z]:[\\/]/.test(value);
        if (isPath) {
            const last = value.split(/[\\/]/).filter((part) => part.length > 0).pop() ?? "";
            return last.length > 0 && !/[@:]/.test(last) && !/^\[[^\]]+\]$/.test(last) ? last : "(no command)";
        }
        // 3. A SIMPLE token with no separator and no userinfo punctuation is the name itself (`docker`, `systemctl`).
        return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value) ? value : "(no command)";
    };
    const name = classify(redacted);
    return name === "(no command)" ? name : Array.from(name).slice(0, 64).join("");
}
//# sourceMappingURL=policy.js.map