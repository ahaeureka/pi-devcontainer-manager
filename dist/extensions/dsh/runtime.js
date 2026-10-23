import { JsonlAuditWriter, defaultAuditDirectory } from "../../src/audit.js";
import { defaultConfigPaths, loadConfigWithDiagnostics } from "../../src/config.js";
import { ExecutionService } from "../../src/execution-service.js";
import { hostToContainer, readWorkspaceConfigFacts } from "../../src/path-mapper.js";
import { configPathOf, selectedConfigPathFor } from "../../src/registry-entry.js";
import { composeHostRuntime } from "../../src/runtime-composition.js";
import { buildWorkspaceRegistry, nodeTraversal } from "../../src/runtime/host-discovery.js";
import { TargetStore } from "../../src/target-store.js";
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
//# sourceMappingURL=runtime.js.map