import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V3_VERSION,
  DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION,
  DATAFORREST_COURTYARD_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_PHYGITALS_CATALOG_ADAPTER_VERSION,
  DATAFORREST_PHYGITALS_CATALOG_ADAPTER_V2_VERSION,
  dataforrestCollectorCryptCatalogV2SourceAdapterManifest,
  dataforrestCollectorCryptCatalogV3SourceAdapterManifest,
  dataforrestCollectorCryptDistributedV2SourceAdapterManifest,
  dataforrestCourtyardCatalogSourceAdapterManifest,
  dataforrestCourtyardCatalogV2SourceAdapterManifest,
  dataforrestCourtyardDistributedV2SourceAdapterManifest,
  dataforrestEventsCatalogSourceConfigurationV1Schema,
  dataforrestEventsJsonNodeBudget,
  dataforrestEventsSourceConfigurationSchemaForAdapter,
  dataforrestEventsSourceConfigurationV1Schema,
  dataforrestEventsV1SourceAdapterManifests,
  dataforrestPhygitalsCatalogSourceAdapterManifest,
  dataforrestPhygitalsCatalogV2SourceAdapterManifest,
  dataforrestPhygitalsDistributedV2SourceAdapterManifest,
  normalizeDataforrestEventRecordForAdapter,
  type DataforrestEventRecordV1,
} from "./index.ts";

const catalogProfiles = [
  {
    provider: "collector_crypt",
    version: DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION,
    manifest: dataforrestCollectorCryptCatalogV2SourceAdapterManifest,
    predecessor: dataforrestCollectorCryptDistributedV2SourceAdapterManifest,
    pageLimit: 100,
  },
  {
    provider: "courtyard",
    version: DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION,
    manifest: dataforrestCourtyardCatalogSourceAdapterManifest,
    predecessor: dataforrestCourtyardDistributedV2SourceAdapterManifest,
    pageLimit: 100,
  },
  {
    provider: "phygitals",
    version: DATAFORREST_PHYGITALS_CATALOG_ADAPTER_VERSION,
    manifest: dataforrestPhygitalsCatalogSourceAdapterManifest,
    predecessor: dataforrestPhygitalsDistributedV2SourceAdapterManifest,
    pageLimit: 100,
  },
  // Pack-reader identities. Each keeps its catalog predecessor's transport
  // admissions exactly; the new version exists only to carry the native
  // catalog-pack interpretation, which adapter immutability forbids adding
  // to an already-admitted version.
  {
    provider: "collector_crypt",
    version: DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V3_VERSION,
    manifest: dataforrestCollectorCryptCatalogV3SourceAdapterManifest,
    predecessor: dataforrestCollectorCryptCatalogV2SourceAdapterManifest,
    pageLimit: 100,
  },
  {
    provider: "courtyard",
    version: DATAFORREST_COURTYARD_CATALOG_ADAPTER_V2_VERSION,
    manifest: dataforrestCourtyardCatalogV2SourceAdapterManifest,
    predecessor: dataforrestCourtyardCatalogSourceAdapterManifest,
    pageLimit: 100,
  },
  {
    provider: "phygitals",
    version: DATAFORREST_PHYGITALS_CATALOG_ADAPTER_V2_VERSION,
    manifest: dataforrestPhygitalsCatalogV2SourceAdapterManifest,
    predecessor: dataforrestPhygitalsCatalogSourceAdapterManifest,
    pageLimit: 100,
  },
] as const;

test("catalog profiles keep provider-local bounds under new immutable identities", () => {
  assert.equal(
    DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_VERSION,
    "dataforrest-collector-crypt-catalog-adapter-v1",
  );
  assert.equal(
    DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION,
    "dataforrest-collector-crypt-catalog-adapter-v2",
  );
  assert.equal(
    DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION,
    "dataforrest-courtyard-catalog-adapter-v1",
  );
  assert.equal(
    DATAFORREST_PHYGITALS_CATALOG_ADAPTER_VERSION,
    "dataforrest-phygitals-catalog-adapter-v1",
  );
  assert.equal(
    DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V3_VERSION,
    "dataforrest-collector-crypt-catalog-adapter-v3",
  );
  assert.equal(
    DATAFORREST_COURTYARD_CATALOG_ADAPTER_V2_VERSION,
    "dataforrest-courtyard-catalog-adapter-v2",
  );
  assert.equal(
    DATAFORREST_PHYGITALS_CATALOG_ADAPTER_V2_VERSION,
    "dataforrest-phygitals-catalog-adapter-v2",
  );
  for (const { provider, version, manifest, predecessor, pageLimit } of catalogProfiles) {
    assert.equal(manifest.adapterVersion, version);
    assert.equal(manifest.requestBounds.pageLimit, pageLimit);
    assert.equal(
      manifest.requestBounds.maximumResponseBytes,
      predecessor.requestBounds.maximumResponseBytes,
    );
    assert.equal(
      manifest.requestBounds.timeoutMilliseconds,
      predecessor.requestBounds.timeoutMilliseconds,
    );
    assert.equal(manifest.cursorCodecKey, predecessor.cursorCodecKey);
    assert.equal(
      manifest.normalizedContractVersion,
      predecessor.normalizedContractVersion,
    );
    assert.deepEqual(
      manifest.supportedProviders.map(({ provider: supported }) => supported),
      [provider],
    );
    assert.deepEqual(
      manifest.supportedProviders[0]!.recordIdScopes,
      predecessor.supportedProviders[0]!.recordIdScopes,
    );
    assert.equal(manifest.supportedProviders[0]!.recordIdScopes.length, 4);
    assert.equal(dataforrestEventsV1SourceAdapterManifests.includes(manifest), true);
    assert.equal(
      dataforrestEventsJsonNodeBudget(version),
      dataforrestEventsJsonNodeBudget(predecessor.adapterVersion),
    );
  }
});

