import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ContainerState, DevcontainerConfigKind, DiscoveredProject, DiscoveryConfig, RegistryEntry } from "../types.js";
import { isPathBelow, resolveRealPath, uniqueWorkspaceKeys } from "../workspace-path.js";
import type { DockerContainer } from "./docker-adapter.js";

/**
 * Bounded host-side DevContainer configuration discovery and workspace
 * registry merge.
 *
 * Discovery is demand-driven and read-only: it scans only the allowed
 * workspace roots (always including the session cwd), never descends into
 * excluded directories, and stops at `discovery.maxDepth`. Results are
 * merged with Docker label candidates into a single workspace registry
 * keyed by the canonicalized host workspace path so both sources unify
 * without duplicates. Config-only projects (never started) are first-class
 * entries; docker-only candidates are retained for diagnostics.
 *
 * All filesystem access goes through the injectable {@link DirectoryTraversal}
 * seam so tests can run against an in-memory tree without touching the real
 * filesystem.
 */

/** Injected seam for the minimal filesystem surface host discovery needs. */
export interface DirectoryTraversal {
  readdir(path: string): readonly string[];
  stat(path: string): { isDirectory(): boolean; isFile(): boolean };
  realpath(path: string): string;
}

export interface HostDiscoveryOptions {
  readonly sessionCwd: string;
  readonly allowedWorkspaceRoots: readonly string[];
  readonly discovery: Readonly<DiscoveryConfig>;
  readonly traversal?: DirectoryTraversal;
}

export interface DiscoveryInput {
  readonly options: HostDiscoveryOptions;
  readonly dockerCandidates: readonly DockerContainer[];
}

export interface RegistryResult {
  readonly entries: readonly RegistryEntry[];
  /** Workspace keys that have host configuration but no Docker candidate. */
  readonly configOnly: readonly string[];
  /** Docker candidates whose workspace has no host configuration, kept for diagnostics. */
  readonly orphanDockerCandidates: readonly DockerContainer[];
  readonly diagnostics: readonly string[];
}

export interface HostDiscoveryResult {
  readonly projects: readonly DiscoveredProject[];
  readonly diagnostics: readonly string[];
}

/**
 * Priority used only to pick a single entry when multiple configuration
 * forms exist for one workspace root. This is a design compatibility
 * decision for v1, not the Dev Containers spec lookup order.
 */
const KIND_PRIORITY: Readonly<Record<DevcontainerConfigKind, number>> = {
  ".devcontainer/devcontainer.json": 0,
  "root/.devcontainer.json": 1,
  "root/devcontainer.json": 2,
};

/** Production traversal backed by the synchronous `node:fs` surface. */
export function nodeTraversal(): DirectoryTraversal {
  return {
    readdir(path) {
      return readdirSync(path);
    },
    stat(path) {
      return statSync(path);
    },
    realpath: resolveRealPath,
  };
}

/**
 * Normalize a Docker container state string into the locked {@link ContainerState}.
 * Known states map directly; unknown or transient states (`restarting`, `dead`,
 * …) collapse to `"unknown"`; an empty/absent state maps to `undefined` so the
 * caller can omit the optional field entirely (compatible with
 * `exactOptionalPropertyTypes`).
 */
export function mapContainerState(state: string | undefined): ContainerState | undefined {
  if (state === undefined || state === "") return undefined;
  switch (state) {
    case "running":
    case "exited":
    case "created":
    case "paused":
      return state;
    default:
      return "unknown";
  }
}

/** Classify a discovered configuration file path into its locked kind. */
export function kindFor(configPath: string): DevcontainerConfigKind {
  if (basename(dirname(configPath)) === ".devcontainer") return ".devcontainer/devcontainer.json";
  if (basename(configPath) === ".devcontainer.json") return "root/.devcontainer.json";
  return "root/devcontainer.json";
}

