import assert from "node:assert/strict";
import { test } from "node:test";
import { countProviderPageRecords, validateProviderPageRecordCounts } from "./provider-page-record-counts.ts";

test("translation counts partition canonical kinds and rejections without reading record bodies", () => {
  const records = [
    { kind: "catalog" as const, entityType: "collectible" },
    { kind: "catalog" as const, entityType: "pack" },
    { kind: "catalog" as const, entityType: "pack_content_snapshot" },
    { kind: "pull" as const }, { kind: "market_event" as const },
    { kind: "catalog" as const, disposition: "quarantine" as const },
    { kind: "pull" as const, disposition: "quarantine" as const },
  ].map(row => Object.defineProperty(row, "candidate", { get() { throw new Error("Do not inspect bodies."); } }));
  assert.deepEqual(countProviderPageRecords(records), { catalogRecordCount: 3, collectibleRecordCount: 1,
    packContentSnapshotCount: 1, pullRecordCount: 1, marketEventRecordCount: 1, rejectedRecordCount: 2 });
});

test("translation counts reject unsafe keys, impossible subsets, mismatched totals and invalid measurements", () => {
  const empty = countProviderPageRecords([]);
  for (const counts of [{ ...empty, payload: "private" }, { ...empty, collectibleRecordCount: 1 },
    { ...empty, catalogRecordCount: -1 }, { ...empty, pullRecordCount: 0.5 },
    { ...empty, rejectedRecordCount: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => validateProviderPageRecordCounts(counts, 0));
  }
  assert.throws(() => validateProviderPageRecordCounts(empty, 1));
  assert.deepEqual(validateProviderPageRecordCounts(empty, 0), empty);
});
