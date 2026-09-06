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

export const SELECTION_ENTRY_KIND = "devcontainer-manager:selection";

export const SELECTION_PAYLOAD_VERSION = 1;

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

export function encodeSelectionRecord(record: SelectionRecord): string {
  return JSON.stringify(record);
}

export function parseSelectionRecord(payload: string): SelectionRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  return normalizeSelectionRecord(parsed);
}

export function normalizeSelectionRecord(value: unknown): SelectionRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== SELECTION_PAYLOAD_VERSION) return undefined;
  if (typeof record.workspaceKey !== "string" || record.workspaceKey.length === 0) {
    return undefined;
  }
  const selectedAt = typeof record.selectedAt === "string" ? record.selectedAt : new Date().toISOString();
  const candidateId = typeof record.candidateId === "string" ? record.candidateId : undefined;
  const displayName = typeof record.displayName === "string" ? record.displayName : undefined;
  return {
    version: SELECTION_PAYLOAD_VERSION,
    workspaceKey: record.workspaceKey,
    selectedAt,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(candidateId !== undefined ? { candidateId } : {}),
  };
}

/**
 * Latest persisted record from a set of session entries (entries are
 * append-only, so the last parseable record wins).
 */
export function recoverLatestSelection(
  entries: readonly { readonly kind: string; readonly payload: string }[],
): SelectionRecord | undefined {
  let latest: SelectionRecord | undefined;
  for (const entry of entries) {
    if (entry.kind !== SELECTION_ENTRY_KIND) continue;
    const record = parseSelectionRecord(entry.payload);
    if (record !== undefined) latest = record;
  }
  return latest;
}
