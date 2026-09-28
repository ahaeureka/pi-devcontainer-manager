/**
 * Safe failure diagnostics for lifecycle operations.
 *
 * A lifecycle failure has two records: the raw transcript in the project's private
 * `.pi/devcontainer-manager/lifecycle-logs/` directory (full stdout/stderr, secret-bearing, operator-only) and this
 * packet, which is the only part that reaches the model automatically.
 *
 * The packet therefore contains **no** captured process text and **no** host path. It carries fixed, extension-owned
 * wording plus bounded metadata, and it declares `complete: false` whenever the class does not itself explain why the
 * operation failed — in that case the raw transcript holds the root cause and reading it is an explicit operator
 * decision. Copying "the last N lines" or regex-selected context windows was deliberately rejected: no finite rule can
 * promise that a credential or an instruction-like string was not selected.
 */
import { isRuntimeError } from "./errors.js";
import type { LifecycleLogOperation } from "./lifecycle-log.js";

export type LifecycleFailureClass =
  | "policy-denied"
  | "cancelled"
  | "timeout"
  | "docker-daemon-unavailable"
  | "devcontainer-cli-unavailable"
  | "post-create-failed"
  | "post-start-failed"
  | "setup-install-failed"
  | "lifecycle-command-failed"
  | "unclassified";

export interface LifecycleFailureDiagnostic {
  readonly operation: LifecycleLogOperation;
  readonly class: LifecycleFailureClass;
  /** True only when the class fully explains the failure, so no raw transcript is needed. */
  readonly complete: boolean;
  /** Fixed wording owned by this extension; never derived from process output. */
  readonly detail: string;
  readonly remedy?: string;
  readonly rawLogAvailable: boolean;
  /** The transcript's file name only — never its directory, which would disclose a host path. */
  readonly logId?: string;
  readonly exitCode?: number | null;
  readonly durationMs?: number;
  readonly truncated?: boolean;
}

export interface LifecycleFailureInput {
  readonly operation: LifecycleLogOperation;
  readonly error?: unknown;
  readonly exitCode?: number | null;
  readonly durationMs?: number;
  readonly truncated?: boolean;
  /** Metadata about the operator-local transcript; its contents are never read here. */
  readonly rawLog?: { readonly path?: string; readonly warning?: string };
}

/**
 * The one stable Dev Containers CLI envelope worth recognising: it names WHICH configured hook failed. The matched
 * text is never emitted — only the fixed class it implies.
 */
const HOOK_FAILURE = /\bpost(Start|Create)Command\b[^\n]{0,80}?\bfailed\b/i;

export function classifyLifecycleFailure(input: LifecycleFailureInput): LifecycleFailureDiagnostic {
  const klass = classify(input);
  const rawLogAvailable = input.rawLog?.path !== undefined && input.rawLog.warning === undefined;
  const logId = rawLogAvailable ? fileNameOf(input.rawLog!.path!) : undefined;

  return {
    operation: input.operation,
    class: klass,
    complete: COMPLETE_CLASSES.has(klass),
    ...wordingFor(klass),
    rawLogAvailable,
    ...(logId !== undefined ? { logId } : {}),
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...(input.truncated !== undefined ? { truncated: input.truncated } : {}),
  };
}

/** Render the packet for the model. Fixed lines only; nothing here comes from process output. */
export function renderLifecycleDiagnostic(diagnostic: LifecycleFailureDiagnostic): string {
  const lines = [
    `lifecycle diagnostic: ${diagnostic.class} (${diagnostic.complete ? "complete" : "incomplete"})`,
    `operation: ${diagnostic.operation}`,
    diagnostic.detail,
  ];
  if (diagnostic.exitCode !== undefined && diagnostic.exitCode !== null) lines.push(`exit code: ${diagnostic.exitCode}`);
  if (diagnostic.durationMs !== undefined) lines.push(`duration: ${Math.round(diagnostic.durationMs)}ms`);
  if (diagnostic.truncated === true) lines.push("the raw transcript was truncated at its byte limit");
  if (diagnostic.remedy !== undefined) lines.push(diagnostic.remedy);

  if (!diagnostic.rawLogAvailable) {
    lines.push("raw transcript: unavailable for this run");
  } else if (diagnostic.complete) {
    lines.push(`raw transcript (operator-local, not included): ${diagnostic.logId!}`);
  } else {
    lines.push(
      `raw transcript (operator-local): ${diagnostic.logId!} — NOT read automatically; ask the operator before inspecting it.`,
    );
  }
  return lines.join("\n");
}

