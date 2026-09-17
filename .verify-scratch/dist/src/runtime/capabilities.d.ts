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
export type CapabilityDiagnosticKind = "unsupported-platform" | "docker-executable-missing" | "docker-daemon-unreachable" | "devcontainer-executable-missing" | "ok";
export interface CapabilityDiagnostic {
    readonly kind: CapabilityDiagnosticKind;
    readonly message: string;
    readonly capabilityState?: CapabilityState;
}
export interface CapabilityService {
    check(): Promise<CapabilityState>;
    diagnose(): Promise<CapabilityDiagnostic>;
}
export declare class NodeCapabilityService implements CapabilityService {
    private readonly runner;
    private readonly options;
    constructor(runner: ProcessRunner, options: {
        readonly dockerPath: string;
        readonly devcontainerPath: string;
        readonly platform?: NodeJS.Platform;
    });
    check(): Promise<CapabilityState>;
    diagnose(): Promise<CapabilityDiagnostic>;
    private probeExecutable;
    private probeDaemon;
}
//# sourceMappingURL=capabilities.d.ts.map