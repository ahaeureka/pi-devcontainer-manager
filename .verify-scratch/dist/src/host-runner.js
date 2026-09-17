import { evaluatePolicy } from "./policy.js";
import { commandIdentity } from "./policy.js";
import { RuntimeError } from "./errors.js";
import { findContainerPath } from "./path-mapper.js";
import { displayProgram } from "./policy.js";
export function createAuditedHostRunner(deps) {
    const now = deps.clock ?? (() => new Date().toISOString());
    const { config } = deps;
    /** Every record this surface writes shares this identity, so the trail stays queryable. */
    const record = (argv, fields) => ({
        version: 1,
        at: now(),
        operation: "host-exec",
        initiator: "host-escape",
        commandCapture: config.audit.commandCapture,
        ...commandIdentity(argv, config.audit.commandCapture),
        ...fields,
    });
    return {
        run: async (argv, options) => {
            if (argv.length === 0) {
                throw new RuntimeError({
                    kind: "no-candidate",
                    message: "Host execution requires at least one argv element.",
                    remedy: "Pass the command to run, for example `hostname`.",
                });
            }
            const note = () => {
                if (deps.ledger === undefined)
                    return;
                if (deps.ledger.noteFirstRun(argv)) {
                    // The program, not the command line: see the ledger's note (no rendered argv anywhere in the
                    // visibility). `displayProgram` is the enforced rendering, not an assumption about argv[0].
                    deps.onFirstHostRun?.(displayProgram(argv));
                }
            };
            const snapshot = evaluatePolicy(config, { operation: "host-exec", initiator: "host-escape" });
            if (!snapshot.authorized) {
                // A refusal is an attempt: it is recorded before it is reported, so an operator asking "why
                // did nothing happen" finds the answer in the same place as every other host run.
                deps.audit.write(record(argv, {
                    policyAuthorized: false,
                    ...(snapshot.denialReason !== undefined ? { policyDenialReason: snapshot.denialReason } : {}),
                    outputTruncated: false,
                }));
                note();
                throw new RuntimeError({
                    kind: "policy-denied",
                    message: "Host execution is disabled by policy.",
                    remedy: "This installation withholds host execution by configuration. Remove `hostExecution.allow: false` from the project file (`.pi/pi-devcontainer-manager.json`, which must be a trusted project) or from the global file, then run `/reload`.",
                });
            }
            // Layer-3 guard: refuse a host run of an argv that targets a container-only path. Reliable
            // because literal argv carries no shell syntax — this is the mis-route a classifier over shell
            // text could never catch safely. It covers BOTH host surfaces and, since the escape hatch is
            // now granted by default, it is the only thing standing between a container path and the host.
            const selection = deps.targetStoreWorkspaceKey();
            if (selection !== undefined) {
                // Resolving the mapping goes through the registry (a `docker ps`), which can FAIL — an
                // unreachable daemon is the escape hatch's own primary use case. A failure here must land on a
                // channel someone reads rather than escaping unaudited, exactly like the container-surface
                // guard (adversarial review of the routing hardening).
                let mapping;
                try {
                    mapping = await deps.guardMappingFor(selection);
                }
                catch (error) {
                    deps.audit.write(record(argv, {
                        policyAuthorized: true,
                        outputTruncated: false,
                        errorSummary: error instanceof Error ? error.message : String(error),
                    }));
                    note();
                    throw error;
                }
                // A mapping that keeps the path is not a mis-route: the same path exists on both sides (the mirror
                // mount idiom), exactly like the reverse guard's exemption (adversarial review).
                const sameSpot = (left, right) => left.replace(/\/+$/, "") === right.replace(/\/+$/, "");
                const violation = mapping !== undefined && !sameSpot(mapping.containerPath, mapping.hostPath)
                    ? findContainerPath(argv, mapping.containerPath)
                    : undefined;
                if (violation !== undefined) {
                    deps.audit.write(record(argv, {
                        policyAuthorized: false,
                        policyDenialReason: "container-path-on-host",
                        outputTruncated: false,
                    }));
                    note();
                    throw new RuntimeError({
                        kind: "policy-denied",
                        message: `Host command references container-only path ${violation}.`,
                        remedy: "Use devcontainer_exec or the bash tool for container paths; devcontainer_host_exec is for host paths.",
                    });
                }
            }
            const startedAt = process.hrtime.bigint();
            // Host execution is bounded by the same configured ceiling as the container path: an omitted
            // or zero timeout defaults to `maxTimeoutSeconds` and a requested one is clamped to it, so an
            // allowed host command can never run unbounded or exceed the operator's maximum.
            const ceilingMs = config.maxTimeoutSeconds * 1000;
            const requestedMs = options?.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
                ? options.timeoutMs
                : ceilingMs;
            const timeoutMs = Math.max(1, Math.min(requestedMs, ceilingMs));
            let result;
            try {
                result = await deps.runner.exec(argv[0], [...argv.slice(1)], {
                    cwd: deps.sessionWorkspace,
                    env: { ...deps.env },
                    maxOutputBytes: config.maxOutputBytes,
                    timeoutMs,
                    ...(options?.signal !== undefined ? { signal: options.signal } : {}),
                });
            }
            catch (error) {
                // A failed or timed-out host run is auditable too: the promise rejects before the success
                // record below, so the failure would otherwise leave no trace.
                deps.audit.write(record(argv, {
                    policyAuthorized: true,
                    durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
                    outputTruncated: false,
                    errorSummary: error instanceof Error ? error.message : String(error),
                }));
                note();
                throw error;
            }
            deps.audit.write(record(argv, {
                policyAuthorized: true,
                durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
                ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
                outputTruncated: result.truncated,
            }));
            note();
            return {
                exitCode: result.exitCode,
                signal: result.signal,
                // The boundary captured both streams because no callbacks were supplied (L5-03).
                stdout: result.stdout ?? "",
                stderr: result.stderr ?? "",
                truncated: result.truncated,
            };
        },
    };
}
//# sourceMappingURL=host-runner.js.map