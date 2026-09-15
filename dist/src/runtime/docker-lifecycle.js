/**
 * Docker lifecycle adapter for bounded logs and confirmed stop/remove.
 *
 * Docker stop/remove are destructive and require BOTH a policy grant
 * (enforced by the execution service against the effective config) and a
 * fresh per-action confirmation token. This adapter enforces the second
 * half: the caller must present a confirmation that names the exact target
 * ID and action; noninteractive callers receive a typed
 * `confirmation-required` result and can never bypass the gate.
 *
 * Only read-only discovery/inspection and these two destructive primitives
 * exist here. The locked {@link DockerAdapter} deliberately has no mutation
 * surface; this module is the sole owner of stop/remove/logs.
 */
import { DEFAULT_MAX_OUTPUT_BYTES, LOGS_MAX_OUTPUT_BYTES, runBounded, } from "./process-runner.js";
import { dockerSpawnErrorSpec } from "./spawn-error.js";
import { RuntimeError } from "../errors.js";
export class NodeDockerLifecycleAdapter {
    runner;
    options;
    constructor(runner, options) {
        this.runner = runner;
        this.options = options;
    }
    async logs(id, options = {}) {
        if (id.length === 0) {
            throw new RuntimeError({
                kind: "no-candidate",
                message: "Cannot read logs for an empty container ID.",
            });
        }
        const tail = options.tail ?? 200;
        const chunks = [];
        const result = await runBounded(this.runner, this.options.dockerPath, ["logs", "--tail", String(tail), id], {
            cwd: this.options.cwd,
            env: this.options.env,
            maxOutputBytes: this.options.maxOutputBytes ?? LOGS_MAX_OUTPUT_BYTES,
            timeoutMs: 30_000,
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
            onData: (chunk) => chunks.push(chunk),
            spawnError: dockerSpawnErrorSpec(this.options.dockerPath),
        });
        return {
            exitCode: result.exitCode,
            output: Buffer.concat(chunks).toString("utf8"),
            truncated: result.truncated,
        };
    }
    async stop(container, confirmation) {
        return this.destructive("stop", container, confirmation, ["stop", container.id]);
    }
    async remove(container, confirmation) {
        return this.destructive("remove", container, confirmation, ["rm", "-f", container.id]);
    }
    async destructive(action, container, confirmation, argv) {
        if (!this.isFreshConfirmation(action, container.id, confirmation)) {
            return {
                status: "confirmation-required",
                action,
                containerId: container.id,
                containerName: container.name,
                instruction: `Type "confirm ${action} ${container.id.slice(0, 12)}" to proceed.`,
            };
        }
        const result = await runBounded(this.runner, this.options.dockerPath, [...argv], {
            cwd: this.options.cwd,
            env: this.options.env,
            maxOutputBytes: this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
            timeoutMs: 60_000,
            spawnError: dockerSpawnErrorSpec(this.options.dockerPath),
        });
        if (result.exitCode !== 0) {
            throw new RuntimeError({
                kind: "docker-cli-failure",
                message: `docker ${action} failed with exit ${result.exitCode}.`,
                exitCode: result.exitCode,
                remedy: "Check Docker daemon reachability and the container state.",
            });
        }
        return { status: "done", action, containerId: container.id };
    }
    /**
     * Confirmation must name the exact action and target ID. The token is
     * opaque to this adapter; freshness is a caller contract (the execution
     * service generates it interactively and never reuses it).
     */
    isFreshConfirmation(action, containerId, confirmation) {
        if (confirmation === undefined)
            return false;
        return (confirmation.action === action &&
            confirmation.containerId === containerId &&
            confirmation.token.length >= 1);
    }
}
//# sourceMappingURL=docker-lifecycle.js.map