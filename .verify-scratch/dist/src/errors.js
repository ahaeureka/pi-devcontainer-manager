export class RuntimeError extends Error {
    kind;
    cause;
    remedy;
    exitCode;
    signal;
    constructor(options) {
        super(options.message);
        this.name = "RuntimeError";
        this.kind = options.kind;
        this.cause = options.cause;
        this.remedy = options.remedy;
        this.exitCode = options.exitCode;
        this.signal = options.signal;
    }
}
export function isRuntimeError(error) {
    return error instanceof RuntimeError;
}
export function errorKindOf(error) {
    return isRuntimeError(error) ? error.kind : "unexpected";
}
//# sourceMappingURL=errors.js.map