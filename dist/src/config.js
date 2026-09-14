import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CONFIG_VERSION } from "./types.js";
const ROUTE_MODES = new Set(["container-required", "container-preferred", "host-only"]);
const CAPTURE_MODES = new Set(["none", "fingerprint-only", "redacted-text"]);
const DEFAULT_EXCLUDED_DIRECTORIES = Object.freeze(["node_modules", ".git", ".pi", "dist", "build"]);
const DEFAULTS = Object.freeze({
    version: CONFIG_VERSION,
    dockerPath: "docker",
    devcontainerPath: "devcontainer",
    routeMode: "container-required",
    activation: "workspace",
    allowedWorkspaceRoots: Object.freeze([]),
    environmentAllowlist: Object.freeze([]),
    maxTimeoutSeconds: 900,
    maxOutputBytes: 50 * 1024,
    discovery: Object.freeze({ maxDepth: 3, excludedDirectories: DEFAULT_EXCLUDED_DIRECTORIES }),
    audit: Object.freeze({ enabled: true, retentionDays: 90, commandCapture: "fingerprint-only" }),
    destructive: Object.freeze({ allowStop: false, allowRemove: false }),
    hostExecution: Object.freeze({ allow: false }),
});
/**
 * Pi's config directory. `PI_CODING_AGENT_DIR` overrides the default
 * `~/.pi/agent` (Pi's `docs/environment-variables.md`), so a relocated agent
 * directory must move this extension's configuration file with it — otherwise a
 * config placed beside the extension auto-discovery folder is silently ignored
 * and the restrictive defaults apply instead.
 */
export function defaultAgentDirectory(env = process.env, home = homedir()) {
    const override = env.PI_CODING_AGENT_DIR;
    return override !== undefined && override.length > 0 ? override : join(home, ".pi", "agent");
}
export function defaultConfigPaths(cwd, env = process.env, home = homedir()) {
    return {
        globalPath: join(defaultAgentDirectory(env, home), "extensions", "pi-devcontainer-manager.json"),
        projectPath: join(cwd, ".pi", "pi-devcontainer-manager.json"),
    };
}
export function loadConfig(paths, options) {
    return loadConfigWithDiagnostics(paths, options).config;
}
/**
 * Like {@link loadConfig}, but also explains two outcomes an operator otherwise
 * cannot see (AC-7): a project file that is never read because the project is not
 * trusted by Pi, and a project value that a host-protective ceiling silently
 * clamped.
 */
export function loadConfigWithDiagnostics(paths, options) {
    const read = options.readFile ?? ((path) => readFileSync(path, "utf8"));
    const global = readOptional(paths.globalPath, read);
    const projectFileExists = canRead(paths.projectPath, read) || existsSync(paths.projectPath);
    const project = options.projectTrusted ? readOptional(paths.projectPath, read) : {};
    return {
        config: compileConfig(global, project),
        diagnostics: describeConfigDiagnostics(global, project, {
            projectTrusted: options.projectTrusted,
            projectPath: paths.projectPath,
            projectFileExists,
        }),
    };
}
/** Does the reader resolve this path? Existence must come from the same seam as
 * the content: with an injected reader the real filesystem is not the source of
 * truth. */