const COMPLETE_CLASSES = new Set<LifecycleFailureClass>([
  "policy-denied",
  "cancelled",
  "timeout",
  "docker-daemon-unavailable",
  "devcontainer-cli-unavailable",
]);

function classify(input: LifecycleFailureInput): LifecycleFailureClass {
  const message = input.error instanceof Error ? input.error.message : typeof input.error === "string" ? input.error : "";

  // The hook envelope wins over the CLI's generic error kind: it is the one case where the CLI tells us the stage,
  // which is more useful than "the CLI failed".
  const hook = HOOK_FAILURE.exec(message);
  if (hook !== null) return hook[1]?.toLowerCase() === "start" ? "post-start-failed" : "post-create-failed";

  if (isRuntimeError(input.error)) {
    switch (input.error.kind) {
      case "policy-denied":
        return "policy-denied";
      case "cancelled":
        return "cancelled";
      case "timeout":
        return "timeout";
      case "daemon-unavailable":
        return "docker-daemon-unavailable";
      case "executable-missing":
      case "spawn-permission-denied":
        return "devcontainer-cli-unavailable";
      case "devcontainer-cli-failure":
      case "docker-cli-failure":
        return "lifecycle-command-failed";
      default:
        break;
    }
  }

  if (input.error === undefined) {
    if (input.exitCode === undefined || input.exitCode === 0) return "unclassified";
    // `setup` runs exactly ONE fixed argv, so a nonzero exit is always the install command itself; naming the
    // command is more useful than the generic class and cannot be wrong.
    return input.operation === "setup" ? "setup-install-failed" : "lifecycle-command-failed";
  }
  return "unclassified";
}

function wordingFor(klass: LifecycleFailureClass): { detail: string; remedy?: string } {
  switch (klass) {
    case "policy-denied":
      return {
        detail: "The lifecycle operation was refused by policy or by a declined confirmation, so no container work ran.",
        remedy: "Check the effective policy for this operation (destructive.allowStop / destructive.allowRemove) or approve the confirmation.",
      };
    case "cancelled":
      return { detail: "The lifecycle operation was cancelled before it finished.", remedy: "Re-run it when you are ready." };
    case "timeout":
      return {
        detail: "The lifecycle operation exceeded its configured timeout.",
        remedy: "Raise the timeout in the effective configuration, then re-run.",
      };
    case "docker-daemon-unavailable":
      return {
        detail: "The Docker daemon could not be reached.",
        remedy: "Start Docker (or fix DOCKER_HOST) and re-run.",
      };
    case "devcontainer-cli-unavailable":
      return {
        detail: "The Dev Containers CLI could not be started on the host.",
        remedy: "Run /devcontainer setup to install it, then re-run.",
      };
    case "post-create-failed":
      return {
        detail: "The container was created, but its configured postCreateCommand failed.",
        remedy: "The postCreateCommand in the devcontainer configuration is the failing stage; its output is in the raw transcript.",
      };
    case "post-start-failed":
      return {
        detail: "The container started, but its configured postStartCommand failed.",
        remedy: "The postStartCommand in the devcontainer configuration is the failing stage; its output is in the raw transcript.",
      };
    case "setup-install-failed":
      return {
        detail: "Installing the Dev Containers CLI with the fixed `npm install -g @devcontainers/cli` command failed.",
        remedy: "Check the registry/proxy configuration and network reachability, then re-run /devcontainer setup. npm's own output is in the raw transcript.",
      };
    case "lifecycle-command-failed":
      return {
        detail: "The lifecycle command exited non-zero.",
        remedy: "The raw transcript holds the command's own output.",
      };
    case "unclassified":
      return {
        detail: "The lifecycle operation failed with an error this extension cannot classify safely.",
        remedy: "The raw transcript holds the underlying output.",
      };
  }
}

function fileNameOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index === -1 ? path : path.slice(index + 1);
}
