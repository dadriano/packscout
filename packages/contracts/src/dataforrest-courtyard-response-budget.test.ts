import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_V2_MAXIMUM_RESPONSE_BYTES,
  DATAFORREST_COURTYARD_DISTRIBUTED_V2_MAXIMUM_JSON_NODES,
  dataforrestEventsJsonNodeBudget,
  dataforrestCourtyardCatalogSourceAdapterManifest,
  dataforrestCourtyardDistributedSourceAdapterManifest,
  dataforrestCourtyardDistributedV2SourceAdapterManifest,
  dataforrestEventRecordV1Schema,
  dataforrestEventsV1SourceAdapterManifests,
  normalizeDataforrestEventRecordForAdapter,
  providerSourceLaunchBounds,
} from "./index.ts";
import { dataforestEventsV1EvidenceFixture } from "./__fixtures__/dataforest-events-v1.fixture.ts";

test("Courtyard response budget stays isolated to v2-derived immutable profiles", () => {
  const manifest = dataforrestCourtyardDistributedV2SourceAdapterManifest;
  assert.equal(manifest.adapterVersion, DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION);
  assert.equal(manifest.adapterVersion, "dataforrest-courtyard-distributed-adapter-v2");
  assert.equal(DATAFORREST_COURTYARD_DISTRIBUTED_V2_MAXIMUM_RESPONSE_BYTES, 32 * 1024 * 1024);
  assert.equal(DATAFORREST_COURTYARD_DISTRIBUTED_V2_MAXIMUM_JSON_NODES, 640_000);
  assert.equal(dataforrestEventsJsonNodeBudget(manifest.adapterVersion), 640_000);
  assert.deepEqual(manifest.requestBounds, {
    pageLimit: 100, maximumResponseBytes: 32 * 1024 * 1024, timeoutMilliseconds: 10_000,
  });
  assert.deepEqual(manifest.supportedProviders, dataforrestCourtyardDistributedSourceAdapterManifest.supportedProviders);
  assert.deepEqual(manifest.supportedProviders.map(({ provider }) => provider), ["courtyard"]);
  assert.equal(manifest.cursorCodecKey, dataforrestCourtyardDistributedSourceAdapterManifest.cursorCodecKey);
  assert.equal(dataforrestEventsV1SourceAdapterManifests.includes(manifest), true);
  const catalog = dataforrestCourtyardCatalogSourceAdapterManifest;
  assert.equal(catalog.adapterVersion, DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION);
  assert.deepEqual(catalog.requestBounds, manifest.requestBounds);
  assert.equal(dataforrestEventsJsonNodeBudget(catalog.adapterVersion), 640_000);
  for (const historical of dataforrestEventsV1SourceAdapterManifests.filter(
    (candidate) => candidate !== manifest && candidate !== catalog,
  )) {
    assert.equal(historical.requestBounds.maximumResponseBytes, 8 * 1024 * 1024);
    assert.equal(dataforrestEventsJsonNodeBudget(historical.adapterVersion), 480_000);
  }
  assert.equal(providerSourceLaunchBounds.maximumResponseBytes, 8 * 1024 * 1024);
  assert.equal(dataforrestEventsJsonNodeBudget("unknown-profile"), null);
});

test("larger Courtyard transport budget preserves every normalized identity and provider fact", () => {
  const records = dataforestEventsV1EvidenceFixture.courtyard.initial.records.map(
    (record) => dataforrestEventRecordV1Schema.parse(record),
  );
  for (const record of records) {
    const native = record.stream === "catalog" && record.entity === "card"
      ? { ...record, data: { asset: { title: "Reviewed native card", imageUrl: "https://example.test/card.png" } } }
      : record;
    assert.deepEqual(
      normalizeDataforrestEventRecordForAdapter(native, "courtyard", "fixture:record",
        dataforrestCourtyardDistributedV2SourceAdapterManifest.adapterVersion),
      normalizeDataforrestEventRecordForAdapter(native, "courtyard", "fixture:record",
        dataforrestCourtyardDistributedSourceAdapterManifest.adapterVersion),
    );
  }
});
