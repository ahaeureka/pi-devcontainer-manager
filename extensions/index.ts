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
import type {
  ExtensionAPI,
  ExtensionContext,
  BashOperations,
  UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";

import { loadConfig, defaultConfigPaths } from "../src/config.js";
import { JsonlAuditWriter, defaultAuditDirectory } from "../src/audit.js";
import { NodeProcessRunner } from "../src/runtime/process-runner.js";
import { NodeCapabilityService } from "../src/runtime/capabilities.js";
import { NodeDockerAdapter } from "../src/runtime/docker-adapter.js";
import { NodeDevcontainerAdapter } from "../src/runtime/devcontainer-adapter.js";
import { NodeDockerLifecycleAdapter } from "../src/runtime/docker-lifecycle.js";
import { buildWorkspaceRegistry, nodeTraversal } from "../src/runtime/host-discovery.js";
import { TargetStore } from "../src/target-store.js";
import { ExecutionService } from "../src/execution-service.js";
import { createRoutedBashOperations, type BashOperationsLike } from "../src/bash-router.js";
import {
  createDevcontainerExecTool,
  createDevcontainerStatusTool,
  createDevcontainerHostExecTool,
  devcontainerExecParams,
  devcontainerStatusParams,
  devcontainerHostExecParams,
  type ToolDefinitionLike,
} from "../src/tools.js";
import { createCommandHandlers, selectionFor, type CommandContextLike, type CommandServices } from "../src/commands.js";
import { canonicalWorkspaceKey } from "../src/workspace-path.js";
import { SELECTION_ENTRY_KIND, recoverLatestSelection, type SelectionRecord } from "../src/selection-state.js";
import { evaluatePolicy, commandFingerprint } from "../src/policy.js";
import type { EffectiveConfig } from "../src/types.js";
import { RuntimeError } from "../src/errors.js";

/** Runtime composed once per session; re-composed on session reload. */
interface Runtime {
  readonly config: EffectiveConfig;
  readonly targetStore: TargetStore;
  readonly execution: ExecutionService;
  readonly bashOperations: BashOperationsLike;
  readonly hostRunner: NonNullable<CommandServices["hostRunner"]>;
  readonly tools: {
    readonly exec: ToolDefinitionLike<unknown>;
    readonly status: ToolDefinitionLike<unknown>;
    readonly hostExec: ToolDefinitionLike<unknown>;
  };
  readonly commandHandlers: ReturnType<typeof createCommandHandlers>;
}

function composeRuntime(config: EffectiveConfig, audit: JsonlAuditWriter, sessionWorkspace: string): Runtime {
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

  const discoveryInput = (traversal: ReturnType<typeof nodeTraversal>) => ({
    options: {
      sessionCwd: sessionWorkspace,
      allowedWorkspaceRoots: config.allowedWorkspaceRoots,
      discovery: config.discovery,
      traversal,
    },
  });

  const registry = async () => {
    const traversal = nodeTraversal();
    const dockerCandidates = (await docker.listDevContainers()).containers;
    return buildWorkspaceRegistry({ ...discoveryInput(traversal), dockerCandidates });
  };

  /**
   * Auto-select the session-cwd workspace as the default target when none is
   * selected yet (empty-selection only — an explicit `/devcontainer use`
   * always wins). Matches only when the policy-scoped request workspace's
   * realpath exactly equals the session cwd; a config-only/stopped project is
   * selected in `selected-stopped` so `exec` fails closed with
   * `target-stopped` and prompts `/devcontainer up` (never auto-starts).
   */
  const autoSelect = async (workspace: string): Promise<void> => {
    const cwdKey = canonicalWorkspaceKey(sessionWorkspace);
    if (canonicalWorkspaceKey(workspace) !== cwdKey) return;
    const { entries } = await registry();
    const match = entries.find((e) => canonicalWorkspaceKey(e.workspacePath) === cwdKey);
    if (match === undefined) return;
    await targetStore.select(selectionFor(match, match.containerId));
  };

  const execution = new ExecutionService({
    config,
    targetStore,
    devcontainer,
    dockerLifecycle,
    audit,
    autoSelect,
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
  const hostRunner: NonNullable<CommandServices["hostRunner"]> = {
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
          ...hostCommandIdentity(argv, config.audit.commandCapture),
        });
        throw new RuntimeError({
          kind: "policy-denied",
          message: "Host execution is disabled by policy.",
          remedy: "Set hostExecution.allow=true in the global configuration to enable host escape.",
        });
      }
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const startedAt = process.hrtime.bigint();
      const result = await runner.exec(argv[0]!, [...argv.slice(1)], {
        cwd: sessionWorkspace,
        env: { ...env },
        maxOutputBytes: config.maxOutputBytes,
        onData: (chunk) => stdoutChunks.push(chunk),
        onStderr: (chunk) => stderrChunks.push(chunk),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      });
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
        ...hostCommandIdentity(argv, config.audit.commandCapture),
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

  const commandServices: CommandServices = {
    config,
    targetStore,
    execution,
    registry,
    refreshRegistry: registry,
    logs: (container, options) => dockerLifecycle.logs(container.id, options),
    hostRunner,
  };

  const tools: Runtime["tools"] = {
    exec: createDevcontainerExecTool({
      execution,
      sessionWorkspace,
      hostRunner,
      hostExecutionAllowed: config.hostExecution.allow,
    }) as ToolDefinitionLike<unknown>,
    status: createDevcontainerStatusTool(() => {
      const snapshot = targetStore.snapshot();
      return {
        summary: renderSelectionSummary(snapshot, config),
        details: { ...snapshot },
      };
    }) as ToolDefinitionLike<unknown>,
    hostExec: createDevcontainerHostExecTool({
      execution,
      sessionWorkspace,
      hostRunner,
      hostExecutionAllowed: config.hostExecution.allow,
    }) as ToolDefinitionLike<unknown>,
  };

  return {
    config,
    targetStore,
    execution,
    bashOperations,
    hostRunner,
    tools,
    commandHandlers: createCommandHandlers(commandServices),
  };
}

function renderSelectionSummary(
  snapshot: { status: string; workspaceKey: string | undefined; candidateId: string | undefined; detail: string | undefined },
  config: EffectiveConfig,
): string {
  const lines: string[] = [`**DevContainer target:** ${snapshot.status}`];
  if (snapshot.workspaceKey !== undefined) lines.push(`workspace: \`${snapshot.workspaceKey}\``);
  if (snapshot.candidateId !== undefined) lines.push(`candidate: \`${snapshot.candidateId}\``);
  if (snapshot.detail !== undefined) lines.push(`detail: ${snapshot.detail}`);
  lines.push(`route: \`${config.routeMode}\``);
  return lines.join("\n");
}

/**
 * Host-command identity for audit records, mirroring the execution
 * service's capture policy (none / fingerprint-only / redacted-text).
 */
function hostCommandIdentity(
  argv: readonly string[],
  capture: import("../src/types.js").CommandCaptureMode,
): { commandFingerprint?: string; commandText?: string } {
  if (capture === "none") return {};
  const parts = argv.filter((p) => p.length > 0);
  if (parts.length === 0) return {};
  const fingerprint = commandFingerprint(parts);
  if (capture === "fingerprint-only") return { commandFingerprint: fingerprint };
  return { commandFingerprint: fingerprint, commandText: parts.join(" ") };
}

/** Compose the effective config, always including the session cwd as a root. */
function composeRuntimeConfig(cwd: string, base: EffectiveConfig): EffectiveConfig {
  const roots = new Set([...base.allowedWorkspaceRoots]);
  roots.add(cwd);
  return {
    ...base,
    allowedWorkspaceRoots: Object.freeze([...roots]),
  };
}

/** Persist a selection record into the session. */
function persistSelection(pi: ExtensionAPI, record: SelectionRecord): void {
  pi.appendEntry(SELECTION_ENTRY_KIND, record);
}

/** Recover the last persisted selection record from session custom entries. */
function restoreSelection(ctx: ExtensionContext): SelectionRecord | undefined {
  const entries = ctx.sessionManager.getEntries();
  const mapped = entries
    .filter(
      (entry): entry is {
        type: "custom";
        customType: string;
        data?: unknown;
        id: string;
        parentId: string | null;
        timestamp: string;
      } => entry.type === "custom",
    )
    .map((entry) => ({
      kind: entry.customType,
      payload: typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data),
    }));
  return recoverLatestSelection(mapped);
}

