export interface SpawnErrorSpec {
    /** Kind reported when the executable itself is missing (tool-specific). */
    readonly missingKind: "daemon-unavailable" | "devcontainer-cli-failure";
    readonly missingMessage: string;
    readonly missingRemedy: string;
    readonly permissionMessage: string;
    readonly permissionRemedy: string;
}
export declare function mapSpawnError(error: unknown, spec: SpawnErrorSpec): Error;
/**
 * Spawn-error spec for a Docker CLI invocation: a missing executable is a daemon
 * availability problem rather than a Docker CLI problem.
 */
export declare function dockerSpawnErrorSpec(dockerPath: string): SpawnErrorSpec;
/**
 * Spawn-error spec for a Dev Containers CLI invocation. A missing executable is
 * reported as `devcontainer-cli-failure` so the remedy points at the CLI package
 * instead of at Docker.
 */
export declare function devcontainerSpawnErrorSpec(devcontainerPath: string): SpawnErrorSpec;
//# sourceMappingURL=spawn-error.d.ts.map