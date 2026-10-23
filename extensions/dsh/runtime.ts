import { resolve } from "node:path";
import { Service, type Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { JsonlAuditWriter, defaultAuditDirectory } from "../../src/audit.js";
import { defaultConfigPaths, loadConfigWithDiagnostics } from "../../src/config.js";
import { ExecutionService } from "../../src/execution-service.js";
import { hostToContainer, readWorkspaceConfigFacts } from "../../src/path-mapper.js";
import { configPathOf, selectedConfigPathFor } from "../../src/registry-entry.js";
import { composeHostRuntime, type HostRuntime } from "../../src/runtime-composition.js";
import { buildWorkspaceRegistry, nodeTraversal, type RegistryResult } from "../../src/runtime/host-discovery.js";
import { TargetStore } from "../../src/target-store.js";
import { resolveTargetAdoption } from "../../src/target-adoption.js";
import type { EffectiveConfig, RegistryEntry } from "../../src/types.js";
import { canonicalWorkspaceKey } from "../../src/workspace-path.js";

/**
 * The dsh-side composition of this extension's runtime.
 *
 * Deliberately harness-free: it wires the same `src/` services the Pi entry wires (one shared
 * `composeHostRuntime`, one config loader, one audit writer, one execution gate), so the two entry
 * points cannot drift in what they call or what they record.
 *
 * It adopts a target the same way the Pi entry does ({@link DshRuntime.autoSelect}): when nothing is
 * bound, the workspace's own running container is selected automatically, and a selection parked by
 * reality (stopped/missing) is re-derived. Without that, every shell command in a DevContainer project
 * failed with `No DevContainer target is selected` until the operator ran `devcontainer use` by hand —
 * which is not how the Pi side behaves and not what "use the DevContainer environment" means.
 * `devcontainer off` suspends adoption, so the verb stays authoritative.
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
  /** Canonical host workspace this runtime manages. */
  readonly workspace: string;
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
  /**
   * Establish a usable target for a workspace, adopting one when nothing is selected yet.
   *
   * Called before every routed command and before the management verbs, so a project whose container
   * is already running needs no manual `devcontainer use`. Exact rules, mirroring the Pi entry:
   * an empty selection adopts only the workspace's OWN container (running or stopped, never
   * ambiguous by Docker order), and a stopped/missing selection is re-derived only when a RUNNING
   * candidate now exists ({@link resolveTargetRepair}). Adoption never starts a container.
   */
  autoSelect(workspace: string): Promise<void>;
  /** Suspend or resume adoption (`devcontainer off` suspends it; `use`/`up` resume it). */
  setAutoSelection(enabled: boolean): void;
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

  // `devcontainer off` must stay authoritative: after it, an auto-adopt would resurrect the target the
  // operator just turned off on the very next command (the Pi entry hit the same trap, L1-02).
  let autoSelectionEnabled = true;

  const autoSelect = async (requestWorkspace: string): Promise<void> => {
    if (!autoSelectionEnabled) return;
    const snapshot = targetStore.snapshot();
    // Nothing to adopt when a target is already healthy or explicitly ambiguous.
    if (snapshot.status !== "none" && snapshot.status !== "selected-stopped" && snapshot.status !== "selected-missing") {
      return;
    }
    const { entries } = await registry();
    // `at-or-under`: dsh's provider is bound to one workspace, and a routed command may name a
    // subdirectory of it. The rule itself lives in `src/target-adoption.ts`, shared with the Pi entry.
    const adoption = resolveTargetAdoption({ requestWorkspace, snapshot, entries, scope: "at-or-under" });
    if (adoption === undefined) return;
    // An empty selection commits only if it is still empty: an explicit `use` that landed while the
    // registry was being read must win. A parked selection is replaced outright.
    if (snapshot.status === "none") await targetStore.selectIfNone(adoption);
    else await targetStore.select(adoption);
  };

  return {
    workspace,
    config,
    diagnostics: loaded.diagnostics,
    targetStore,
    execution,
    host,
    registry,
    autoSelect,
    setAutoSelection: (enabled: boolean) => {
      autoSelectionEnabled = enabled;
    },
    refresh: async () => {
      cached = undefined;
      return registry();
    },
  };
}

/**
 * The runtime as a dsh SERVICE.
 *
 * dsh's composition model is "a service the others inject", not "closures captured by one `apply`":
 * the shell provider, the tool, the command and the prompt section are separate plugins with their own
 * `inject`, their own fibers and their own config, so a deployment can drop any of them (the web app
 * composes no bash tool; ACP composes no command surface) without losing the rest. That is only
 * possible if what they share is reachable through `ctx`, which is what this class provides.
 *
 * The name is `devcontainerRuntime` (a capability of this package, not a harness seam).
 */
export class DshRuntimeService extends Service implements DshRuntime {
  /** Services this one needs. Empty: it only composes `src/` and the host CLIs. */
  static inject: string[] = [];

  static Config: Schema<DshServiceConfig> = Schema.object({
    workspace: Schema.string().description("Host workspace to manage (default: process.cwd())."),
    globalConfigPath: Schema.string().description("Override this extension's global configuration file."),
    projectConfigPath: Schema.string().description("Override the project configuration file."),
    projectTrusted: Schema.boolean()
      .default(false)
      .description("Read the project configuration file (it can grant capabilities, so this is opt-in)."),
  });

  /** The workspace this instance manages (canonical host path). */
  public readonly workspace: string;
  private readonly inner: DshRuntime;

  public constructor(ctx: Context, config: DshServiceConfig = {}) {
    super(ctx, "devcontainerRuntime");
    this.workspace = resolve(config.workspace ?? process.cwd());
    this.inner = composeDshRuntime({
      workspace: this.workspace,
      ...(config.globalConfigPath !== undefined ? { globalConfigPath: config.globalConfigPath } : {}),
      ...(config.projectConfigPath !== undefined ? { projectConfigPath: config.projectConfigPath } : {}),
      projectTrusted: config.projectTrusted ?? false,
    });
  }

  public get config(): EffectiveConfig {
    return this.inner.config;
  }

  public get diagnostics(): readonly string[] {
    return this.inner.diagnostics;
  }

  public get targetStore(): TargetStore {
    return this.inner.targetStore;
  }

  public get execution(): ExecutionService {
    return this.inner.execution;
  }

  public get host(): HostRuntime {
    return this.inner.host;
  }

  public registry(): Promise<RegistryResult> {
    return this.inner.registry();
  }

  public refresh(): Promise<RegistryResult> {
    return this.inner.refresh();
  }

  public autoSelect(workspace: string): Promise<void> {
    return this.inner.autoSelect(workspace);
  }

  public setAutoSelection(enabled: boolean): void {
    this.inner.setAutoSelection(enabled);
  }
}

/** Configuration accepted by the runtime service (the row's own keys). */
export interface DshServiceConfig {
  readonly workspace?: string;
  readonly globalConfigPath?: string;
  readonly projectConfigPath?: string;
  readonly projectTrusted?: boolean;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** This package's runtime: shared by its shell provider, tool, command and prompt section. */
    devcontainerRuntime: DshRuntimeService;
  }
}
