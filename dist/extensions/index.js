/**
 * Pi extension factory and lifecycle composition (Pi entrypoint).
 *
 * Ordering constraint 6: the entrypoint comes after every service, so tool
 * and command registration observes fully composed dependencies. The factory
 * stays lazy: heavy host work (config load, host + Docker discovery,
 * capability probing) happens on `session_start`, not during extension load,
 * so Pi starts fast and `/reload` re-composes cleanly.
 *
 * Wiring summary:
 *
 * - `ExecutionService` is the single gate for `devcontainer_exec`, routed
 *   `bash` (LLM + `!`/`!!`), `up`/`build`, and confirmed `stop`/`remove` —
 *   policy snapshot, environment filtering, audit, output accounting,
 *   cancellation, timeout all live there and cannot drift between paths.
 * - The built-in `bash` tool is replaced by registering the same name with
 *   `createBashToolDefinition(..., { operations, exposeSessionEnvironment: false })`.
 *   `exposeSessionEnvironment: false` is mandatory: the container never sees
 *   `PI_*` session metadata. Extension tools override built-ins by name
 *   (verified in `dist/core/agent-session-runtime.js` `_refreshToolRegistry`).
 * - `!`/`!!` (`user_bash`) returns the SAME `BashOperations` instance, so the
 *   two surfaces cannot drift.
 * - The only host escape hatch is the explicitly named, policy-gated, audited
 *   `devcontainer_host_exec` tool + `/devcontainer host-exec` command.
 * - Selection intent is persisted as a versioned Pi session custom entry
 *   (`SELECTION_ENTRY_KIND`) and restored on `session_start` from
 *   `sessionManager.getEntries()`.
 *
 * `src/` modules stay Pi-dependency-free; this file performs the structural
 * casts that wire them into the Pi runtime.
 */
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { createBashToolDefinition, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { defaultConfigPaths, loadConfigWithDiagnostics } from "../src/config.js";
import { createDiagnosticSink, reportDiscoveryDiagnostics } from "../src/discovery-diagnostics.js";
import { decideActivation, surfacesFor } from "../src/activation.js";
import { JsonlAuditWriter, defaultAuditDirectory } from "../src/audit.js";
import { NodeProcessRunner } from "../src/runtime/process-runner.js";
import { NodeCapabilityService } from "../src/runtime/capabilities.js";
import { NodeDockerAdapter } from "../src/runtime/docker-adapter.js";
import { NodeDevcontainerAdapter } from "../src/runtime/devcontainer-adapter.js";
import { NodeDockerLifecycleAdapter } from "../src/runtime/docker-lifecycle.js";
import { buildWorkspaceRegistry, nodeTraversal, workspaceHasConfig, workspacePathFor } from "../src/runtime/host-discovery.js";
import { buildPathMapping, findContainerPath, hostToContainer } from "../src/path-mapper.js";
import { TargetStore } from "../src/target-store.js";
import { ExecutionService } from "../src/execution-service.js";
import { createRoutedBashOperations } from "../src/bash-router.js";
import { createDevcontainerExecTool, createDevcontainerStatusTool, createDevcontainerHostExecTool, devcontainerExecParams, devcontainerStatusParams, devcontainerHostExecParams, DEV_CONTAINER_HOST_EXEC_TOOL, } from "../src/tools.js";
import { createCommandHandlers, displayCommandResult, selectionFor } from "../src/commands.js";
import { reconcileSelection } from "../src/commands.js";
import { canonicalWorkspaceKey } from "../src/workspace-path.js";
import { SELECTION_ENTRY_KIND, recoverLatestSelection } from "../src/selection-state.js";
import { evaluatePolicy, commandIdentity } from "../src/policy.js";
import { createSetupCli } from "../src/setup-cli.js";
import { RuntimeError } from "../src/errors.js";
import { renderExecutionContext } from "../src/execution-context.js";
function composeRuntime(config, audit, sessionWorkspace, activation) {
    const runner = new NodeProcessRunner();
    const capabilities = new NodeCapabilityService(runner, {
        dockerPath: config.dockerPath,
        devcontainerPath: config.devcontainerPath,
    });
    void capabilities.check().catch(() => undefined);
    const env = {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? homedir(),
        ...(process.env.XDG_STATE_HOME !== undefined ? { XDG_STATE_HOME: process.env.XDG_STATE_HOME } : {}),
    };
    const docker = new NodeDockerAdapter(runner, {
        dockerPath: config.dockerPath,
        env,
        cwd: sessionWorkspace,
        maxOutputBytes: config.maxOutputBytes,
    });
    const devcontainer = new NodeDevcontainerAdapter(runner, {
        devcontainerPath: config.devcontainerPath,
        env,
        cwd: sessionWorkspace,
        limits: { maxOutputBytes: config.maxOutputBytes, timeoutMs: config.maxTimeoutSeconds * 1000 },
    });
    const dockerLifecycle = new NodeDockerLifecycleAdapter(runner, {
        dockerPath: config.dockerPath,
        env,
        cwd: sessionWorkspace,
        maxOutputBytes: config.maxOutputBytes,
    });
    const targetStore = new TargetStore({});
    const discoveryInput = (traversal) => ({
        options: {
            sessionCwd: sessionWorkspace,
            allowedWorkspaceRoots: config.allowedWorkspaceRoots,
            discovery: config.discovery,
            traversal,
        },
    });
    // Discovery diagnostics are computed on every pass and were previously dropped on the floor.
    // Queue them here (the sink dedupes and never re-reports) and let the /devcontainer dispatch
    // below surface them through the same warning channel the config-load diagnostics use. The
    // activation probe also calls registry(); it only ever contributes, never notifies.
    const discoveryDiagnostics = createDiagnosticSink();
    const registry = async () => {
        const traversal = nodeTraversal();
        const dockerResult = await docker.listDevContainers();
        const result = buildWorkspaceRegistry({ ...discoveryInput(traversal), dockerCandidates: dockerResult.containers });
        discoveryDiagnostics.add([...result.diagnostics, ...dockerResult.errors]);
        return result;
    };
    /**
     * Auto-select the session-cwd workspace as the default target when none is
     * selected yet (empty-selection only — an explicit `/devcontainer use`
     * always wins). Matches only when the policy-scoped request workspace's
     * realpath exactly equals the session cwd; a config-only/stopped project is
     * selected in `selected-stopped` so `exec` fails closed with
     * `target-stopped` and prompts `/devcontainer up` (never auto-starts).
     */
    const autoSelect = async (workspace) => {
        const cwdKey = canonicalWorkspaceKey(sessionWorkspace);
        if (canonicalWorkspaceKey(workspace) !== cwdKey)
            return;
        const { entries } = await registry();
        const match = entries.find((e) => canonicalWorkspaceKey(e.workspacePath) === cwdKey);
        if (match === undefined)
            return;
        // Ambiguous (2+ running containers) must never be auto-picked by Docker
        // order — selectionFor returns selected-ambiguous when no id is supplied.
        await targetStore.select(selectionFor(match, match.ambiguous === true ? undefined : match.containerId));
    };
    /**
     * Map a HOST workspace path to its in-container path (presentation only).
     * Reads the workspace's devcontainer.json workspaceFolder/workspaceMount;
     * returns undefined (host path unchanged) when the config is absent or
     * declares no resolvable mapping.
     */
    const resolveContainerWorkspace = async (hostWorkspace) => {
        const { entries } = await registry();
        const key = canonicalWorkspaceKey(hostWorkspace);
        const entry = entries.find((e) => canonicalWorkspaceKey(e.workspacePath) === key);
        if (entry === undefined || entry.configPath.length === 0)
            return undefined;
        const mapping = readWorkspaceMapping(entry.configPath);
        if (mapping === undefined)
            return undefined;
        return hostToContainer(entry.workspacePath, mapping) ?? undefined;
    };
    const execution = new ExecutionService({
        config,
        targetStore,
        devcontainer,
        dockerLifecycle,
        audit,
        autoSelect,
        resolveContainerWorkspace,
    });
    const bashOperations = createRoutedBashOperations({
        execution,
        sessionWorkspace,
        initiator: "routed-bash",
        environmentAllowlist: config.environmentAllowlist,
    });
    /**
     * Shared host escape-hatch runner used by BOTH `devcontainer_host_exec`
     * and `/devcontainer host-exec`. Policy (`host-exec` / `host-escape`) is
     * evaluated BEFORE any spawn — denial returns a typed error and never
     * touches the host. Authorized runs are audited with the command
     * fingerprint under the same capture policy as every other operation.
     *
     * Note: `NodeProcessRunner` only surfaces output through the
     * `onData`/`onStderr` callbacks; without them the host's stdout/stderr
     * would be discarded. They are captured here and returned so the tool
     * and command surfaces can render them.
     */
    const hostRunner = {
        run: async (argv, options) => {
            const snapshot = evaluatePolicy(config, {
                operation: "host-exec",
                initiator: "host-escape",
            });
            if (!snapshot.authorized) {
                audit.write({
                    version: 1,
                    at: new Date().toISOString(),
                    operation: "host-exec",
                    initiator: "host-escape",
                    policyAuthorized: false,
                    ...(snapshot.denialReason !== undefined ? { policyDenialReason: snapshot.denialReason } : {}),
                    outputTruncated: false,
                    commandCapture: config.audit.commandCapture,
                    ...commandIdentity(argv, config.audit.commandCapture),
                });
                throw new RuntimeError({
                    kind: "policy-denied",
                    message: "Host execution is disabled by policy.",
                    remedy: "Set hostExecution.allow=true in the global configuration to enable host escape.",
                });
            }
            // Layer-3 guard: refuse host execution of an argv that targets a
            // container-only path. Reliable because literal argv carries no shell
            // syntax — this is the mis-route a text classifier could never catch
            // safely. Covers BOTH devcontainer_host_exec and /devcontainer host-exec.
            const selection = targetStore.snapshot();
            if (selection.workspaceKey !== undefined) {
                const { entries } = await registry();
                const key = canonicalWorkspaceKey(selection.workspaceKey);
                const entry = entries.find((e) => canonicalWorkspaceKey(e.workspacePath) === key);
                const guardMapping = entry !== undefined && entry.configPath.length > 0 ? readWorkspaceMapping(entry.configPath) : undefined;
                const violation = guardMapping !== undefined ? findContainerPath(argv, guardMapping.containerPath) : undefined;
                if (violation !== undefined) {
                    audit.write({
                        version: 1,
                        at: new Date().toISOString(),
                        operation: "host-exec",
                        initiator: "host-escape",
                        policyAuthorized: false,
                        policyDenialReason: "container-path-on-host",
                        outputTruncated: false,
                        commandCapture: config.audit.commandCapture,
                        ...commandIdentity(argv, config.audit.commandCapture),
                    });
                    throw new RuntimeError({
                        kind: "policy-denied",
                        message: `Host command references container-only path ${violation}.`,
                        remedy: "Use devcontainer_exec or the bash tool for container paths; devcontainer_host_exec is for host paths.",
                    });
                }
            }
            const stdoutChunks = [];
            const stderrChunks = [];
            const startedAt = process.hrtime.bigint();
            // Host execution is bounded by the same configured ceiling as the
            // container path: an omitted/zero timeout defaults to maxTimeoutSeconds
            // and a requested one is clamped to it, so an allowed host command can
            // never run unbounded or exceed the operator's configured maximum.
            const ceilingMs = config.maxTimeoutSeconds * 1000;
            const requestedMs = options?.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
                ? options.timeoutMs
                : ceilingMs;
            const timeoutMs = Math.max(1, Math.min(requestedMs, ceilingMs));
            let result;
            try {
                result = await runner.exec(argv[0], [...argv.slice(1)], {
                    cwd: sessionWorkspace,
                    env: { ...env },
                    maxOutputBytes: config.maxOutputBytes,
                    onData: (chunk) => stdoutChunks.push(chunk),
                    onStderr: (chunk) => stderrChunks.push(chunk),
                    timeoutMs,
                    ...(options?.signal !== undefined ? { signal: options.signal } : {}),
                });
            }
            catch (error) {
                // A failed/timed-out host run is auditable too (spawn errors and
                // timeouts reject before the success record below).
                audit.write({
                    version: 1,
                    at: new Date().toISOString(),
                    operation: "host-exec",
                    initiator: "host-escape",
                    policyAuthorized: true,
                    durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
                    outputTruncated: false,
                    commandCapture: config.audit.commandCapture,
                    ...commandIdentity(argv, config.audit.commandCapture),
                    errorSummary: error instanceof Error ? error.message : String(error),
                });
                throw error;
            }
            audit.write({
                version: 1,
                at: new Date().toISOString(),
                operation: "host-exec",
                initiator: "host-escape",
                policyAuthorized: true,
                durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
                ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
                outputTruncated: result.truncated,
                commandCapture: config.audit.commandCapture,
                ...commandIdentity(argv, config.audit.commandCapture),
            });
            return {
                exitCode: result.exitCode,
                signal: result.signal,
                stdout: Buffer.concat(stdoutChunks).toString("utf8"),
                stderr: Buffer.concat(stderrChunks).toString("utf8"),
                truncated: result.truncated,
            };
        },
    };
    const commandServices = {
        config,
        targetStore,
        execution,
        registry,
        refreshRegistry: registry,
        logs: (container, options) => dockerLifecycle.logs(container.id, options),
        hostRunner,
        setupCli: createSetupCli({ runner, audit, config, sessionWorkspace, env }),
    };
    const tools = {
        exec: createDevcontainerExecTool({
            execution,
            sessionWorkspace,
            hostRunner,
            hostExecutionAllowed: config.hostExecution.allow,
        }),
        status: createDevcontainerStatusTool(() => {
            const snapshot = targetStore.snapshot();
            return {
                summary: renderSelectionSummary(snapshot, config),
                details: { ...snapshot },
            };
        }),
        hostExec: createDevcontainerHostExecTool({
            execution,
            sessionWorkspace,
            hostRunner,
            hostExecutionAllowed: config.hostExecution.allow,
        }),
    };
    /**
     * Render the execution-context block from the CURRENT selection + the
     * workspace's devcontainer.json mapping. Recomputed per turn so a selection
     * change or `/devcontainer up` is reflected immediately.
     */
    const executionContext = async () => {
        const snapshot = targetStore.snapshot();
        if (snapshot.workspaceKey === undefined && snapshot.candidateId === undefined)
            return undefined;
        let mapping;
        if (snapshot.workspaceKey !== undefined) {
            const { entries } = await registry();
            const key = canonicalWorkspaceKey(snapshot.workspaceKey);
            const entry = entries.find((e) => canonicalWorkspaceKey(e.workspacePath) === key);
            if (entry !== undefined && entry.configPath.length > 0) {
                mapping = readWorkspaceMapping(entry.configPath);
            }
        }
        return renderExecutionContext({
            ...(snapshot.candidateId !== undefined ? { candidateId: snapshot.candidateId } : {}),
            status: snapshot.status,
            ...(mapping !== undefined ? { mapping } : {}),
        });
    };
    return {
        config,
        targetStore,
        execution,
        bashOperations,
        hostRunner,
        tools,
        commandHandlers: createCommandHandlers(commandServices),
        registry,
        discoveryDiagnostics,
        activation,
        executionContext,
        // One shared implementation for session restore and /devcontainer up.
        // No persistence here: a restored selection is already stored.
        reconcileSelection: async (hint) => {
            await reconcileSelection(commandServices, {}, hint);
        },
    };
}
function renderSelectionSummary(snapshot, config) {
    const lines = [`**DevContainer target:** ${snapshot.status}`];
    if (snapshot.workspaceKey !== undefined)
        lines.push(`workspace: \`${snapshot.workspaceKey}\``);
    if (snapshot.candidateId !== undefined)
        lines.push(`candidate: \`${snapshot.candidateId}\``);
    if (snapshot.detail !== undefined)
        lines.push(`detail: ${snapshot.detail}`);
    lines.push(`route: \`${config.routeMode}\``);
    return lines.join("\n");
}
/**
 * Host-command identity for audit records, mirroring the execution
 * service's capture policy (none / fingerprint-only / redacted-text).
 */
/**
 * Read a workspace's devcontainer.json and derive a host<->container path
 * mapping (workspaceMount preferred, workspaceFolder fallback). Returns
 * undefined when the config is absent/unreadable or declares no mapping.
 */
function readWorkspaceMapping(configPath) {
    let raw;
    try {
        raw = readFileSync(configPath, "utf8");
    }
    catch {
        return undefined;
    }
    let parsed;
    try {
        // DevContainer configs are JSON with Comments in practice. Strip block
        // comments, line comments (not inside strings) and trailing commas before
        // parsing, so a commented config still yields its workspace mapping.
        parsed = JSON.parse(raw
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1")
            .replace(/,\s*([}\]])/g, "$1"));
    }
    catch {
        return undefined;
    }
    const configDir = workspacePathFor(configPath);
    const workspaceFolder = typeof parsed.workspaceFolder === "string" ? parsed.workspaceFolder : undefined;
    const workspaceMount = typeof parsed.workspaceMount === "string" ? parsed.workspaceMount : undefined;
    return buildPathMapping(configDir, workspaceFolder, workspaceMount);
}
/** Compose the effective config, always including the session cwd as a root. */
function composeRuntimeConfig(cwd, base) {
    const roots = new Set([...base.allowedWorkspaceRoots]);
    roots.add(cwd);
    return {
        ...base,
        allowedWorkspaceRoots: Object.freeze([...roots]),
    };
}
/** Persist a selection record into the session. */
function persistSelection(pi, record) {
    pi.appendEntry(SELECTION_ENTRY_KIND, record);
}
/** Recover the last persisted selection record from session custom entries. */
function restoreSelection(ctx) {
    const entries = ctx.sessionManager.getEntries();
    const mapped = entries
        .filter((entry) => entry.type === "custom")
        .map((entry) => ({
        kind: entry.customType,
        payload: typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data),
    }));
    return recoverLatestSelection(mapped);
}
export default function (pi) {
    // Lazy composition: heavy work only on session_start / reload.
    let runtime;
    pi.on("session_start", async (_event, ctx) => {
        const paths = defaultConfigPaths(ctx.cwd);
        const loaded = loadConfigWithDiagnostics(paths, { projectTrusted: ctx.isProjectTrusted() });
        const config = composeRuntimeConfig(ctx.cwd, loaded.config);
        const recovered = restoreSelection(ctx);
        const activation = { decision: { active: false, reason: "no-evidence" } };
        // Honor audit.enabled and audit.directory: the configured directory is used
        // when set, and `enabled: false` accepts records but persists nothing.
        const audit = new JsonlAuditWriter(config.audit.directory ?? defaultAuditDirectory(), config.audit.retentionDays, config.audit.enabled);
        const rt = composeRuntime(config, audit, ctx.cwd, activation);
        runtime = rt;
        // Activation is decided BEFORE any execution surface is registered. In a
        // workspace that is not a DevContainer project the extension must leave Pi's
        // built-in `bash`, `!`/`!!`, and the host file tools alone instead of taking
        // them over and failing closed (AC-3/AC-4). `/devcontainer use|up` can still
        // engage it for this session.
        const evidence = {
            activation: config.activation,
            workspaceHasConfig: workspaceHasConfig(ctx.cwd),
            workspaceHasRunningContainer: false,
            hasExplicitSelection: recovered !== undefined,
        };
        let decision = decideActivation(evidence);
        if (!decision.active && decision.reason === "no-evidence") {
            // Chain step 4 is the only expensive signal, so it is probed last and only
            // when every cheaper one missed. Its failure modes (no daemon, timeout) mean
            // "no evidence": the decision fails toward dormancy, never toward takeover.
            evidence.workspaceHasRunningContainer = await probeRunningContainer(rt, ctx.cwd);
            decision = decideActivation(evidence);
        }
        activation.decision = decision;
        // Register the devcontainer surfaces now that the runtime exists, so each tool
        // carries its real description/promptSnippet/promptGuidelines into the system
        // prompt (the agent needs them to know when to use the tool). session_start
        // refires on /reload and session switches; same-name re-registration replaces
        // the prior definitions.
        const surfaces = surfacesFor(decision);
        if (surfaces.containerTools)
            registerDevcontainerTools(pi, () => runtime);
        if (surfaces.bashReplacement)
            registerBashReplacement(pi, () => runtime);
        if (!decision.active) {
            ctx.ui.notify(`DevContainer extension is dormant here (${decision.reason}): bash, !/!!, and the file tools are host surfaces. Run /devcontainer use|up to engage a container target.`, "info");
        }
        for (const line of loaded.diagnostics) {
            ctx.ui.notify(`[devcontainer-manager] ${line}`, "warning");
        }
        if (recovered !== undefined && decision.active) {
            // Re-resolve against the live registry instead of parking the selection in
            // `selected-missing` forever: a still-running target becomes usable again
            // without a manual re-`use`.
            await runtime.reconcileSelection({
                workspaceKey: recovered.workspaceKey,
                ...(recovered.candidateId !== undefined ? { candidateId: recovered.candidateId } : {}),
            });
            const restoredStatus = runtime.targetStore.snapshot().status;
            ctx.ui.notify(`Restored DevContainer selection ${recovered.workspaceKey} (${restoredStatus}).`, "info");
        }
    });
    pi.on("session_shutdown", async () => {
        runtime = undefined;
    });
    // --- Execution-context injection ---------------------------------------
    // Append the current workspace's host<->container mapping and the execution
    // surface guidance to the system prompt each turn. This is how the agent gets
    // the FACTS it needs to choose the right surface (container by default; host
    // only via the explicit devcontainer_host_exec), instead of the extension
    // guessing an environment from command text.
    pi.on("before_agent_start", async (event) => {
        const rt = runtime;
        if (rt === undefined || !surfacesFor(rt.activation.decision).executionContext)
            return undefined;
        const block = await rt.executionContext();
        if (block === undefined)
            return undefined;
        return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
    });
    // --- Non-routable execution surfaces ------------------------------------
    // Pi's `tool_call` hook can BLOCK (and mutate input) but cannot re-route.
    // While a DevContainer target is selected, the built-in `powershell` tool
    // would spawn on the HOST — an execution surface this extension otherwise
    // governs. Block it and point the agent at the routed surfaces instead.
    // (`bash` is NOT touched here: it is our own overridden, container-routed
    // tool.)
    pi.on("tool_call", (event) => {
        if (event.toolName !== "powershell")
            return undefined;
        const rt = runtime;
        if (rt === undefined)
            return undefined;
        if (rt.targetStore.snapshot().status === "none")
            return undefined;
        return {
            block: true,
            reason: "PowerShell is not routed into the DevContainer. Use the `bash` tool or devcontainer_exec for container work, or devcontainer_host_exec for explicit host administration.",
        };
    });
    // --- Commands ----------------------------------------------------------
    pi.registerCommand("devcontainer", {
        description: "DevContainer management (list, use, status, up, build, stop, remove, logs, host-exec, setup, off)",
        handler: async (args, ctx) => {
            const rt = runtime;
            if (rt === undefined) {
                ctx.ui.notify("DevContainer runtime not initialized; run /reload or restart pi.", "error");
                return;
            }
            const run = async (verbArg) => {
                const spaceIndex = verbArg.indexOf(" ");
                const verb = (spaceIndex === -1 ? verbArg : verbArg.slice(0, spaceIndex)).trim().toLowerCase();
                const rest = spaceIndex === -1 ? "" : verbArg.slice(spaceIndex + 1).trim();
                if (verb.length === 0) {
                    await showVerbPicker(ctx, run);
                    return;
                }
                const handler = rt.commandHandlers[verb];
                if (handler === undefined) {
                    ctx.ui.notify(`Unknown /devcontainer verb: ${verb}. Run /devcontainer to list verbs.`, "error");
                    return;
                }
                const cmdCtx = {
                    cwd: ctx.cwd,
                    hasUI: ctx.hasUI,
                    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
                    ui: {
                        select: (title, options, opts) => ctx.ui.select(title, options, opts),
                        confirm: (title, message, opts) => ctx.ui.confirm(title, message, opts),
                        notify: (message, type) => ctx.ui.notify(message, type),
                    },
                    persistSelection: (record) => persistSelection(pi, record),
                    restoreSelection: () => restoreSelection(ctx),
                };
                const result = await handler(rest, cmdCtx).finally(() => {
                    // Surface anything the discovery pass could not do, and do it even when the handler
                    // failed: silent degradation (a scan that stopped early, a Docker record that failed
                    // to parse) is indistinguishable from an empty workspace, which is exactly how a
                    // broken setup used to look healthy.
                    reportDiscoveryDiagnostics(rt.discoveryDiagnostics, (line) => ctx.ui.notify(`[devcontainer-manager] ${line}`, "warning"));
                });
                // Pi's command dispatcher ignores a handler's return value, so the rendered result has to
                // be delivered from here or the operator sees nothing at all.
                displayCommandResult(result, (message, type) => ctx.ui.notify(message, type));
                // `/devcontainer use|up` engages this session's container surfaces;
                // `/devcontainer off` hands them back to the host. `activation: "never"` is
                // the one thing an explicit use cannot override (AC-5).
                if (verb === "use" || verb === "up")
                    engageDevcontainerSurfaces(pi, rt, () => runtime);
                if (verb === "off")
                    rt.activation.decision = { active: false, reason: "no-evidence" };
            };
            await run(args);
        },
    });
    // --- Bash routing ------------------------------------------------------
    pi.on("user_bash", (event) => resolveUserBash(runtime, event));
}
/**
 * Register the container-routed `bash` replacement: a same-name override of Pi's
 * built-in tool (`_refreshToolRegistry` replaces by name). Only called while the
 * session is engaged — in a dormant workspace the built-in host shell, `!`/`!!`,
 * and the host file tools stay exactly as Pi shipped them (AC-4).
 */
