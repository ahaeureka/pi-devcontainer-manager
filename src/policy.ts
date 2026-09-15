import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { RuntimeError } from "./errors.js";
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
 * Filesystem-identity-aware workspace containment.
 *
 * Containment is checked on `realpath`-resolved paths, not lexical ones: a
 * symlink created beneath an allowed root that points outside it must not pass
 * (`/allowed/link -> /outside`). Paths that do not exist fall back to their
 * resolved lexical form so configuration/selection flows for not-yet-created
 * workspaces keep working; operations that require an existing workspace still
 * fail closed downstream when the path cannot be resolved by the CLI.
 */
export function isWorkspaceAllowed(workspace: string, roots: readonly string[]): boolean {
  if (!isAbsolute(workspace) || roots.length === 0) return false;
  const candidate = canonicalForPolicy(workspace);
  const separator = process.platform === "win32" ? "\\" : "/";
  return roots.some((root) => {
    const base = canonicalForPolicy(root);
    const rel = relative(base, candidate);
    return rel === "" || (!rel.startsWith(`..${separator}`) && rel !== "..");
  });
}

/** realpath when the path exists, else the resolved lexical path. */
function canonicalForPolicy(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
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
const SECRET_KEY = "(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|passwd|credential|credentials|authorization|auth)";

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
    new RegExp(`(${SECRET_KEY})(\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s"']+)`, "gi"),
    "$1$2[REDACTED]",
  );
  // 3. --secret-flag value / --secret-flag=value.
  out = out.replace(
    new RegExp(`(--?${SECRET_KEY})(\\s*=\\s*|\\s+)("[^"]*"|'[^']*'|[^\\s"']+)`, "gi"),
    "$1$2[REDACTED]",
  );
  // 4. Credentials embedded in URLs: scheme://user:pass@host.
  out = out.replace(/(\w+:\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1[REDACTED]@");
  return out;
}
