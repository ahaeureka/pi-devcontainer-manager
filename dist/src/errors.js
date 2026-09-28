export class RuntimeError extends Error {
    kind;
    cause;
    remedy;
    exitCode;
    signal;
    diagnostic;
    constructor(options) {
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
export function isRuntimeError(error) {
    return error instanceof RuntimeError;
}
export function errorKindOf(error) {
    return isRuntimeError(error) ? error.kind : "unexpected";
}
/**
 * A lifecycle operation's own failure is the class the operator needs, not an inherited inner one.
 *
 * An EXPLICIT packet always wins over an inherited one: the same `RuntimeError` can cross several
 * lifecycle boundaries (setup runs the version probe through the shared runner), and the boundary where
 * the operation actually failed is the one that knows the staged cause.
 */
export function withLifecycleDiagnostic(error, diagnostic, options = {}) {
    if (error instanceof RuntimeError && (error.diagnostic === undefined || options.replace === true)) {
        error.diagnostic = diagnostic;
    }
    return error;
}
//# sourceMappingURL=errors.js.map