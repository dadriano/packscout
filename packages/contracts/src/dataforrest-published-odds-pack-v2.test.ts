import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V3_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V4_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V3_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V4_VERSION,
  adaptDataforrestEventRecordForAdapter,
  dataforrestCollectorCryptDistributedV3SourceAdapterManifest,
  dataforrestCollectorCryptDistributedV4SourceAdapterManifest,
  dataforrestCourtyardDistributedV3SourceAdapterManifest,
  dataforrestCourtyardDistributedV4SourceAdapterManifest,
  dataforrestEventsJsonNodeBudget,
  dataforrestEventsSourceConfigurationSchemaForAdapter,
} from "./dataforrest-events-v1.ts";
import { collectorCryptPackProviderFactsV1 } from "./dataforrest-collector-crypt-pack-v1.ts";
import { collectorCryptPackProviderFactsV2 } from "./dataforrest-collector-crypt-pack-v2.ts";
import { courtyardPackProviderFactsV1 } from "./dataforrest-courtyard-pack-v1.ts";
import { courtyardPackProviderFactsV2 } from "./dataforrest-courtyard-pack-v2.ts";
import { readDataforrestProviderFacts } from "./dataforrest-provider-facts-registry.ts";

// Synthetic values preserve only the native keys/types documented by each V1 census.
function courtyard() {
  return { title: "Sample", saleDetails: { salePriceUsd: 100, expectedValueUsd: 900 }, buybackRatio: 0.846,
    odds: { buckets: [{ oddsPercent: 33.333, minValueUsd: 0, maxValueUsd: 50 },
      { oddsPercent: 66.667, minValueUsd: 50, maxValueUsd: 150 }] } };
}
function collector() {
  return { name: "Sample", price: { amount: 100 }, targetEV: 900,
    instantBuyback: { percentageOfValue: 90 }, contains: 1,
    weightMultipliers: { common: 0.7, uncommon: 0.2, rare: 0.08, epic: 0.02 },
    tierRanges: { common: { start: 0, end: 50 }, uncommon: { start: 50, end: 150 },
      rare: { start: 150, end: 500 }, epic: { start: 500, end: 2_000 } } };
}

test("pack V2 readers retain published probabilities and ranges without inventing inventory or membership", () => {
  for (const [v1, v2, data] of [
    [courtyardPackProviderFactsV1, courtyardPackProviderFactsV2, courtyard()],
    [collectorCryptPackProviderFactsV1, collectorCryptPackProviderFactsV2, collector()],
  ] as const) {
    const before = structuredClone(data), previous = v1(data), current = v2(data);
    assert.deepEqual({ ...current, evInput: previous.evInput }, previous);
    assert.equal(current.evInput.state, "present");
    if (current.evInput.state !== "present") throw new Error("Expected evidence");
    assert.equal(current.evInput.value.totalQuantity, null);
    assert.equal(current.evInput.value.unitBasis, "per_pack");
    assert.equal(current.evInput.value.drawCount, 1);
    assert.equal(current.evInput.value.currency, "USD");
    assert.ok(current.evInput.value.buckets.every(bucket => bucket.quantity === null));
    assert.equal(current.packMembership, undefined);
    assert.deepEqual(data, before);
    assert.deepEqual(previous.evInput, { state: "absent" });
  }
});

test("Courtyard distinguishes absent odds from malformed or incomplete distributions", () => {
  for (const odds of [undefined, null]) {
    assert.deepEqual(courtyardPackProviderFactsV2({ ...courtyard(), odds }).evInput, { state: "absent" });
  }
  for (const odds of [[], {}, { buckets: [] }, { buckets: Array(1_001).fill(courtyard().odds.buckets[0]) },
    { buckets: [{ oddsPercent: 99, minValueUsd: 0, maxValueUsd: 100 }] },
    ...["100", -1, Infinity, NaN].map(oddsPercent => ({ buckets: [{ oddsPercent, minValueUsd: 0, maxValueUsd: 1 }] })),
    ...[null, -1, Infinity, "100"].map(maxValueUsd => ({ buckets: [{ oddsPercent: 100, minValueUsd: 0, maxValueUsd }] })),
    { buckets: [{ oddsPercent: 100, minValueUsd: 100, maxValueUsd: 50 }] },
  ]) {
    assert.deepEqual(courtyardPackProviderFactsV2({ ...courtyard(), odds }).evInput, { state: "malformed" });
  }
});

