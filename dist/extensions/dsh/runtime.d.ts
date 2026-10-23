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
export declare function composeDshRuntime(options: DshRuntimeOptions): DshRuntime;
//# sourceMappingURL=runtime.d.ts.map