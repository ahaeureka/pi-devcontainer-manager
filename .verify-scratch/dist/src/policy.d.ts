import type { CommandCaptureMode, EffectiveConfig, OperationPolicySnapshot, PolicyInput } from "./types.js";
export declare function evaluatePolicy(config: EffectiveConfig, input: PolicyInput, now?: () => Date): OperationPolicySnapshot;
/**
 * Workspace containment, delegated to the single owner (review finding L5-01).
 *
 * The realpath-aware comparison and its fallback for a path that does not exist live in
 * `workspace-path.ts`; this function only applies it to the configured roots.
 */
export declare function isWorkspaceAllowed(workspace: string, roots: readonly string[]): boolean;
export declare function isEnvironmentAllowed(name: string, allowlist: readonly string[]): boolean;
export declare function buildChildEnvironment(requested: Readonly<Record<string, string>> | undefined, allowlist: readonly string[], baseline?: Readonly<Record<string, string | undefined>>): Record<string, string>;
export declare function commandFingerprint(parts: readonly string[]): string;
/**
 * Audit command identity for one invocation.
 *
 * Single-sourced so every audited surface (the extension's host-exec and setup paths, the
 * execution service, the extracted setup install) derives fingerprint/plaintext the same way:
 * `none` records nothing, `fingerprint-only` records the fingerprint, `redacted-text` also
 * records the joined command text (the audit writer redacts it on the way out).
 */
export declare function commandIdentity(parts: readonly string[], capture: CommandCaptureMode): {
    commandFingerprint?: string;
    commandText?: string;
};
export declare function redactText(text: string): string;
/**
 * Render an argv as the PROGRAM it names, for operator-facing text.
 *
 * This is the only thing the in-session visibility shows, so it is enforced here rather than assumed:
 * basename of `argv[0]`, redacted with the audit rules (a program name CAN be credential-shaped —
 * `argv[0]="Authorization: Bearer sk-live-…"` was reproduced by adversarial review), capped so a
 * pathological argument cannot flood the operator channel or the status block, and never blank.
 */
export declare function displayProgram(argv: readonly string[]): string;
//# sourceMappingURL=policy.d.ts.map