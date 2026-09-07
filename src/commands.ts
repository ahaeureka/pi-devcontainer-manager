/**
 * Namespaced interactive command UX (`/devcontainer ...`) and shared
 * presentation helpers.
 *
 * The slash commands are the operator-facing management surface: list, use,
 * status, up, build, stop, remove, logs, and host-exec. Every mutating path
 * goes through the shared `ExecutionService` (policy snapshot, audit,
 * cancellation) and, for destructive actions, the adapter's confirmation
 * contract — a per-action token generated here, never bypassed.
 *
 * This module stays Pi-dependency-free: it defines the small `CommandUI` /
 * `CommandContextLike` structural interfaces it needs, and `extensions/index.ts`
 * adapts Pi's `ExtensionCommandContext` to them.
 */
import type { ExecutionService, LifecycleServiceResult, UpBuildOutcome } from "./execution-service.js";
import type { TargetStore, TargetStoreSnapshot, TargetSelection } from "./target-store.js";
import type { DockerContainer } from "./runtime/docker-adapter.js";
import type { SelectionRecord } from "./selection-state.js";
import { RuntimeError, errorKindOf } from "./errors.js";
import { isWorkspaceAllowed, isEnvironmentAllowed } from "./policy.js";
import { canonicalWorkspaceKey } from "./workspace-path.js";
import type { EffectiveConfig } from "./types.js";
import { SELECTION_ENTRY_KIND, SELECTION_PAYLOAD_VERSION } from "./selection-state.js";

