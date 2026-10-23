import { composeHostEnvironment } from "./host-environment.js";
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

export function composeHostRuntime(config: EffectiveConfig, options: HostRuntimeOptions): HostRuntime {
  const runner = new NodeProcessRunner();
  const capabilities = new NodeCapabilityService(runner, {
    dockerPath: config.dockerPath,
    devcontainerPath: config.devcontainerPath,
  });
  // A failed probe is reported by the first operation that needs the capability; the eager check
  // only warms the answer and must never fail extension load.
  void capabilities.check().catch(() => undefined);

  // One definition of what a host child sees (`src/host-environment.ts`). It carries the executable
  // and cache basics plus the operator's proxy variables, which the CLI's own OCI Feature fetch needs
  // to reach the registry.
  const env = composeHostEnvironment(process.env);

  const docker = new NodeDockerAdapter(runner, {
    dockerPath: config.dockerPath,
    env,
    cwd: options.cwd,
    maxOutputBytes: config.maxOutputBytes,
  });
  const devcontainer = new NodeDevcontainerAdapter(runner, {
    devcontainerPath: config.devcontainerPath,
    env,
    cwd: options.cwd,
    limits: { maxOutputBytes: config.maxOutputBytes, timeoutMs: config.maxTimeoutSeconds * 1000 },
  });
  const dockerLifecycle = new NodeDockerLifecycleAdapter(runner, {
    dockerPath: config.dockerPath,
    env,
    cwd: options.cwd,
    maxOutputBytes: config.maxOutputBytes,
  });

  return { runner, env, capabilities, docker, devcontainer, dockerLifecycle };
}
