const SUPPORTED_PLATFORMS = new Set(["linux", "darwin"]);
export class NodeCapabilityService {
    runner;
    options;
    constructor(runner, options) {
        this.runner = runner;
        this.options = options;
    }
    async check() {
        const platform = this.options.platform ?? process.platform;
        const platformSupported = SUPPORTED_PLATFORMS.has(platform);
        const docker = await this.probeExecutable(this.options.dockerPath);
        const dockerDaemonReachable = docker.present ? await this.probeDaemon(this.options.dockerPath) : false;
        const devcontainer = await this.probeExecutable(this.options.devcontainerPath);
        return {
            platform,
            platformSupported,
            dockerExecutablePresent: docker.present,
            ...(docker.version !== undefined ? { dockerVersion: docker.version } : {}),
            dockerDaemonReachable,
            devcontainerExecutablePresent: devcontainer.present,
            ...(devcontainer.version !== undefined ? { devcontainerVersion: devcontainer.version } : {}),
        };
    }
    async diagnose() {
        const state = await this.check();
        if (!state.platformSupported) {
            return {
                kind: "unsupported-platform",
                message: `Platform ${state.platform} is not supported; Linux and macOS are required.`,
                capabilityState: state,
            };
        }
        if (!state.dockerExecutablePresent) {
            return {
                kind: "docker-executable-missing",
                message: `Docker executable '${this.options.dockerPath}' was not found.`,
                capabilityState: state,
            };
        }
        if (!state.dockerDaemonReachable) {
            return {
                kind: "docker-daemon-unreachable",
                message: "Docker daemon is not reachable (docker info failed).",
                capabilityState: state,
            };
        }
        if (!state.devcontainerExecutablePresent) {
            return {
                kind: "devcontainer-executable-missing",
                message: `Dev Containers CLI '${this.options.devcontainerPath}' was not found.`,
                capabilityState: state,
            };
        }
        return { kind: "ok", message: "All capabilities satisfied.", capabilityState: state };
    }
    async probeExecutable(path) {
        try {
            const result = await this.runner.exec(path, ["--version"], {
                cwd: process.cwd(),
                env: { PATH: process.env.PATH ?? "" },
            });
            if (result.exitCode === null)
                return { present: false };
            // The boundary captured the stream (L5-03): no callback, no hand-rolled collection.
            const version = (result.stdout ?? "").trim().split(/\s+/).pop();
            return version ? { present: true, version } : { present: true };
        }
        catch {
            return { present: false };
        }
    }
    async probeDaemon(path) {
        try {
            const result = await this.runner.exec(path, ["info"], {
                cwd: process.cwd(),
                env: { PATH: process.env.PATH ?? "" },
                timeoutMs: 10_000,
            });
            return result.exitCode === 0;
        }
        catch {
            return false;
        }
    }
}
//# sourceMappingURL=capabilities.js.map