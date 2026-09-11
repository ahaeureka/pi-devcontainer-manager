import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AuditConfig, DestructiveConfig, DiscoveryConfig, EffectiveConfig, HostExecutionConfig, ManagerConfig, RouteMode } from "./types.js";
import { CONFIG_VERSION } from "./types.js";

const ROUTE_MODES = new Set<RouteMode>(["container-required", "container-preferred", "host-only"]);
const CAPTURE_MODES = new Set(["none", "fingerprint-only", "redacted-text"]);
const DEFAULT_EXCLUDED_DIRECTORIES = Object.freeze(["node_modules", ".git", ".pi", "dist", "build"]);

const DEFAULTS: EffectiveConfig = Object.freeze({
  version: CONFIG_VERSION,
  dockerPath: "docker",
  devcontainerPath: "devcontainer",
  routeMode: "container-required",
  allowedWorkspaceRoots: Object.freeze([]),
  environmentAllowlist: Object.freeze([]),
  maxTimeoutSeconds: 900,
  maxOutputBytes: 50 * 1024,
  discovery: Object.freeze({ maxDepth: 3, excludedDirectories: DEFAULT_EXCLUDED_DIRECTORIES }),
  audit: Object.freeze({ enabled: true, retentionDays: 90, commandCapture: "fingerprint-only" }),
  destructive: Object.freeze({ allowStop: false, allowRemove: false }),
  hostExecution: Object.freeze({ allow: false }),
});

export interface ConfigPaths {
  globalPath: string;
  projectPath: string;
}

export function defaultConfigPaths(cwd: string): ConfigPaths {
  return {
    globalPath: join(homedir(), ".pi", "agent", "extensions", "pi-devcontainer-manager.json"),
    projectPath: join(cwd, ".pi", "pi-devcontainer-manager.json"),
  };
}

export function loadConfig(
  paths: ConfigPaths,
  options: { projectTrusted: boolean; readFile?: (path: string) => string },
): EffectiveConfig {
  const read = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const global = readOptional(paths.globalPath, read);
  const project = options.projectTrusted ? readOptional(paths.projectPath, read) : {};
  return compileConfig(global, project);
}