/** UI primitives the command layer needs (structural subset of Pi's). */
export interface CommandUI {
  select(title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }): Promise<boolean>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** Command execution context (structural subset of Pi's ExtensionCommandContext). */
export interface CommandContextLike {
  readonly cwd: string;
  /** Whether an interactive UI is available to confirm/select (mirrors ctx.hasUI). */
  readonly hasUI: boolean;
  readonly signal?: AbortSignal;
  readonly ui: CommandUI;
  /** Persist selection intent to the session. */
  readonly persistSelection?: (record: SelectionRecord) => void;
  /** Restore a previously persisted selection record, if any. */
  readonly restoreSelection?: () => SelectionRecord | undefined;
}

export interface CommandServices {
  readonly config: EffectiveConfig;
  readonly targetStore: TargetStore;
  readonly execution: ExecutionService;
  /** Host registry (discovered projects + docker candidates). */
  readonly registry: () => Promise<{ entries: readonly import("./types.js").RegistryEntry[]; diagnostics: readonly string[] }>;
  /** Re-run host + docker discovery and return the fresh registry. */
  readonly refreshRegistry: () => Promise<{ entries: readonly import("./types.js").RegistryEntry[]; diagnostics: readonly string[] }>;
  /** Bounded container logs (wired to the docker lifecycle adapter). */
  readonly logs: (container: DockerContainer, options?: { tail?: number; signal?: AbortSignal }) => Promise<{ exitCode: number | null; output: string; truncated: boolean }>;
  /** Optional explicit host runner for `/devcontainer host-exec` (policy-gated). */
  readonly hostRunner?: {
    run(argv: readonly string[], options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<{
      exitCode: number | null;
      signal: string | null;
      stdout: string;
      stderr: string;
      truncated: boolean;
    }>;
  };
  /** Per-action confirmation token generator (defaults to crypto). */
  readonly generateToken?: () => string;
  /**
   * Install (or upgrade) the Dev Containers CLI globally via npm. Dedicated
   * setup capability: fixed npm argv, always user-confirmed in the handler,
   * audited under operation "setup" — independent of the host-exec policy
   * (which gates arbitrary host escape).
   */
  readonly setupCli?: (opts: { signal?: AbortSignal }) => Promise<{
    installed: boolean;
    version: string | undefined;
    error?: string;
  }>;
}

export interface CommandResult {
  /** Markdown rendered into the TUI. */
  readonly text: string;
}


/** Generate a fresh opaque confirmation token for a destructive action. */
export function generateConfirmationToken(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function tokenFor(services: CommandServices): string {
  return services.generateToken !== undefined ? services.generateToken() : generateConfirmationToken();
}

/** Render the selection + registry state as a compact status block. */
export function renderStatus(
  snapshot: TargetStoreSnapshot,
  entries: readonly import("./types.js").RegistryEntry[],
  config: EffectiveConfig,
): string {
  const lines: string[] = [];
  lines.push(`**DevContainer target:** ${snapshot.status}`);
  if (snapshot.workspaceKey !== undefined) lines.push(`workspace: \`${snapshot.workspaceKey}\``);
  if (snapshot.candidateId !== undefined) lines.push(`candidate: \`${snapshot.candidateId}\``);
  if (snapshot.detail !== undefined) lines.push(`detail: ${snapshot.detail}`);
  lines.push("");
  lines.push(`**Registry (${entries.length}):**`);
  for (const entry of entries) {
    const state = entry.containerState !== undefined ? entry.containerState : "config-only";
    const marker = entry.workspacePath === snapshot.workspaceKey ? " ▸" : "";
    lines.push(`- \`${entry.workspacePath}\` [${state}]${marker}`);
  }
  lines.push("");
  lines.push(`route: \`${config.routeMode}\` · maxTimeout: ${config.maxTimeoutSeconds}s · maxOutput: ${(config.maxOutputBytes / 1024).toFixed(0)}KiB`);
  return lines.join("\n");
}

/** Resolve a selection state back into the store, or return an error text. */
export async function applySelection(
  services: CommandServices,
  target: TargetSelection,
  ctx: CommandContextLike,
): Promise<void> {
  await services.targetStore.select(target);
  const snapshot = services.targetStore.snapshot();
  // Persist selection intent whenever the workspace key is known (running,
  // stopped, config-only, or missing) so `/reload` restores the target even
  // before it is running (End-State `use project-b` flow).
  if (snapshot.workspaceKey === undefined) return;
  ctx.persistSelection?.({
    version: SELECTION_PAYLOAD_VERSION,
    workspaceKey: snapshot.workspaceKey,
    ...(snapshot.candidateId !== undefined ? { candidateId: snapshot.candidateId } : {}),
    selectedAt: new Date().toISOString(),
  });
}

/** Build the selection record from a registry entry + chosen candidate id. */
export function selectionFor(
  entry: import("./types.js").RegistryEntry,
  candidateId: string | undefined,
): TargetSelection {
  const state = entry.containerState ?? "exited";
  const candidate = candidateId !== undefined
    ? {
        id: candidateId,
        name: candidateId,
        workspaceKey: entry.workspacePath,
        state,
        status: state === "running" ? "running" : "stopped",
      }
    : undefined;
  return {
    status: state === "running" ? "selected-valid" : "selected-stopped",
    ...(candidate !== undefined ? { candidate } : {}),
    workspaceKey: entry.workspacePath,
    ...(state === "running" ? {} : { detail: `Target ${entry.workspacePath} is not running; run /devcontainer up.` }),
  };
}

/** Namespaced command handler surface. */
export function createCommandHandlers(services: CommandServices): Record<string, (args: string, ctx: CommandContextLike) => Promise<CommandResult>> {
  const handlers: Record<string, (args: string, ctx: CommandContextLike) => Promise<CommandResult>> = {};

  handlers["list"] = async (_args, _ctx) => {
    const { entries } = await services.registry();
    const snapshot = services.targetStore.snapshot();
    return { text: renderStatus(snapshot, entries, services.config) };
  };

  handlers["status"] = async (_args, _ctx) => {
    const { entries } = await services.registry();
    const snapshot = services.targetStore.snapshot();
    return { text: renderStatus(snapshot, entries, services.config) };
  };

  handlers["use"] = async (args, ctx) => {
    const { entries } = await services.registry();
    const wanted = args.trim();
    let candidates = entries;
    if (wanted.length > 0) {
      candidates = entries.filter((e) => e.workspacePath.includes(wanted));
      if (candidates.length === 0) {
        return {
          text: `[no-candidate] No registry entry matches \`${wanted}\`.\nRun /devcontainer list to see available targets.`,
        };
      }
    }
    if (candidates.length === 1) {
      const entry = candidates[0]!;
      await applySelection(services, selectionFor(entry, entry.containerId), ctx);
      return { text: `Selected \`${entry.workspacePath}\` (${entry.containerState ?? "config-only"}).\nRun /devcontainer up if it is not running.` };
    }
    const labels = candidates.map((e) => `${e.workspacePath} [${e.containerState ?? "config-only"}]`);
    const choice = await ctx.ui.select("Select DevContainer target", labels, ctx.signal !== undefined ? { signal: ctx.signal } : undefined);
    if (choice === undefined) return { text: "Selection cancelled." };
    const idx = labels.indexOf(choice);
    if (idx === -1) return { text: "[unexpected] Unknown selection." };
    const entry = candidates[idx]!;
    await applySelection(services, selectionFor(entry, entry.containerId), ctx);
    return { text: `Selected \`${entry.workspacePath}\` (${entry.containerState ?? "config-only"}).\nRun /devcontainer up if it is not running.` };
  };

  handlers["up"] = async (args, ctx) => {
    const workspace = args.trim().length > 0 ? args.trim() : ctx.cwd;
    let outcome: UpBuildOutcome;
    try {
      outcome = await services.execution.up({ operation: "up", initiator: "slash-command", workspace });
    } catch (error) {
      return { text: describeError(error) };
    }
    const id = outcome.candidateId !== undefined ? `\`${outcome.candidateId}\`` : "(no container id)";
    return { text: `Up: ${outcome.workspaceKey} → ${id}\n${outcome.remoteUser !== undefined ? `remote user: ${outcome.remoteUser}\n` : ""}${outcome.remoteWorkspaceFolder !== undefined ? `remote folder: ${outcome.remoteWorkspaceFolder}` : ""}` };
  };

  handlers["build"] = async (args, ctx) => {
    const workspace = args.trim().length > 0 ? args.trim() : ctx.cwd;
    let outcome: UpBuildOutcome;
    try {
      outcome = await services.execution.build({ operation: "build", initiator: "slash-command", workspace });
    } catch (error) {
      return { text: describeError(error) };
    }
    return { text: `Build: ${outcome.workspaceKey}${outcome.imageName !== undefined ? ` → ${outcome.imageName}` : ""}` };
  };

  handlers["stop"] = async (args, ctx) => {
    return lifecycleCommand(services, ctx, "stop", args);
  };

  handlers["remove"] = async (args, ctx) => {
    return lifecycleCommand(services, ctx, "remove", args);
  };

  handlers["logs"] = async (args, ctx) => {
    const snapshot = services.targetStore.snapshot();
    const container = resolveContainer(snapshot);
    if (container === undefined) {
      return { text: `[${snapshot.status}] No resolvable target for logs. Run /devcontainer list then /devcontainer use.` };
    }
    const tail = parseTail(args);
    try {
      const result = await services.logs(container, { tail, ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}) });
      return { text: result.output.length > 0 ? result.output : `(no log output, exit ${result.exitCode})` };
    } catch (error) {
      return { text: describeError(error) };
    }
  };

  handlers["setup"] = async (_args, ctx) => {
    if (services.setupCli === undefined) {
      return { text: "[unexpected] Dev Containers CLI setup is not wired in this environment." };
    }
    if (!ctx.hasUI) {
      return { text: "[confirmation-required] /devcontainer setup installs a global npm package and needs an interactive confirmation; not available in this mode." };
    }
    const confirmed = await ctx.ui.confirm(
      "Install Dev Containers CLI",
      "This runs \"npm install -g @devcontainers/cli\" (installs or upgrades the CLI globally on the HOST). Continue?",
      ctx.signal !== undefined ? { signal: ctx.signal } : undefined,
    );
    if (!confirmed) return { text: "setup cancelled." };
    try {
      const result = await services.setupCli({ ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}) });
      if (!result.installed) {
        return { text: `[setup-failed] ${result.error ?? "unknown error"}` };
      }
      return { text: `Dev Containers CLI ready: ${result.version ?? "(version unknown)"}. Run /devcontainer list to start.` };
    } catch (error) {
      return { text: describeError(error) };
    }
  };

  handlers["host-exec"] = async (args, ctx) => {
    if (!services.config.hostExecution.allow) {
      return { text: "[policy-denied] Host execution is disabled by policy.\nSet hostExecution.allow=true in the global configuration to enable /devcontainer host-exec." };
    }
    if (services.hostRunner === undefined) {
      return { text: "[unexpected] Host runner is not wired in this environment." };
    }
    const argv = parseArgv(args);
    if (argv.length === 0) {
      return { text: "Usage: /devcontainer host-exec <argv...>\nRuns a command on the HOST machine (audited escape hatch)." };
    }
    try {
      const result = await services.hostRunner.run(argv, ctx.signal !== undefined ? { signal: ctx.signal } : undefined);
      return {
        text: result.stdout.length > 0 ? result.stdout : result.stderr.length > 0 ? result.stderr : `(no output, exit ${result.exitCode})`,
      };
    } catch (error) {
      return { text: describeError(error) };
    }
  };

  return handlers;
}

