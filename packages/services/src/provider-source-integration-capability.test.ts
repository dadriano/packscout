import assert from "node:assert/strict";
import test from "node:test";
import {
  dataforrestClutchpacksDistributedSourceAdapterManifest,
  dataforrestCollectorCryptCatalogSourceAdapterManifest,
  dataforrestCollectorCryptCatalogV2SourceAdapterManifest,
  dataforrestCollectorCryptCatalogV3SourceAdapterManifest,
  dataforrestCollectorCryptDistributedSourceAdapterManifest,
  dataforrestCollectorCryptDistributedV2SourceAdapterManifest,
  dataforrestCollectorCryptDistributedV3SourceAdapterManifest,
  dataforrestCourtyardCatalogSourceAdapterManifest,
  dataforrestCourtyardCatalogV2SourceAdapterManifest,
  dataforrestCourtyardDistributedSourceAdapterManifest,
  dataforrestCourtyardDistributedV2SourceAdapterManifest,
  dataforrestCourtyardDistributedV3SourceAdapterManifest,
  dataforrestEventsV1LegacySourceAdapterManifest,
  dataforrestLaunchDistributedSourceAdapterManifest,
  dataforrestPhygitalsCatalogSourceAdapterManifest,
  dataforrestPhygitalsCatalogV2SourceAdapterManifest,
  dataforrestPhygitalsDistributedV2SourceAdapterManifest,
  dataforrestPhygitalsDistributedV3SourceAdapterManifest,
} from "@packscout/contracts";
import {
  ProviderMappingAdapterRegistry,
  ProviderTransportAdapterRegistry,
} from "./provider-adapter-registry.ts";
import {
  CLUTCHPACKS_CAPTURE_ADAPTER_KEY,
  createClutchpacksSourceIntegrationCapabilities,
  createLaunchSourceIntegrationCapabilities,
  providerSourceIntegrationCapability,
  ProviderSourceIntegrationCapabilityRegistry,
} from "./provider-source-integration-capability.ts";

test("ClutchPacks advertises capture and only the current live DataForrest adapter", () => {
  const installed = createClutchpacksSourceIntegrationCapabilities();

  assert.deepEqual(installed.keys(), [
    `clutchpacks:${dataforrestClutchpacksDistributedSourceAdapterManifest.adapterVersion}`,
    `clutchpacks:${CLUTCHPACKS_CAPTURE_ADAPTER_KEY}`,
  ].sort());
  assert.equal(
    installed.has("clutchpacks", CLUTCHPACKS_CAPTURE_ADAPTER_KEY),
    true,
  );
  assert.equal(
    installed.has(
      "clutchpacks",
      dataforrestClutchpacksDistributedSourceAdapterManifest.adapterVersion,
    ),
    true,
  );
  assert.equal(
    installed.has(
      "clutchpacks",
      dataforrestEventsV1LegacySourceAdapterManifest.adapterVersion,
    ),
    false,
  );
  assert.equal(
    installed.has(
      "clutchpacks",
      dataforrestClutchpacksDistributedSourceAdapterManifest.sourceTypeKey,
    ),
    false,
  );
});

test("only explicitly installed source integrations advertise execution capability", () => {
  const installed = new ProviderSourceIntegrationCapabilityRegistry([
    providerSourceIntegrationCapability("courtyard", "source_alpha"),
    providerSourceIntegrationCapability("clutchpacks", "source_beta"),
  ]);

  assert.deepEqual(installed.keys(), [
    "clutchpacks:source_beta",
    "courtyard:source_alpha",
  ]);
  assert.equal(installed.has("courtyard", "source_alpha"), true);
  assert.equal(
    installed.resolve("courtyard", "source_alpha")?.mapperKey,
    "courtyard-provider-observation",
  );
  assert.equal(installed.has("clutchpacks", "source_alpha"), false);
  assert.equal(installed.has("clutchpacks", "source_beta"), true);
  assert.equal(
    installed.has("courtyard", "configured_but_not_installed"),
    false,
  );

  const mappings = new ProviderMappingAdapterRegistry();
  const transports = new ProviderTransportAdapterRegistry();
  assert.deepEqual(mappings.keys(), []);
  assert.deepEqual(transports.keys(), []);
  assert.equal(
    installed.has("courtyard", "legacy_mapping_or_transport"),
    false,
  );
});

