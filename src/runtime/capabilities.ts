import type { ProcessRunner } from "./process-runner.js";

export interface CapabilityState {
  readonly platform: NodeJS.Platform;
  readonly platformSupported: boolean;
  readonly dockerExecutablePresent: boolean;
  readonly dockerVersion?: string;
  readonly dockerDaemonReachable: boolean;
  readonly devcontainerExecutablePresent: boolean;
  readonly devcontainerVersion?: string;
}

export type CapabilityDiagnosticKind =
  | "unsupported-platform"
  | "docker-executable-missing"
  | "docker-daemon-unreachable"
  | "devcontainer-executable-missing"
  | "ok";

export interface CapabilityDiagnostic {
  readonly kind: CapabilityDiagnosticKind;
  readonly message: string;
  readonly capabilityState?: CapabilityState;
}

export interface CapabilityService {
  check(): Promise<CapabilityState>;
  diagnose(): Promise<CapabilityDiagnostic>;
}

const SUPPORTED_PLATFORMS: ReadonlySet<string> = new Set(["linux", "darwin"]);

export class NodeCapabilityService implements CapabilityService {
  public constructor(
    private readonly runner: ProcessRunner,
    private readonly options: {
      readonly dockerPath: string;
      readonly devcontainerPath: string;
      readonly platform?: NodeJS.Platform;
    },
  ) {}

  public async check(): Promise<CapabilityState> {
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

  public async diagnose(): Promise<CapabilityDiagnostic> {
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

  private async probeExecutable(path: string): Promise<{ present: boolean; version?: string }> {
    const stdout: Buffer[] = [];
    try {
      const result = await this.runner.exec(path, ["--version"], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        onData: (chunk) => stdout.push(chunk),
      });
      if (result.exitCode === null) return { present: false };
      const version = Buffer.concat(stdout).toString("utf8").trim().split(/\s+/).pop();
      return version ? { present: true, version } : { present: true };
    } catch {
      return { present: false };
    }
  }

  private async probeDaemon(path: string): Promise<boolean> {
    try {
      const result = await this.runner.exec(path, ["info"], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 10_000,
      });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }
}
