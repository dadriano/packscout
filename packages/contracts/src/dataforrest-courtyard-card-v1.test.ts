import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_VERSION,
  dataforrestCourtyardDistributedSourceAdapterManifest,
  dataforrestEventRecordV1Schema,
  dataforrestEventsV1SourceAdapterManifests,
  dataforrestLaunchDistributedSourceAdapterManifest,
  normalizeDataforrestEventRecordForAdapter,
  type DataforrestEventRecordV1,
} from "./index.ts";
import { readDataforrestProviderFacts } from "./dataforrest-provider-facts-registry.ts";
import { dataforestEventsV1EvidenceFixture } from "./__fixtures__/dataforest-events-v1.fixture.ts";

const version = DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_VERSION;
function observation(data: DataforrestEventRecordV1["data"], adapterVersion: string = version) {
  return normalizeDataforrestEventRecordForAdapter({
    stream: "catalog", entity: "card", platform: "courtyard",
    record_id: "envelope-courtyard-card", occurred_at: "2026-08-30T01:00:00Z",
    collected_at: "2026-08-30T01:00:01Z", first_seen_at: "2026-08-30T01:00:00Z",
    available: true, data,
  }, "courtyard", "fixture:record", adapterVersion);
}

test("Courtyard native cards have a separate immutable 100-record profile", () => {
  const manifest = dataforrestCourtyardDistributedSourceAdapterManifest;
  assert.equal(version, "dataforrest-courtyard-distributed-adapter-v1");
  assert.equal(manifest.adapterVersion, version);
  assert.deepEqual(manifest.requestBounds, {
    pageLimit: 100, maximumResponseBytes: 8_388_608, timeoutMilliseconds: 10_000,
  });
  assert.deepEqual(manifest.supportedProviders.map(({ provider }) => provider), ["courtyard"]);
  assert.equal(dataforrestEventsV1SourceAdapterManifests.includes(manifest), true);
  assert.deepEqual(manifest.supportedProviders[0],
    dataforrestLaunchDistributedSourceAdapterManifest.supportedProviders.find(
      ({ provider }) => provider === "courtyard",
    ));
  assert.equal(manifest.cursorCodecKey, dataforrestLaunchDistributedSourceAdapterManifest.cursorCodecKey);
  assert.equal(dataforrestLaunchDistributedSourceAdapterManifest.requestBounds.pageLimit, 100);
});

test("Courtyard selects exact asset or reveal title/image fields and retains envelope identity", () => {
  for (const [wrapper, imageField] of [["asset", "imageUrl"], ["reveal", "image"]] as const) {
    const result = observation({ [wrapper]: {
      title: "  Reviewed card  ", [imageField]: "https://example.test/card.png",
      objectID: "unreviewed-native-id", collectible_id: "unreviewed-native-id",
      owner: "protected-owner", estimatedValueUsd: 500, fmv_estimate_usd: 500,
      price: { amountUsd: 500, currency: "USD" }, metadata: { name: "Do not infer" },
    } });
    assert.deepEqual(result.providerRecordIdentity, {
      recordIdScopeKey: "catalog-card-v1", providerRecordId: "envelope-courtyard-card",
    });
    assert.deepEqual(result.providerFacts.displayName, { state: "present", value: "Reviewed card" });
    assert.deepEqual(result.providerFacts.imageReferences,
      { state: "present", value: ["https://example.test/card.png"] });
    assert.equal(result.providerFacts.kind, "card");
    if (result.providerFacts.kind !== "card") assert.fail("expected card facts");
    assert.deepEqual(result.providerFacts.estimatedValue, { state: "absent" });
    assert.deepEqual(result.providerFacts.valueSource, { state: "absent" });
    const serialized = JSON.stringify(result);
    for (const forbidden of ["unreviewed-native-id", "protected-owner", "Do not infer", "500"]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  }
});

test("supplied asset takes precedence without borrowing reveal names or images", () => {
  const result = observation({
    asset: { title: "Asset title" },
    reveal: { title: "Different reveal title", image: "https://example.test/reveal.png" },
  });
  assert.deepEqual(result.providerFacts.displayName, { state: "present", value: "Asset title" });
  assert.deepEqual(result.providerFacts.imageReferences, { state: "absent" });
  for (const asset of [null, [], 1, { title: 1 }, { title: " " }, { title: "x".repeat(10_001) }]) {
    assert.deepEqual(observation({ asset, reveal: { title: "Fallback prohibited" } })
      .providerFacts.displayName, { state: "malformed" });
  }
  const absentAssets: DataforrestEventRecordV1["data"][string][] = [{}, { title: null }];
  for (const asset of absentAssets) {
    assert.deepEqual(observation({ asset, reveal: { title: "Fallback prohibited" } })
      .providerFacts.displayName, { state: "absent" });
  }
  assert.equal(observation({ asset: { title: "x".repeat(10_000) } })
    .providerFacts.displayName.state, "present");
});

test("absent or malformed reveal names never infer labels from prices or history", () => {
  for (const reveal of [null, [], { title: 42 }, { title: "" }]) {
    assert.deepEqual(observation({ reveal }).providerFacts.displayName, { state: "malformed" });
  }
  const unnamed: DataforrestEventRecordV1["data"][] = [{}, { reveal: {} }, {
    provider_label: "Not the reviewed native field",
    prices: { priceHistory: [{ title: "Unreviewed historical title" }] },
  }];
  for (const data of unnamed) {
    assert.deepEqual(observation(data).providerFacts.displayName, { state: "absent" });
  }
});

test("optional native images keep the HTTPS, credential, fragment and length guards", () => {
  for (const imageUrl of ["http://example.test/image", "javascript:unsafe", "https://u:p@example.test/a",
    "https://example.test/a#fragment", "x".repeat(2_049), 42, " "]) {
    const result = observation({ asset: { title: "Valid title", imageUrl } });
    assert.deepEqual(result.providerFacts.imageReferences, { state: "malformed" });
    assert.deepEqual(result.providerFacts.displayName, { state: "present", value: "Valid title" });
  }
});

test("shared launch interpretation is unchanged and native mapping is Courtyard-only", () => {
  const data = { asset: { title: "Native title" } };
  const historical = dataforrestLaunchDistributedSourceAdapterManifest.adapterVersion;
  assert.deepEqual(observation(data, historical).providerFacts.displayName, { state: "absent" });
  assert.deepEqual(observation({ ...data, provider_label: "Historical label" }, historical)
    .providerFacts.displayName, { state: "present", value: "Historical label" });
  for (const provider of ["clutchpacks", "collector_crypt", "phygitals"] as const) {
    assert.equal(readDataforrestProviderFacts(version, provider, "card", data), null);
  }
});

test("Courtyard profile preserves complete normalized pack, pull and event facts and identity", () => {
  const records = dataforestEventsV1EvidenceFixture.courtyard.initial.records.map(
    (record) => dataforrestEventRecordV1Schema.parse(record),
  ).filter(
    (record) => record.stream !== "catalog" || record.entity === "pack",
  );
  assert.deepEqual(records.map(({ stream }) => stream), ["catalog", "pulls", "trades"]);
  for (const record of records) {
    assert.deepEqual(
      normalizeDataforrestEventRecordForAdapter(record, "courtyard", "fixture:record", version),
      normalizeDataforrestEventRecordForAdapter(record, "courtyard", "fixture:record",
        dataforrestLaunchDistributedSourceAdapterManifest.adapterVersion),
    );
  }
});
