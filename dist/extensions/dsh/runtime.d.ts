import { Service, type Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { ExecutionService } from "../../src/execution-service.js";
import { type HostRuntime } from "../../src/runtime-composition.js";
import { type RegistryResult } from "../../src/runtime/host-discovery.js";
import { TargetStore } from "../../src/target-store.js";
import type { EffectiveConfig } from "../../src/types.js";
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
export declare function composeDshRuntime(options: DshRuntimeOptions): DshRuntime;
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
export declare class DshRuntimeService extends Service implements DshRuntime {
    /** Services this one needs. Empty: it only composes `src/` and the host CLIs. */
    static inject: string[];
    static Config: Schema<DshServiceConfig>;
    /** The workspace this instance manages (canonical host path). */
    readonly workspace: string;
    private readonly inner;
    constructor(ctx: Context, config?: DshServiceConfig);
    get config(): EffectiveConfig;
    get diagnostics(): readonly string[];
    get targetStore(): TargetStore;
    get execution(): ExecutionService;
    get host(): HostRuntime;
    registry(): Promise<RegistryResult>;
    refresh(): Promise<RegistryResult>;
    autoSelect(workspace: string): Promise<void>;
    setAutoSelection(enabled: boolean): void;
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
//# sourceMappingURL=runtime.d.ts.map