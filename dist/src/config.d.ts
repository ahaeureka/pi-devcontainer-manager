import type { EffectiveConfig, ManagerConfig } from "./types.js";
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
export declare function defaultAgentDirectory(env?: Readonly<Record<string, string | undefined>>, home?: string): string;
export declare function defaultConfigPaths(cwd: string, env?: Readonly<Record<string, string | undefined>>, home?: string): ConfigPaths;
export declare function loadConfig(paths: ConfigPaths, options: {
    projectTrusted: boolean;
    readFile?: (path: string) => string;
}): EffectiveConfig;
/**
 * Like {@link loadConfig}, but also explains two outcomes an operator otherwise
 * cannot see (AC-7): a project file that is never read because the project is not
 * trusted by Pi, and a project value that a host-protective ceiling silently
 * clamped.
 */
export declare function loadConfigWithDiagnostics(paths: ConfigPaths, options: {
    projectTrusted: boolean;
    readFile?: (path: string) => string;
}): {
    config: EffectiveConfig;
    diagnostics: string[];
};
/**
 * Report configuration that cannot take effect. Narrowing at a ceiling is
 * intentional — the ceilings protect the host — but doing it silently is not.
 */
export declare function describeConfigDiagnostics(global: ManagerConfig, project: ManagerConfig, options: {
    projectTrusted: boolean;
    projectPath?: string;
    projectFileExists?: boolean;
}): string[];
export declare function compileConfig(global?: ManagerConfig, project?: ManagerConfig): EffectiveConfig;
//# sourceMappingURL=config.d.ts.map