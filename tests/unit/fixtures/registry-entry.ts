/**
 * Fixtures for the `RegistryEntry` discriminated union.
 *
 * The union is the point (review finding L4-04): a test that builds the shape by hand burns its
 * reader's attention on fields the test does not care about, and every future field addition edits
 * dozens of literals. These factories build the two variants with sensible defaults, so a test states
 * only the facts it asserts.
 */
import type {
  ConfigCandidate,
  ContainerState,
  DevcontainerConfigKind,
  RegistryCandidate,
  RegistryConfigEntry,
  RegistryContainerOnlyEntry,
} from "../../../src/types.js";

/** One container candidate; most tests only care about the id and whether it runs. */
export function candidate(id: string, state: ContainerState = "running"): RegistryCandidate {
  return { id, state };
}

export function configCandidate(
  configPath: string,
  configKind: DevcontainerConfigKind = ".devcontainer/devcontainer.json",
): ConfigCandidate {
  return { configPath, configKind };
}

/**
 * A workspace with a configuration.
 *
 * `configPath` defaults to the folder form under the workspace; pass `configCandidates` (with
 * `primaryIndex` if needed) for a workspace with several configurations.
 */
export function configEntry(input: {
  workspacePath: string;
  configPath?: string;
  configKind?: DevcontainerConfigKind;
  configCandidates?: readonly ConfigCandidate[];
  primaryIndex?: number;
  containers?: readonly RegistryCandidate[];
  ambiguous?: boolean;
  discoveredFrom?: "host-config" | "both";
}): RegistryConfigEntry {
  const configCandidates =
    input.configCandidates ?? [configCandidate(input.configPath ?? `${input.workspacePath}/.devcontainer/devcontainer.json`, input.configKind)];
  const primaryConfig = configCandidates[input.primaryIndex ?? 0]!;
  const containers = input.containers ?? [];
  return {
    kind: "config",
    workspacePath: input.workspacePath,
    discoveredFrom: input.discoveredFrom ?? (containers.length > 0 ? "both" : "host-config"),
    configCandidates,
    primaryConfig,
    containerCandidates: containers,
    ambiguous: input.ambiguous ?? containers.filter((c) => c.state === "running").length > 1,
  };
}

/** A workspace known only through a labelled container (no configuration on the host). */
export function containerOnlyEntry(input: {
  workspacePath: string;
  containers: readonly RegistryCandidate[];
  ambiguous?: boolean;
}): RegistryContainerOnlyEntry {
  return {
    kind: "container-only",
    workspacePath: input.workspacePath,
    discoveredFrom: "docker-label",
    containerCandidates: input.containers,
    ambiguous: input.ambiguous ?? input.containers.filter((c) => c.state === "running").length > 1,
  };
}
