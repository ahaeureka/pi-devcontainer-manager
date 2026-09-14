import type { EffectiveConfig, OperationPolicySnapshot, PolicyInput } from "./types.js";
export declare function evaluatePolicy(config: EffectiveConfig, input: PolicyInput, now?: () => Date): OperationPolicySnapshot;
/**
 * Filesystem-identity-aware workspace containment.
 *
 * Containment is checked on `realpath`-resolved paths, not lexical ones: a
 * symlink created beneath an allowed root that points outside it must not pass
 * (`/allowed/link -> /outside`). Paths that do not exist fall back to their
 * resolved lexical form so configuration/selection flows for not-yet-created
 * workspaces keep working; operations that require an existing workspace still
 * fail closed downstream when the path cannot be resolved by the CLI.
 */
export declare function isWorkspaceAllowed(workspace: string, roots: readonly string[]): boolean;
export declare function isEnvironmentAllowed(name: string, allowlist: readonly string[]): boolean;
export declare function buildChildEnvironment(requested: Readonly<Record<string, string>> | undefined, allowlist: readonly string[], baseline?: Readonly<Record<string, string | undefined>>): Record<string, string>;
export declare function commandFingerprint(parts: readonly string[]): string;
export declare function redactText(text: string): string;
//# sourceMappingURL=policy.d.ts.map