function registerBashReplacement(pi, getRuntime) {
    const definition = createBashToolDefinition(process.cwd(), {
        operations: lazyBashOperations(getRuntime),
        exposeSessionEnvironment: false,
    });
    // Override the built-in's system-prompt contribution: its snippet/guidelines
    // describe a HOST shell (including "inspect PI_* variables"), which is false for
    // the routed tool. The agent must see the routed semantics so it does not run
    // container work on the host or expect host state inside bash.
    pi.registerTool({
        ...definition,
        promptSnippet: "Execute a shell command inside the selected DevContainer (routed; not the host)",
        promptGuidelines: [
            `bash runs INSIDE the currently selected DevContainer, never on the host. Use it for container-side shells, pipelines, and quick command checks.`,
            `The container environment differs from the host: toolchains, node_modules platform builds, interpreters, and container-only mounts live here. Anything whose result depends on the container (npm test, pip, cargo, dev servers) MUST run here, not via a host shell.`,
            `Host-side file inspection and editing stay in the host file tools (read/ls/grep/find/write/edit) — they see the same workspace files as the container through the bind mount; prefer them over container bash for reading files.`,
            `Host administration (systemctl, host services, docker itself) does NOT belong here — use ${DEV_CONTAINER_HOST_EXEC_TOOL} for that.`,
            `PI_* environment variables are NOT available inside bash (session environment is not exposed to the container).`,
            `If no target is selected or it is stopped, bash fails closed (target-stopped) — run /devcontainer up first.`,
        ],
    });
}
/**
 * Engage the container surfaces for a session that started dormant, after an
 * explicit `/devcontainer use|up`. `activation: "never"` outranks this (AC-5).
 *
 * Registration happens mid-session here. Tool definitions registered during a
 * command are expected to be picked up by the next turn (Pi refreshes its tool
 * registry per turn); if a host cannot observe that, `/reload` makes it
 * authoritative.
 */