/** Shared stop/remove flow: resolve container, confirm via ui, run with token. */
async function lifecycleCommand(
  services: CommandServices,
  ctx: CommandContextLike,
  action: "stop" | "remove",
  _args: string,
): Promise<CommandResult> {
  const snapshot = services.targetStore.snapshot();
  const container = resolveContainer(snapshot);
  if (container === undefined) {
    return { text: `[${snapshot.status}] No resolvable target for ${action}. Run /devcontainer list then /devcontainer use.` };
  }
  // Destructive actions REQUIRE an interactive human confirmation. In modes
  // without UI (print/json) ctx.ui.confirm is a no-op; refuse explicitly
  // rather than relying on its silent default (mirrors ctx.hasUI guidance).
  if (!ctx.hasUI) {
    return { text: `[confirmation-required] ${action} needs an interactive confirmation; not available in this mode (${action} cancelled).` };
  }
  const confirmed = await ctx.ui.confirm(
    `Confirm ${action}`,
    `${action === "stop" ? "Stop" : "Remove"} container \`${container.name}\` (${container.id.slice(0, 12)})?`,
    ctx.signal !== undefined ? { signal: ctx.signal } : undefined,
  );
  if (!confirmed) return { text: `${action} cancelled.` };
  const token = tokenFor(services);
  try {
    const result = await services.execution.lifecycle({
      operation: action,
      initiator: "slash-command",
      workspace: snapshot.workspaceKey ?? ctx.cwd,
      container,
      confirmation: { token, action, containerId: container.id },
    });
    return { text: renderLifecycle(result) };
  } catch (error) {
    return { text: describeError(error) };
  }
}

