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
import type { ExecutionService } from "./execution-service.js";
import type { TargetStore, TargetStoreSnapshot, TargetSelection } from "./target-store.js";
import type { DockerContainer } from "./runtime/docker-adapter.js";
import type { SelectionRecord } from "./selection-state.js";
import { errorKindOf } from "./errors.js";
import { isWorkspaceAllowed, isEnvironmentAllowed } from "./policy.js";
import { canonicalWorkspaceKey } from "./workspace-path.js";
import type { EffectiveConfig, RegistryEntry } from "./types.js";
import { SELECTION_ENTRY_KIND } from "./selection-state.js";
/** UI primitives the command layer needs (structural subset of Pi's). */
export interface CommandUI {
    select(title: string, options: string[], opts?: {
        signal?: AbortSignal;
        timeout?: number;
    }): Promise<string | undefined>;
    confirm(title: string, message: string, opts?: {
        signal?: AbortSignal;
        timeout?: number;
    }): Promise<boolean>;
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
    readonly registry: () => Promise<{
        entries: readonly import("./types.js").RegistryEntry[];
        diagnostics: readonly string[];
    }>;
    /** Re-run host + docker discovery and return the fresh registry. */
    readonly refreshRegistry: () => Promise<{
        entries: readonly import("./types.js").RegistryEntry[];
        diagnostics: readonly string[];
    }>;
    /** Bounded container logs (wired to the docker lifecycle adapter). */
    readonly logs: (container: DockerContainer, options?: {
        tail?: number;
        signal?: AbortSignal;
    }) => Promise<{
        exitCode: number | null;
        output: string;
        truncated: boolean;
    }>;
    /** Optional explicit host runner for `/devcontainer host-exec` (policy-gated). */
    readonly hostRunner?: {
        run(argv: readonly string[], options?: {
            timeoutMs?: number;
            signal?: AbortSignal;
        }): Promise<{
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
    readonly setupCli?: (opts: {
        signal?: AbortSignal;
    }) => Promise<{
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
export declare function generateConfirmationToken(): string;
/** Render the selection + registry state as a compact status block. */
export declare function renderStatus(snapshot: TargetStoreSnapshot, entries: readonly import("./types.js").RegistryEntry[], config: EffectiveConfig): string;
/** Resolve a selection state back into the store, or return an error text. */
export declare function applySelection(services: CommandServices, target: TargetSelection, ctx: CommandContextLike): Promise<void>;
/** Build the selection record from a registry entry + chosen candidate id. */
export declare function selectionFor(entry: import("./types.js").RegistryEntry, candidateId: string | undefined, configPath?: string): TargetSelection;
/**
 * Re-resolve a selection hint against the CURRENT registry.
 *
 * Used by session restore and `/devcontainer up` so a persisted or config-only
 * selection actually becomes usable instead of staying `selected-missing` /
 * `selected-stopped` forever. Matching is by canonical workspace key; a
 * persisted candidate id informs the choice but never overrides the ambiguity
 * check — several running containers still fail closed.
 */
export declare function reconcileSelection(services: Pick<CommandServices, "targetStore" | "registry">, ctx: Pick<CommandContextLike, "persistSelection">, hint: {
    workspaceKey: string;
    candidateId?: string;
}, 
/**
 * Registry entries the caller already fetched. `/devcontainer up` resolves the target
 * through the registry before starting, so discovering again here would run the host
 * scan and `docker ps` twice for one command (review finding on revision-8e6c0670).
 */
preloaded?: readonly RegistryEntry[]): Promise<TargetSelection>;
/** Split `/devcontainer use <selector> [--config <name|path>]`. */
export declare function parseUseArgs(args: string): {
    selector: string;
    config?: string;
};
export type ConfigResolution = {
    readonly ok: true;
    readonly configPath?: string;
} | {
    readonly ok: false;
    readonly text: string;
};
/**
 * The configuration `up`/`build` should hand the CLI, most explicit source first: the
 * operator's `--config` selector, the configuration already selected for that
 * workspace, then the workspace's highest-priority discovered form.
 *
 * Every path returned comes from the discovered candidate set, so no caller can put an
 * arbitrary path into the CLI's `--config`.
 */
export declare function configPathFor(entry: RegistryEntry, requested: {
    selector?: string;
    selectedWorkspaceKey?: string;
    selectedConfigPath?: string;
}): ConfigResolution;
/** Resolve a `--config` selector against every configuration of one workspace. */
export declare function resolveConfigCandidate(entry: RegistryEntry, requested: string): ConfigResolution;
/** Namespaced command handler surface. */
export declare function createCommandHandlers(services: CommandServices): Record<string, (args: string, ctx: CommandContextLike) => Promise<CommandResult>>;
/** Minimal argv splitter for `/devcontainer host-exec` (whitespace + quotes). */
export declare function parseArgv(input: string): string[];
/** Format a typed error into command output (kind surfaced). */
export declare function describeError(error: unknown): string;
export { SELECTION_ENTRY_KIND, isWorkspaceAllowed, isEnvironmentAllowed, canonicalWorkspaceKey, errorKindOf };
//# sourceMappingURL=commands.d.ts.map