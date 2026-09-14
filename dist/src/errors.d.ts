/**
 * Typed error kinds for process, capability, and domain failures.
 *
 * A nonzero exit from a successfully spawned target command is NOT an error:
 * it is carried back through `ProcessResult.exitCode` and recorded in
 * `AuditRecord.exitCode`, never thrown as a `RuntimeError`. Thrown errors are
 * reserved for failures to start, timeout, cancellation, and policy/domain
 * rejections.
 */
export type ErrorKind = "executable-missing" | "spawn-permission-denied" | "daemon-unavailable" | "authorization-denied" | "devcontainer-cli-failure" | "no-candidate" | "ambiguous-candidate" | "target-stopped" | "policy-denied" | "timeout" | "cancelled" | "parse-failure" | "unexpected";
export interface RuntimeErrorOptions {
    readonly kind: ErrorKind;
    readonly message: string;
    readonly cause?: unknown;
    readonly remedy?: string;
    readonly exitCode?: number | null;
    readonly signal?: string | null;
}
export declare class RuntimeError extends Error {
    readonly kind: ErrorKind;
    readonly cause?: unknown;
    readonly remedy: string | undefined;
    readonly exitCode: number | null | undefined;
    readonly signal: string | null | undefined;
    constructor(options: RuntimeErrorOptions);
}
export declare function isRuntimeError(error: unknown): error is RuntimeError;
export declare function errorKindOf(error: unknown): ErrorKind;
//# sourceMappingURL=errors.d.ts.map