function engageDevcontainerSurfaces(pi, rt, getRuntime) {
    if (rt.config.activation === "never" || rt.activation.decision.active)
        return;
    rt.activation.decision = { active: true, reason: "explicit-selection" };
    registerDevcontainerTools(pi, getRuntime);
    registerBashReplacement(pi, getRuntime);
}
/**
 * Activation chain step 4: is there a RUNNING container labelled for this
 * workspace? Bounded, and every failure mode (no daemon, timeout) counts as "no
 * evidence" — the decision must fail toward dormancy, never toward takeover.
 */
async function probeRunningContainer(rt, workspace) {
    try {
        const { entries } = await Promise.race([
            rt.registry(),
            new Promise((_resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("container probe timed out")), 2_500);
                timer.unref();
            }),
        ]);
        const key = canonicalWorkspaceKey(workspace);
        return entries.some((entry) => canonicalWorkspaceKey(entry.workspacePath) === key && (entry.containerState ?? "") === "running");
    }
    catch {
        return false;
    }
}
/**
 * Decide the `user_bash` (`!`/`!!`) interception result.
 *
 * Receives the full `UserBashEvent` (per pi's extension convention) so callers
 * can branch on `event.command`, `event.cwd`, and `event.excludeFromContext`
 * (`!!` — output excluded from the LLM context).
 *

 * Fail-closed contract: when the DevContainer runtime is not initialized
 * (session_start not yet run, or the reload window), returning `undefined`
 * would let Pi fall back to executing `!`/`!!` on the HOST's local bash — the
 * exact silent host fallback this extension forbids. Throwing from the handler
 * is also unsafe: Pi's emitUserBash catches handler errors, logs them, and
 * still falls through to local bash. The only hard stop is a full
 * `{ result }` replacement, which Pi consumes directly and never routes to
 * the host.
 */
