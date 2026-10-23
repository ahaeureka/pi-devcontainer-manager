import type { EffectiveConfig } from "./types.js";
import { NodeCapabilityService } from "./runtime/capabilities.js";
import { NodeDevcontainerAdapter } from "./runtime/devcontainer-adapter.js";
import { NodeDockerAdapter } from "./runtime/docker-adapter.js";
import { NodeDockerLifecycleAdapter } from "./runtime/docker-lifecycle.js";
import { NodeProcessRunner } from "./runtime/process-runner.js";
/**
 * The host-side adapters every entry point needs, composed once.
 *
 * Pi and DeepSeek Harness each wire their own surfaces (tools, commands, prompt), but they must not
 * compose the process runner, the environment, or the three CLI adapters differently: a divergence
 * there is invisible until one harness works and the other silently does not. This module is the one
 * definition of "what a host child sees and which binaries we call", shared by
 * `extensions/index.ts` (Pi) and `extensions/dsh/index.ts` (dsh).
 */
export interface HostRuntime {
    readonly runner: NodeProcessRunner;
    readonly env: Record<string, string>;
    readonly capabilities: NodeCapabilityService;
    readonly docker: NodeDockerAdapter;
    readonly devcontainer: NodeDevcontainerAdapter;
    readonly dockerLifecycle: NodeDockerLifecycleAdapter;
}
export interface HostRuntimeOptions {
    /** Working directory for the spawned CLIs. */
    readonly cwd: string;
}
export declare function composeHostRuntime(config: EffectiveConfig, options: HostRuntimeOptions): HostRuntime;
//# sourceMappingURL=runtime-composition.d.ts.map