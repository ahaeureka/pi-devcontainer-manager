/**
 * Pi session custom-entry serialization and recovery.
 *
 * Selection intent is persisted as an append-only versioned JSON payload in
 * Pi session custom entries. Readers ignore unknown versions and retain a
 * versioned payload so future extension updates can migrate safely (see
 * Migration Notes in the design). The record stores a stable workspace key
 * and a candidate discriminator — never a bare container ID, because
 * container IDs are ephemeral across rebuilds.
 */
export declare const SELECTION_ENTRY_KIND = "devcontainer-manager:selection";
export declare const SELECTION_PAYLOAD_VERSION = 1;
export interface SelectionRecordV1 {
    readonly version: 1;
    readonly workspaceKey: string;
    /** Stable display name for UI/diagnostics. */
    readonly displayName?: string;
    /** Candidate discriminator (container name preferred, else ID prefix). */
    readonly candidateId?: string;
    /** ISO timestamp of the selection intent. */
    readonly selectedAt: string;
}
export type SelectionRecord = SelectionRecordV1;
export declare function encodeSelectionRecord(record: SelectionRecord): string;
export declare function parseSelectionRecord(payload: string): SelectionRecord | undefined;
export declare function normalizeSelectionRecord(value: unknown): SelectionRecord | undefined;
/**
 * Latest persisted record from a set of session entries (entries are
 * append-only, so the last parseable record wins).
 */
export declare function recoverLatestSelection(entries: readonly {
    readonly kind: string;
    readonly payload: string;
}[]): SelectionRecord | undefined;
//# sourceMappingURL=selection-state.d.ts.map