import assert from "node:assert/strict";
import { test } from "node:test";
import { providerPackContentSnapshotV1Schema, type ProviderPackContentSnapshotV1 } from "./provider-pack-content-snapshot-v1.ts";

const valid: ProviderPackContentSnapshotV1 = {
  schemaVersion: "provider_pack_content_snapshot_v1", providerId: "10000000-0000-4000-8000-000000000001",
  packKey: "pack:one", sourceKey: "provider:inventory:v1", sourceAdapterVersion: "adapter-1", mapperVersion: "1",
  effectiveAt: "2026-08-30T10:00:00.000Z", effectiveAtBasis: "response_observed_at", collectedAt: "2026-08-30T10:00:01.000Z", completeness: "complete",
  items: [{
    collectibleKey: "card:one", collectibleInstanceKey: null, status: "present", totalQuantity: null,
    availableQuantity: null, contentRole: "possible_outcome", probability: null,
    statedValueAmount: null, statedValueCurrency: null, evidenceKinds: ["vendor_inventory"],
    matchConfidenceBasisPoints: 10_000, displayOrder: 0,
  }],
};

test("membership snapshots preserve explicit source clock basis and unknown item odds", () => {
  assert.deepEqual(providerPackContentSnapshotV1Schema.parse(valid), valid);
  assert.equal(providerPackContentSnapshotV1Schema.parse({ ...valid, items: [] }).completeness, "complete");
  assert.equal(providerPackContentSnapshotV1Schema.parse({ ...valid, completeness: "partial" }).completeness, "partial");
});

test("membership snapshots reject malformed identities, clocks, history-only proof and inflated item odds", () => {
  const item = valid.items[0]!;
  for (const value of [
    { ...valid, providerId: "wrong-provider" }, { ...valid, rawPayload: {} },
    { ...valid, effectiveAtBasis: "publication_time" },
    { ...valid, collectedAt: "2026-08-29T10:00:00.000Z" },
    { ...valid, items: [item, item] },
    { ...valid, items: [{ ...item, probability: "0.5" }] },
    { ...valid, items: [{ ...item, probability: "1.5", evidenceKinds: ["vendor_inventory", "vendor_odds"] }] },
    { ...valid, items: [{ ...item, evidenceKinds: ["historical_pull_inference"] }] },
    { ...valid, items: [{ ...item, totalQuantity: "1", availableQuantity: "2" }] },
    { ...valid, items: [{ ...item, statedValueAmount: "2.00" }] },
    { ...valid, items: [{ ...item, availableQuantity: "9223372036854775808" }] },
    { ...valid, items: [{ ...item, evidenceKinds: ["vendor_inventory", "vendor_inventory"] }] },
  ]) assert.equal(providerPackContentSnapshotV1Schema.safeParse(value).success, false);
  assert.equal(providerPackContentSnapshotV1Schema.safeParse({ ...valid, items: [{
    ...item, probability: "0.25", evidenceKinds: ["vendor_inventory", "vendor_odds"],
  }] }).success, true);
});

test("membership snapshot capacity is bounded by both cardinality and serialized bytes", () => {
  const item = valid.items[0]!;
  assert.equal(providerPackContentSnapshotV1Schema.safeParse({
    ...valid, items: Array.from({ length: 1_001 }, (_, index) => ({ ...item, collectibleKey: `card:${index}` })),
  }).success, false);
  assert.equal(providerPackContentSnapshotV1Schema.safeParse({
    ...valid, items: Array.from({ length: 500 }, (_, index) => ({
      ...item, collectibleKey: `card:${index}:${"x".repeat(480)}`, collectibleInstanceKey: "y".repeat(500),
    })),
  }).success, false);
});
