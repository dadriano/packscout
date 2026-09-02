import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_PAGE_TARGET_RECORDS,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V2_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_PAGE_TARGET_RECORDS,
  dataforrestClutchpacksDistributedSourceAdapterManifest,
  dataforrestCollectorCryptCatalogV2SourceAdapterManifest,
  dataforrestCollectorCryptDistributedSourceAdapterManifest,
  dataforrestCollectorCryptDistributedV2SourceAdapterManifest,
  dataforrestEventsV1SourceAdapterManifest,
  dataforrestEventsV1SourceAdapterManifests,
  dataforrestLaunchDistributedSourceAdapterManifest,
  dataforrestNextCursor,
  dataforrestPhygitalsDistributedV2SourceAdapterManifest,
  normalizeDataforrestEventRecordForAdapter,
  providerSourceRecordsPerRequest,
  type DataforrestEventRecordV1,
} from "./index.ts";

test("Collector Crypt keeps its immutable 1,000-record profile independent of configurable source limits", () => {
  const manifest = dataforrestCollectorCryptDistributedSourceAdapterManifest;
  assert.equal(DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_PAGE_TARGET_RECORDS, 1_000);
  assert.equal(manifest.adapterVersion, DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_VERSION);
  assert.equal(manifest.adapterVersion, "dataforrest-collector-crypt-distributed-adapter-v1");
  assert.deepEqual(manifest.requestBounds, {
    pageLimit: 1_000,
    maximumResponseBytes: 8_388_608,
    timeoutMilliseconds: 10_000,
  });
  assert.equal(manifest.maximumPlatformRequestCap, 2);
  assert.deepEqual(manifest.supportedProviders.map(({ provider }) => provider), ["collector_crypt"]);
  assert.equal(dataforrestEventsV1SourceAdapterManifests.includes(manifest), true);
  assert.equal(dataforrestEventsV1SourceAdapterManifest.requestBounds.pageLimit, 5_000);
  assert.equal(providerSourceRecordsPerRequest.default, 500);
  assert.equal(dataforrestClutchpacksDistributedSourceAdapterManifest.requestBounds.pageLimit, 2_000);
  assert.equal(dataforrestLaunchDistributedSourceAdapterManifest.requestBounds.pageLimit, 100);
  assert.equal(dataforrestPhygitalsDistributedV2SourceAdapterManifest.requestBounds.pageLimit, 100);
  assert.deepEqual(dataforrestLaunchDistributedSourceAdapterManifest.supportedProviders.map(
    ({ provider }) => provider,
  ), ["courtyard", "collector_crypt", "phygitals"]);
});

test("Collector Crypt V2 separates the safe catalog bound from the event profile", () => {
  const distributed = dataforrestCollectorCryptDistributedV2SourceAdapterManifest;
  const catalog = dataforrestCollectorCryptCatalogV2SourceAdapterManifest;

  assert.equal(
    distributed.adapterVersion,
    DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V2_VERSION,
  );
  assert.equal(distributed.requestBounds.pageLimit, 1_000);
  assert.equal(
    catalog.adapterVersion,
    DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION,
  );
  assert.equal(DATAFORREST_COLLECTOR_CRYPT_CATALOG_PAGE_TARGET_RECORDS, 100);
  assert.deepEqual(catalog.requestBounds, {
    pageLimit: 100,
    maximumResponseBytes: 8_388_608,
    timeoutMilliseconds: 10_000,
  });
  for (const manifest of [distributed, catalog]) {
    assert.deepEqual(
      manifest.supportedProviders.map(({ provider }) => provider),
      ["collector_crypt"],
    );
    assert.equal(dataforrestEventsV1SourceAdapterManifests.includes(manifest), true);
  }
});

test("Collector profile changes request size without changing normalized facts or opaque cursor grammar", () => {
  const record: DataforrestEventRecordV1 = {
    platform: "collector_crypt",
    stream: "catalog",
    entity: "pack",
    record_id: "collector-profile-pack",
    occurred_at: "2026-08-30T00:00:00.000Z",
    collected_at: "2026-08-30T00:00:01.000Z",
    first_seen_at: "2026-08-30T00:00:00.000Z",
    available: true,
    data: { name: "Collector fixture pack", provider_label: "Not the pack name" },
  };
  const historical = dataforrestLaunchDistributedSourceAdapterManifest;
  const current = dataforrestCollectorCryptDistributedSourceAdapterManifest;
  assert.deepEqual(
    normalizeDataforrestEventRecordForAdapter(record, "collector_crypt", "fixture:profile", current.adapterVersion),
    normalizeDataforrestEventRecordForAdapter(record, "collector_crypt", "fixture:profile", historical.adapterVersion),
  );
  assert.equal(current.cursorCodecKey, historical.cursorCodecKey);
  for (const manifest of [historical, current]) {
    const requested = {
      sourceInstanceId: "collector-source",
      sourceRevisionId: "collector-revision",
      sourceTypeKey: manifest.sourceTypeKey,
      adapterVersion: manifest.adapterVersion,
      cursorCodecKey: manifest.cursorCodecKey,
      cursorGeneration: 1,
      value: "fixture-current-cursor",
    };
    assert.deepEqual(dataforrestNextCursor(requested, {
      records: [], next_cursor: "fixture-next-cursor", poll_after_seconds: 0,
    }), { ...requested, value: "fixture-next-cursor" });
  }
  assert.throws(() => normalizeDataforrestEventRecordForAdapter(
    record, "courtyard", "fixture:profile", current.adapterVersion,
  ), /platform_mismatch/);
});

test("Collector V2 reads reviewed native cards without redefining V1", () => {
  const record: DataforrestEventRecordV1 = {
    platform: "collector_crypt",
    stream: "catalog",
    entity: "card",
    record_id: "collector-profile-card",
    occurred_at: "2026-09-01T00:00:00.000Z",
    collected_at: "2026-09-01T00:00:01.000Z",
    first_seen_at: "2026-09-01T00:00:00.000Z",
    available: true,
    data: {
      asset: {
        itemName: "Collector fixture card",
        images: { frontImage: "https://images.example.test/card.png" },
      },
      provider_label: "V1 label",
    },
  };

  const v1 = normalizeDataforrestEventRecordForAdapter(
    record,
    "collector_crypt",
    "fixture:profile",
    DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_VERSION,
  );
  const distributedV2 = normalizeDataforrestEventRecordForAdapter(
    record,
    "collector_crypt",
    "fixture:profile",
    DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V2_VERSION,
  );
  const catalogV2 = normalizeDataforrestEventRecordForAdapter(
    record,
    "collector_crypt",
    "fixture:profile",
    DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION,
  );

  assert.deepEqual(v1.providerFacts.displayName, {
    state: "present",
    value: "V1 label",
  });
  for (const current of [distributedV2, catalogV2]) {
    assert.equal(
      current.providerRecordIdentity.providerRecordId,
      "collector-profile-card",
    );
    assert.deepEqual(current.providerFacts.displayName, {
      state: "present",
      value: "Collector fixture card",
    });
    assert.deepEqual(current.providerFacts.imageReferences, {
      state: "present",
      value: ["https://images.example.test/card.png"],
    });
  }
});
