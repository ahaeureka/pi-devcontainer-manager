export const CONFIG_VERSION = 1 as const;

export type RouteMode = "container-required" | "container-preferred" | "host-only";
export type CommandCaptureMode = "none" | "fingerprint-only" | "redacted-text";
export type OperationKind =
  | "discover" | "status" | "logs" | "up" | "build"
  | "container-exec" | "routed-bash" | "user-bash" | "host-exec" | "stop" | "remove" | "setup";
export type Initiator = "tool" | "slash-command" | "routed-bash" | "user-bash" | "host-escape";
export type ContainerState = "running" | "exited" | "created" | "paused" | "unknown";

export type DevcontainerConfigKind =
  | "root/devcontainer.json"
  | "root/.devcontainer.json"
  | ".devcontainer/devcontainer.json"
  | ".devcontainer/<name>/devcontainer.json";

export interface DiscoveredProject {
  readonly workspacePath: string;
  readonly configPath: string;
  readonly configKind: DevcontainerConfigKind;
}

/** One discovered container for a workspace (identity + observed state). */
export interface RegistryCandidate {
  readonly id: string;
  readonly state: ContainerState;
}

/** One discovered DevContainer configuration for a workspace. */
export interface ConfigCandidate {
  readonly configPath: string;
  readonly configKind: DevcontainerConfigKind;
}

export interface RegistryEntry {
  readonly workspacePath: string;
  readonly configPath: string;
  readonly configKind: DevcontainerConfigKind;
  readonly discoveredFrom: "host-config" | "docker-label" | "both";
  /** Primary candidate id (first discovered); see `containerCandidates`. */
  readonly containerId?: string;
  readonly containerState?: ContainerState;
  /** ALL containers discovered for this workspace (never collapsed away). */
  readonly containerCandidates?: readonly RegistryCandidate[];
  /** EVERY configuration discovered for this workspace (never collapsed away). */
  readonly configCandidates?: readonly ConfigCandidate[];
  /**
   * True when MORE THAN ONE running container matches this workspace. Such a
   * target must never be auto-selected by Docker result order; the operator
   * picks an explicit candidate id.
   */
  readonly ambiguous?: boolean;
}

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
  readonly denialReason?:
    | "workspace-not-allowed"
    | "destructive-operation-disabled"
    | "host-execution-disabled"
    | "environment-variable-denied";
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
