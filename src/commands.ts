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
import { combineCommandOutput } from "./tool-output.js";
import { canonicalWorkspaceKey } from "./workspace-path.js";
import type { ConfigCandidate, EffectiveConfig, RegistryEntry } from "./types.js";
import { SELECTION_ENTRY_KIND, SELECTION_PAYLOAD_VERSION } from "./selection-state.js";
import { needsExplicitConfig } from "./runtime/devcontainer-adapter.js";

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

/**
 * Deliver a command handler's rendered result to the operator.
 *
 * Pi's command dispatcher ignores a handler's return value — `_tryExecuteExtensionCommand` is
 * `return await command.handler(args, ctx), true` — so a handler that only returns `{ text }`
 * produced no output whatsoever: `/devcontainer list`, `status`, `logs` and the rest were silent
 * even though `CommandResult` is documented as "Markdown rendered into the TUI". The extension
 * owns the UI, so it renders the text through the same channel the handlers' own messages use.
 */
export function displayCommandResult(
  result: CommandResult,
  notify: (message: string, type?: "info" | "warning" | "error") => void,
): void {
  if (result.text.length > 0) notify(result.text, "info");
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
  configPath?: string,
): TargetSelection {
  const state = entry.containerState ?? "exited";
  // A named configuration (or the legacy root form) is invisible to the CLI's own
  // lookup, so it must travel with the operation. Only a DISCOVERED path is ever
  // carried — a caller cannot smuggle an arbitrary `--config` into the argv — and the
  // default-lookup forms stay flag-free so today's argv is unchanged.
  const resolvedConfig =
    configPath !== undefined
      ? candidatesOf(entry).find((candidate) => candidate.configPath === configPath)?.configPath
      : needsExplicitConfig(entry.configKind) && entry.configPath.length > 0
        ? entry.configPath
        : undefined;
  // More than one running container for this workspace: Docker result order
  // must never decide the target. Fail closed until an explicit id is given.
  if (entry.ambiguous === true && candidateId === undefined) {
    const ids = (entry.containerCandidates ?? []).map((c) => c.id).join(", ");
    return {
      status: "selected-ambiguous",
      workspaceKey: entry.workspacePath,
      detail: `Multiple running containers for ${entry.workspacePath}${ids.length > 0 ? `: ${ids}` : ""}. Select one explicitly.`,
    };
  }
  const candidate = candidateId !== undefined
    ? {
        id: candidateId,
        name: candidateId,
        workspaceKey: entry.workspacePath,
        state,
        status: state === "running" ? "running" : "stopped",
        ...(resolvedConfig !== undefined ? { configPath: resolvedConfig } : {}),
      }
    : undefined;
  return {
    status: state === "running" ? "selected-valid" : "selected-stopped",
    ...(candidate !== undefined ? { candidate } : {}),
    workspaceKey: entry.workspacePath,
    ...(state === "running" ? {} : { detail: `Target ${entry.workspacePath} is not running; run /devcontainer up.` }),
  };
}

/**
 * Re-resolve a selection hint against the CURRENT registry.
 *
 * Used by session restore and `/devcontainer up` so a persisted or config-only
 * selection actually becomes usable instead of staying `selected-missing` /
 * `selected-stopped` forever. Matching is by canonical workspace key; a
 * persisted candidate id informs the choice but never overrides the ambiguity
 * check — several running containers still fail closed.
 */
