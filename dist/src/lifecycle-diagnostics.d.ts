import type { LifecycleLogOperation } from "./lifecycle-log.js";
export type LifecycleFailureClass = "policy-denied" | "cancelled" | "timeout" | "docker-daemon-unavailable" | "devcontainer-cli-unavailable" | "post-create-failed" | "post-start-failed" | "setup-install-failed" | "lifecycle-command-failed" | "unclassified";
export interface LifecycleFailureDiagnostic {
    readonly operation: LifecycleLogOperation;
    readonly class: LifecycleFailureClass;
    /** True only when the class fully explains the failure, so no raw transcript is needed. */
    readonly complete: boolean;
    /** Fixed wording owned by this extension; never derived from process output. */
    readonly detail: string;
    readonly remedy?: string;
    readonly rawLogAvailable: boolean;
    /** The transcript's file name only — never its directory, which would disclose a host path. */
    readonly logId?: string;
    readonly exitCode?: number | null;
    readonly durationMs?: number;
    readonly truncated?: boolean;
}
export interface LifecycleFailureInput {
    readonly operation: LifecycleLogOperation;
    readonly error?: unknown;
    readonly exitCode?: number | null;
    readonly durationMs?: number;
    readonly truncated?: boolean;
    /** Metadata about the operator-local transcript; its contents are never read here. */
    readonly rawLog?: {
        readonly path?: string;
        readonly warning?: string;
    };
}
export declare function classifyLifecycleFailure(input: LifecycleFailureInput): LifecycleFailureDiagnostic;
/** Render the packet for the model. Fixed lines only; nothing here comes from process output. */
export declare function renderLifecycleDiagnostic(diagnostic: LifecycleFailureDiagnostic): string;
//# sourceMappingURL=lifecycle-diagnostics.d.ts.map