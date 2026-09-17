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
/**
 * Redact a command LINE that arrived as argv, without losing either idiom.
 *
 * Neither single pass is complete, which two adversarial passes established in sequence:
 *
 * - Redacting the JOINED line is what the audit trail does, and it is the only form that sees
 *   `--password s3cr3t` (rule 3 needs the flag and its value in one string).
 * - Redacting each ELEMENT first is the only form that sees an element that is entirely a scheme
 *   value (`"Bearer sk-live-…"`), because on the joined line the scheme word of the NEXT element can
 *   pair with a preceding value token and orphan that element's own value
 *   (`["curl","-H","Bearer","Bearer sk-live-T"]` → `curl -H Bearer sk-live-T` if only joined).
 *
 * So do both, in that order: element-wise first (which cannot introduce a leak, only remove tokens),
 * then the joined result. The second pass can only redact more, never less.
 */
export declare function redactCommandLine(argv: readonly string[]): string;
export declare function redactText(text: string): string;
//# sourceMappingURL=policy.d.ts.map