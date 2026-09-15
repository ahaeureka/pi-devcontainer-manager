/**
 * Shared spawn-error mapping for the runtime adapters.
 *
 * `NodeProcessRunner` classifies a failed spawn into the process-boundary kinds
 * (`executable-missing`, `spawn-permission-denied`). Each adapter used to
 * translate those into its own tool-specific kind with a private copy of the
 * same two-case branch, and the copies drifted: the Dev Containers adapter
 * reports a missing executable as `devcontainer-cli-failure` while the Docker
 * adapters report `daemon-unavailable`.
 *
 * `mapSpawnError` takes that per-tool decision as data. It returns an `Error`
 * rather than throwing, so a caller can write `throw mapSpawnError(error, spec)`
 * and delete the compile-time-only `unreachable` throw that used to follow every
 * `catch (error) { this.rethrowMapped(error); }` block. Errors that are not spawn
 * failures are returned unchanged, so nothing is swallowed.
 */
import { RuntimeError } from "../errors.js";

export interface SpawnErrorSpec {
  /** Kind reported when the executable itself is missing (tool-specific). */
  readonly missingKind: "daemon-unavailable" | "devcontainer-cli-failure";
  readonly missingMessage: string;
  readonly missingRemedy: string;
  readonly permissionMessage: string;
  readonly permissionRemedy: string;
}

export function mapSpawnError(error: unknown, spec: SpawnErrorSpec): Error {
  if (error instanceof RuntimeError) {
    if (error.kind === "executable-missing") {
      return new RuntimeError({
        kind: spec.missingKind,
        message: spec.missingMessage,
        cause: error,
        remedy: spec.missingRemedy,
      });
    }
    if (error.kind === "spawn-permission-denied") {
      return new RuntimeError({
        kind: "authorization-denied",
        message: spec.permissionMessage,
        cause: error,
        remedy: spec.permissionRemedy,
      });
    }
    return error;
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Spawn-error spec for a Docker CLI invocation: a missing executable is a daemon
 * availability problem rather than a Docker CLI problem.
 */
export function dockerSpawnErrorSpec(dockerPath: string): SpawnErrorSpec {
  return {
    missingKind: "daemon-unavailable",
    missingMessage: `Docker executable '${dockerPath}' is unavailable.`,
    missingRemedy: "Install Docker or set dockerPath in configuration.",
    permissionMessage: `Docker spawn was denied for '${dockerPath}'.`,
    permissionRemedy: "Check operator privileges for the Docker executable.",
  };
}

/**
 * Spawn-error spec for a Dev Containers CLI invocation. A missing executable is
 * reported as `devcontainer-cli-failure` so the remedy points at the CLI package
 * instead of at Docker.
 */
export function devcontainerSpawnErrorSpec(devcontainerPath: string): SpawnErrorSpec {
  return {
    missingKind: "devcontainer-cli-failure",
    missingMessage: `Dev Containers CLI '${devcontainerPath}' is unavailable.`,
    missingRemedy: "Install @devcontainers/cli or set devcontainerPath in configuration.",
    permissionMessage: `Dev Containers CLI spawn was denied for '${devcontainerPath}'.`,
    permissionRemedy: "Check operator privileges for the Dev Containers executable.",
  };
}
