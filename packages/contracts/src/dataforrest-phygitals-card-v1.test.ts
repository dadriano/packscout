import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION,
  dataforrestPhygitalsDistributedSourceAdapterManifest,
  normalizeDataforrestEventRecordForAdapter,
  type DataforrestEventRecordV1,
} from "./dataforrest-events-v1.ts";
import { phygitalsCardProviderFactsV1 } from "./dataforrest-phygitals-card-v1.ts";
import { readDataforrestProviderFacts } from "./dataforrest-provider-facts-registry.ts";

function record(data: DataforrestEventRecordV1["data"]): DataforrestEventRecordV1 {
  return {
    platform: "phygitals", stream: "catalog", entity: "card",
    record_id: "envelope-identity", occurred_at: "2026-08-30T01:00:00Z",
    collected_at: "2026-08-30T01:00:01Z", first_seen_at: "2026-08-30T01:00:00Z",
    available: true, data,
  };
}

test("new Phygitals profile reads only evidenced nested wrappers and keeps envelope identity", () => {
  for (const wrapper of ["chase", "asset"] as const) {
    const raw = record({ [wrapper]: {
      id: "native-id-must-not-be-identity", name: "  Reviewed Card  ",
      image: "https://images.example.test/card.png", fmv: 500,
      altFmv: "500", price: 500, currency: null,
      owner: "protected-owner", address: "protected-address", metadata: [],
    } });
    const normalized = normalizeDataforrestEventRecordForAdapter(
      raw, "phygitals", "fixture:native", DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION,
    );
    assert.equal(normalized.providerRecordIdentity.providerRecordId, "envelope-identity");
    assert.deepEqual(normalized.providerFacts.displayName,
      { state: "present", value: "Reviewed Card" });
    assert.deepEqual(normalized.providerFacts.imageReferences,
      { state: "present", value: ["https://images.example.test/card.png"] });
    assert.equal(normalized.providerFacts.kind, "card");
    if (normalized.providerFacts.kind !== "card") assert.fail("card facts required");
    assert.deepEqual(normalized.providerFacts.estimatedValue, { state: "absent" });
    assert.deepEqual(normalized.providerFacts.valueSource, { state: "absent" });
    const serialized = JSON.stringify(normalized);
    assert.equal(serialized.includes("protected-owner"), false);
    assert.equal(serialized.includes("native-id-must-not-be-identity"), false);
  }
  assert.deepEqual(dataforrestPhygitalsDistributedSourceAdapterManifest.supportedProviders
    .map(({ provider }) => provider), ["phygitals"]);
  assert.equal(dataforrestPhygitalsDistributedSourceAdapterManifest.requestBounds.pageLimit, 100);
});

test("old shared launch profile remains unchanged for the same native card", () => {
  const raw = record({ chase: { name: "Nested Card" } });
  const old = normalizeDataforrestEventRecordForAdapter(
    raw, "phygitals", "fixture:native", DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION,
  );
  assert.deepEqual(old.providerFacts.displayName, { state: "absent" });
  assert.equal(readDataforrestProviderFacts(
    DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION, "phygitals", "card", raw.data,
  ), null);
  assert.equal(readDataforrestProviderFacts(
    DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION, "courtyard", "card", raw.data,
  ), null);
});

test("ambiguous, malformed, and unknown card shapes never receive a fallback name", () => {
  for (const native of [
    { chase: { name: "One" }, asset: { name: "Two" } },
    { chase: null, asset: { name: "One" } },
    { chase: [] }, { asset: { name: 42 } }, { asset: { name: " " } },
  ]) {
    assert.deepEqual(phygitalsCardProviderFactsV1(native).displayName,
      { state: "malformed" });
  }
  assert.deepEqual(phygitalsCardProviderFactsV1({
    name: "Unknown top-level name", provider_label: "Unknown fallback",
  }).displayName, { state: "absent" });
  assert.deepEqual(phygitalsCardProviderFactsV1({ asset: { name: "Valid", image: "javascript:unsafe" } })
    .imageReferences, { state: "malformed" });
});
