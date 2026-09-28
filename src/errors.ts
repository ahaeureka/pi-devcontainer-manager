/**
 * Typed error kinds for process, capability, and domain failures.
 *
 * A nonzero exit from a successfully spawned target command is NOT an error:
 * it is carried back through `ProcessResult.exitCode` and recorded in
 * `AuditRecord.exitCode`, never thrown as a `RuntimeError`. Thrown errors are
 * reserved for failures to start, timeout, cancellation, and policy/domain
 * rejections.
 */
import type { LifecycleFailureDiagnostic } from "./lifecycle-diagnostics.js";

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
  /**
   * The safe, model-facing failure packet for a lifecycle operation.
   *
   * It exists because the raw lifecycle transcript is operator-only: the packet carries the fixed class, bounded
   * metadata, and the transcript's file name, and it never carries captured process text or a host path.
   */
  readonly diagnostic?: LifecycleFailureDiagnostic;
}

export class RuntimeError extends Error {
  public readonly kind: ErrorKind;
  public readonly cause?: unknown;
  public readonly remedy: string | undefined;
  public readonly exitCode: number | null | undefined;
  public readonly signal: string | null | undefined;
  public diagnostic: LifecycleFailureDiagnostic | undefined;


  public constructor(options: RuntimeErrorOptions) {
    super(options.message);
    this.name = "RuntimeError";
    this.kind = options.kind;
    this.cause = options.cause;
    this.remedy = options.remedy;
    this.exitCode = options.exitCode;
    this.signal = options.signal;
    this.diagnostic = options.diagnostic;
  }
}

export function isRuntimeError(error: unknown): error is RuntimeError {
  return error instanceof RuntimeError;
}

export function errorKindOf(error: unknown): ErrorKind {
  return isRuntimeError(error) ? error.kind : "unexpected";
}

/**
 * A lifecycle operation's own failure is the class the operator needs, not an inherited inner one.
 *
 * An EXPLICIT packet always wins over an inherited one: the same `RuntimeError` can cross several
 * lifecycle boundaries (setup runs the version probe through the shared runner), and the boundary where
 * the operation actually failed is the one that knows the staged cause.
 */
export function withLifecycleDiagnostic<T>(
  error: T,
  diagnostic: LifecycleFailureDiagnostic,
  options: { replace?: boolean } = {},
): T {
  if (error instanceof RuntimeError && (error.diagnostic === undefined || options.replace === true)) {
    error.diagnostic = diagnostic;
  }
  return error;
}