function canRead(path, read) {
    try {
        read(path);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Report configuration that cannot take effect. Narrowing at a ceiling is
 * intentional — the ceilings protect the host — but doing it silently is not.
 */
export function describeConfigDiagnostics(global, project, options) {
    const diagnostics = [];
    if (!options.projectTrusted && options.projectFileExists === true) {
        diagnostics.push(`project configuration at ${options.projectPath ?? "<project>"} is ignored: this project is not trusted by Pi`);
    }
    const widened = [];
    const globalRoots = global.allowedWorkspaceRoots ?? [];
    const projectRoots = project.allowedWorkspaceRoots ?? [];
    const rootsOutside = projectRoots.filter((root) => !globalRoots.includes(root));
    if (rootsOutside.length > 0) {
        widened.push({ key: "allowedWorkspaceRoots", requested: rootsOutside.join(", "), ceiling: globalRoots.join(", ") });
    }
    const globalEnv = global.environmentAllowlist ?? [];
    const projectEnv = project.environmentAllowlist ?? [];
    const envOutside = projectEnv.filter((name) => !globalEnv.includes(name));
    if (envOutside.length > 0) {
        widened.push({ key: "environmentAllowlist", requested: envOutside.join(", "), ceiling: globalEnv.join(", ") });
    }
    for (const key of ["maxTimeoutSeconds", "maxOutputBytes"]) {
        const requested = project[key];
        const ceiling = global[key];
        if (requested !== undefined && ceiling !== undefined && requested > ceiling) {
            widened.push({ key, requested: String(requested), ceiling: String(ceiling) });
        }
    }
    for (const entry of widened) {
        diagnostics.push(`project ${entry.key} requested ${entry.requested} but is clamped by the global ceiling ${entry.ceiling}`);
    }
    return diagnostics;
}
export function compileConfig(global = {}, project = {}) {
    validateConfig(global, "global");
    validateConfig(project, "project");
    const globalRoots = global.allowedWorkspaceRoots ?? DEFAULTS.allowedWorkspaceRoots;
    const projectRoots = project.allowedWorkspaceRoots === undefined
        ? globalRoots
        : intersect(project.allowedWorkspaceRoots, globalRoots);
    const globalEnv = global.environmentAllowlist ?? DEFAULTS.environmentAllowlist;
    const projectEnv = project.environmentAllowlist === undefined
        ? globalEnv
        : intersect(project.environmentAllowlist, globalEnv);
    const maxTimeout = Math.min(project.maxTimeoutSeconds ?? global.maxTimeoutSeconds ?? DEFAULTS.maxTimeoutSeconds, global.maxTimeoutSeconds ?? DEFAULTS.maxTimeoutSeconds);
    const maxOutput = Math.min(project.maxOutputBytes ?? global.maxOutputBytes ?? DEFAULTS.maxOutputBytes, global.maxOutputBytes ?? DEFAULTS.maxOutputBytes);
    const discovery = mergeDiscovery(global.discovery, project.discovery);
    const audit = mergeAudit(global.audit, project.audit);
    const destructive = mergeDestructive(global.destructive, project.destructive);
    const hostExecution = mergeHostExecution(global.hostExecution, project.hostExecution);
    return freezeConfig({
        version: CONFIG_VERSION,
        dockerPath: project.dockerPath ?? global.dockerPath ?? DEFAULTS.dockerPath,
        devcontainerPath: project.devcontainerPath ?? global.devcontainerPath ?? DEFAULTS.devcontainerPath,
        routeMode: project.routeMode ?? global.routeMode ?? DEFAULTS.routeMode,
        activation: project.activation ?? global.activation ?? DEFAULTS.activation,
        allowedWorkspaceRoots: projectRoots,
        environmentAllowlist: projectEnv,
        maxTimeoutSeconds: maxTimeout,
        maxOutputBytes: maxOutput,
        discovery,
        audit,
        destructive,
        hostExecution,
    });
}
function mergeDiscovery(global, project) {
    const maxDepth = Math.min(project?.maxDepth ?? global?.maxDepth ?? DEFAULTS.discovery.maxDepth, global?.maxDepth ?? DEFAULTS.discovery.maxDepth);
    const excluded = intersect(project?.excludedDirectories ?? global?.excludedDirectories ?? DEFAULTS.discovery.excludedDirectories, global?.excludedDirectories ?? DEFAULTS.discovery.excludedDirectories);
    return { maxDepth, excludedDirectories: excluded };
}
function mergeAudit(global, project) {
    const globalCeiling = global?.commandCapture ?? DEFAULTS.audit.commandCapture;
    const requested = project?.commandCapture ?? globalCeiling;
    const commandCapture = pickLowerCapture(requested, globalCeiling) ?? DEFAULTS.audit.commandCapture;
    return {
        enabled: project?.enabled === false ? false : global?.enabled ?? DEFAULTS.audit.enabled,
        ...(global?.directory !== undefined ? { directory: global.directory } : {}),
        retentionDays: Math.min(project?.retentionDays ?? global?.retentionDays ?? DEFAULTS.audit.retentionDays, global?.retentionDays ?? DEFAULTS.audit.retentionDays),
        commandCapture: commandCapture ?? DEFAULTS.audit.commandCapture,
    };
}
function pickLowerCapture(requested, ceiling) {
    const order = ["none", "fingerprint-only", "redacted-text"];
    const req = order.indexOf(requested);
    const cap = order.indexOf(ceiling);
    return order[Math.min(req, cap)];
}
function mergeDestructive(global, project) {
    const allowStop = (project?.allowStop === true && global?.allowStop === true) || (project?.allowStop === undefined && global?.allowStop === true) || (project?.allowStop === undefined && global?.allowStop === undefined && false);
    const allowRemove = (project?.allowRemove === true && global?.allowRemove === true) || (project?.allowRemove === undefined && global?.allowRemove === true) || (project?.allowRemove === undefined && global?.allowRemove === undefined && false);
    return { allowStop, allowRemove };
}
function mergeHostExecution(global, project) {
    const allow = (project?.allow === true && global?.allow === true) || (project?.allow === undefined && global?.allow === true) || (project?.allow === undefined && global?.allow === undefined && false);
    return { allow };
}
function intersect(requested, ceiling) {
    return requested.filter((value) => ceiling.includes(value));
}
function readOptional(path, read) {
    try {
        return JSON.parse(read(path));
    }
    catch (error) {
        if (error.code === "ENOENT" || !existsSync(path))
            return {};
        throw new Error(`Invalid configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function validateConfig(config, source) {
    if (config.version !== undefined && config.version !== CONFIG_VERSION) {
        throw new Error(`${source} configuration version must be ${CONFIG_VERSION}`);
    }
    if (config.routeMode !== undefined && !ROUTE_MODES.has(config.routeMode)) {
        throw new Error(`${source} configuration has an invalid routeMode`);
    }
    if (config.routeMode !== undefined && config.routeMode !== "container-required") {
        throw new Error(`${source} configuration routeMode '${config.routeMode}' is not implemented; only "container-required" is supported in v1`);
    }
    if (config.activation !== undefined && !["workspace", "always", "never"].includes(config.activation)) {
        throw new Error(`${source} configuration activation is invalid`);
    }
    for (const [name, value] of [["allowedWorkspaceRoots", config.allowedWorkspaceRoots], ["environmentAllowlist", config.environmentAllowlist]]) {
        if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0))) {
            throw new Error(`${source} configuration ${name} must be a non-empty string array`);
        }
    }
    for (const [name, value] of [["maxTimeoutSeconds", config.maxTimeoutSeconds], ["maxOutputBytes", config.maxOutputBytes]]) {
        if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
            throw new Error(`${source} configuration ${name} must be a positive finite number`);
        }
    }
    if (config.discovery?.maxDepth !== undefined && (!Number.isInteger(config.discovery.maxDepth) || config.discovery.maxDepth < 1)) {
        throw new Error(`${source} configuration discovery.maxDepth must be a positive integer`);
    }
    if (config.audit?.retentionDays !== undefined && (!Number.isFinite(config.audit.retentionDays) || config.audit.retentionDays < 1)) {
        throw new Error(`${source} configuration audit.retentionDays must be a positive number`);
    }
    if (config.audit?.commandCapture !== undefined && !CAPTURE_MODES.has(config.audit.commandCapture)) {
        throw new Error(`${source} configuration audit.commandCapture is invalid`);
    }
    if (config.audit?.enabled !== undefined && typeof config.audit.enabled !== "boolean") {
        throw new Error(`${source} configuration audit.enabled must be a boolean`);
    }
    if (config.audit?.directory !== undefined && (typeof config.audit.directory !== "string" || config.audit.directory.length === 0)) {
        throw new Error(`${source} configuration audit.directory must be a non-empty string`);
    }
    if (config.discovery?.excludedDirectories !== undefined &&
        (!Array.isArray(config.discovery.excludedDirectories) ||
            config.discovery.excludedDirectories.some((item) => typeof item !== "string" || item.length === 0))) {
        throw new Error(`${source} configuration discovery.excludedDirectories must be an array of non-empty strings`);
    }
    for (const [name, value] of [["dockerPath", config.dockerPath], ["devcontainerPath", config.devcontainerPath]]) {
        if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
            throw new Error(`${source} configuration ${name} must be a non-empty string`);
        }
    }
    for (const [name, value] of [
        ["destructive.allowStop", config.destructive?.allowStop],
        ["destructive.allowRemove", config.destructive?.allowRemove],
        ["hostExecution.allow", config.hostExecution?.allow],
    ]) {
        if (value !== undefined && typeof value !== "boolean") {
            throw new Error(`${source} configuration ${name} must be a boolean`);
        }
    }
}
function freezeConfig(value) {
    return Object.freeze({
        ...value,
        allowedWorkspaceRoots: Object.freeze([...value.allowedWorkspaceRoots].map((path) => resolve(path))),
        environmentAllowlist: Object.freeze([...value.environmentAllowlist]),
        discovery: Object.freeze({ ...value.discovery, excludedDirectories: Object.freeze([...value.discovery.excludedDirectories]) }),
        audit: Object.freeze({ ...value.audit }),
        destructive: Object.freeze({ ...value.destructive }),
        hostExecution: Object.freeze({ ...value.hostExecution }),
    });
}
//# sourceMappingURL=config.js.map