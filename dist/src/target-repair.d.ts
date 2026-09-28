import type { TargetSelection, TargetStoreSnapshot } from "./target-store.js";
import type { RegistryEntry } from "./types.js";
export interface TargetRepairContext {
    /** The store's current (parked) selection. */
    readonly snapshot: TargetStoreSnapshot;
    /** The workspace the caller is actually operating on. */
    readonly requestWorkspace: string;
    /** A fresh registry read. */
    readonly entries: readonly RegistryEntry[];
}
/**
 * Resolve the repair for a parked selection, or `undefined` when nothing may be repaired.
 *
 * Returning a `TargetSelection` means "commit this"; `undefined` means "leave the store exactly as it is",
 * so a caller cannot accidentally turn a refusal into a different refusal.
 */
export declare function resolveTargetRepair(context: TargetRepairContext): TargetSelection | undefined;
//# sourceMappingURL=target-repair.d.ts.map