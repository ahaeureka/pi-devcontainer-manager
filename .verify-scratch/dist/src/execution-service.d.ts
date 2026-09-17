import type { AuditWriter } from "./audit.js";
import type { EffectiveConfig, Initiator, OperationKind } from "./types.js";
import type { TargetStore } from "./target-store.js";
import type { DevcontainerAdapter } from "./runtime/devcontainer-adapter.js";
import type { DockerLifecycleAdapter, LifecycleConfirmation, LifecycleResult } from "./runtime/docker-lifecycle.js";
import type { DockerContainer } from "./runtime/docker-adapter.js";
import { type HostToContainerMapping } from "./routing-guard.js";
export interface ExecRequest {
    readonly operation: "container-exec" | "routed-bash" | "user-bash";
    readonly initiator: Initiator;
    /** Host workspace path of the selected target (policy-scoped). */
    readonly workspace: string;
    /** argv form for `container-exec`; a shell `-lc` string for routed bash. */
    readonly cmd: string;
    readonly args: readonly string[];
    /** Approved environment variables already filtered by the caller. */
    readonly environment?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly onData?: (chunk: Buffer) => void;
    readonly onStderr?: (chunk: Buffer) => void;
}
export interface ExecOutcome {
    readonly operation: OperationKind;
    readonly workspaceKey: string;
    readonly candidateId: string;
    readonly candidateName: string;
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly durationMs: number;
    readonly truncated: boolean;
    readonly policyAuthorized: boolean;
    /** Bounded captured stdout from the container-side command. */
    readonly stdout: string;
    /** Bounded captured stderr from the container-side command. */
    readonly stderr: string;
}
export interface LifecycleRequest {
    readonly operation: "stop" | "remove";
    readonly initiator: Initiator;
    readonly workspace: string;
    readonly container: DockerContainer;
    readonly confirmation: LifecycleConfirmation | undefined;
}
export type LifecycleServiceResult = LifecycleResult;
export interface UpBuildRequest {
    readonly operation: "up" | "build";
    readonly initiator: Initiator;
    readonly workspace: string;
    readonly dockerPath?: string;
    /** Named configuration to start/build (`--config`); absent uses the CLI default. */
    readonly configPath?: string;
    readonly noCache?: boolean;
    readonly imageName?: string;
    readonly signal?: AbortSignal;
}
export interface UpBuildOutcome {
    readonly operation: "up" | "build";
    readonly workspaceKey: string;
    readonly candidateId?: string;
    readonly remoteUser?: string;
    readonly remoteWorkspaceFolder?: string;
    readonly imageName?: string;
    readonly policyAuthorized: boolean;
}
export interface ExecutionServiceOptions {
    readonly config: EffectiveConfig;
    readonly targetStore: TargetStore;
    readonly devcontainer: DevcontainerAdapter;
    /**
     * The selected workspace's host<->container mapping, when the configuration declares one.
     *
     * Injected because resolving it means reading a configuration off disk through the registry; used by
     * the REVERSE routing guard so a `devcontainer_exec` that names the HOST workspace path fails closed
     * instead of being reinterpreted inside the container.
     */
    readonly mappingFor?: (workspaceKey: string) => Promise<HostToContainerMapping | undefined>;
    readonly dockerLifecycle: DockerLifecycleAdapter;
    readonly audit: AuditWriter;
    /** ISO-8601 string clock for audit timestamps. */
    readonly clock?: () => string;
    /**
     * Optional hook to auto-select a default target when none is selected yet.
     * Called with the policy-scoped request workspace BEFORE `bind()` only when
     * the target store is in `none`. Wired by the extension to select the
     * session-cwd workspace when its realpath exactly matches a discovered
     * config-only/stopped/running project; a no-op elsewhere preserves the
     * fail-closed `no-candidate` behavior.
     */
    readonly autoSelect?: (workspace: string) => Promise<void>;
    /**
     * Optional resolver that maps a HOST workspace path to its in-container
     * path (from the workspace's devcontainer.json workspaceFolder/workspaceMount).
     * Used ONLY for presentation (the workspaceKey the agent sees); the Dev
     * Containers CLI still receives the host path, which it maps itself.
     * Returns undefined when no mapping exists (host path is shown unchanged).
     */
    readonly resolveContainerWorkspace?: (hostWorkspace: string) => Promise<string | undefined>;
    /**
     * Optional probe deciding whether a workspace is itself a DevContainer project.
     * Injected by tests; defaults to the filesystem probe. It only decides whether a
     * request from outside the bound target is allowed (AC-8).
     */
    readonly workspaceHasConfig?: (workspace: string) => boolean;
}
export declare class ExecutionService {
    private readonly options;
    private readonly clock;
    constructor(options: ExecutionServiceOptions);
    exec(request: ExecRequest): Promise<ExecOutcome>;
    up(request: UpBuildRequest): Promise<UpBuildOutcome>;
    build(request: UpBuildRequest): Promise<UpBuildOutcome>;
    lifecycle(request: LifecycleRequest): Promise<LifecycleServiceResult>;
    /**
     * Bounded container logs, routed through the shared service so the read is
     * policy-checked and audited like every other operation (it previously
     * bypassed both).
     */
    logs(request: {
        initiator: Initiator;
        workspace: string;
        containerId: string;
        tail?: number;
        signal?: AbortSignal;
    }): Promise<{
        exitCode: number | null;
        output: string;
        truncated: boolean;
    }>;
    /**
     * The container identity a `logs` or lifecycle request may act on.
     *
     * `exec` already refuses a request whose workspace differs from the bound target; `logs`, `stop`
     * and `remove` trusted a caller-supplied identity, never bound it, and recorded that value as the
     * audit target — so two surfaces of the same service held different invariants about whether the
     * operated container belonged to the authorized workspace (review finding L3-07). They now verify
     * the requested identity against the current SELECTION and return it, so every audit record below
     * writes the identity the service authorized rather than the one the caller supplied.
     *
     * The check deliberately does not route the bindable states through `bind()`: `bind()` refuses a
     * STOPPED target, and reading the logs of an exited container, stopping it, or removing it are
     * exactly what those operations are for. Only a selection that cannot name a container at all
     * (`none`, `refreshing`, `selected-ambiguous`, `selected-missing`, `selected-policy-denied`) is
     * delegated to the store, so the typed refusal is the store's own.
     */
    private bindContainer;
    /**
     * Frozen policy gate before target resolution or spawn.
     *
     * A DENIED attempt is itself an auditable event: policy probes (workspace,
     * environment, destructive, host-exec) are recorded before the typed error is
     * thrown, so denials are visible in the audit trail instead of silently
     * absent. Denied environment VALUES are never recorded.
     */
    private authorize;
    private audit;
    /** Is this workspace itself a DevContainer project? (injectable for tests) */
    private projectProbe;
    /**
     * What the record says about *where* the operation happened: the executed workspace
     * is the bound target, and the request's cwd is recorded alongside it when the caller
     * stood somewhere else. Without a bound context (pre-bind denials) the request's
     * workspace is all there is.
     */
    private workspaceIdentity;
    private commandIdentity;
    private asAuditError;
}
/** Convenience for building the shell form of a routed bash command. */
export declare function shellForm(cmd: string): {
    cmd: string;
    args: readonly string[];
};
//# sourceMappingURL=execution-service.d.ts.map