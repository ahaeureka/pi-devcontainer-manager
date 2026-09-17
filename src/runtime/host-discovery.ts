import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  ConfigCandidate,
  ContainerState,
  DevcontainerConfigKind,
  DiscoveredProject,
  DiscoveryConfig,
  RegistryConfigEntry,
  RegistryEntry,
} from "../types.js";
import { isWithinWorkspace, resolveRealPath, uniqueWorkspaceKeys } from "../workspace-path.js";
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
  /**
   * Everything the scan could not do (unreadable directory, symlink escape, `maxDepth`
   * pruning, a Docker candidate without its `devcontainer.local_folder` label). Consumers must
   * surface these; a field nothing reads is not a diagnostic.
   */
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
  ".devcontainer/<name>/devcontainer.json": 1,
  "root/.devcontainer.json": 2,
  "root/devcontainer.json": 3,
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

/**
 * Cheap, cwd-anchored probe used by the activation decision: does this workspace
 * itself own a DevContainer configuration? Unlike {@link discoverHostConfigs} it
 * never scans a tree and never touches Docker — it only looks at the forms a
 * workspace can declare at its own root.
 */
export function workspaceHasConfig(workspace: string, traversal: DirectoryTraversal = nodeTraversal()): boolean {
  for (const name of ["devcontainer.json", ".devcontainer.json"]) {
    if (isExistingFile(join(workspace, name), traversal)) return true;
  }
  const dotDevcontainer = join(workspace, ".devcontainer");
  if (isExistingFile(join(dotDevcontainer, "devcontainer.json"), traversal)) return true;
  let entries: readonly string[];
  try {
    entries = traversal.readdir(dotDevcontainer);
  } catch {
    return false;
  }
  return entries.some(
    (entry) => !entry.startsWith(".") && isExistingFile(join(dotDevcontainer, entry, "devcontainer.json"), traversal),
  );
}

