import { ShellExecutor, } from "@deepseek-ai/dsh-shell";
import { executeWithTimeout } from "../../src/bash-router.js";
import { RuntimeError } from "../../src/errors.js";
import { shellForm } from "../../src/execution-service.js";
import { canonicalWorkspaceKey } from "../../src/workspace-path.js";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TIMEOUT_MS = 900_000;
const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024;
export class DevcontainerShellExecutor extends ShellExecutor {
    options;
    constructor(ctx, options) {
        super(ctx);
        this.options = options;
    }
    /** Fill the request's defaults and caps. Only `kill` deadlines are enforced; `none` arms nothing. */
    resolve(request) {
        const maxTimeoutMs = this.options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
        const requested = request.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const timeoutMs = Math.max(1, Math.min(Math.round(requested), maxTimeoutMs));
        const maxOutputBytes = this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
        const stdoutMaxBytes = Math.max(1, Math.min(request.stdoutMaxBytes ?? maxOutputBytes, maxOutputBytes));
        const workdir = this.hostWorkdir(request.workdir);
        return {
            command: request.command,
            workdir,
            timeoutMs,
            onExpiry: request.onExpiry ?? "kill",
            stdoutMaxBytes,
            ...(request.signal !== undefined ? { signal: request.signal } : {}),
            ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
            ...(request.env !== undefined ? { env: request.env } : {}),
            ...(request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {}),
            sandboxPolicy: request.sandboxPolicy,
        };
    }
    async execute(spec) {
        const shell = shellForm(spec.command);
        const explicitEnvironment = collectEnvironment(spec);
        const request = {
            operation: "routed-bash",
            initiator: "routed-bash",
            workspace: spec.workdir,
            cmd: shell.cmd,
            args: [...shell.args],
            ...(explicitEnvironment !== undefined ? { explicitEnvironment } : {}),
        };
        let outcome;
        let timedOut = false;
        let abortedFirst = false;
        try {
            outcome =
                spec.onExpiry === "none"
                    ? await this.options.execution.exec({ ...request, ...(spec.signal !== undefined ? { signal: spec.signal } : {}) })
                    : await executeWithTimeout(request, spec.timeoutMs, spec.signal, (execRequest) => this.options.execution.exec(execRequest));
        }
        catch (error) {
            if (error instanceof RuntimeError && error.kind === "timeout") {
                timedOut = true;
            }
            else if (spec.signal?.aborted === true) {
                // A cancellation is not an infrastructure failure: dsh expects a settled, classified result.
                abortedFirst = true;
            }
            else {
                // Policy denials, a missing/ambiguous target, an unusable CLI — all preparation failures.
                // dsh's contract lets `execute()` throw for these, and pretending otherwise would hide the
                // refusal inside a tool result.
                throw error;
            }
        }
        const stdout = { text: outcome?.stdout ?? "", truncated: outcome?.truncated ?? false };
        const stderr = { text: outcome?.stderr ?? "", truncated: outcome?.truncated ?? false };
        const runResult = {
            exitCode: outcome?.exitCode ?? null,
            signal: (outcome?.signal ?? null),
            timedOut,
            aborted: abortedFirst && !timedOut,
            timeoutMs: spec.timeoutMs,
            stdout,
            stderr,
        };
        const killed = timedOut || abortedFirst || runResult.exitCode === null;
        return settledHandle(runResult, killed ? "killed" : "completed");
    }
    /**
     * The HOST working directory. `devcontainer exec` runs on the host and receives
     * `--workspace-folder <host path>`; the CLI maps the path itself, so a container path here would
     * name a directory that does not exist on this side.
     */
    hostWorkdir(workdir) {
        const candidate = workdir ?? this.options.workspace;
        if (!isAbsolutePath(candidate))
            return this.options.workspace;
        const key = canonicalWorkspaceKey(candidate);
        return key.length > 0 ? key : this.options.workspace;
    }
}
function isAbsolutePath(path) {
    return path.startsWith("/");
}
/**
 * Deliver the caller's declared environment verbatim.
 *
 * dsh's `env` carries entries a trusted in-process caller set for THIS command (hook bridges set
 * `CLAUDE_PROJECT_DIR`) and `dshEnv` carries harness-owned `DSH_*` facts. `buildChildEnvironment`'s
 * allowlist governs inherited ambient state, not these, so they travel on `explicitEnvironment`.
 */
function collectEnvironment(spec) {
    const merged = { ...(spec.env ?? {}), ...(spec.dshEnv ?? {}) };
    return Object.keys(merged).length > 0 ? merged : undefined;
}
/**
 * A handle for an execution that has already settled.
 *
 * `readOutput()` delivers the collected output exactly once (the contract is "output since the
 * previous read"), and the offset readers expose the same text without consuming it.
 */
function settledHandle(result, status) {
    let drained = false;
    const delta = result.stderr.text.length > 0
        ? `${result.stdout.text}\n[stderr]\n${result.stderr.text}`
        : result.stdout.text;
    return {
        status,
        exitCode: result.exitCode,
        signal: result.signal,
        done: Promise.resolve(),
        readOutput() {
            if (drained)
                return { delta: "", lossy: false };
            drained = true;
            if (!result.stdout.truncated && !result.stderr.truncated)
                return { delta, lossy: false };
            return {
                delta,
                lossy: true,
                ...(result.stdout.spillPath !== undefined ? { stdoutSpillPath: result.stdout.spillPath } : {}),
                ...(result.stderr.spillPath !== undefined ? { stderrSpillPath: result.stderr.spillPath } : {}),
            };
        },
        observed: {
            stdout: offsetReader(result.stdout.text),
            stderr: offsetReader(result.stderr.text),
        },
        kill: () => false,
        result: async () => result,
    };
}
/** A byte-offset reader over an already-collected stream. */
function offsetReader(text) {
    const bytes = Buffer.from(text, "utf8");
    return {
        readFrom(fromByte) {
            const from = Number.isFinite(fromByte) ? Math.max(0, Math.min(Math.trunc(fromByte), bytes.length)) : 0;
            return { text: bytes.subarray(from).toString("utf8"), nextOffset: bytes.length, lossy: false };
        },
    };
}
//# sourceMappingURL=executor.js.map