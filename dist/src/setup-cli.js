/**
 * `/devcontainer setup`: install (or upgrade) the Dev Containers CLI on the HOST.
 *
 * This is the extension's only host-side install capability. It is deliberately narrow: a
 * FIXED argv (`npm install -g @devcontainers/cli`), a bounded timeout, its own audit operation
 * (`setup`, independent of the host-execution policy that gates arbitrary host commands), and an
 * interactive confirmation owned by the command handler.
 *
 * It used to live as a closure inside `extensions/index.ts`, which made the failure path this
 * module exists for unreachable from a unit test: the install stage ran without a `try`/`catch`,
 * so a rejected spawn (npm missing, timeout, abort) escaped before the audit record was written
 * and reached the handler as an unnormalized error — while the version probe right below it was
 * already normalized. Both stages now share one contract: **one attempt = exactly one `setup`
 * audit record, and a structured result whatever fails.**
 */
import { commandIdentity, redactText } from "./policy.js";
/**
 * Fixed argv: this capability installs exactly one named package and never runs a
 * caller-supplied command, so it cannot be turned into a general host escape hatch.
 */
const SETUP_ARGV = ["npm", "install", "-g", "@devcontainers/cli"];
const INSTALL_TIMEOUT_MS = 300_000;
const PROBE_TIMEOUT_MS = 30_000;
const PROBE_MAX_OUTPUT_BYTES = 16 * 1024;
export function createSetupCli(deps) {
    const now = deps.clock ?? (() => new Date().toISOString());
    const identity = (argv) => commandIdentity(argv, deps.config.audit.commandCapture);
    /**
     * Write this attempt's single record and report whether the trail accepted it.
     *
     * A failing audit sink must not turn a reported setup failure into an unnormalized throw, and
     * it must not vanish either: the caller folds the returned note into the result it hands back.
     */
    const writeRecord = (argv, durationMs, exitCode, outputTruncated, errorSummary) => {
        const record = {
            version: 1,
            at: now(),
            operation: "setup",
            initiator: "slash-command",
            policyAuthorized: true,
            durationMs,
            exitCode,
            outputTruncated,
            commandCapture: deps.config.audit.commandCapture,
            ...identity(argv),
            ...(errorSummary !== undefined ? { errorSummary } : {}),
        };
        try {
            deps.audit.write(record);
            return undefined;
        }
        catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
    };
    /**
     * Compose the operator-visible failure text.
     *
     * `redactText` protects the returned string the same way it protects the audit copy: this value
     * is shown to the operator AND handed to the model as the command result, so unredacted npm
     * stderr could put a registry token into model context.
     */
    const failure = (reason, auditNote) => ({
        installed: false,
        version: undefined,
        error: redactText(auditNote === undefined ? reason : `${reason} (audit record not written: ${auditNote})`),
    });
    return async (options) => {
        const startedAt = process.hrtime.bigint();
        const elapsedMs = () => Number(process.hrtime.bigint() - startedAt) / 1e6;
        const stdoutChunks = [];
        const stderrChunks = [];
        const argv = [...SETUP_ARGV];
        let runResult;
        try {
            runResult = await deps.runner.exec(argv[0], argv.slice(1), {
                cwd: deps.sessionWorkspace,
                env: { ...deps.env },
                maxOutputBytes: deps.config.maxOutputBytes,
                timeoutMs: INSTALL_TIMEOUT_MS,
                ...(options?.signal !== undefined ? { signal: options.signal } : {}),
                onData: (chunk) => stdoutChunks.push(chunk),
                onStderr: (chunk) => stderrChunks.push(chunk),
            });
        }
        catch (error) {
            // A refused spawn is an attempt too. Record it (so the trail shows the failure) and answer
            // with the same structured shape a nonzero exit produces, instead of letting the error
            // escape past the audit and reach the handler unnormalized.
            const reason = error instanceof Error ? error.message : String(error);
            return failure(reason, writeRecord(argv, elapsedMs(), null, false, reason));
        }
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        if (runResult.exitCode !== 0) {
            // A signal-killed child resolves with `exitCode: null`, and `signal` is the only field that
            // says what happened — reporting it as "exited null" helped nobody.
            const reason = runResult.exitCode === null && runResult.signal !== null
                ? `npm install was killed by ${runResult.signal}${stderr.length > 0 ? `: ${stderr}` : ""}`
                : stderr || `npm install exited ${runResult.exitCode}`;
            return failure(reason, writeRecord(argv, elapsedMs(), runResult.exitCode, runResult.truncated, reason));
        }
        // Verify the freshly installed CLI is resolvable on PATH.
        const versionChunks = [];
        let reason;
        let version;
        try {
            const probe = await deps.runner.exec(deps.config.devcontainerPath, ["--version"], {
                cwd: deps.sessionWorkspace,
                env: { ...deps.env },
                maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
                timeoutMs: PROBE_TIMEOUT_MS,
                onData: (chunk) => versionChunks.push(chunk),
            });
            if (probe.exitCode === 0) {
                version = Buffer.concat(versionChunks).toString("utf8").trim().split(/\s+/).pop() || undefined;
            }
            else {
                reason = `npm install succeeded but \`${deps.config.devcontainerPath} --version\` failed (exit ${probe.exitCode}); check PATH.`;
            }
        }
        catch (error) {
            reason = `npm install succeeded but verifying the CLI failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        // One attempt, one record, written once the outcome is known: recording the install before the
        // verification used to leave a success-shaped record (`exitCode: 0`, no error summary) behind a
        // setup the operator was told had failed.
        const auditNote = writeRecord(argv, elapsedMs(), runResult.exitCode, runResult.truncated, reason);
        if (reason !== undefined)
            return { ...failure(reason, auditNote) };
        return {
            installed: true,
            version,
            ...(auditNote !== undefined ? { error: redactText(`audit record not written: ${auditNote}`) } : {}),
        };
    };
}
//# sourceMappingURL=setup-cli.js.map