export function resolveUserBash(rt, event = undefined) {
    if (rt === undefined) {
        // For `!!` the output never reaches the LLM context, so the terse form
        // is enough; for `!` the full guidance is shown to the agent too.
        const output = event?.excludeFromContext
            ? "[devcontainer-manager] runtime not initialized (run /reload)"
            : "[devcontainer-manager] DevContainer runtime is not initialized. Run /reload or restart pi.";
        return {
            result: {
                output,
                exitCode: 1,
                cancelled: false,
                truncated: false,
            },
        };
    }
    if (!surfacesFor(rt.activation.decision).bashReplacement) {
        // Dormant: this session's `!`/`!!` belong to the host. Returning undefined is
        // the correct answer HERE (unlike the unknown-runtime case above) — it is what
        // lets Pi run the command with its own local bash, which is the dormant
        // contract (AC-4).
        return undefined;
    }
    // Future hook: `event` is available here to route by command/cwd or to
    // honour excludeFromContext; today every `!`/`!!` routes through the same
    // selected-container operations.
    void event;
    return { operations: rt.bashOperations };
}
/**
 * Interactive `/devcontainer` verb picker for a bare invocation (no verb).
 * Lets the user choose a verb from a list; the chosen verb is then dispatched
 * through the same handler. When no UI is available, falls back to a one-line
 * usage notice.
 */