export async function reconcileSelection(
  services: Pick<CommandServices, "targetStore" | "registry">,
  ctx: Pick<CommandContextLike, "persistSelection">,
  hint: { workspaceKey: string; candidateId?: string },
  /**
   * Registry entries the caller already fetched. `/devcontainer up` resolves the target
   * through the registry before starting, so discovering again here would run the host
   * scan and `docker ps` twice for one command (review finding on revision-8e6c0670).
   */
  preloaded?: readonly RegistryEntry[],
): Promise<TargetSelection> {
  const entries = preloaded ?? (await services.registry()).entries;
  const key = canonicalWorkspaceKey(hint.workspaceKey);
  const entry = entries.find((e) => canonicalWorkspaceKey(e.workspacePath) === key);
  if (entry === undefined) {
    const missing: TargetSelection = {
      status: "selected-missing",
      workspaceKey: hint.workspaceKey,
      detail: "Selection restored from session; target not found. Run /devcontainer list.",
    };
    await services.targetStore.select(missing);
    return missing;
  }
  const usableId = hint.candidateId !== undefined && entry.ambiguous !== true ? hint.candidateId : undefined;
  const selection = selectionFor(entry, usableId);
  await services.targetStore.select(selection);
  if (selection.workspaceKey !== undefined) {
    ctx.persistSelection?.({
      version: SELECTION_PAYLOAD_VERSION,
      workspaceKey: selection.workspaceKey,
      ...(selection.candidate?.id !== undefined ? { candidateId: selection.candidate.id } : {}),
      selectedAt: new Date().toISOString(),
    });
  }
  return selection;
}

/** Split `/devcontainer use <selector> [--config <name|path>]`. */
export function parseUseArgs(args: string): { selector: string; config?: string } {
  const match = /(?:^|\s)--config(?:=|\s+)(\S+)/.exec(args);
  const config = match?.[1];
  const selector = args.replace(/(?:^|\s)--config(?:=|\s+)\S+/g, " ").trim();
  return { selector, ...(config !== undefined ? { config } : {}) };
}

export type ConfigResolution =
  | { readonly ok: true; readonly configPath?: string }
  | { readonly ok: false; readonly text: string };

/** Operator-facing name: `<name>` for a named configuration, else `default`. */
function selectorNameOf(candidate: ConfigCandidate): string {
  if (candidate.configKind !== ".devcontainer/<name>/devcontainer.json") return "default";
  const parts = candidate.configPath.split("/");
  return parts[parts.length - 2] ?? "default";
}

/** Every configuration discovered for one workspace (primary form when unlisted). */
function candidatesOf(entry: RegistryEntry): readonly ConfigCandidate[] {
  return entry.configCandidates ?? (entry.configPath.length > 0 ? [{ configPath: entry.configPath, configKind: entry.configKind }] : []);
}

/**
 * The configuration `up`/`build` should hand the CLI, most explicit source first: the
 * operator's `--config` selector, the configuration already selected for that
 * workspace, then the workspace's highest-priority discovered form.
 *
 * Every path returned comes from the discovered candidate set, so no caller can put an
 * arbitrary path into the CLI's `--config`.
 */
export function configPathFor(
  entry: RegistryEntry,
  requested: { selector?: string; selectedWorkspaceKey?: string; selectedConfigPath?: string },
): ConfigResolution {
  if (requested.selector !== undefined) return resolveConfigCandidate(entry, requested.selector);
  const { selectedConfigPath, selectedWorkspaceKey } = requested;
  if (
    selectedConfigPath !== undefined &&
    selectedWorkspaceKey !== undefined &&
    canonicalWorkspaceKey(selectedWorkspaceKey) === canonicalWorkspaceKey(entry.workspacePath)
  ) {
    const validated = resolveConfigCandidate(entry, selectedConfigPath);
    if (validated.ok) return validated;
  }
  return {
    ok: true,
    ...(needsExplicitConfig(entry.configKind) && entry.configPath.length > 0 ? { configPath: entry.configPath } : {}),
  };
}

