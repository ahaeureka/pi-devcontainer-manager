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
export const SELECTION_ENTRY_KIND = "devcontainer-manager:selection";
export const SELECTION_PAYLOAD_VERSION = 2;
export function encodeSelectionRecord(record) {
    return JSON.stringify(record);
}
export function parseSelectionRecord(payload) {
    const intent = parseSelectionIntent(payload);
    if (intent === undefined || intent.kind !== "selected")
        return undefined;
    return intent.record.version === 2 ? intent.record : normalizeSelectionRecord(intent.record);
}
/** Parse one payload into an intent, accepting both payload versions. */
export function parseSelectionIntent(payload) {
    let parsed;
    try {
        parsed = JSON.parse(payload);
    }
    catch {
        return undefined;
    }
    return normalizeSelectionIntent(parsed);
}
export function normalizeSelectionIntent(value) {
    if (typeof value !== "object" || value === null)
        return undefined;
    const record = value;
    if (record.version === 1) {
        const legacy = normalizeSelectionRecord(record);
        return legacy === undefined ? undefined : { kind: "selected", record: { ...legacy, state: "selected" } };
    }
    if (record.version !== SELECTION_PAYLOAD_VERSION)
        return undefined;
    const selectedAt = typeof record.selectedAt === "string" ? record.selectedAt : new Date().toISOString();
    if (record.state === "cleared") {
        return { kind: "cleared", record: { version: 2, state: "cleared", selectedAt } };
    }
    if (record.state !== "selected")
        return undefined;
    const normalized = normalizeSelectionRecord({ ...record, version: 1 });
    const workspaceKey = normalized?.workspaceKey;
    if (normalized === undefined || workspaceKey === undefined)
        return undefined;
    const configPath = typeof record.configPath === "string" && record.configPath.length > 0 ? record.configPath : undefined;
    return {
        kind: "selected",
        record: {
            version: 2,
            state: "selected",
            workspaceKey,
            selectedAt: normalized.selectedAt,
            ...(normalized.displayName !== undefined ? { displayName: normalized.displayName } : {}),
            ...(normalized.candidateId !== undefined ? { candidateId: normalized.candidateId } : {}),
            ...(configPath !== undefined ? { configPath } : {}),
        },
    };
}
export function normalizeSelectionRecord(value) {
    if (typeof value !== "object" || value === null)
        return undefined;
    const record = value;
    if (record.version !== 1 && record.version !== SELECTION_PAYLOAD_VERSION)
        return undefined;
    const workspaceKey = typeof record.workspaceKey === "string" ? record.workspaceKey : undefined;
    if (workspaceKey === undefined || workspaceKey.length === 0) {
        return undefined;
    }
    const selectedAt = typeof record.selectedAt === "string" ? record.selectedAt : new Date().toISOString();
    const candidateId = typeof record.candidateId === "string" ? record.candidateId : undefined;
    const displayName = typeof record.displayName === "string" ? record.displayName : undefined;
    const configPath = typeof record.configPath === "string" && record.configPath.length > 0 ? record.configPath : undefined;
    return {
        version: SELECTION_PAYLOAD_VERSION,
        state: "selected",
        workspaceKey,
        selectedAt,
        ...(displayName !== undefined ? { displayName } : {}),
        ...(candidateId !== undefined ? { candidateId } : {}),
        ...(configPath !== undefined ? { configPath } : {}),
    };
}
/**
 * Latest persisted intent from a set of session entries (entries are append-only, so the last
 * parseable record wins — across both payload versions, which is what lets an opt-out survive a
 * later selection and vice versa).
 */
export function recoverSelectionIntent(entries) {
    let latest;
    for (const entry of entries) {
        if (entry.kind !== SELECTION_ENTRY_KIND)
            continue;
        const intent = parseSelectionIntent(entry.payload);
        if (intent !== undefined)
            latest = intent;
    }
    return latest;
}
/**
 * The latest persisted *selection*, ignoring an opt-out.
 *
 * Kept for callers that only ever want a selection to reconcile; a tombstone reports `undefined`,
 * which is the same answer as "nothing was ever selected".
 */
export function recoverLatestSelection(entries) {
    const intent = recoverSelectionIntent(entries);
    if (intent === undefined || intent.kind !== "selected")
        return undefined;
    return intent.record.version === 2 ? intent.record : normalizeSelectionRecord(intent.record);
}
//# sourceMappingURL=selection-state.js.map