export default function (pi: ExtensionAPI): void {
  // Lazy composition: heavy work only on session_start / reload.
  let runtime: Runtime | undefined;

  pi.on("session_start", async (_event, ctx) => {
    const paths = defaultConfigPaths(ctx.cwd);
    const base = loadConfig(paths, { projectTrusted: ctx.isProjectTrusted() });
    const config = composeRuntimeConfig(ctx.cwd, base);
    const audit = new JsonlAuditWriter(defaultAuditDirectory(), config.audit.retentionDays);
    runtime = composeRuntime(config, audit, ctx.cwd);

    const recovered = restoreSelection(ctx);
    if (recovered !== undefined) {
      await runtime.targetStore.select({
        status: "selected-missing",
        workspaceKey: recovered.workspaceKey,
        detail: "Selection restored from session; refresh to re-resolve the target.",
      });
      ctx.ui.notify(`Restored DevContainer selection ${recovered.workspaceKey}. Run /devcontainer list to refresh.`, "info");
    }
  });

  pi.on("session_shutdown", async () => {
    runtime = undefined;
  });

  // --- Tools -------------------------------------------------------------

  registerDevcontainerTools(pi, () => runtime);

  // --- Commands ----------------------------------------------------------

  pi.registerCommand("devcontainer", {
    description: "DevContainer management (list, use, status, up, build, stop, remove, logs, host-exec)",
    handler: async (args, ctx) => {
      const rt = runtime;
      if (rt === undefined) {
        ctx.ui.notify("DevContainer runtime not initialized; run /reload or restart pi.", "error");
        return;
      }
      const spaceIndex = args.indexOf(" ");
      const verb = (spaceIndex === -1 ? args : args.slice(0, spaceIndex)).trim().toLowerCase();
      const rest = spaceIndex === -1 ? "" : args.slice(spaceIndex + 1).trim();
      const handler = rt.commandHandlers[verb];
      if (handler === undefined) {
        ctx.ui.notify(`Unknown /devcontainer verb: ${verb}.`, "error");
        return;
      }
      const cmdCtx: CommandContextLike = {
        cwd: ctx.cwd,
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        ui: {
          select: (title, options, opts) => ctx.ui.select(title, options, opts),
          confirm: (title, message, opts) => ctx.ui.confirm(title, message, opts),
          notify: (message, type) => ctx.ui.notify(message, type),
        },
        persistSelection: (record) => persistSelection(pi, record),
        restoreSelection: () => restoreSelection(ctx),
      };
      const result = await handler(rest, cmdCtx);
      ctx.ui.notify(result.text, "info");
    },
  });

  // --- Bash routing ------------------------------------------------------

  // Same-name registration replaces the built-in `bash` tool (extension tools
  // override built-ins by name in `_refreshToolRegistry`). The operations are
  // resolved lazily so they observe the current runtime.
  pi.registerTool(
    createBashToolDefinition(process.cwd(), {
      operations: lazyBashOperations(() => runtime),
      exposeSessionEnvironment: false,
    }),
  );

  pi.on("user_bash", () => resolveUserBash(runtime));
}

