import { RuntimeError } from "../errors.js";
/**
 * Forms the pinned CLI resolves on its own, in this order:
 * `.devcontainer/devcontainer.json`, then `.devcontainer.json` — verified with
 * `devcontainer read-configuration --workspace-folder <dir>` on 0.88.0. Every
 * other discovered form (a named `.devcontainer/<name>/devcontainer.json`, or the
 * legacy root `devcontainer.json`) is invisible to that lookup and must be handed
 * over with `--config`.
 */
const CLI_DEFAULT_CONFIG_KINDS = new Set([
    ".devcontainer/devcontainer.json",
    "root/.devcontainer.json",
]);
/** Whether a discovered configuration has to be passed to the CLI explicitly. */
export function needsExplicitConfig(kind) {
    return !CLI_DEFAULT_CONFIG_KINDS.has(kind);
}
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const CLI_TIMEOUT_MS = 300_000;
/** stderr markers the pinned CLI emits for structural (non-command) failures. */
const CONTAINER_NOT_FOUND = /Dev container not found\./;
const DAEMON_UNREACHABLE = /Cannot connect to the Docker daemon|docker: error during connect|Error response from daemon/i;
const CONTAINER_STOPPED = /is not running|not running/i;
export class NodeDevcontainerAdapter {
    runner;
    options;
    constructor(runner, options) {
        this.runner = runner;
        this.options = options;
    }
    async up(workspace, options = {}) {
        const args = ["up", "--workspace-folder", workspace];
        if (options.dockerPath !== undefined)
            args.push("--docker-path", options.dockerPath);
        if (options.configPath !== undefined)
            args.push("--config", options.configPath);
        const { result, stdout, stderr } = await this.runCli(args, options.signal);
        return this.parseUp(result, stdout, stderr);
    }
    async build(workspace, options = {}) {
        const args = ["build", "--workspace-folder", workspace];
        if (options.dockerPath !== undefined)
            args.push("--docker-path", options.dockerPath);
        if (options.noCache === true)
            args.push("--no-cache");
        if (options.imageName !== undefined)
            args.push("--image-name", options.imageName);
        if (options.configPath !== undefined)
            args.push("--config", options.configPath);
        const { result, stdout, stderr } = await this.runCli(args, options.signal);
        return this.parseBuild(result, stdout, stderr);
    }
    async exec(workspace, containerId, cmd, args, options = {}) {
        if (cmd.length === 0) {
            throw new RuntimeError({
                kind: "parse-failure",
                message: "devcontainer exec requires a non-empty command.",
            });
        }
        const argv = ["exec", "--workspace-folder", workspace, "--container-id", containerId];
        if (options.dockerPath !== undefined)
            argv.push("--docker-path", options.dockerPath);
        if (options.configPath !== undefined)
            argv.push("--config", options.configPath);
        const remoteEnv = options.remoteEnv ?? {};
        // CLI 0.88.0 accepts repeated `--remote-env name=value` flags: yargs
        // accumulates duplicate flags into an array and the CLI normalizes a single
        // value to a one-element array. Forward EVERY allowlisted variable; never
        // silently drop all but the first.
        for (const [name, value] of Object.entries(remoteEnv)) {
            argv.push("--remote-env", `${name}=${value}`);
        }
        argv.push("--", cmd, ...args);
        const chunks = [];
        const errChunks = [];
        try {
            const result = await this.runner.exec(this.options.devcontainerPath, argv, {
                cwd: this.options.cwd,
                env: { ...this.options.env },
                maxOutputBytes: this.options.limits?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
                timeoutMs: this.options.limits?.timeoutMs ?? CLI_TIMEOUT_MS,
                ...(options.signal !== undefined ? { signal: options.signal } : {}),
                onData: (chunk) => chunks.push(chunk),
                onStderr: (chunk) => errChunks.push(chunk),
            });
            const stdout = Buffer.concat(chunks).toString("utf8");
            const stderr = Buffer.concat(errChunks).toString("utf8");
            this.rejectStructuralFailure(result, stdout, stderr);
            return {
                exitCode: result.exitCode,
                signal: result.signal,
                durationMs: result.durationMs,
                truncated: result.truncated,
                stdout,
                stderr,
            };
        }
        catch (error) {
            this.rethrowMappedSpawnError(error);
        }
        throw new RuntimeError({ kind: "unexpected", message: "unreachable exec path" });
    }
    /** Shared argv runner for up/build/exec with error mapping. */
    async runCli(args, signal) {
        const chunks = [];
        const errChunks = [];
        try {
            const result = await this.runner.exec(this.options.devcontainerPath, [...args], {
                cwd: this.options.cwd,
                env: { ...this.options.env },
                maxOutputBytes: this.options.limits?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
                timeoutMs: this.options.limits?.timeoutMs ?? CLI_TIMEOUT_MS,
                ...(signal !== undefined ? { signal } : {}),
                onData: (chunk) => chunks.push(chunk),
                onStderr: (chunk) => errChunks.push(chunk),
            });
            return { result, stdout: Buffer.concat(chunks), stderr: Buffer.concat(errChunks) };
        }
        catch (error) {
            this.rethrowMappedSpawnError(error);
        }
        throw new RuntimeError({ kind: "unexpected", message: "unreachable runCli path" });
    }
    rethrowMappedSpawnError(error) {
        if (error instanceof RuntimeError && error.kind === "executable-missing") {
            throw new RuntimeError({
                kind: "devcontainer-cli-failure",
                message: `Dev Containers CLI '${this.options.devcontainerPath}' is unavailable.`,
                cause: error,
                remedy: "Install @devcontainers/cli or set devcontainerPath in configuration.",
            });
        }
        if (error instanceof RuntimeError && error.kind === "spawn-permission-denied") {
            throw new RuntimeError({
                kind: "authorization-denied",
                message: `Dev Containers CLI spawn was denied for '${this.options.devcontainerPath}'.`,
                cause: error,
                remedy: "Check operator privileges for the Dev Containers executable.",
            });
        }
        throw error;
    }
    parseUp(result, stdout, stderr) {
        if (result.exitCode !== 0) {
            // Prefer the CLI's structured JSON when it was emitted, else stderr markers.
            const parsed = this.tryParseJsonOutcome(stdout);
            if (parsed !== undefined) {
                if (parsed.outcome !== "success")
                    throw this.cliFailure(parsed, result, "devcontainer up");
            }
            else {
                throw this.failureFromStderr(result, stderr, "devcontainer up");
            }
        }
        else {
            const parsed = this.parseJsonOutcome(stdout, "devcontainer up");
            if (parsed.outcome !== "success")
                throw this.cliFailure(parsed, result, "devcontainer up");
            if (typeof parsed.containerId !== "string" || parsed.containerId.length === 0) {
                throw new RuntimeError({
                    kind: "parse-failure",
                    message: "devcontainer up succeeded without a containerId.",
                });
            }
            return {
                containerId: parsed.containerId,
                ...(typeof parsed.composeProjectName === "string" ? { composeProjectName: parsed.composeProjectName } : {}),
                ...(typeof parsed.remoteUser === "string" ? { remoteUser: parsed.remoteUser } : {}),
                ...(typeof parsed.remoteWorkspaceFolder === "string" ? { remoteWorkspaceFolder: parsed.remoteWorkspaceFolder } : {}),
            };
        }
        throw new RuntimeError({ kind: "unexpected", message: "unreachable parseUp path" });
    }
    parseBuild(result, stdout, stderr) {
        if (result.exitCode !== 0) {
            const parsed = this.tryParseJsonOutcome(stdout);
            if (parsed !== undefined) {
                if (parsed.outcome !== "success")
                    throw this.cliFailure(parsed, result, "devcontainer build");
            }
            else {
                throw this.failureFromStderr(result, stderr, "devcontainer build");
            }
        }
        else {
            const parsed = this.parseJsonOutcome(stdout, "devcontainer build");
            if (parsed.outcome !== "success")
                throw this.cliFailure(parsed, result, "devcontainer build");
            return {
                ...(typeof parsed.imageName === "string" ? { imageName: parsed.imageName } : {}),
            };
        }
        throw new RuntimeError({ kind: "unexpected", message: "unreachable parseBuild path" });
    }
    /** Structured failure: prefer the CLI's own `message`/`description` when present. */
    cliFailure(parsed, result, source) {
        const message = typeof parsed.message === "string" && parsed.message.length > 0 ? parsed.message : "unknown error";
        const description = typeof parsed.description === "string" && parsed.description.length > 0 ? `: ${parsed.description}` : "";
        return new RuntimeError({
            kind: "devcontainer-cli-failure",
            message: `${source} failed: ${message}${description}`,
            exitCode: result.exitCode,
            remedy: "Check the DevContainer configuration and Docker daemon state.",
        });
    }
    /** Parse the single JSON document the CLI writes to stdout (with trailing space). */
    parseJsonOutcome(stdout, source) {
        const text = stdout.toString("utf8").trim();
        try {
            const parsed = JSON.parse(text);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
                throw new Error("not an object");
            }
            return parsed;
        }
        catch (error) {
            throw new RuntimeError({
                kind: "parse-failure",
                message: `Unparseable ${source} stdout: ${text.slice(0, 120)}`,
                cause: error,
            });
        }
    }
    /** Best-effort parse for the nonzero-exit path; undefined when stdout is not JSON. */
    tryParseJsonOutcome(stdout) {
        const text = stdout.toString("utf8").trim();
        if (text.length === 0)
            return undefined;
        try {
            const parsed = JSON.parse(text);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
                return undefined;
            return parsed;
        }
        catch {
            return undefined;
        }
    }
    failureFromStderr(result, stderr, source) {
        const text = stderr.toString("utf8");
        if (CONTAINER_NOT_FOUND.test(text)) {
            return new RuntimeError({
                kind: "target-stopped",
                message: `${source} reported the dev container was not found.`,
                exitCode: result.exitCode,
                remedy: "Run devcontainer up to create the container first.",
            });
        }
        if (DAEMON_UNREACHABLE.test(text)) {
            return new RuntimeError({
                kind: "daemon-unavailable",
                message: `${source} could not reach the Docker daemon.`,
                exitCode: result.exitCode,
                remedy: "Check Docker daemon reachability.",
            });
        }
        return new RuntimeError({
            kind: "devcontainer-cli-failure",
            message: `${source} failed with exit ${result.exitCode}: ${text.slice(0, 200)}`,
            exitCode: result.exitCode,
            remedy: "Inspect the Dev Containers CLI output above.",
        });
    }
    /** Exec: throw typed structural failures; carry command exits in the result. */
    rejectStructuralFailure(result, stdout, stderr) {
        if (result.exitCode === 0)
            return;
        if (CONTAINER_NOT_FOUND.test(stderr)) {
            throw new RuntimeError({
                kind: "target-stopped",
                message: "devcontainer exec reported the dev container was not found.",
                exitCode: result.exitCode,
                remedy: "Run devcontainer up to create the container first.",
            });
        }
        if (DAEMON_UNREACHABLE.test(stderr)) {
            throw new RuntimeError({
                kind: "daemon-unavailable",
                message: "devcontainer exec could not reach the Docker daemon.",
                exitCode: result.exitCode,
                remedy: "Check Docker daemon reachability.",
            });
        }
        if (CONTAINER_STOPPED.test(stderr)) {
            throw new RuntimeError({
                kind: "target-stopped",
                message: "devcontainer exec target container is not running.",
                exitCode: result.exitCode,
                remedy: "Run devcontainer up to start the container.",
            });
        }
        // Any other nonzero exit is the container-side command's own exit code.
        void stdout;
    }
}
//# sourceMappingURL=devcontainer-adapter.js.map