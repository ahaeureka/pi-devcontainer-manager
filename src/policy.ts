import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { RuntimeError } from "./errors.js";
import { isWithinWorkspace } from "./workspace-path.js";
import type { CommandCaptureMode, EffectiveConfig, OperationPolicySnapshot, PolicyInput } from "./types.js";

const SECRET_NAME = /(?:^|_)(?:api[_-]?key|token|secret|password|credential|auth|bearer)(?:$|_)/i;
const PI_NAME = /^PI_/i;

export function evaluatePolicy(
  config: EffectiveConfig,
  input: PolicyInput,
  now: () => Date = () => new Date(),
): OperationPolicySnapshot {
  let denialReason: OperationPolicySnapshot["denialReason"];

  if (input.workspace && !isWorkspaceAllowed(input.workspace, config.allowedWorkspaceRoots)) {
    denialReason = "workspace-not-allowed";
  } else if (
    (input.operation === "stop" && !config.destructive.allowStop) ||
    (input.operation === "remove" && !config.destructive.allowRemove)
  ) {
    denialReason = "destructive-operation-disabled";
  } else if (input.operation === "host-exec" && !config.hostExecution.allow) {
    denialReason = "host-execution-disabled";
  } else if (
    input.requestedEnvironment &&
    Object.keys(input.requestedEnvironment).some((name) => !isEnvironmentAllowed(name, config.environmentAllowlist))
  ) {
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
export function isWorkspaceAllowed(workspace: string, roots: readonly string[]): boolean {
  if (!isAbsolute(workspace) || roots.length === 0) return false;
  return roots.some((root) => isWithinWorkspace(root, workspace));
}

export function isEnvironmentAllowed(name: string, allowlist: readonly string[]): boolean {
  return !PI_NAME.test(name) && !SECRET_NAME.test(name) && allowlist.includes(name);
}

export function buildChildEnvironment(
  requested: Readonly<Record<string, string>> | undefined,
  allowlist: readonly string[],
  baseline: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(baseline)) {
    if (typeof value === "string" && isEnvironmentAllowed(name, allowlist)) result[name] = value;
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

export function commandFingerprint(parts: readonly string[]): string {
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
export function commandIdentity(
  parts: readonly string[],
  capture: CommandCaptureMode,
): { commandFingerprint?: string; commandText?: string } {
  if (capture === "none") return {};
  const nonEmpty = parts.filter((part) => part.length > 0);
  if (nonEmpty.length === 0) return {};
  const fingerprint = commandFingerprint(nonEmpty);
  if (capture === "fingerprint-only") return { commandFingerprint: fingerprint };
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
const SECRET_KEY =
  "(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|passwd|pwd|pass|sig|credential|credentials|authorization|auth)";

export function redactText(text: string): string {
  let out = text;
  // 1. Auth schemes: "Bearer <token>" / "Basic <b64>" / "Token <t>".
  out = out.replace(
    /\b(Bearer|Basic|Token)(\s+)("[^"]*"|'[^']*'|\S+)/gi,
    (_match, scheme: string, space: string, value: string) => {
      // Consume the WHOLE value, not just the prefix that happens to match a
      // character class: a value containing `,` `;` `:` or non-ASCII characters
      // used to be redacted only up to that character, leaving the credential's
      // tail in the audit file.
      const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : "";
      return `${scheme}${space}${quote}[REDACTED]${quote}`;
    },
  );
  // 2. key: value / key=value (quoted or bare token).
  out = out.replace(
    new RegExp(`(${SECRET_KEY})(\\s*[=:]\\s*)("[^"]*"?|'[^']*'?|[^\\s"']+)`, "gi"),
    "$1$2[REDACTED]",
  );
  // 3. --secret-flag value / --secret-flag=value.
  out = out.replace(
    new RegExp(`(--?${SECRET_KEY})(\\s*=\\s*|\\s+)("[^"]*"?|'[^']*'?|[^\\s"']+)`, "gi"),
    "$1$2[REDACTED]",
  );
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
export function displayProgram(argv: readonly string[]): string {
  // The rendering is deliberately CLOSED rather than clever: nine adversarial passes each broke a heuristic that
  // tried to tell a program name from a credential, so only a name that can be justified is rendered and
  // `(no command)` is returned otherwise. `argv[0]` may be a whole command line, so only its first
  // ASCII-whitespace-delimited token is considered.
  const first = argv[0]?.trim().split(/[ \t\n\r\f\v]+/)[0];
  if (first === undefined || first.length === 0) return "(no command)";

  // Control, format and line-separator characters are removed; Unicode SPACES (Zs) become an ASCII space so
  // they still terminate a token (`Bearer<NBSP>secret` must not glue into one bare word) without breaking the
  // summary's ` | ` separator.
  const cleaned = first
    .replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/\p{Zs}/gu, " ")
    .trim();
  if (cleaned.length === 0) return "(no command)";

  // Redact with the audit rules BEFORE classifying: the auth-scheme and key=value rules need the original
  // spacing to recognise a credential. Then take the FIRST token again — a Unicode space is a separator, so
  // `/usr/bin/curl<NBSP>secret` must classify `/usr/bin/curl`, not the whole string.
  const token = (redactText(cleaned).split(" ")[0] ?? "").trim();
  if (token.length === 0) return "(no command)";
  const classify = (value: string): string => {
    // 1. A URL renders its HOST. A `://` scheme or a LEADING `//` is a URL (a protocol-relative reference —
    //    the previous dot-in-the-first-segment condition let `//host/hook/SECRET` render its path).
    const schemed = value.includes("://");
    if (schemed || value.startsWith("//")) {
      const rest = schemed ? (value.split("://")[1] ?? "") : value.slice(2);
      const authority = rest.split(/[/?#]/)[0] ?? "";
      const host = authority.includes("@") ? (authority.split("@").pop() ?? "") : authority;
      // A `user:password` authority with no `@` keeps only the part before a colon that is NOT a port.
      const colon = host.lastIndexOf(":");
      const bare = colon > 0 && !/^[0-9]+$/.test(host.slice(colon + 1)) ? host.slice(0, colon) : host;
      return bare.length > 0 ? bare : "(no command)";
    }
    // 2. A filesystem path (absolute, explicitly relative or Windows-drive) renders its LAST segment, and only
    //    when that segment is a plain name: a segment carrying `@` or `:` is a credential position.
    const isPath = value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || /^[A-Za-z]:[\\/]/.test(value);
    if (isPath) {
      const last = value.split(/[\\/]/).filter((part) => part.length > 0).pop() ?? "";
      return last.length > 0 && !/[@:]/.test(last) ? last : "(no command)";
    }
    // 3. A SIMPLE token with no separator and no punctuation beyond `._+-` is the name itself.
    return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value) ? value : "(no command)";
  };

  const name = classify(token);
  return name === "(no command)" ? name : Array.from(name).slice(0, 64).join("");
}
