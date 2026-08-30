import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_PAGE_TARGET_RECORDS,
  dataforrestClutchpacksDistributedSourceAdapterManifest,
  dataforrestCollectorCryptDistributedSourceAdapterManifest,
  dataforrestEventsV1SourceAdapterManifest,
  dataforrestEventsV1SourceAdapterManifests,
  dataforrestLaunchDistributedSourceAdapterManifest,
  dataforrestNextCursor,
  dataforrestPhygitalsDistributedV2SourceAdapterManifest,
  normalizeDataforrestEventRecordForAdapter,
  type DataforrestEventRecordV1,
} from "./index.ts";

test("Collector Crypt owns an immutable 1,000-record profile without changing historical bounds", () => {
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
  assert.equal(dataforrestEventsV1SourceAdapterManifest.requestBounds.pageLimit, 500);
  assert.equal(dataforrestClutchpacksDistributedSourceAdapterManifest.requestBounds.pageLimit, 2_000);
  assert.equal(dataforrestLaunchDistributedSourceAdapterManifest.requestBounds.pageLimit, 100);
  assert.equal(dataforrestPhygitalsDistributedV2SourceAdapterManifest.requestBounds.pageLimit, 100);
  assert.deepEqual(dataforrestLaunchDistributedSourceAdapterManifest.supportedProviders.map(
    ({ provider }) => provider,
  ), ["courtyard", "collector_crypt", "phygitals"]);
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
