import { describe, expect, it } from "vitest";
import {
  SELECTION_ENTRY_KIND,
  encodeSelectionRecord,
  normalizeSelectionRecord,
  parseSelectionRecord,
  recoverLatestSelection,
  type SelectionRecord,
} from "../../src/selection-state.js";

const base: SelectionRecord = {
  version: 1,
  workspaceKey: "/data/work/proj-a",
  selectedAt: "2026-08-31T00:00:00.000Z",
};

describe("selection-state encoding", () => {
  it("round-trips a record with candidate discriminator", () => {
    const record: SelectionRecord = {
      ...base,
      displayName: "proj-a",
      candidateId: "proj-a-container",
    };
    const decoded = parseSelectionRecord(encodeSelectionRecord(record));
    expect(decoded).toEqual(record);
  });

  it("round-trips a minimal record without candidate", () => {
    const decoded = parseSelectionRecord(encodeSelectionRecord(base));
    expect(decoded).toEqual(base);
  });

  it("rejects invalid JSON", () => {
    expect(parseSelectionRecord("not json")).toBeUndefined();
  });

  it("ignores unknown payload versions", () => {
    expect(parseSelectionRecord(JSON.stringify({ ...base, version: 99 }))).toBeUndefined();
  });

  it("ignores records without a workspace key", () => {
    expect(normalizeSelectionRecord({ version: 1, selectedAt: "2026-08-31T00:00:00.000Z" })).toBeUndefined();
  });

  it("ignores non-object payloads", () => {
    expect(normalizeSelectionRecord("string")).toBeUndefined();
    expect(normalizeSelectionRecord(null)).toBeUndefined();
    expect(normalizeSelectionRecord(42)).toBeUndefined();
  });
});

describe("selection-state recovery", () => {
  it("recovers the latest parseable selection entry", () => {
    const entries = [
      { kind: "other:thing", payload: "{}" },
      {
        kind: SELECTION_ENTRY_KIND,
        payload: encodeSelectionRecord({ ...base, workspaceKey: "/w/one", selectedAt: "2026-08-31T00:00:00.000Z" }),
      },
      {
        kind: SELECTION_ENTRY_KIND,
        payload: encodeSelectionRecord({ ...base, workspaceKey: "/w/two", selectedAt: "2026-08-31T01:00:00.000Z" }),
      },
    ];
    const recovered = recoverLatestSelection(entries);
    expect(recovered?.workspaceKey).toBe("/w/two");
  });

  it("skips unparseable and unknown-version entries", () => {
    const entries = [
      { kind: SELECTION_ENTRY_KIND, payload: "garbage" },
      { kind: SELECTION_ENTRY_KIND, payload: encodeSelectionRecord({ ...base, version: 99 } as unknown as SelectionRecord) },
    ];
    expect(recoverLatestSelection(entries)).toBeUndefined();
  });

  it("returns undefined when no selection entries exist", () => {
    expect(recoverLatestSelection([{ kind: "other", payload: "x" }])).toBeUndefined();
    expect(recoverLatestSelection([])).toBeUndefined();
  });
});