/** Classify a discovered configuration file path into its locked kind. */
export function kindFor(configPath: string): DevcontainerConfigKind {
  const parent = basename(dirname(configPath));
  if (parent === ".devcontainer") return ".devcontainer/devcontainer.json";
  if (basename(dirname(dirname(configPath))) === ".devcontainer") {
    return ".devcontainer/<name>/devcontainer.json";
  }
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
  if (basename(parent) === ".devcontainer") return dirname(parent);
  // Named configuration: `.devcontainer/<name>/devcontainer.json` belongs to the
  // folder that owns `.devcontainer/`, exactly like the unnamed form.
  if (basename(dirname(parent)) === ".devcontainer") return dirname(dirname(parent));
  return parent;
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
        // Named configurations: `.devcontainer/<name>/devcontainer.json` (one
        // level only). This is a first-class Dev Containers feature — the CLI
        // resolves it when given `--config`, and VS Code offers a picker.
        for (const entry of safeReaddir(full, traversal, diagnostics)) {
          if (entry.startsWith(".")) continue;
          const namedPath = join(full, entry, "devcontainer.json");
          if (isExistingFile(namedPath, traversal)) {
            found.push(toDiscoveredProject(namedPath, traversal));
          }
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
      if (!isWithinWorkspace(anchorRoot, traversal.realpath(full))) {
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

/** Read a directory for the `.devcontainer` sub-scan; failure is a diagnostic, not fatal. */
function safeReaddir(
  dir: string,
  traversal: DirectoryTraversal,
  diagnostics: string[],
): readonly string[] {
  try {
    return [...traversal.readdir(dir)].sort();
  } catch (error) {
    diagnostics.push(`cannot read directory ${dir}: ${errorMessage(error)}`);
    return [];
  }
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
 * Each entry's variant (`kind`) says what was found — `"config"` when the host owns a configuration
 * (with or without a labelled container), `"container-only"` when the workspace is known only through
 * a labelled container. `discoveredFrom` records HOW it was found and is informational: it carries no
 * state that `kind` does not already determine (review finding L4-04).
 *
 * - host + docker on the same key -> `kind: "config"`, `discoveredFrom: "both"`
 * - host only -> `kind: "config"`, `discoveredFrom: "host-config"`
 * - docker only -> `kind: "container-only"`, `discoveredFrom: "docker-label"` — no configuration path
 *   and no placeholder kind, because there is no configuration
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
    const candidate = { configPath: project.configPath, configKind: project.configKind };
    const existing = byKey.get(project.workspacePath);
    if (existing === undefined) {
      byKey.set(project.workspacePath, {
        kind: "config",
        workspacePath: project.workspacePath,
        discoveredFrom: "host-config",
        configCandidates: [candidate],
        primaryConfig: candidate,
        containerCandidates: [],
        ambiguous: false,
      });
      continue;
    }
    // A workspace can own several configurations: the CLI's default lookup plus
    // any number of named ones. Keep them all, ordered by lookup priority; the
    // primary is the highest-priority one and always a member of the collection.
    if (existing.kind !== "config") continue;
    const configCandidates = [...existing.configCandidates, candidate].sort(compareConfigCandidates);
    byKey.set(project.workspacePath, {
      ...existing,
      configCandidates,
      primaryConfig: configCandidates[0]!,
    });
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
  for (const [key, hostEntry] of byKey) {
    const dockerList = dockerByKey.get(key);
    if (dockerList === undefined || dockerList.length === 0) {
      entries.push(hostEntry);
      continue;
    }
    // Expose EVERY candidate, ordered RUNNING-FIRST by the sort below, and fail closed when more than one is
    // running so Docker's listing order never decides the target. (Docker does NOT reliably put the running
    // container first — assuming it did made a stopped container a workspace's primary candidate.)
    const candidates = dockerList
      .filter((c) => c.id !== "")
      .map((c) => ({
        id: c.id,
        state: mapContainerState(c.state) ?? ("unknown" as const),
        // Carried so the operator-facing container picker can name the image (AC-4).
        ...(c.image !== undefined && c.image.length > 0 ? { image: c.image } : {}),
      }))
      // The candidate ORDER is priority: the primary candidate is `containerCandidates[0]`, and `ambiguous`
      // only trips for more than one RUNNING container, so a stopped container listed first by Docker would
      // otherwise become the target of a workspace that has a running one (adversarial review).
      .sort((left, right) => Number(right.state === "running") - Number(left.state === "running"));
    const runningCount = candidates.filter((c) => c.state === "running").length;
    // `byKey` only ever holds host-config entries, so the variant is known here; `both` says the
    // containers were discovered alongside a configuration rather than instead of one.
    if (hostEntry.kind !== "config") continue; // `byKey` only ever holds host-config entries
    const configEntry: RegistryConfigEntry = { ...hostEntry, kind: "config", discoveredFrom: "both" };
    entries.push({ ...configEntry, containerCandidates: candidates, ambiguous: runningCount > 1 });
  }

  for (const [key, list] of dockerByKey) {
    if (byKey.has(key)) continue;
    // A labelled container with no host configuration: its own variant, so there is no configuration
    // path to invent and no placeholder kind to explain away (review finding L4-04).
    const candidates = list
      .filter((c) => c.id !== "")
      .map((c) => ({
        id: c.id,
        state: mapContainerState(c.state) ?? ("unknown" as const),
        // Carried so the operator-facing container picker can name the image (AC-4).
        ...(c.image !== undefined && c.image.length > 0 ? { image: c.image } : {}),
      }))
      // Running first, for the same reason as above.
      .sort((left, right) => Number(right.state === "running") - Number(left.state === "running"));
    if (candidates.length === 0) continue;
    entries.push({
      kind: "container-only",
      workspacePath: key,
      discoveredFrom: "docker-label",
      containerCandidates: candidates,
      ambiguous: candidates.filter((c) => c.state === "running").length > 1,
    });
  }

  entries.sort((a, b) => a.workspacePath.localeCompare(b.workspacePath));
  return { entries, diagnostics };
}

/** Deterministic candidate order: CLI lookup priority first, then path. */
function compareConfigCandidates(left: ConfigCandidate, right: ConfigCandidate): number {
  return kindPriority(left.configKind) - kindPriority(right.configKind) || left.configPath.localeCompare(right.configPath);
}

function kindPriority(kind: DevcontainerConfigKind): number {
  return KIND_PRIORITY[kind] ?? Number.MAX_SAFE_INTEGER;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
