import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isWithinWorkspace, resolveRealPath, uniqueWorkspaceKeys } from "../workspace-path.js";
/**
 * Priority used only to pick a single entry when multiple configuration
 * forms exist for one workspace root. This is a design compatibility
 * decision for v1, not the Dev Containers spec lookup order.
 */
const KIND_PRIORITY = {
    ".devcontainer/devcontainer.json": 0,
    ".devcontainer/<name>/devcontainer.json": 1,
    "root/.devcontainer.json": 2,
    "root/devcontainer.json": 3,
};
/** Production traversal backed by the synchronous `node:fs` surface. */
export function nodeTraversal() {
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
export function mapContainerState(state) {
    if (state === undefined || state === "")
        return undefined;
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
export function workspaceHasConfig(workspace, traversal = nodeTraversal()) {
    for (const name of ["devcontainer.json", ".devcontainer.json"]) {
        if (isExistingFile(join(workspace, name), traversal))
            return true;
    }
    const dotDevcontainer = join(workspace, ".devcontainer");
    if (isExistingFile(join(dotDevcontainer, "devcontainer.json"), traversal))
        return true;
    let entries;
    try {
        entries = traversal.readdir(dotDevcontainer);
    }
    catch {
        return false;
    }
    return entries.some((entry) => !entry.startsWith(".") && isExistingFile(join(dotDevcontainer, entry, "devcontainer.json"), traversal));
}
/** Classify a discovered configuration file path into its locked kind. */
export function kindFor(configPath) {
    const parent = basename(dirname(configPath));
    if (parent === ".devcontainer")
        return ".devcontainer/devcontainer.json";
    if (basename(dirname(dirname(configPath))) === ".devcontainer") {
        return ".devcontainer/<name>/devcontainer.json";
    }
    if (basename(configPath) === ".devcontainer.json")
        return "root/.devcontainer.json";
    return "root/devcontainer.json";
}
/**
 * The workspace identity of a configuration file: `.devcontainer/devcontainer.json`
 * belongs to the parent of the `.devcontainer` directory; the other two forms
 * belong to their own directory.
 */
export function workspacePathFor(configPath) {
    const parent = dirname(configPath);
    if (basename(parent) === ".devcontainer")
        return dirname(parent);
    // Named configuration: `.devcontainer/<name>/devcontainer.json` belongs to the
    // folder that owns `.devcontainer/`, exactly like the unnamed form.
    if (basename(dirname(parent)) === ".devcontainer")
        return dirname(dirname(parent));
    return parent;
}
/**
 * Roots to scan: the session cwd is always included, then allowed roots.
 * Every root is realpath-normalized before deduplication so symlinked roots
 * collapse into the same real path used by Docker label discovery.
 */
export function workspaceRootsFor(sessionCwd, allowedWorkspaceRoots, realpath = resolveRealPath) {
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
export function discoverHostConfigs(options) {
    const traversal = options.traversal ?? nodeTraversal();
    const roots = workspaceRootsFor(options.sessionCwd, options.allowedWorkspaceRoots, traversal.realpath);
    const projects = [];
    const diagnostics = [];
    for (const root of roots) {
        walkDir(root, 0, root, options.discovery, traversal, projects, diagnostics);
    }
    return { projects, diagnostics };
}
function walkDir(dir, depth, anchorRoot, discovery, traversal, found, diagnostics) {
    let names;
    try {
        names = [...traversal.readdir(dir)].sort();
    }
    catch (error) {
        diagnostics.push(`cannot read directory ${dir}: ${errorMessage(error)}`);
        return;
    }
    for (const name of names) {
        const full = join(dir, name);
        let stats;
        try {
            stats = traversal.stat(full);
        }
        catch (error) {
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
                    if (entry.startsWith("."))
                        continue;
                    const namedPath = join(full, entry, "devcontainer.json");
                    if (isExistingFile(namedPath, traversal)) {
                        found.push(toDiscoveredProject(namedPath, traversal));
                    }
                }
                continue; // never descend further into .devcontainer
            }
            if (name.startsWith("."))
                continue; // hidden directories are skipped
            if (discovery.excludedDirectories.includes(name))
                continue;
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
        }
        else if (stats.isFile()) {
            if (name === "devcontainer.json" || name === ".devcontainer.json") {
                found.push(toDiscoveredProject(full, traversal));
            }
        }
    }
}
function toDiscoveredProject(configPath, traversal) {
    return {
        workspacePath: traversal.realpath(workspacePathFor(configPath)),
        configPath,
        configKind: kindFor(configPath),
    };
}
/** Read a directory for the `.devcontainer` sub-scan; failure is a diagnostic, not fatal. */
function safeReaddir(dir, traversal, diagnostics) {
    try {
        return [...traversal.readdir(dir)].sort();
    }
    catch (error) {
        diagnostics.push(`cannot read directory ${dir}: ${errorMessage(error)}`);
        return [];
    }
}
/** Existence probe for a nested config file; absence is the normal case, not a diagnostic. */
function isExistingFile(path, traversal) {
    try {
        return traversal.stat(path).isFile();
    }
    catch {
        return false;
    }
}
/**
 * Merge host configuration discoveries with Docker label candidates into a
 * single workspace registry keyed by the canonicalized real workspace path.
 *
 * - host + docker on the same key -> `"both"` with the first candidate's id/state
 * - host only -> `"host-config"`
 * - docker only -> `"docker-label"` placeholder retained with its full candidate
 *   list in `containerCandidates` (the locked `RegistryEntry`
 *   requires `configPath`/`configKind`, so a placeholder kind is recorded;
 *   `discoveredFrom: "docker-label"` is the authoritative discriminator)
 * - a candidate without a `devcontainer.local_folder` label has no workspace
 *   identity and is never registered; a diagnostic is emitted instead
 */
export function buildWorkspaceRegistry(input) {
    const options = input.options;
    const traversal = options.traversal ?? nodeTraversal();
    const { projects, diagnostics: scanDiagnostics } = discoverHostConfigs(options);
    const diagnostics = [...scanDiagnostics];
    const byKey = new Map();
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
        if (existing.kind !== "config")
            continue;
        const configCandidates = [...existing.configCandidates, candidate].sort(compareConfigCandidates);
        byKey.set(project.workspacePath, {
            ...existing,
            configCandidates,
            primaryConfig: configCandidates[0],
        });
    }
    const dockerByKey = new Map();
    for (const candidate of input.dockerCandidates) {
        if (candidate.workspaceKey === undefined) {
            diagnostics.push(`docker candidate ${candidate.id} has no devcontainer.local_folder label; no workspace entry created`);
            continue;
        }
        const key = traversal.realpath(candidate.workspaceKey);
        const list = dockerByKey.get(key);
        if (list === undefined)
            dockerByKey.set(key, [candidate]);
        else
            list.push(candidate);
    }
    const entries = [];
    for (const [key, hostEntry] of byKey) {
        const dockerList = dockerByKey.get(key);
        if (dockerList === undefined || dockerList.length === 0) {
            entries.push(hostEntry);
            continue;
        }
        // Expose EVERY candidate, ordered by Docker's own listing (which puts the running container
        // first), and fail closed when more than one is running so result order never decides the target.
        const candidates = dockerList
            .filter((c) => c.id !== "")
            .map((c) => ({ id: c.id, state: mapContainerState(c.state) ?? "unknown" }));
        const runningCount = candidates.filter((c) => c.state === "running").length;
        // `byKey` only ever holds host-config entries, so the variant is known here; `both` says the
        // containers were discovered alongside a configuration rather than instead of one.
        if (hostEntry.kind !== "config")
            continue; // `byKey` only ever holds host-config entries
        const configEntry = { ...hostEntry, kind: "config", discoveredFrom: "both" };
        entries.push({ ...configEntry, containerCandidates: candidates, ambiguous: runningCount > 1 });
    }
    for (const [key, list] of dockerByKey) {
        if (byKey.has(key))
            continue;
        // A labelled container with no host configuration: its own variant, so there is no configuration
        // path to invent and no placeholder kind to explain away (review finding L4-04).
        const candidates = list
            .filter((c) => c.id !== "")
            .map((c) => ({ id: c.id, state: mapContainerState(c.state) ?? "unknown" }));
        if (candidates.length === 0)
            continue;
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
function compareConfigCandidates(left, right) {
    return kindPriority(left.configKind) - kindPriority(right.configKind) || left.configPath.localeCompare(right.configPath);
}
function kindPriority(kind) {
    return KIND_PRIORITY[kind] ?? Number.MAX_SAFE_INTEGER;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=host-discovery.js.map