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
        try {
            const result = await this.runner.exec(this.options.dockerPath, ["logs", "--tail", String(tail), id], {
                cwd: this.options.cwd,
                env: { ...this.options.env },
                maxOutputBytes: this.options.maxOutputBytes ?? 256 * 1024,
                timeoutMs: 30_000,
                ...(options.signal !== undefined ? { signal: options.signal } : {}),
                onData: (chunk) => chunks.push(chunk),
            });
            return {
                exitCode: result.exitCode,
                output: Buffer.concat(chunks).toString("utf8"),
                truncated: result.truncated,
            };
        }
        catch (error) {
            this.rethrowMapped(error);
        }
        throw new RuntimeError({ kind: "unexpected", message: "unreachable logs path" });
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
        try {
            const result = await this.runner.exec(this.options.dockerPath, [...argv], {
                cwd: this.options.cwd,
                env: { ...this.options.env },
                maxOutputBytes: this.options.maxOutputBytes ?? 64 * 1024,
                timeoutMs: 60_000,
            });
            if (result.exitCode !== 0) {
                throw new RuntimeError({
                    kind: "devcontainer-cli-failure",
                    message: `docker ${action} failed with exit ${result.exitCode}.`,
                    exitCode: result.exitCode,
                    remedy: "Check Docker daemon reachability and the container state.",
                });
            }
            return { status: "done", action, containerId: container.id };
        }
        catch (error) {
            this.rethrowMapped(error);
        }
        throw new RuntimeError({ kind: "unexpected", message: "unreachable destructive path" });
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
    rethrowMapped(error) {
        if (error instanceof RuntimeError && error.kind === "executable-missing") {
            throw new RuntimeError({
                kind: "daemon-unavailable",
                message: `Docker executable '${this.options.dockerPath}' is unavailable.`,
                cause: error,
                remedy: "Install Docker or set dockerPath in configuration.",
            });
        }
        if (error instanceof RuntimeError && error.kind === "spawn-permission-denied") {
            throw new RuntimeError({
                kind: "authorization-denied",
                message: `Docker spawn was denied for '${this.options.dockerPath}'.`,
                cause: error,
                remedy: "Check operator privileges for the Docker executable.",
            });
        }
        throw error;
    }
}
//# sourceMappingURL=docker-lifecycle.js.map