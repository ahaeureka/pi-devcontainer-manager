/**
 * Unit tests for the shared spawn-error mapper.
 *
 * The three runtime adapters used to carry their own copies of this mapping,
 * which had already drifted (the Dev Containers adapter reports a missing
 * executable as `devcontainer-cli-failure`, the Docker adapters as
 * `daemon-unavailable`). These tests pin the mapper's contract: the caller
 * supplies the per-tool kind, the cause survives, and unrelated errors are
 * passed through untouched so `throw mapSpawnError(error, spec)` can replace a
 * `catch` block without swallowing anything.
 */
import { describe, expect, it } from "vitest";
import { RuntimeError, errorKindOf } from "../../src/errors.js";
import {
  devcontainerSpawnErrorSpec,
  dockerSpawnErrorSpec,
  mapSpawnError,
  type SpawnErrorSpec,
} from "../../src/runtime/spawn-error.js";

const dockerSpec: SpawnErrorSpec = {
  missingKind: "daemon-unavailable",
  missingMessage: "Docker executable '/usr/bin/docker' is unavailable.",
  missingRemedy: "Install Docker or set dockerPath in configuration.",
  permissionMessage: "Docker spawn was denied for '/usr/bin/docker'.",
  permissionRemedy: "Check operator privileges for the Docker executable.",
};

const cliSpec: SpawnErrorSpec = {
  missingKind: "devcontainer-cli-failure",
  missingMessage: "Dev Containers CLI '/usr/bin/devcontainer' is unavailable.",
  missingRemedy: "Install @devcontainers/cli or set devcontainerPath in configuration.",
  permissionMessage: "Dev Containers CLI spawn was denied for '/usr/bin/devcontainer'.",
  permissionRemedy: "Check operator privileges for the Dev Containers executable.",
};

describe("mapSpawnError", () => {
  it("maps executable-missing to the caller's kind and preserves the cause", () => {
    const cause = new RuntimeError({ kind: "executable-missing", message: "spawn ENOENT" });
    const mapped = mapSpawnError(cause, dockerSpec);

    expect(mapped).toBeInstanceOf(RuntimeError);
    expect(errorKindOf(mapped)).toBe("daemon-unavailable");
    expect((mapped as RuntimeError).message).toBe(dockerSpec.missingMessage);
    expect((mapped as RuntimeError).remedy).toBe(dockerSpec.missingRemedy);
    expect((mapped as RuntimeError).cause).toBe(cause);
  });

  it("lets the Dev Containers adapter keep its own missing-executable kind", () => {
    const mapped = mapSpawnError(new RuntimeError({ kind: "executable-missing", message: "ENOENT" }), cliSpec);

    expect(errorKindOf(mapped)).toBe("devcontainer-cli-failure");
    expect((mapped as RuntimeError).message).toBe(cliSpec.missingMessage);
  });

  it("maps spawn-permission-denied to authorization-denied", () => {
    const cause = new RuntimeError({ kind: "spawn-permission-denied", message: "EACCES" });
    const mapped = mapSpawnError(cause, dockerSpec);

    expect(errorKindOf(mapped)).toBe("authorization-denied");
    expect((mapped as RuntimeError).message).toBe(dockerSpec.permissionMessage);
    expect((mapped as RuntimeError).remedy).toBe(dockerSpec.permissionRemedy);
    expect((mapped as RuntimeError).cause).toBe(cause);
  });

  it("returns errors that are not spawn failures unchanged", () => {
    const timeout = new RuntimeError({ kind: "timeout", message: "Process timed out after 30ms" });
    expect(mapSpawnError(timeout, dockerSpec)).toBe(timeout);

    const plain = new Error("boom");
    expect(mapSpawnError(plain, dockerSpec)).toBe(plain);
  });
});

describe("spawn error specs", () => {
  it("reports a missing docker executable as a daemon problem", () => {
    const spec = dockerSpawnErrorSpec("/usr/bin/docker");

    expect(spec.missingKind).toBe("daemon-unavailable");
    expect(spec.missingMessage).toBe("Docker executable '/usr/bin/docker' is unavailable.");
    expect(spec.missingRemedy).toBe("Install Docker or set dockerPath in configuration.");
    expect(spec.permissionMessage).toBe("Docker spawn was denied for '/usr/bin/docker'.");
    expect(spec.permissionRemedy).toBe("Check operator privileges for the Docker executable.");
  });

  it("reports a missing Dev Containers CLI executable as a CLI failure", () => {
    const spec = devcontainerSpawnErrorSpec("/usr/bin/devcontainer");

    expect(spec.missingKind).toBe("devcontainer-cli-failure");
    expect(spec.missingMessage).toBe("Dev Containers CLI '/usr/bin/devcontainer' is unavailable.");
    expect(spec.missingRemedy).toBe("Install @devcontainers/cli or set devcontainerPath in configuration.");
    expect(spec.permissionMessage).toBe("Dev Containers CLI spawn was denied for '/usr/bin/devcontainer'.");
    expect(spec.permissionRemedy).toBe("Check operator privileges for the Dev Containers executable.");
  });
});