test("launch registry installs exact live and catalog tuples and refuses crossed tuples", () => {
  const installed = createLaunchSourceIntegrationCapabilities();
  const adapterKey =
    dataforrestLaunchDistributedSourceAdapterManifest.adapterVersion;
  const catalogProfiles = [
    ["courtyard", dataforrestCourtyardCatalogSourceAdapterManifest.adapterVersion],
    ["collector_crypt", dataforrestCollectorCryptCatalogV2SourceAdapterManifest.adapterVersion],
    ["phygitals", dataforrestPhygitalsCatalogSourceAdapterManifest.adapterVersion],
  ] as const;

  assert.deepEqual(installed.keys(), [
    `clutchpacks:${CLUTCHPACKS_CAPTURE_ADAPTER_KEY}`,
    `clutchpacks:${dataforrestClutchpacksDistributedSourceAdapterManifest.adapterVersion}`,
    `collector_crypt:${dataforrestCollectorCryptCatalogV2SourceAdapterManifest.adapterVersion}`,
    `collector_crypt:${dataforrestCollectorCryptDistributedSourceAdapterManifest.adapterVersion}`,
    `collector_crypt:${dataforrestCollectorCryptDistributedV2SourceAdapterManifest.adapterVersion}`,
    `courtyard:${dataforrestCourtyardCatalogSourceAdapterManifest.adapterVersion}`,
    `courtyard:${dataforrestCourtyardDistributedV2SourceAdapterManifest.adapterVersion}`,
    `phygitals:${dataforrestPhygitalsCatalogSourceAdapterManifest.adapterVersion}`,
    `phygitals:${dataforrestPhygitalsDistributedV2SourceAdapterManifest.adapterVersion}`,
    // Pack-reading catalog versions, admitted before activation so the admin
    // admission gate does not refuse a run with PROVIDER_SOURCE_ADAPTER_UNAVAILABLE.
    `courtyard:${dataforrestCourtyardCatalogV2SourceAdapterManifest.adapterVersion}`,
    `collector_crypt:${dataforrestCollectorCryptCatalogV3SourceAdapterManifest.adapterVersion}`,
    `phygitals:${dataforrestPhygitalsCatalogV2SourceAdapterManifest.adapterVersion}`,
    // Pack-reading DISTRIBUTED versions. Production runs all-stream sources for
    // these providers, so these - not the catalog-scoped ones - are the tuples
    // an activated production source needs admitted.
    `courtyard:${dataforrestCourtyardDistributedV3SourceAdapterManifest.adapterVersion}`,
    `collector_crypt:${dataforrestCollectorCryptDistributedV3SourceAdapterManifest.adapterVersion}`,
    `phygitals:${dataforrestPhygitalsDistributedV3SourceAdapterManifest.adapterVersion}`,
  ].sort());
  for (const [providerKey, adapterVersion] of [
    ["courtyard", dataforrestCourtyardCatalogV2SourceAdapterManifest.adapterVersion],
    ["collector_crypt", dataforrestCollectorCryptCatalogV3SourceAdapterManifest.adapterVersion],
    ["phygitals", dataforrestPhygitalsCatalogV2SourceAdapterManifest.adapterVersion],
    ["courtyard", dataforrestCourtyardDistributedV3SourceAdapterManifest.adapterVersion],
    ["collector_crypt", dataforrestCollectorCryptDistributedV3SourceAdapterManifest.adapterVersion],
    ["phygitals", dataforrestPhygitalsDistributedV3SourceAdapterManifest.adapterVersion],
  ] as const) {
    assert.equal(installed.has(providerKey, adapterVersion), true,
      `${providerKey} must be admitted on ${adapterVersion}`);
    for (const crossedProviderKey of [
      "clutchpacks", "collector_crypt", "courtyard", "phygitals",
    ]) {
      if (crossedProviderKey !== providerKey) {
        assert.equal(installed.has(crossedProviderKey, adapterVersion), false);
      }
    }
  }
  assert.equal(installed.has("courtyard", adapterKey), false);
  assert.equal(installed.has("courtyard",
    dataforrestCourtyardDistributedSourceAdapterManifest.adapterVersion), false);
  assert.equal(installed.has("courtyard",
    dataforrestCourtyardDistributedV2SourceAdapterManifest.adapterVersion), true);
  for (const providerKey of ["clutchpacks", "collector_crypt", "phygitals"]) {
    assert.equal(installed.has(providerKey,
      dataforrestCourtyardDistributedV2SourceAdapterManifest.adapterVersion), false);
  }
  assert.equal(installed.has("collector_crypt", adapterKey), false);
  assert.equal(installed.has("collector_crypt",
    dataforrestCollectorCryptDistributedV2SourceAdapterManifest.adapterVersion), true);
  assert.equal(installed.has("collector_crypt",
    dataforrestCollectorCryptDistributedSourceAdapterManifest.adapterVersion), true);
  for (const providerKey of ["courtyard", "clutchpacks", "phygitals"]) {
    assert.equal(installed.has(providerKey,
      dataforrestCollectorCryptDistributedV2SourceAdapterManifest.adapterVersion), false);
  }
  assert.equal(installed.has("collector_crypt",
    dataforrestCollectorCryptCatalogSourceAdapterManifest.adapterVersion), false);
  assert.equal(installed.has("phygitals", adapterKey), false);
  assert.equal(installed.has("phygitals",
    dataforrestPhygitalsDistributedV2SourceAdapterManifest.adapterVersion), true);
  for (const [providerKey, catalogAdapterVersion] of catalogProfiles) {
    assert.equal(installed.has(providerKey, catalogAdapterVersion), true);
    for (const crossedProviderKey of ["clutchpacks", "collector_crypt", "courtyard", "phygitals"]) {
      if (crossedProviderKey !== providerKey) {
        assert.equal(installed.has(crossedProviderKey, catalogAdapterVersion), false);
      }
    }
  }
  assert.equal(installed.has("clutchpacks",
    dataforrestClutchpacksDistributedSourceAdapterManifest.adapterVersion), true);
  assert.equal(installed.has("clutchpacks", adapterKey), false);
  assert.equal(installed.has("unknown_provider", adapterKey), false);
  for (const providerKey of ["courtyard", "collector_crypt", "phygitals"]) {
    assert.equal(installed.has(providerKey, "dataforrest-events-adapter-v3"), false);
    assert.equal(installed.has(providerKey,
      dataforrestClutchpacksDistributedSourceAdapterManifest.adapterVersion), false);
  }
});

test("invalid or duplicate source capability declarations fail closed", () => {
  assert.throws(
    () => new ProviderSourceIntegrationCapabilityRegistry([
      providerSourceIntegrationCapability("courtyard", "source_alpha"),
      providerSourceIntegrationCapability("courtyard", "source_alpha"),
    ]),
    /duplicated/,
  );
  assert.throws(
    () => new ProviderSourceIntegrationCapabilityRegistry([
      providerSourceIntegrationCapability("courtyard", "INVALID KEY"),
    ]),
    /invalid/,
  );
});