async function showVerbPicker(ctx, run) {
    if (!ctx.hasUI) {
        ctx.ui.notify("DevContainer management: list, status, use, up, build, stop, remove, logs, host-exec, setup, off. Try /devcontainer <verb>.", "info");
        return;
    }
    const choice = await ctx.ui.select("DevContainer command", [
        "list - show registry + selection",
        "status - show current selection",
        "use [path] - select a target",
        "up [path] - start a container",
        "build [path] - build a container",
        "stop - stop selected container (confirmed)",
        "remove - delete selected container (confirmed)",
        "logs [--tail N] - container logs",
        "host-exec <argv...> - HOST escape hatch (policy-gated)",
        "setup - install/upgrade the Dev Containers CLI",
        "off - return this session to the host (dormant)",
    ], ctx.signal !== undefined ? { signal: ctx.signal } : undefined);
    if (choice === undefined)
        return;
    const picked = choice.split(" ")[0].toLowerCase();
    await run(picked);
}
function registerDevcontainerTools(pi, getRuntime) {
    registerNamedTool(pi, () => getRuntime()?.tools.exec, "devcontainer_exec", devcontainerExecParams);
    registerNamedTool(pi, () => getRuntime()?.tools.status, "devcontainer_status", devcontainerStatusParams);
    registerNamedTool(pi, () => getRuntime()?.tools.hostExec, "devcontainer_host_exec", devcontainerHostExecParams);
}
/**
 * Register a tool whose static metadata (name/label/description/promptSnippet/
 * promptGuidelines/parameters) is taken from the runtime tool definition, and
 * whose `execute` resolves the current runtime at call time.
 *
 * The prompt metadata matters: Pi surfaces promptSnippet in the Available-tools
 * section and appends promptGuidelines to the system-prompt Guidelines so the
 * agent knows when to reach for this tool instead of plain bash. Dropping them
 * (as an earlier wrapper did) hid the tools from the agent's judgment.
 */
