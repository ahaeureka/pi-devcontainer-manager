/**
 * The audited host escape hatch shared by `devcontainer_host_exec` and `/devcontainer host-exec`.
 *
 * Host execution is granted by default and withheld by configuration, so everything that makes it
 * *governed* is the part that matters: the policy decision happens before any spawn, a refusal is
 * both typed and audited, an argv that targets a container-only path is refused before it can run on
 * the host, and every attempt — denial, failure, success — leaves a record under the same capture
 * policy as every other operation.
 *
 * This lives outside `extensions/index.ts` on purpose (the same move as `setup-cli.ts`): the facade
 * cannot be unit-tested, and these are exactly the properties a review has to be able to verify.
 */
import type { AuditRecord } from "./types.js";
import type { EffectiveConfig } from "./types.js";
import { type PathMapping } from "./path-mapper.js";
import type { ProcessRunner } from "./runtime/process-runner.js";
export interface AuditedHostRunResult {
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly truncated: boolean;
}
export interface AuditedHostRunnerDeps {
    readonly runner: ProcessRunner;
    readonly config: EffectiveConfig;
    readonly audit: {
        write(record: AuditRecord): void;
    };
    /** Host working directory for the spawned command. */
    readonly sessionWorkspace: string;
    /** Environment for the spawned process (composed by the caller, never the raw Pi env). */
    readonly env: Readonly<Record<string, string>>;
    /**
     * The selected workspace's host<->container mapping, or `undefined` when there is none.
     *
     * Injected because resolving it means reading a configuration off disk through the registry; the
     * runner only needs the answer. `undefined` means the container-path guard cannot run — the caller
     * is responsible for saying so, which it does through the discovery diagnostics.
     */
    readonly guardMappingFor: (workspaceKey: string) => Promise<PathMapping | undefined>;
    /** The workspace key of the CURRENT selection, or `undefined` when nothing is selected. */
    readonly targetStoreWorkspaceKey: () => string | undefined;
    /** Injectable clock for deterministic audit timestamps. */
    readonly clock?: () => string;
    /**
     * Session-scoped visibility for host runs (command-routing assessment section 4.1).
     *
     * The audit trail stays authoritative; this makes drift visible while it happens: every attempt is
     * counted, and the FIRST one of the session is reported through the operator UI.
     */
    readonly ledger?: {
        /** Counts the attempt and reports whether it is the session's first. */
        noteFirstRun(argv: readonly string[]): boolean;
    };
    /**
     * Called once per session with the REDACTED rendering of the first host attempt.
     *
     * Redaction happens here, not in the callback: the audit trail and the ledger both redact, and a
     * notice is the third rendering of the same argv — the boundary that already knows the rules is the
     * only place that can guarantee none of the three leaks (adversarial review of the routing
     * hardening found the notice emitting a bearer token verbatim).
     */
    readonly onFirstHostRun?: (rendered: string) => void;
}
/** The shape `CommandServices.hostRunner` expects. */
export interface AuditedHostRunner {
    run(argv: readonly string[], options?: {
        timeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<AuditedHostRunResult>;
}
export declare function createAuditedHostRunner(deps: AuditedHostRunnerDeps): AuditedHostRunner;
//# sourceMappingURL=host-runner.d.ts.map