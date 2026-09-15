/**
 * Typed error kinds for process, capability, and domain failures.
 *
 * A nonzero exit from a successfully spawned target command is NOT an error:
 * it is carried back through `ProcessResult.exitCode` and recorded in
 * `AuditRecord.exitCode`, never thrown as a `RuntimeError`. Thrown errors are
 * reserved for failures to start, timeout, cancellation, and policy/domain
 * rejections.
 */
export type ErrorKind =
  | "executable-missing"
  | "spawn-permission-denied"
  | "daemon-unavailable"
  | "authorization-denied"
  | "devcontainer-cli-failure"
  | "docker-cli-failure"
  | "no-candidate"
  | "ambiguous-candidate"
  | "target-stopped"
  | "target-refreshing"
  | "policy-denied"
  | "timeout"
  | "cancelled"
  | "parse-failure"
  | "unexpected";

export interface RuntimeErrorOptions {
  readonly kind: ErrorKind;
  readonly message: string;
  readonly cause?: unknown;
  readonly remedy?: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
}

export class RuntimeError extends Error {
  public readonly kind: ErrorKind;
  public readonly cause?: unknown;
  public readonly remedy: string | undefined;
  public readonly exitCode: number | null | undefined;
  public readonly signal: string | null | undefined;

  public constructor(options: RuntimeErrorOptions) {
    super(options.message);
    this.name = "RuntimeError";
    this.kind = options.kind;
    this.cause = options.cause;
    this.remedy = options.remedy;
    this.exitCode = options.exitCode;
    this.signal = options.signal;
  }
}

export function isRuntimeError(error: unknown): error is RuntimeError {
  return error instanceof RuntimeError;
}

export function errorKindOf(error: unknown): ErrorKind {
  return isRuntimeError(error) ? error.kind : "unexpected";
}