function registerNamedTool(pi, getTool, fallbackName, params) {
    const probe = getTool();
    const name = probe?.name ?? fallbackName;
    const definition = {
        name: probe?.name ?? fallbackName,
        label: probe?.label ?? name,
        description: probe?.description ?? `(runtime not composed; ${fallbackName})`,
        ...(probe?.promptSnippet !== undefined ? { promptSnippet: probe.promptSnippet } : {}),
        ...(probe?.promptGuidelines !== undefined ? { promptGuidelines: probe.promptGuidelines } : {}),
        parameters: params,
        execute: async (toolCallId, toolParams, signal, onUpdate, ctx) => {
            const tool = getTool();
            if (tool === undefined) {
                throw new RuntimeError({
                    kind: "unexpected",
                    message: `DevContainer runtime is not initialized for ${name}.`,
                    remedy: "Run /reload or restart pi.",
                });
            }
            return tool.execute(toolCallId, toolParams, signal, onUpdate, ctx);
        },
    };
    pi.registerTool(definition);
}
/**
 * Lazy BashOperations wrapper resolving the current runtime at exec time.
 *
 * While engaged it delegates to the container-routed operations. While dormant it
 * delegates to Pi's OWN local bash operations, so the surface is exactly the built-in
 * one (shell resolution, environment, truncation, timeout) instead of a reimplementation
 * — the previous hand-rolled `spawn` diverged from the built-in in shell choice and
 * output accounting (review finding on revision-8e6c0670). `localBash` is injectable so
 * the delegation itself is unit-tested.
 */
export function lazyBashOperations(getRuntime, localBash = createLocalBashOperations()) {
    return {
        exec: async (command, cwd, options) => {
            const rt = getRuntime();
            if (rt === undefined) {
                throw new RuntimeError({
                    kind: "unexpected",
                    message: "DevContainer runtime is not initialized.",
                    remedy: "Run /reload or restart pi.",
                });
            }
            if (!surfacesFor(rt.activation.decision).bashReplacement) {
                // `/devcontainer off` returned this session to dormancy after the routed tool was
                // registered, so `bash` hands over to Pi's own local operations — the same
                // behavior the built-in tool has when this extension is absent.
                return localBash.exec(command, cwd, options);
            }
            return rt.bashOperations.exec(command, cwd, options);
        },
    };
}
//# sourceMappingURL=index.js.map