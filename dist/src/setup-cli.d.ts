import type { AuditWriter } from "./audit.js";
import type { ProcessRunner } from "./runtime/process-runner.js";
import type { EffectiveConfig } from "./types.js";
import type { LifecycleLogWriter } from "./lifecycle-log.js";
export interface SetupCliDeps {
    readonly runner: ProcessRunner;
    readonly audit: AuditWriter;
    readonly config: EffectiveConfig;
    /** Host workspace the install runs from (the policy-scoped session workspace). */
    readonly sessionWorkspace: string;
    /** Private raw transcript writer for the fixed install and version-probe processes. */
    readonly lifecycleLogs?: LifecycleLogWriter;
    /** Minimal child environment; never the inherited Pi environment. */
    readonly env: Readonly<Record<string, string>>;
    /** ISO-8601 clock for audit timestamps. */
    readonly clock?: () => string;
}
export interface SetupCliResult {
    readonly installed: boolean;
    readonly version: string | undefined;
    readonly error?: string;
    /**
     * The safe failure packet (fixed class + bounded metadata) for the model.
     *
     * `error` still carries redacted npm text for the operator; the packet is what an agent can act on without
     * reading the raw transcript.
     */
    readonly diagnosis?: string;
}
export type SetupCli = (options?: {
    signal?: AbortSignal;
}) => Promise<SetupCliResult>;
export declare function createSetupCli(deps: SetupCliDeps): SetupCli;
//# sourceMappingURL=setup-cli.d.ts.map