test("catalog source configuration is exact and selected only by catalog versions", () => {
  const valid = { platform: "courtyard", stream: "catalog" };
  assert.equal(
    dataforrestEventsCatalogSourceConfigurationV1Schema.safeParse(valid).success,
    true,
  );
  for (const invalid of [
    { platform: "courtyard" },
    { platform: "courtyard", stream: "pulls" },
    { platform: "courtyard", stream: "catalog", cursor: "injected" },
  ]) {
    assert.equal(
      dataforrestEventsCatalogSourceConfigurationV1Schema.safeParse(invalid)
        .success,
      false,
    );
  }
  assert.equal(dataforrestEventsSourceConfigurationV1Schema.safeParse(valid).success, false);
  assert.equal(
    dataforrestEventsSourceConfigurationSchemaForAdapter(
      dataforrestCourtyardDistributedV2SourceAdapterManifest.adapterVersion,
    ),
    dataforrestEventsSourceConfigurationV1Schema,
  );
  for (const { version } of catalogProfiles) {
    assert.equal(
      dataforrestEventsSourceConfigurationSchemaForAdapter(version),
      dataforrestEventsCatalogSourceConfigurationV1Schema,
    );
  }
  const catalogVersions: ReadonlySet<string> = new Set(
    [
      ...catalogProfiles.map(({ version }) => version),
      DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_VERSION,
    ],
  );
  for (const manifest of dataforrestEventsV1SourceAdapterManifests) {
    assert.equal(
      dataforrestEventsSourceConfigurationSchemaForAdapter(
        manifest.adapterVersion,
      ),
      catalogVersions.has(manifest.adapterVersion)
        ? dataforrestEventsCatalogSourceConfigurationV1Schema
        : dataforrestEventsSourceConfigurationV1Schema,
    );
  }
  assert.throws(
    () => dataforrestEventsSourceConfigurationSchemaForAdapter("unknown-adapter"),
    /adapter_version_unsupported/,
  );
});

test("catalog profiles preserve their predecessor provider-facts semantics", () => {
  const records: ReadonlyArray<Readonly<{
    provider: "collector_crypt" | "courtyard" | "phygitals";
    currentVersion: string;
    predecessorVersion: string;
    record: DataforrestEventRecordV1;
  }>> = [
    {
      provider: "collector_crypt",
      currentVersion: DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION,
      predecessorVersion:
        dataforrestCollectorCryptDistributedV2SourceAdapterManifest.adapterVersion,
      record: {
        platform: "collector_crypt",
        stream: "catalog",
        entity: "pack",
        record_id: "collector-pack",
        occurred_at: "2026-08-31T00:00:00Z",
        collected_at: "2026-08-31T00:00:01Z",
        first_seen_at: "2026-08-31T00:00:00Z",
        available: true,
        data: { name: "Collector pack", provider_label: "Ignored label" },
      },
    },
    {
      provider: "courtyard",
      currentVersion: DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION,
      predecessorVersion:
        dataforrestCourtyardDistributedV2SourceAdapterManifest.adapterVersion,
      record: {
        platform: "courtyard",
        stream: "catalog",
        entity: "card",
        record_id: "courtyard-card",
        occurred_at: "2026-08-31T00:00:00Z",
        collected_at: "2026-08-31T00:00:01Z",
        first_seen_at: "2026-08-31T00:00:00Z",
        available: true,
        data: {
          asset: {
            title: "Courtyard card",
            imageUrl: "https://example.test/courtyard.png",
          },
        },
      },
    },
    {
      provider: "phygitals",
      currentVersion: DATAFORREST_PHYGITALS_CATALOG_ADAPTER_VERSION,
      predecessorVersion:
        dataforrestPhygitalsDistributedV2SourceAdapterManifest.adapterVersion,
      record: {
        platform: "phygitals",
        stream: "catalog",
        entity: "card",
        record_id: "phygitals-card",
        occurred_at: "2026-08-31T00:00:00Z",
        collected_at: "2026-08-31T00:00:01Z",
        first_seen_at: "2026-08-31T00:00:00Z",
        available: true,
        data: { inventory: { title: "Phygitals card" } },
      },
    },
  ];

  for (const { provider, currentVersion, predecessorVersion, record } of records) {
    assert.deepEqual(
      normalizeDataforrestEventRecordForAdapter(
        record,
        provider,
        "fixture:catalog-profile",
        currentVersion,
      ),
      normalizeDataforrestEventRecordForAdapter(
        record,
        provider,
        "fixture:catalog-profile",
        predecessorVersion,
      ),
    );
  }
});
