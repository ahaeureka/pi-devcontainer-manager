import { type ProcessRunner } from "./process-runner.js";
export interface DockerContainer {
    readonly id: string;
    readonly name: string;
    readonly state: string;
    readonly status: string;
    readonly image: string;
    readonly created: string;
    readonly labels: Readonly<Record<string, string>>;
    readonly localFolder?: string;
    readonly workspaceKey?: string;
}
export interface DockerDiscoveryResult {
    readonly containers: readonly DockerContainer[];
    readonly truncated: boolean;
    readonly errors: readonly string[];
}
export interface DockerInspectResult {
    readonly container: DockerContainer | undefined;
    readonly errors: readonly string[];
}
export interface DockerAdapter {
    /** Read-only all-container discovery, filtering to DevContainer-labelled candidates. */
    listDevContainers(signal?: AbortSignal): Promise<DockerDiscoveryResult>;
    /** Read-only single-container inspection by full or prefix ID. */
    inspectContainer(id: string, signal?: AbortSignal): Promise<DockerInspectResult>;
}
/**
 * Adapter over the host Docker CLI for read-only discovery and inspection.
 * Every invocation uses fixed argv (no shell), the injected runner, and a
 * sanitized environment. No mutation commands exist on this adapter.
 */
export declare class NodeDockerAdapter implements DockerAdapter {
    private readonly runner;
    private readonly options;
    constructor(runner: ProcessRunner, options: {
        readonly dockerPath: string;
        readonly env: Readonly<Record<string, string>>;
        readonly cwd: string;
        readonly maxOutputBytes?: number;
    });
    listDevContainers(signal?: AbortSignal): Promise<DockerDiscoveryResult>;
    inspectContainer(id: string, signal?: AbortSignal): Promise<DockerInspectResult>;
    private safeRun;
    private parsePsAll;
    /** Parse one 7-line container record (one JSON string per field). */
    private pushPsContainer;
    private parseInspect;
}
//# sourceMappingURL=docker-adapter.d.ts.map