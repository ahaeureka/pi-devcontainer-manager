/**
 * Pi session custom-entry serialization and recovery.
 *
 * Selection intent is persisted as an append-only versioned JSON payload in Pi session custom
 * entries. Readers ignore unknown versions and retain a versioned payload so future extension
 * updates can migrate safely (see Migration Notes in the design). The record stores a stable
 * workspace key and a candidate discriminator — never a bare container ID as *authority*, because
 * container IDs are ephemeral across rebuilds.
 *
 * Version 2 adds the two facts the review found missing from the persisted contract
 * (findings L1-02 and L1-04):
 *
 *   - `state: "cleared"` — an explicit `/devcontainer off` is an intent too, so the opt-out
 *     survives a reload instead of being undone by the older record still sitting in the log. An
 *     opt-out carries no workspace: nothing is selected.
 *   - `configPath` — the configuration the operator selected. Without it a reload silently dropped
 *     back to the workspace's primary configuration, which also meant the prompt context and the
 *     host container-path guard were built from a configuration the operator had not chosen.
 *
 * A v1 reader ignores a v2 payload (unknown version) and therefore restores the older `selected`
 * record — i.e. precisely the behaviour that existed before this change, so a session log written
 * by an older build keeps working and nothing needs migrating. A v2 reader understands both.
 */
export declare const SELECTION_ENTRY_KIND = "devcontainer-manager:selection";
export declare const SELECTION_PAYLOAD_VERSION = 2;
/** The v1 payload, still accepted because existing session logs contain it. */
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
export interface SelectionRecordV2 {
    readonly version: 2;
    /** `cleared` is the opt-out tombstone; `selected` carries an intent. */
    readonly state: "selected" | "cleared";
    /** Absent on a tombstone: nothing is selected. */
    readonly workspaceKey?: string;
    /** Stable display name for UI/diagnostics. */
    readonly displayName?: string;
    /** Candidate discriminator (container name preferred, else ID prefix) — a hint, never authority. */
    readonly candidateId?: string;
    /** The configuration the operator selected. Validated against discovery before it is written. */
    readonly configPath?: string;
    /** ISO timestamp of the intent. */
    readonly selectedAt: string;
}
export type SelectionIntent = {
    readonly kind: "selected";
    readonly record: SelectionRecordV2 | SelectionRecordV1;
} | {
    readonly kind: "cleared";
    readonly record: SelectionRecordV2;
};
/** What callers write: a v2 selection or the opt-out tombstone. */
export type SelectionRecord = SelectionRecordV2;
export declare function encodeSelectionRecord(record: SelectionRecord | SelectionRecordV1): string;
export declare function parseSelectionRecord(payload: string): SelectionRecordV2 | undefined;
/** Parse one payload into an intent, accepting both payload versions. */
export declare function parseSelectionIntent(payload: string): SelectionIntent | undefined;
export declare function normalizeSelectionIntent(value: unknown): SelectionIntent | undefined;
export declare function normalizeSelectionRecord(value: unknown): SelectionRecordV2 | undefined;
/**
 * Latest persisted intent from a set of session entries (entries are append-only, so the last
 * parseable record wins — across both payload versions, which is what lets an opt-out survive a
 * later selection and vice versa).
 */
export declare function recoverSelectionIntent(entries: readonly {
    readonly kind: string;
    readonly payload: string;
}[]): SelectionIntent | undefined;
/**
 * The latest persisted *selection*, ignoring an opt-out.
 *
 * Kept for callers that only ever want a selection to reconcile; a tombstone reports `undefined`,
 * which is the same answer as "nothing was ever selected".
 */
export declare function recoverLatestSelection(entries: readonly {
    readonly kind: string;
    readonly payload: string;
}[]): SelectionRecordV2 | undefined;
//# sourceMappingURL=selection-state.d.ts.map