test("Collector Crypt requires matching reviewed tier keys, closed probabilities, ranges and one draw", () => {
  assert.deepEqual(collectorCryptPackProviderFactsV2({ ...collector(), weightMultipliers: null, tierRanges: null }).evInput,
    { state: "absent" });
  for (const override of [
    { weightMultipliers: null }, { tierRanges: null }, { contains: 2 }, { contains: null },
    { weightMultipliers: { ...collector().weightMultipliers, common: 0.69 } },
    { weightMultipliers: { ...collector().weightMultipliers, surprise: 0 } },
    { tierRanges: { common: { start: 0, end: 100 } } },
    { tierRanges: { ...collector().tierRanges, epic: { start: 5, end: 4 } } },
    { tierRanges: { ...collector().tierRanges, epic: { start: 5, end: null } } },
    { weightMultipliers: { ...collector().weightMultipliers, epic: "0.02" } },
  ]) {
    assert.deepEqual(collectorCryptPackProviderFactsV2({ ...collector(), ...override }).evInput, { state: "malformed" });
  }
});

test("new odds reader admissions preserve previous pack/card/stream and transport identities", () => {
  for (const [provider, previousVersion, currentVersion, previousManifest, currentManifest, data] of [
    ["courtyard", DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V3_VERSION, DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V4_VERSION,
      dataforrestCourtyardDistributedV3SourceAdapterManifest, dataforrestCourtyardDistributedV4SourceAdapterManifest, courtyard()],
    ["collector_crypt", DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V3_VERSION, DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V4_VERSION,
      dataforrestCollectorCryptDistributedV3SourceAdapterManifest, dataforrestCollectorCryptDistributedV4SourceAdapterManifest, collector()],
  ] as const) {
    const previous = readDataforrestProviderFacts(previousVersion, provider, "pack", data);
    const current = readDataforrestProviderFacts(currentVersion, provider, "pack", data);
    assert.equal(previous?.kind, "pack");
    assert.equal(current?.kind, "pack");
    if (previous?.kind !== "pack" || current?.kind !== "pack") throw new Error("Expected packs");
    assert.equal(previous.evInput.state, "absent");
    assert.equal(current.evInput.state, "present");
    assert.deepEqual({ ...current, evInput: previous.evInput }, previous);
    for (const kind of ["card", "pull", "trade"] as const) {
      assert.deepEqual(readDataforrestProviderFacts(currentVersion, provider, kind, {}),
        readDataforrestProviderFacts(previousVersion, provider, kind, {}));
    }
    for (const crossed of ["clutchpacks", "courtyard", "collector_crypt", "phygitals"] as const) {
      if (crossed !== provider) assert.equal(readDataforrestProviderFacts(currentVersion, crossed, "pack", data), null);
    }
    assert.deepEqual({ ...currentManifest, adapterVersion: previousVersion }, previousManifest);
    assert.equal(dataforrestEventsJsonNodeBudget(currentVersion), dataforrestEventsJsonNodeBudget(previousVersion));
    const configuration = dataforrestEventsSourceConfigurationSchemaForAdapter(currentVersion);
    assert.equal(configuration.safeParse({ platform: provider }).success, true);
    assert.equal(configuration.safeParse({ platform: provider, stream: "catalog" }).success, false);
    const record = { stream: "catalog", entity: "pack" };
    assert.deepEqual(adaptDataforrestEventRecordForAdapter(record, currentVersion),
      adaptDataforrestEventRecordForAdapter(record, previousVersion));
  }
});