/** Resolve a `--config` selector against every configuration of one workspace. */
export function resolveConfigCandidate(entry: RegistryEntry, requested: string): ConfigResolution {
  const discovered: readonly ConfigCandidate[] = candidatesOf(entry);
  for (const candidate of discovered) {
    if (candidate.configPath === requested || selectorNameOf(candidate) === requested) {
      return { ok: true, configPath: candidate.configPath };
    }
  }
  const available = discovered.map((candidate) => selectorNameOf(candidate));
  return {
    ok: false,
    text: `[no-candidate] Unknown configuration \`${requested}\` for \`${entry.workspacePath}\`.\nAvailable: ${available.length > 0 ? available.map((name) => `\`${name}\``).join(", ") : "(none)"}.`,
  };
}

/** Namespaced command handler surface. */
export function createCommandHandlers(services: CommandServices): Record<string, (args: string, ctx: CommandContextLike) => Promise<CommandResult>> {
  const handlers: Record<string, (args: string, ctx: CommandContextLike) => Promise<CommandResult>> = {};

  handlers["list"] = async (_args, ctx) => {
    // `list` is the command the extension tells operators to run to refresh;
    // actually re-resolve a stale/missing selection here so it repairs the
    // target instead of only printing the registry.
    const stale = services.targetStore.snapshot();
    if (stale.status === "selected-missing" && stale.workspaceKey !== undefined) {
      await reconcileSelection(services, ctx, { workspaceKey: stale.workspaceKey });
    }
    const { entries } = await services.registry();
    const snapshot = services.targetStore.snapshot();
    return { text: renderStatus(snapshot, entries, services.config) };
  };

  handlers["status"] = async (_args, _ctx) => {
    const { entries } = await services.registry();
    const snapshot = services.targetStore.snapshot();
    return { text: renderStatus(snapshot, entries, services.config) };
  };

  /**
   * Return to the dormant state: clear the target so the session's execution
   * surfaces belong to the host again (AC-5).
   */
  handlers["off"] = async (_args, _ctx) => {
    await services.targetStore.clear();
    return {
      text: "DevContainer target cleared. `bash`, `!`/`!!`, and the file tools are host surfaces again.\nRun /devcontainer use to take over a container again.",
    };
  };

  handlers["use"] = async (args, ctx) => {
    const { entries } = await services.registry();
    const { selector: wanted, config: configSelector } = parseUseArgs(args);
    // Resolve the requested configuration before committing any selection, so an
    // unknown name never changes the target.
    const select = async (entry: RegistryEntry, candidateId: string | undefined): Promise<string | undefined> => {
      const resolved = configSelector === undefined ? { ok: true as const } : resolveConfigCandidate(entry, configSelector);
      if (resolved.ok === false) return resolved.text;
      await applySelection(services, selectionFor(entry, candidateId, resolved.configPath), ctx);
      return undefined;
    };
    // An explicit CONTAINER id selects that candidate of an ambiguous workspace
    // (the only way to resolve 2+ running containers for one workspace).
    if (wanted.length > 0) {
      const byCandidate = entries.find((e) => (e.containerCandidates ?? []).some((c) => c.id === wanted));
      if (byCandidate !== undefined) {
        const failure = await select(byCandidate, wanted);
        if (failure !== undefined) return { text: failure };
        return { text: `Selected \`${byCandidate.workspacePath}\` → container \`${wanted}\`.` };
      }
    }
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
      const only = candidates[0]!;
      if (only.ambiguous === true) {
        const ids = (only.containerCandidates ?? []).map((c) => c.id);
        return {
          text: `[ambiguous-candidate] Multiple running containers for \`${only.workspacePath}\`${ids.length > 0 ? `: ${ids.map((id) => `\`${id}\``).join(", ")}` : ""}.\nRun /devcontainer use <container-id> to pick one.`,
        };
      }
      const failure = await select(only, only.containerId);
      if (failure !== undefined) return { text: failure };
      return { text: `Selected \`${only.workspacePath}\` (${only.containerState ?? "config-only"}).\nRun /devcontainer up if it is not running.` };
    }
    const labels = candidates.map((e) => `${e.workspacePath} [${e.containerState ?? "config-only"}]`);
    const choice = await ctx.ui.select("Select DevContainer target", labels, ctx.signal !== undefined ? { signal: ctx.signal } : undefined);
    if (choice === undefined) return { text: "Selection cancelled." };
    const idx = labels.indexOf(choice);
    if (idx === -1) return { text: "[unexpected] Unknown selection." };
    const picked = candidates[idx]!;
    const pickedFailure = await select(picked, picked.ambiguous === true ? undefined : picked.containerId);
    if (pickedFailure !== undefined) return { text: pickedFailure };
    return { text: `Selected \`${picked.workspacePath}\` (${picked.containerState ?? "config-only"}).\nRun /devcontainer up if it is not running.` };
  };

  /**
   * Resolve which workspace and which configuration an `/devcontainer up`/`build`
   * invocation targets. Shared by both verbs so their argument handling cannot drift,
   * and resolved through the registry so every path handed to the CLI is a discovered
   * one (AC-2).
   */
  const resolveUpBuildTarget = async (
    args: string,
    ctx: CommandContextLike,
  ): Promise<
    | { ok: true; workspace: string; configPath?: string; entries: readonly RegistryEntry[] }
    | { ok: false; text: string }
  > => {
    const { selector, config } = parseUseArgs(args);
    const workspace = selector.length > 0 ? selector : ctx.cwd;
    const { entries } = await services.registry();
    const key = canonicalWorkspaceKey(workspace);
    const entry = entries.find((candidate) => canonicalWorkspaceKey(candidate.workspacePath) === key);
    if (entry === undefined) {
      // Nothing discovered for this path: keep the CLI's own lookup and its own error,
      // unless a configuration was requested explicitly — then nothing can resolve it.
      return config === undefined
        ? { ok: true, workspace, entries }
        : {
            ok: false,
            text: `[no-candidate] No registry entry matches \`${workspace}\`.\nRun /devcontainer list to see available targets.`,
          };
    }
    const snapshot = services.targetStore.snapshot();
    const resolved = configPathFor(entry, {
      ...(config !== undefined ? { selector: config } : {}),
      ...(snapshot.workspaceKey !== undefined ? { selectedWorkspaceKey: snapshot.workspaceKey } : {}),
      ...(snapshot.configPath !== undefined ? { selectedConfigPath: snapshot.configPath } : {}),
    });
    if (resolved.ok === false) return { ok: false, text: resolved.text };
    return {
      ok: true,
      workspace,
      entries,
      ...(resolved.configPath !== undefined ? { configPath: resolved.configPath } : {}),
    };
  };

  handlers["up"] = async (args, ctx) => {
    const target = await resolveUpBuildTarget(args, ctx);
    if (target.ok === false) return { text: target.text };
    const { workspace } = target;
    let outcome: UpBuildOutcome;
    try {
      outcome = await services.execution.up({
        operation: "up",
        initiator: "slash-command",
        workspace,
        ...(target.configPath !== undefined ? { configPath: target.configPath } : {}),
      });
    } catch (error) {
      return { text: describeError(error) };
    }
    const id = outcome.candidateId !== undefined ? `\`${outcome.candidateId}\`` : "(no container id)";
    // A successful `up` must make the selection usable: re-resolve it against
    // the refreshed registry so exec does not fail with target-stopped right
    // after a successful start (config-only / previously-missing selections).
    let reconciled = "";
    try {
      const selection = await reconcileSelection(services, ctx, { workspaceKey: workspace }, target.entries);
      reconciled = `\nselection: ${selection.status}`;
    } catch (error) {
      reconciled = `\nselection: (reconcile failed: ${error instanceof Error ? error.message : String(error)})`;
    }
    return { text: `Up: ${outcome.workspaceKey} → ${id}${reconciled}\n${outcome.remoteUser !== undefined ? `remote user: ${outcome.remoteUser}\n` : ""}${outcome.remoteWorkspaceFolder !== undefined ? `remote folder: ${outcome.remoteWorkspaceFolder}` : ""}` };
  };

  handlers["build"] = async (args, ctx) => {
    const target = await resolveUpBuildTarget(args, ctx);
    if (target.ok === false) return { text: target.text };
    const { workspace } = target;
    let outcome: UpBuildOutcome;
    try {
      outcome = await services.execution.build({
        operation: "build",
        initiator: "slash-command",
        workspace,
        ...(target.configPath !== undefined ? { configPath: target.configPath } : {}),
      });
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
      // Route logs through the shared service: policy-checked and audited like
      // every other operation (it previously bypassed both).
      const result = await services.execution.logs({
        initiator: "slash-command",
        workspace: snapshot.workspaceKey ?? ctx.cwd,
        containerId: container.id,
        tail,
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      });
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
        text: combineCommandOutput(result.stdout, result.stderr) || `(no output, exit ${result.exitCode})`,
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
