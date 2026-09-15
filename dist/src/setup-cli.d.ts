import type { AuditWriter } from "./audit.js";
import type { ProcessRunner } from "./runtime/process-runner.js";
import type { EffectiveConfig } from "./types.js";
export interface SetupCliDeps {
    readonly runner: ProcessRunner;
    readonly audit: AuditWriter;
    readonly config: EffectiveConfig;
    /** Host workspace the install runs from (the policy-scoped session workspace). */
    readonly sessionWorkspace: string;
    /** Minimal child environment; never the inherited Pi environment. */
    readonly env: Readonly<Record<string, string>>;
    /** ISO-8601 clock for audit timestamps. */
    readonly clock?: () => string;
}
export interface SetupCliResult {
    readonly installed: boolean;
    readonly version: string | undefined;
    readonly error?: string;
}
export type SetupCli = (options?: {
    signal?: AbortSignal;
}) => Promise<SetupCliResult>;
export declare function createSetupCli(deps: SetupCliDeps): SetupCli;
//# sourceMappingURL=setup-cli.d.ts.map