export function compileConfig(
  global: ManagerConfig = {},
  project: ManagerConfig = {},
): EffectiveConfig {
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

  const maxTimeout = Math.min(
    project.maxTimeoutSeconds ?? global.maxTimeoutSeconds ?? DEFAULTS.maxTimeoutSeconds,
    global.maxTimeoutSeconds ?? DEFAULTS.maxTimeoutSeconds,
  );
  const maxOutput = Math.min(
    project.maxOutputBytes ?? global.maxOutputBytes ?? DEFAULTS.maxOutputBytes,
    global.maxOutputBytes ?? DEFAULTS.maxOutputBytes,
  );

  const discovery = mergeDiscovery(global.discovery, project.discovery);
  const audit = mergeAudit(global.audit, project.audit);
  const destructive = mergeDestructive(global.destructive, project.destructive);
  const hostExecution = mergeHostExecution(global.hostExecution, project.hostExecution);

  return freezeConfig({
    version: CONFIG_VERSION,
    dockerPath: project.dockerPath ?? global.dockerPath ?? DEFAULTS.dockerPath,
    devcontainerPath: project.devcontainerPath ?? global.devcontainerPath ?? DEFAULTS.devcontainerPath,
    routeMode: project.routeMode ?? global.routeMode ?? DEFAULTS.routeMode,
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

function mergeDiscovery(
  global?: Partial<DiscoveryConfig>,
  project?: Partial<DiscoveryConfig>,
): DiscoveryConfig {
  const maxDepth = Math.min(
    project?.maxDepth ?? global?.maxDepth ?? DEFAULTS.discovery.maxDepth,
    global?.maxDepth ?? DEFAULTS.discovery.maxDepth,
  );
  const excluded = intersect(
    project?.excludedDirectories ?? global?.excludedDirectories ?? DEFAULTS.discovery.excludedDirectories,
    global?.excludedDirectories ?? DEFAULTS.discovery.excludedDirectories,
  );
  return { maxDepth, excludedDirectories: excluded };
}

function mergeAudit(global?: Partial<AuditConfig>, project?: Partial<AuditConfig>): AuditConfig {
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

function pickLowerCapture(requested: string, ceiling: string): "none" | "fingerprint-only" | "redacted-text" | undefined {
  const order: Array<"none" | "fingerprint-only" | "redacted-text"> = ["none", "fingerprint-only", "redacted-text"];
  const req = order.indexOf(requested as "none" | "fingerprint-only" | "redacted-text");
  const cap = order.indexOf(ceiling as "none" | "fingerprint-only" | "redacted-text");
  return order[Math.min(req, cap)];
}

function mergeDestructive(
  global?: Partial<DestructiveConfig>,
  project?: Partial<DestructiveConfig>,
): DestructiveConfig {
  const allowStop = (project?.allowStop === true && global?.allowStop === true) || (project?.allowStop === undefined && global?.allowStop === true) || (project?.allowStop === undefined && global?.allowStop === undefined && false);
  const allowRemove = (project?.allowRemove === true && global?.allowRemove === true) || (project?.allowRemove === undefined && global?.allowRemove === true) || (project?.allowRemove === undefined && global?.allowRemove === undefined && false);
  return { allowStop, allowRemove };
}

function mergeHostExecution(
  global?: Partial<HostExecutionConfig>,
  project?: Partial<HostExecutionConfig>,
): HostExecutionConfig {
  const allow = (project?.allow === true && global?.allow === true) || (project?.allow === undefined && global?.allow === true) || (project?.allow === undefined && global?.allow === undefined && false);
  return { allow };
}

function intersect(requested: readonly string[], ceiling: readonly string[]): string[] {
  return requested.filter((value) => ceiling.includes(value));
}

function readOptional(path: string, read: (path: string) => string): ManagerConfig {
  try {
    return JSON.parse(read(path)) as ManagerConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || !existsSync(path)) return {};
    throw new Error(`Invalid configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateConfig(config: ManagerConfig, source: string): void {
  if (config.version !== undefined && config.version !== CONFIG_VERSION) {
    throw new Error(`${source} configuration version must be ${CONFIG_VERSION}`);
  }
  if (config.routeMode !== undefined && !ROUTE_MODES.has(config.routeMode)) {
    throw new Error(`${source} configuration has an invalid routeMode`);
  }
  if (config.routeMode !== undefined && config.routeMode !== "container-required") {
    throw new Error(
      `${source} configuration routeMode '${config.routeMode}' is not implemented; only "container-required" is supported in v1`,
    );
  }
  for (const [name, value] of [["allowedWorkspaceRoots", config.allowedWorkspaceRoots], ["environmentAllowlist", config.environmentAllowlist]] as const) {
    if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0))) {
      throw new Error(`${source} configuration ${name} must be a non-empty string array`);
    }
  }
  for (const [name, value] of [["maxTimeoutSeconds", config.maxTimeoutSeconds], ["maxOutputBytes", config.maxOutputBytes]] as const) {
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
  if (
    config.discovery?.excludedDirectories !== undefined &&
    (!Array.isArray(config.discovery.excludedDirectories) ||
      config.discovery.excludedDirectories.some((item) => typeof item !== "string" || item.length === 0))
  ) {
    throw new Error(`${source} configuration discovery.excludedDirectories must be an array of non-empty strings`);
  }
  for (const [name, value] of [["dockerPath", config.dockerPath], ["devcontainerPath", config.devcontainerPath]] as const) {
    if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
      throw new Error(`${source} configuration ${name} must be a non-empty string`);
    }
  }
  for (const [name, value] of [
    ["destructive.allowStop", config.destructive?.allowStop],
    ["destructive.allowRemove", config.destructive?.allowRemove],
    ["hostExecution.allow", config.hostExecution?.allow],
  ] as const) {
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error(`${source} configuration ${name} must be a boolean`);
    }
  }
}

function freezeConfig(value: {
  version: typeof CONFIG_VERSION;
  dockerPath: string;
  devcontainerPath: string;
  routeMode: RouteMode;
  allowedWorkspaceRoots: readonly string[];
  environmentAllowlist: readonly string[];
  maxTimeoutSeconds: number;
  maxOutputBytes: number;
  discovery: DiscoveryConfig;
  audit: AuditConfig;
  destructive: DestructiveConfig;
  hostExecution: HostExecutionConfig;
}): EffectiveConfig {
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