function renderLifecycle(result: LifecycleServiceResult): string {
  if (result.status === "done") {
    return `${result.action} done for \`${result.containerId}\`.`;
  }
  return `[confirmation-required] ${result.instruction}`;
}

/** Resolve the current selection to a concrete DockerContainer, or undefined. */
function resolveContainer(
  snapshot: TargetStoreSnapshot,
): DockerContainer | undefined {
  if (snapshot.candidateId === undefined) return undefined;
  return {
    id: snapshot.candidateId,
    name: snapshot.candidateId,
    state: snapshot.status === "selected-valid" ? "running" : "exited",
    status: snapshot.status,
    image: "",
    created: "",
    labels: {},
  };
}

function parseTail(args: string): number {
  const match = /--tail\s+(\d+)/.exec(args);
  if (match !== null && match[1] !== undefined) return Number(match[1]);
  return 100;
}

/** Minimal argv splitter for `/devcontainer host-exec` (whitespace + quotes). */
export function parseArgv(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    out.push((match[1] ?? match[2] ?? match[3] ?? "").toString());
  }
  return out;
}

/** Format a typed error into command output (kind surfaced). */
export function describeError(error: unknown): string {
  if (error instanceof RuntimeError) {
    const remedy = error.remedy !== undefined ? `\n${error.remedy}` : "";
    return `[${error.kind}] ${error.message}${remedy}`;
  }
  return `[unexpected] ${error instanceof Error ? error.message : String(error)}`;
}

export { SELECTION_ENTRY_KIND, isWorkspaceAllowed, isEnvironmentAllowed, canonicalWorkspaceKey, errorKindOf };
