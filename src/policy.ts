import { isAbsolute, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { EffectiveConfig, OperationPolicySnapshot, PolicyInput } from "./types.js";

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

export function isWorkspaceAllowed(workspace: string, roots: readonly string[]): boolean {
  if (!isAbsolute(workspace) || roots.length === 0) return false;
  const candidate = resolve(workspace);
  return roots.some((root) => {
    const rel = relative(resolve(root), candidate);
    return rel === "" || (!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== "..");
  });
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
      throw new Error(`Environment variable is not allowed: ${name}`);
    }
    result[name] = value;
  }
  return result;
}

export function commandFingerprint(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex");
}

export function redactText(text: string): string {
  return text.replace(/(api[_-]?key|token|secret|password|authorization)\s*[=:]\s*[^\s]+/gi, "$1=[REDACTED]");
}