/**
 * Decide the `user_bash` (`!`/`!!`) interception result.
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
export function resolveUserBash(
  rt: Runtime | undefined,
): UserBashEventResult {
  if (rt === undefined) {
    return {
      result: {
        output: "[devcontainer-manager] DevContainer runtime is not initialized. Run /reload or restart pi.",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  }
  return { operations: rt.bashOperations as unknown as BashOperations };
}


function registerDevcontainerTools(pi: ExtensionAPI, getRuntime: () => Runtime | undefined): void {
  pi.registerTool(resolveTool(
    () => getRuntime()?.tools.exec,
    "devcontainer_exec",
    "Dev Container Exec",
    "Execute an argv command inside the selected DevContainer. Requires a selected target.",
    devcontainerExecParams,
  ) as never);
  pi.registerTool(resolveTool(
    () => getRuntime()?.tools.status,
    "devcontainer_status",
    "Dev Container Status",
    "Read-only summary of the current DevContainer selection and registry.",
    devcontainerStatusParams,
  ) as never);
  pi.registerTool(resolveTool(
    () => getRuntime()?.tools.hostExec,
    "devcontainer_host_exec",
    "Dev Container Host Exec (escape hatch)",
    "Execute an argv command on the HOST (escape hatch). Policy-gated and audited.",
    devcontainerHostExecParams,
  ) as never);
}
/** Register a tool whose execute resolves the current runtime at call time.
 * The TypeBox `parameters` schema is fixed at registration (Pi validates
 * tool-call args against it), while `execute` defers to the current
 * runtime so session composition stays lazy.
 */
function resolveTool<TParams extends import("typebox").TSchema>(
  getTool: () => ToolDefinitionLike<unknown> | undefined,
  name: string,
  label: string,
  description: string,
  params: TParams,
): ToolDefinitionLike<TParams> {
  const definition: ToolDefinitionLike<TParams> = {
    name,
    label,
    description,
    parameters: params,
    execute: async (toolCallId: string, toolParams: TParams, signal: AbortSignal | undefined, onUpdate: ((partial: import("../src/tools.js").ToolResultLike) => void) | undefined, ctx: { cwd: string }) => {
      const tool = getTool();
      if (tool === undefined) {
        throw new RuntimeError({
          kind: "unexpected",
          message: `DevContainer runtime is not initialized for ${name}.`,
          remedy: "Run /reload or restart pi.",
        });
      }
      return tool.execute(toolCallId, toolParams as never, signal, onUpdate, ctx);
    },
  };
  return definition;
}

/** Lazy BashOperations wrapper resolving the current runtime at exec time. */
function lazyBashOperations(getRuntime: () => Runtime | undefined): BashOperations {
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
      return rt.bashOperations.exec(command, cwd, options);
    },
  } as BashOperations;
}
