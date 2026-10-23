import { JsonlAuditWriter, defaultAuditDirectory } from "../../src/audit.js";
import { defaultConfigPaths, loadConfigWithDiagnostics } from "../../src/config.js";
import { ExecutionService } from "../../src/execution-service.js";
import { hostToContainer, readWorkspaceConfigFacts } from "../../src/path-mapper.js";
import { configPathOf, selectedConfigPathFor } from "../../src/registry-entry.js";
import { composeHostRuntime, type HostRuntime } from "../../src/runtime-composition.js";
import { buildWorkspaceRegistry, nodeTraversal, type RegistryResult } from "../../src/runtime/host-discovery.js";
import { TargetStore } from "../../src/target-store.js";
import type { EffectiveConfig, RegistryEntry } from "../../src/types.js";
import { canonicalWorkspaceKey } from "../../src/workspace-path.js";

/**
 * The dsh-side composition of this extension's runtime.
 *
 * Deliberately harness-free: it wires the same `src/` services the Pi entry wires (one shared
 * `composeHostRuntime`, one config loader, one audit writer, one execution gate), so the two entry
 * points cannot drift in what they call or what they record. What it does NOT do is adopt a target on
 * its own: dsh has no `/reload` and no session-restore equivalent, so the target is only ever the
 * result of an explicit `devcontainer use`/`up` (or a persisted selection the caller supplies).
 */
export interface DshRuntimeOptions {
  /** Host workspace of the dsh process (its working directory). */
  readonly workspace: string;
  /** Override the global configuration file (defaults to this extension's Pi-compatible location). */
  readonly globalConfigPath?: string;
  /** Override the project configuration file (defaults to `<workspace>/.pi/pi-devcontainer-manager.json`). */
  readonly projectConfigPath?: string;
  /**
   * Read the project configuration file.
   *
   * Defaults to FALSE: this extension's project file is only honoured where the host harness has
   * established that the project is trusted (Pi asks; dsh has no equivalent gate here), and a project
   * file can grant capabilities. Fail closed and let the operator opt in.
   */
  readonly projectTrusted?: boolean;
}

export interface DshRuntime {
  readonly config: EffectiveConfig;
  /** Configuration problems the operator must see (unreadable layer, withheld host execution…). */
  readonly diagnostics: readonly string[];
  readonly targetStore: TargetStore;
  readonly execution: ExecutionService;
  readonly host: HostRuntime;
  /** Cached registry read: discovery plus one Docker listing. */
  registry(): Promise<RegistryResult>;
  /** Re-run discovery after a mutation this runtime itself performed. */
  refresh(): Promise<RegistryResult>;
}

export function composeDshRuntime(options: DshRuntimeOptions): DshRuntime {
  const workspace = options.workspace;
  const defaults = defaultConfigPaths(workspace);
  const paths = {
    globalPath: options.globalConfigPath ?? defaults.globalPath,
    projectPath: options.projectConfigPath ?? defaults.projectPath,
  };
  const loaded = loadConfigWithDiagnostics(paths, { projectTrusted: options.projectTrusted ?? false });
  const config = loaded.config;

  // Honor `audit.directory`/`audit.enabled` exactly as the Pi entry does: one audit trail format,
  // one retention policy, whichever harness produced the record.
  const audit = new JsonlAuditWriter(
    config.audit.directory ?? defaultAuditDirectory(),
    config.audit.retentionDays,
    config.audit.enabled,
  );
  const host = composeHostRuntime(config, { cwd: workspace });
  const targetStore = new TargetStore({});

  let cached: Promise<RegistryResult> | undefined;
  const read = async (): Promise<RegistryResult> => {
    const dockerResult = await host.docker.listDevContainers();
    const result = buildWorkspaceRegistry({
      options: {
        sessionCwd: workspace,
        allowedWorkspaceRoots: config.allowedWorkspaceRoots,
        discovery: config.discovery,
        traversal: nodeTraversal(),
      },
      dockerCandidates: dockerResult.containers,
    });
    return {
      entries: result.entries,
      diagnostics: [...result.diagnostics, ...dockerResult.errors],
    };
  };
  const registry = (): Promise<RegistryResult> => {
    cached ??= read();
    return cached;
  };

  /**
   * The selected workspace's host<->container mapping.
   *
   * The reverse routing guard needs it: a `devcontainer exec` argv naming the HOST workspace path must
   * fail closed instead of being reinterpreted inside the container. Derived through the same
   * `readWorkspaceConfigFacts` the Pi entry uses, and the same "selected configuration wins" rule.
   */
  const mappingFor = async (workspaceKey: string) => {
    const { entries } = await registry();
    const entry: RegistryEntry | undefined = entries.find(
      (candidate) => canonicalWorkspaceKey(candidate.workspacePath) === canonicalWorkspaceKey(workspaceKey),
    );
    if (entry === undefined) return undefined;
    const discovered = configPathOf(entry);
    if (discovered === undefined) return undefined;
    const facts = readWorkspaceConfigFacts(
      selectedConfigPathFor(targetStore.snapshot(), entry.workspacePath, discovered),
    );
    if (facts.mapping === undefined) return undefined;
    return {
      hostPath: facts.mapping.hostPath,
      containerPath: facts.mapping.containerPath,
      ...(facts.samePathMounts !== undefined ? { containerVisiblePaths: facts.samePathMounts } : {}),
    };
  };

  const execution = new ExecutionService({
    config,
    targetStore,
    devcontainer: host.devcontainer,
    dockerLifecycle: host.dockerLifecycle,
    audit,
    mappingFor,
    resolveContainerWorkspace: async (hostWorkspace: string) => {
      const mapping = await mappingFor(hostWorkspace);
      return mapping === undefined ? undefined : hostToContainer(hostWorkspace, mapping) ?? undefined;
    },
  });

  return {
    config,
    diagnostics: loaded.diagnostics,
    targetStore,
    execution,
    host,
    registry,
    refresh: async () => {
      cached = undefined;
      return registry();
    },
  };
}
