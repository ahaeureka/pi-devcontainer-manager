import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AuditConfig, DestructiveConfig, DiscoveryConfig, EffectiveConfig, HostExecutionConfig, ManagerConfig, RouteMode } from "./types.js";
import { CONFIG_VERSION } from "./types.js";

const ROUTE_MODES = new Set<RouteMode>(["container-required", "container-preferred", "host-only"]);
const CAPTURE_MODES = new Set(["none", "fingerprint-only", "redacted-text"]);
const DEFAULT_EXCLUDED_DIRECTORIES = Object.freeze(["node_modules", ".git", ".pi", "dist", "build"]);

/** The shipped configuration values — the single source of truth the docs are checked against. */
export const DEFAULTS: EffectiveConfig = Object.freeze({
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
  /**
   * The shipped posture for the host escape hatch: GRANTED.
   *
   * `devcontainer_host_exec` and `/devcontainer host-exec` are audited, transported as literal argv
   * and gated on this value alone; the operator decides the posture, and a configuration can withhold
   * it from either layer (see `mergeHostExecution`). This is the single place the default lives —
   * `mergeHostExecution` reads it rather than hard-coding a fallback.
   */
  hostExecution: Object.freeze({ allow: true }),
});

export interface ConfigPaths {
  globalPath: string;
  projectPath: string;
}

/**
 * Pi's config directory. `PI_CODING_AGENT_DIR` overrides the default
 * `~/.pi/agent` (Pi's `docs/environment-variables.md`), so a relocated agent
 * directory must move this extension's configuration file with it — otherwise a
 * config placed beside the extension auto-discovery folder is silently ignored
 * and the restrictive defaults apply instead.
 */
export function defaultAgentDirectory(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  const override = env.PI_CODING_AGENT_DIR;
  return override !== undefined && override.length > 0 ? override : join(home, ".pi", "agent");
}

export function defaultConfigPaths(
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): ConfigPaths {
  return {
    globalPath: join(defaultAgentDirectory(env, home), "extensions", "pi-devcontainer-manager.json"),
    projectPath: join(cwd, ".pi", "pi-devcontainer-manager.json"),
  };
}

export function loadConfig(
  paths: ConfigPaths,
  options: { projectTrusted: boolean; readFile?: (path: string) => string },
): EffectiveConfig {
  return loadConfigWithDiagnostics(paths, options).config;
}

/**
 * Like {@link loadConfig}, but also explains two outcomes an operator otherwise
 * cannot see (AC-7): a project file that is never read because the project is not
 * trusted by Pi, and a project value that a host-protective ceiling silently
 * clamped.
 */

/**
 * Is this configuration layer's `hostExecution` unusable?
 *
 * Host execution is granted by DEFAULT, so a layer that is present but malformed must not silently
 * fall back to that default: "the operator wrote something we cannot read" is not the same statement
 * as "the operator did not speak". The caller withholds instead — the fail-closed direction for a
 * policy value — and reports a diagnostic so the file gets fixed.
 */
function hostExecutionUnusable(layer: unknown): boolean {
  if (typeof layer !== "object" || layer === null || Array.isArray(layer)) return true;
  const value = (layer as { hostExecution?: unknown }).hostExecution;
  if (value === undefined) return false;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return true;
  const allow = (value as { allow?: unknown }).allow;
  return allow !== undefined && allow !== null && typeof allow !== "boolean";
}

export function loadConfigWithDiagnostics(
  paths: ConfigPaths,
  options: { projectTrusted: boolean; readFile?: (path: string) => string },
): { config: EffectiveConfig; diagnostics: string[] } {
  const read = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const withheld: string[] = [];
  // A layer whose `hostExecution` cannot be read withholds host execution rather than inheriting the
  // granted default, and says why (see `hostExecutionUnusable`).
  const layer = (path: string, label: string): ManagerConfig => {
    const parsed = readOptional(path, read);
    if (!hostExecutionUnusable(parsed)) return parsed;
    withheld.push(
      `${label} configuration at ${path} does not declare a usable hostExecution block; host execution is withheld until it is fixed.`,
    );
    return { ...(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {}), hostExecution: { allow: false } };
  };
  const global = layer(paths.globalPath, "global");
  const projectFileExists = canRead(paths.projectPath, read) || existsSync(paths.projectPath);
  const project = options.projectTrusted ? layer(paths.projectPath, "project") : {};
  return {
    config: compileConfig(global, project),
    diagnostics: [
      ...withheld,
      ...describeConfigDiagnostics(global, project, {
        projectTrusted: options.projectTrusted,
        projectPath: paths.projectPath,
        projectFileExists,
      }),
    ],
  };
}

/** Does the reader resolve this path? Existence must come from the same seam as
 * the content: with an injected reader the real filesystem is not the source of
 * truth. */
function canRead(path: string, read: (path: string) => string): boolean {
  try {
    read(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Report configuration that cannot take effect. Narrowing at a ceiling is
 * intentional — the ceilings protect the host — but doing it silently is not.
 */
export function describeConfigDiagnostics(
  global: ManagerConfig,
  project: ManagerConfig,
  options: { projectTrusted: boolean; projectPath?: string; projectFileExists?: boolean },
): string[] {
  const diagnostics: string[] = [];
  if (!options.projectTrusted && options.projectFileExists === true) {
    diagnostics.push(
      `project configuration at ${options.projectPath ?? "<project>"} is ignored: this project is not trusted by Pi`,
    );
  }

  const widened: Array<{ key: string; requested: string; ceiling: string }> = [];
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
  for (const key of ["maxTimeoutSeconds", "maxOutputBytes"] as const) {
    const requested = project[key];
    const ceiling = global[key];
    if (requested !== undefined && ceiling !== undefined && requested > ceiling) {
      widened.push({ key, requested: String(requested), ceiling: String(ceiling) });
    }
  }
  for (const entry of widened) {
    diagnostics.push(
      `project ${entry.key} requested ${entry.requested} but is clamped by the global ceiling ${entry.ceiling}`,
    );
  }
  return diagnostics;
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
  // An explicit deny from EITHER layer wins: a project file may withhold host execution, and a global
  // file may withhold it even when a project asks for it. The shipped posture applies only when
  // neither layer speaks, so `DEFAULTS.hostExecution` stays the one place the default lives.
  if (project?.allow === false || global?.allow === false) return { allow: false };
  return { allow: project?.allow ?? global?.allow ?? DEFAULTS.hostExecution.allow };
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
  if (config.activation !== undefined && !["workspace", "always", "never"].includes(config.activation)) {
    throw new Error(`${source} configuration activation is invalid`);
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
  activation: EffectiveConfig["activation"];
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
