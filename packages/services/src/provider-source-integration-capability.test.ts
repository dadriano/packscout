import assert from "node:assert/strict";
import test from "node:test";
import {
  dataforrestClutchpacksDistributedSourceAdapterManifest,
  dataforrestEventsV1LegacySourceAdapterManifest,
  dataforrestLaunchDistributedSourceAdapterManifest,
  dataforrestPhygitalsDistributedV2SourceAdapterManifest,
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

test("launch registry installs exact tuples for all four providers and refuses unknown tuples", () => {
  const installed = createLaunchSourceIntegrationCapabilities();
  const adapterKey =
    dataforrestLaunchDistributedSourceAdapterManifest.adapterVersion;
  assert.equal(installed.has("courtyard", adapterKey), true);
  assert.equal(installed.has("collector_crypt", adapterKey), true);
  assert.equal(installed.has("phygitals", adapterKey), false);
  assert.equal(installed.has("phygitals",
    dataforrestPhygitalsDistributedV2SourceAdapterManifest.adapterVersion), true);
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