/**
 * The workspace identity of a configuration file: `.devcontainer/devcontainer.json`
 * belongs to the parent of the `.devcontainer` directory; the other two forms
 * belong to their own directory.
 */
export function workspacePathFor(configPath: string): string {
  const parent = dirname(configPath);
  return basename(parent) === ".devcontainer" ? dirname(parent) : parent;
}

/**
 * Roots to scan: the session cwd is always included, then allowed roots.
 * Every root is realpath-normalized before deduplication so symlinked roots
 * collapse into the same real path used by Docker label discovery.
 */
export function workspaceRootsFor(
  sessionCwd: string,
  allowedWorkspaceRoots: readonly string[],
  realpath: (path: string) => string = resolveRealPath,
): string[] {
  const roots = [sessionCwd, ...allowedWorkspaceRoots].map(realpath);
  return uniqueWorkspaceKeys(roots);
}

/**
 * Scan every allowed workspace root for the three canonical DevContainer
 * configuration forms. Root is depth 0; directories are visited down to
 * `discovery.maxDepth` inclusive. Excluded and hidden directories are never
 * entered (`.devcontainer` is preserved), and each directory is enumerated in
 * sorted order for deterministic output.
 */
export function discoverHostConfigs(options: HostDiscoveryOptions): HostDiscoveryResult {
  const traversal = options.traversal ?? nodeTraversal();
  const roots = workspaceRootsFor(options.sessionCwd, options.allowedWorkspaceRoots, traversal.realpath);
  const projects: DiscoveredProject[] = [];
  const diagnostics: string[] = [];
  for (const root of roots) {
    walkDir(root, 0, root, options.discovery, traversal, projects, diagnostics);
  }
  return { projects, diagnostics };
}

function walkDir(
  dir: string,
  depth: number,
  anchorRoot: string,
  discovery: Readonly<DiscoveryConfig>,
  traversal: DirectoryTraversal,
  found: DiscoveredProject[],
  diagnostics: string[],
): void {
  let names: readonly string[];
  try {
    names = [...traversal.readdir(dir)].sort();
  } catch (error) {
    diagnostics.push(`cannot read directory ${dir}: ${errorMessage(error)}`);
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    let stats: { isDirectory(): boolean; isFile(): boolean };
    try {
      stats = traversal.stat(full);
    } catch (error) {
      diagnostics.push(`cannot stat ${full}: ${errorMessage(error)}`);
      continue;
    }
    if (stats.isDirectory()) {
      if (name === ".devcontainer") {
        const configPath = join(full, "devcontainer.json");
        if (isExistingFile(configPath, traversal)) {
          found.push(toDiscoveredProject(configPath, traversal));
        }
        continue; // never descend further into .devcontainer
      }
      if (name.startsWith(".")) continue; // hidden directories are skipped
      if (discovery.excludedDirectories.includes(name)) continue;
      if (depth >= discovery.maxDepth) {
        // Pruning actually happened: surface it once instead of silently stopping.
        diagnostics.push(`max depth ${discovery.maxDepth} reached; not traversing ${full}`);
        continue;
      }
      // A directory that resolves outside the anchoring workspace root
      // escapes the scan boundary (symlink escape); do not traverse it.
      if (!isPathBelow(traversal.realpath(full), anchorRoot)) {
        diagnostics.push(`not traversing ${full}: resolves outside allowed workspace root`);
        continue;
      }
      walkDir(full, depth + 1, anchorRoot, discovery, traversal, found, diagnostics);
    } else if (stats.isFile()) {
      if (name === "devcontainer.json" || name === ".devcontainer.json") {
        found.push(toDiscoveredProject(full, traversal));
      }
    }
  }
}

function toDiscoveredProject(configPath: string, traversal: DirectoryTraversal): DiscoveredProject {
  return {
    workspacePath: traversal.realpath(workspacePathFor(configPath)),
    configPath,
    configKind: kindFor(configPath),
  };
}

