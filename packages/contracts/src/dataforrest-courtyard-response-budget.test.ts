import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION,
  DATAFORREST_COURTYARD_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V3_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V4_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_V2_MAXIMUM_RESPONSE_BYTES,
  DATAFORREST_COURTYARD_DISTRIBUTED_V2_MAXIMUM_JSON_NODES,
  dataforrestEventsJsonNodeBudget,
  dataforrestCourtyardCatalogSourceAdapterManifest,
  dataforrestCourtyardCatalogV2SourceAdapterManifest,
  dataforrestCourtyardDistributedSourceAdapterManifest,
  dataforrestCourtyardDistributedV2SourceAdapterManifest,
  dataforrestCourtyardDistributedV3SourceAdapterManifest,
  dataforrestCourtyardDistributedV4SourceAdapterManifest,
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
  // Catalog-v2 adds the native pack reader on the same reviewed transport
  // admissions; it is a v2-derived profile, not a historical 8 MiB one.
  const catalogV2 = dataforrestCourtyardCatalogV2SourceAdapterManifest;
  assert.equal(catalogV2.adapterVersion, DATAFORREST_COURTYARD_CATALOG_ADAPTER_V2_VERSION);
  assert.deepEqual(catalogV2.requestBounds, manifest.requestBounds);
  assert.equal(dataforrestEventsJsonNodeBudget(catalogV2.adapterVersion), 640_000);
  // Distributed-v3 is the all-stream pack-reading identity. It copies
  // distributed-v2's transport admissions exactly, so it is v2-derived too.
  const distributedV3 = dataforrestCourtyardDistributedV3SourceAdapterManifest;
  assert.equal(
    distributedV3.adapterVersion,
    DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V3_VERSION,
  );
  assert.equal(distributedV3.adapterVersion, "dataforrest-courtyard-distributed-adapter-v3");
  assert.deepEqual(distributedV3.requestBounds, manifest.requestBounds);
  assert.deepEqual(distributedV3.supportedProviders, manifest.supportedProviders);
  assert.equal(dataforrestEventsJsonNodeBudget(distributedV3.adapterVersion), 640_000);
  assert.equal(dataforrestEventsV1SourceAdapterManifests.includes(distributedV3), true);
  // Distributed-v4 changes retained odds interpretation, preserving V3's exact capacity admission.
  const distributedV4 = dataforrestCourtyardDistributedV4SourceAdapterManifest;
  assert.equal(distributedV4.adapterVersion, DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V4_VERSION);
  assert.equal(distributedV4.adapterVersion, "dataforrest-courtyard-distributed-adapter-v4");
  assert.deepEqual(distributedV4.requestBounds, manifest.requestBounds);
  assert.deepEqual(distributedV4.supportedProviders, manifest.supportedProviders);
  assert.equal(dataforrestEventsJsonNodeBudget(distributedV4.adapterVersion), 640_000);
  assert.equal(dataforrestEventsV1SourceAdapterManifests.includes(distributedV4), true);
  for (const historical of dataforrestEventsV1SourceAdapterManifests.filter(
    (candidate) =>
      candidate !== manifest && candidate !== catalog && candidate !== catalogV2
      && candidate !== distributedV3 && candidate !== distributedV4,
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
