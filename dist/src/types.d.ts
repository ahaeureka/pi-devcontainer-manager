export declare const CONFIG_VERSION: 1;
export type RouteMode = "container-required" | "container-preferred" | "host-only";
export type CommandCaptureMode = "none" | "fingerprint-only" | "redacted-text";
export type OperationKind = "discover" | "status" | "logs" | "up" | "build" | "container-exec" | "routed-bash" | "user-bash" | "host-exec" | "stop" | "remove" | "setup";
export type Initiator = "tool" | "slash-command" | "routed-bash" | "user-bash" | "host-escape";
export type ContainerState = "running" | "exited" | "created" | "paused" | "unknown";
export type DevcontainerConfigKind = "root/devcontainer.json" | "root/.devcontainer.json" | ".devcontainer/devcontainer.json" | ".devcontainer/<name>/devcontainer.json";
export interface DiscoveredProject {
    readonly workspacePath: string;
    readonly configPath: string;
    readonly configKind: DevcontainerConfigKind;
}
/** One discovered DevContainer configuration for a workspace. */
export interface ConfigCandidate {
    readonly configPath: string;
    readonly configKind: DevcontainerConfigKind;
}
/**
 * One container discovered for a workspace.
 *
 * The collection's ORDER is the priority: `containerCandidates[0]` is the primary target. There is
 * deliberately no separate `containerId`/`containerState` pair on the entry — that pair could
 * disagree with this collection, which is exactly what review finding L4-04 found consumers
 * reconstructing by hand.
 */
export interface RegistryCandidate {
    readonly id: string;
    readonly state: ContainerState;
    /**
     * The container's image, when discovery saw it.
     *
     * Optional because a candidate can come from a source that does not report one (a managed container
     * listing); the operator-facing container picker prefers it when present.
     */
    readonly image?: string;
}
/** What every registry entry has, whatever was discovered for it. */
interface RegistryEntryBase {
    readonly workspacePath: string;
    /** Every container discovered, most-preferred first. Empty when only a configuration exists. */
    readonly containerCandidates: readonly RegistryCandidate[];
    /**
     * True when MORE THAN ONE running container matches this workspace. Such a target must never be
     * auto-selected by Docker result order; the operator picks an explicit candidate id.
     */
    readonly ambiguous: boolean;
}
/** A configuration was discovered on the host (with or without a labelled container). */
export interface RegistryConfigEntry extends RegistryEntryBase {
    readonly kind: "config";
    readonly discoveredFrom: "host-config" | "both";
    /** EVERY configuration discovered for this workspace (never collapsed away). */
    readonly configCandidates: readonly ConfigCandidate[];
    /** The configuration discovery selected; always a member of `configCandidates`. */
    readonly primaryConfig: ConfigCandidate;
}
/** No configuration exists: the workspace is known only through a labelled container. */
export interface RegistryContainerOnlyEntry extends RegistryEntryBase {
    readonly kind: "container-only";
    readonly discoveredFrom: "docker-label";
}
/**
 * A discovered workspace, with its state readable from ONE field (`kind`).
 *
 * Review finding L4-04: this used to be a single interface that required `configPath: ""` as a
 * sentinel for "no configuration", carried a placeholder `configKind`, and exposed four optional
 * fields whose combinations encoded the state — so consumers had to reconstruct it and could forget
 * a check. The variant also removes the `containerId`/`containerCandidates` disagreement by keeping
 * container identity in exactly one ordered collection.
 */
export type RegistryEntry = RegistryConfigEntry | RegistryContainerOnlyEntry;
export interface DiscoveryConfig {
    maxDepth: number;
    excludedDirectories: readonly string[];
}
export interface AuditConfig {
    enabled: boolean;
    directory?: string;
    retentionDays: number;
    commandCapture: CommandCaptureMode;
}
export interface DestructiveConfig {
    allowStop: boolean;
    allowRemove: boolean;
}
export interface HostExecutionConfig {
    allow: boolean;
}
/** Whether the extension takes over a workspace's execution surfaces. */
export type ActivationMode = "workspace" | "always" | "never";
export interface ManagerConfig {
    version?: number;
    dockerPath?: string;
    devcontainerPath?: string;
    routeMode?: RouteMode;
    activation?: ActivationMode;
    allowedWorkspaceRoots?: string[];
    environmentAllowlist?: string[];
    maxTimeoutSeconds?: number;
    maxOutputBytes?: number;
    discovery?: Partial<DiscoveryConfig>;
    audit?: Partial<AuditConfig>;
    destructive?: Partial<DestructiveConfig>;
    hostExecution?: Partial<HostExecutionConfig>;
}
export interface EffectiveConfig {
    version: typeof CONFIG_VERSION;
    dockerPath: string;
    devcontainerPath: string;
    routeMode: RouteMode;
    readonly activation: ActivationMode;
    allowedWorkspaceRoots: readonly string[];
    environmentAllowlist: readonly string[];
    maxTimeoutSeconds: number;
    maxOutputBytes: number;
    discovery: Readonly<DiscoveryConfig>;
    audit: Readonly<AuditConfig>;
    destructive: Readonly<DestructiveConfig>;
    hostExecution: Readonly<HostExecutionConfig>;
}
export interface PolicyInput {
    workspace?: string;
    operation: OperationKind;
    initiator: Initiator;
    requestedEnvironment?: Readonly<Record<string, string>>;
}
export interface OperationPolicySnapshot {
    readonly effectiveConfig: EffectiveConfig;
    readonly input: Readonly<PolicyInput>;
    readonly authorized: boolean;
    readonly denialReason?: "workspace-not-allowed" | "destructive-operation-disabled" | "host-execution-disabled" | "environment-variable-denied";
    readonly createdAt: string;
}
export interface AuditRecord {
    readonly version: 1;
    readonly at: string;
    readonly sessionId?: string;
    readonly operation: OperationKind;
    readonly initiator: Initiator;
    readonly workspace?: string;
    readonly targetId?: string;
    /** The request's cwd when it differs from the executed (target) workspace. */
    readonly requestedCwd?: string;
    readonly policyAuthorized: boolean;
    readonly policyDenialReason?: string;
    readonly durationMs?: number;
    readonly exitCode?: number | null;
    readonly outputTruncated: boolean;
    readonly commandCapture: CommandCaptureMode;
    readonly commandFingerprint?: string;
    readonly commandText?: string;
    readonly errorSummary?: string;
}
export {};
//# sourceMappingURL=types.d.ts.map