/** Existence probe for a nested config file; absence is the normal case, not a diagnostic. */
function isExistingFile(path: string, traversal: DirectoryTraversal): boolean {
  try {
    return traversal.stat(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Merge host configuration discoveries with Docker label candidates into a
 * single workspace registry keyed by the canonicalized real workspace path.
 *
 * - host + docker on the same key -> `"both"` with the first candidate's id/state
 * - host only -> `"host-config"` and listed in `configOnly`
 * - docker only -> `"docker-label"` placeholder retained with its full candidate
 *   in `orphanDockerCandidates` for diagnostics (the locked `RegistryEntry`
 *   requires `configPath`/`configKind`, so a placeholder kind is recorded;
 *   `discoveredFrom: "docker-label"` is the authoritative discriminator)
 * - a candidate without a `devcontainer.local_folder` label has no workspace
 *   identity and is never registered; a diagnostic is emitted instead
 */
export function buildWorkspaceRegistry(input: DiscoveryInput): RegistryResult {
  const options = input.options;
  const traversal = options.traversal ?? nodeTraversal();
  const { projects, diagnostics: scanDiagnostics } = discoverHostConfigs(options);
  const diagnostics: string[] = [...scanDiagnostics];

  const byKey = new Map<string, RegistryEntry>();
  for (const project of projects) {
    const existing = byKey.get(project.workspacePath);
    if (existing === undefined || kindPriority(project.configKind) < kindPriority(existing.configKind)) {
      byKey.set(project.workspacePath, {
        workspacePath: project.workspacePath,
        configPath: project.configPath,
        configKind: project.configKind,
        discoveredFrom: "host-config",
      });
    }
  }

  const dockerByKey = new Map<string, DockerContainer[]>();
  for (const candidate of input.dockerCandidates) {
    if (candidate.workspaceKey === undefined) {
      diagnostics.push(
        `docker candidate ${candidate.id} has no devcontainer.local_folder label; no workspace entry created`,
      );
      continue;
    }
    const key = traversal.realpath(candidate.workspaceKey);
    const list = dockerByKey.get(key);
    if (list === undefined) dockerByKey.set(key, [candidate]);
    else list.push(candidate);
  }

  const entries: RegistryEntry[] = [];
  const configOnly: string[] = [];
  for (const [key, hostEntry] of byKey) {
    const dockerList = dockerByKey.get(key);
    if (dockerList === undefined || dockerList.length === 0) {
      configOnly.push(key);
      entries.push(hostEntry);
      continue;
    }
    const first = dockerList[0];
    if (first === undefined) continue;
    entries.push({
      ...hostEntry,
      discoveredFrom: "both",
      ...(first.id !== "" ? { containerId: first.id } : {}),
      ...containerStateField(first.state),
    });
  }

  const orphanDockerCandidates: DockerContainer[] = [];
  for (const [key, list] of dockerByKey) {
    if (byKey.has(key)) continue;
    orphanDockerCandidates.push(...list);
    const first = list[0];
    if (first === undefined) continue;
    entries.push({
      workspacePath: key,
      // Placeholder: never read as a real configuration; docker-label is authoritative.
      configPath: "",
      configKind: "root/devcontainer.json",
      discoveredFrom: "docker-label",
      ...(first.id !== "" ? { containerId: first.id } : {}),
      ...containerStateField(first.state),
    });
  }

  entries.sort((a, b) => a.workspacePath.localeCompare(b.workspacePath));
  return { entries, configOnly, orphanDockerCandidates, diagnostics };
}

function kindPriority(kind: DevcontainerConfigKind): number {
  return KIND_PRIORITY[kind] ?? Number.MAX_SAFE_INTEGER;
}

/** Spread helper: omits `containerState` entirely when there is no state. */
function containerStateField(state: string | undefined): { containerState?: ContainerState } {
  const mapped = mapContainerState(state);
  return mapped === undefined ? {} : { containerState: mapped };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
