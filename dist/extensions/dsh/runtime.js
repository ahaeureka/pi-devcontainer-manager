import { resolve } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { JsonlAuditWriter, defaultAuditDirectory } from "../../src/audit.js";
import { defaultConfigPaths, loadConfigWithDiagnostics } from "../../src/config.js";
import { ExecutionService } from "../../src/execution-service.js";
import { hostToContainer, readWorkspaceConfigFacts } from "../../src/path-mapper.js";
import { configPathOf, selectedConfigPathFor } from "../../src/registry-entry.js";
import { composeHostRuntime } from "../../src/runtime-composition.js";
import { buildWorkspaceRegistry, nodeTraversal } from "../../src/runtime/host-discovery.js";
import { TargetStore } from "../../src/target-store.js";
import { resolveTargetAdoption } from "../../src/target-adoption.js";
import { canonicalWorkspaceKey } from "../../src/workspace-path.js";
export function composeDshRuntime(options) {
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
    const audit = new JsonlAuditWriter(config.audit.directory ?? defaultAuditDirectory(), config.audit.retentionDays, config.audit.enabled);
    const host = composeHostRuntime(config, { cwd: workspace });
    const targetStore = new TargetStore({});
    let cached;
    const read = async () => {
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
    const registry = () => {
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
    const mappingFor = async (workspaceKey) => {
        const { entries } = await registry();
        const entry = entries.find((candidate) => canonicalWorkspaceKey(candidate.workspacePath) === canonicalWorkspaceKey(workspaceKey));
        if (entry === undefined)
            return undefined;
        const discovered = configPathOf(entry);
        if (discovered === undefined)
            return undefined;
        const facts = readWorkspaceConfigFacts(selectedConfigPathFor(targetStore.snapshot(), entry.workspacePath, discovered));
        if (facts.mapping === undefined)
            return undefined;
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
        resolveContainerWorkspace: async (hostWorkspace) => {
            const mapping = await mappingFor(hostWorkspace);
            return mapping === undefined ? undefined : hostToContainer(hostWorkspace, mapping) ?? undefined;
        },
    });
    // `devcontainer off` must stay authoritative: after it, an auto-adopt would resurrect the target the
    // operator just turned off on the very next command (the Pi entry hit the same trap, L1-02).
    let autoSelectionEnabled = true;
    const autoSelect = async (requestWorkspace) => {
        if (!autoSelectionEnabled)
            return;
        const snapshot = targetStore.snapshot();
        // Nothing to adopt when a target is already healthy or explicitly ambiguous.
        if (snapshot.status !== "none" && snapshot.status !== "selected-stopped" && snapshot.status !== "selected-missing") {
            return;
        }
        const { entries } = await registry();
        // `at-or-under`: dsh's provider is bound to one workspace, and a routed command may name a
        // subdirectory of it. The rule itself lives in `src/target-adoption.ts`, shared with the Pi entry.
        const adoption = resolveTargetAdoption({ requestWorkspace, snapshot, entries, scope: "at-or-under" });
        if (adoption === undefined)
            return;
        // An empty selection commits only if it is still empty: an explicit `use` that landed while the
        // registry was being read must win. A parked selection is replaced outright.
        if (snapshot.status === "none")
            await targetStore.selectIfNone(adoption);
        else
            await targetStore.select(adoption);
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
        setAutoSelection: (enabled) => {
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
export class DshRuntimeService extends Service {
    /** Services this one needs. Empty: it only composes `src/` and the host CLIs. */
    static inject = [];
    static Config = Schema.object({
        workspace: Schema.string().description("Host workspace to manage (default: process.cwd())."),
        globalConfigPath: Schema.string().description("Override this extension's global configuration file."),
        projectConfigPath: Schema.string().description("Override the project configuration file."),
        projectTrusted: Schema.boolean()
            .default(false)
            .description("Read the project configuration file (it can grant capabilities, so this is opt-in)."),
    });
    /** The workspace this instance manages (canonical host path). */
    workspace;
    inner;
    constructor(ctx, config = {}) {
        super(ctx, "devcontainerRuntime");
        this.workspace = resolve(config.workspace ?? process.cwd());
        this.inner = composeDshRuntime({
            workspace: this.workspace,
            ...(config.globalConfigPath !== undefined ? { globalConfigPath: config.globalConfigPath } : {}),
            ...(config.projectConfigPath !== undefined ? { projectConfigPath: config.projectConfigPath } : {}),
            projectTrusted: config.projectTrusted ?? false,
        });
    }
    get config() {
        return this.inner.config;
    }
    get diagnostics() {
        return this.inner.diagnostics;
    }
    get targetStore() {
        return this.inner.targetStore;
    }
    get execution() {
        return this.inner.execution;
    }
    get host() {
        return this.inner.host;
    }
    registry() {
        return this.inner.registry();
    }
    refresh() {
        return this.inner.refresh();
    }
    autoSelect(workspace) {
        return this.inner.autoSelect(workspace);
    }
    setAutoSelection(enabled) {
        this.inner.setAutoSelection(enabled);
    }
}
//# sourceMappingURL=runtime.js.map