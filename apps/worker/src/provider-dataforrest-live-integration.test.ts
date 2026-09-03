import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V3_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_PAGE_TARGET_RECORDS,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V2_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_PAGE_TARGET_RECORDS,
  DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION,
  DATAFORREST_COURTYARD_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_V2_MAXIMUM_RESPONSE_BYTES,
  DATAFORREST_PHYGITALS_CATALOG_ADAPTER_VERSION,
  DATAFORREST_PHYGITALS_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION,
  type LaunchProviderKey,
} from "@packscout/contracts";
import { providerDataforrestLiveIntegrationRegistry } from
  "./provider-dataforrest-live-integration.ts";

const dualProfiles = Object.freeze([
  {
    providerKey: "collector_crypt" as const,
    baselineAdapterKey:
      DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V2_VERSION,
    catalogAdapterKey: DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION,
    mapperKey: "collector-crypt-provider-observation",
    baselinePageLimit: DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_PAGE_TARGET_RECORDS,
    catalogPageLimit: DATAFORREST_COLLECTOR_CRYPT_CATALOG_PAGE_TARGET_RECORDS,
    maximumResponseBytes: 8_388_608,
  },
  {
    providerKey: "courtyard" as const,
    baselineAdapterKey: DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION,
    catalogAdapterKey: DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION,
    mapperKey: "courtyard-provider-observation",
    baselinePageLimit: 100,
    catalogPageLimit: 100,
    maximumResponseBytes:
      DATAFORREST_COURTYARD_DISTRIBUTED_V2_MAXIMUM_RESPONSE_BYTES,
  },
  {
    providerKey: "phygitals" as const,
    baselineAdapterKey: DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION,
    catalogAdapterKey: DATAFORREST_PHYGITALS_CATALOG_ADAPTER_VERSION,
    mapperKey: "phygitals-provider-observation",
    baselinePageLimit: 100,
    catalogPageLimit: 100,
    maximumResponseBytes: 8_388_608,
  },
]);

test("the worker resolves every baseline and catalog profile by exact tuple", () => {
  for (const profile of dualProfiles) {
    const baseline = providerDataforrestLiveIntegrationRegistry.resolve(
      profile.providerKey,
      profile.baselineAdapterKey,
    );
    const catalog = providerDataforrestLiveIntegrationRegistry.resolve(
      profile.providerKey,
      profile.catalogAdapterKey,
    );

    assert.ok(baseline);
    assert.ok(catalog);
    assert.notEqual(baseline, catalog);
    for (const integration of [baseline, catalog]) {
      assert.equal(integration.providerKey, profile.providerKey);
      assert.equal(integration.mapper.mapperKey, profile.mapperKey);
      assert.equal(integration.mapper.mapperVersion, "1");
      assert.equal(
        integration.mapper.identityNamespaceKey,
        `dataforrest-${profile.providerKey}-records-v1`,
      );
      assert.equal(
        integration.manifest.requestBounds.maximumResponseBytes,
        profile.maximumResponseBytes,
      );
    }
    assert.equal(
      baseline.manifest.adapterVersion,
      profile.baselineAdapterKey,
    );
    assert.equal(catalog.manifest.adapterVersion, profile.catalogAdapterKey);
    assert.equal(
      baseline.manifest.requestBounds.pageLimit,
      profile.baselinePageLimit,
    );
    assert.equal(
      catalog.manifest.requestBounds.pageLimit,
      profile.catalogPageLimit,
    );
  }
});

test("provider-only lookup fails closed for dual-profile providers", () => {
  for (const { providerKey } of dualProfiles) {
    assert.equal(
      providerDataforrestLiveIntegrationRegistry.resolveProvider(providerKey),
      null,
    );
  }

  const clutchpacks = providerDataforrestLiveIntegrationRegistry.resolve(
    "clutchpacks",
    DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
  );
  assert.ok(clutchpacks);
  assert.equal(
    providerDataforrestLiveIntegrationRegistry.resolveProvider("clutchpacks"),
    clutchpacks,
  );
});

test("provider capability admission remains independent of profile ambiguity", () => {
  for (const providerKey of [
    "clutchpacks",
    "collector_crypt",
    "courtyard",
    "phygitals",
  ]) {
    assert.equal(
      providerDataforrestLiveIntegrationRegistry.supportsProvider(providerKey),
      true,
    );
  }
  for (const providerKey of ["unknown_provider", "Courtyard", "", "courtyard\\n"]) {
    assert.equal(
      providerDataforrestLiveIntegrationRegistry.supportsProvider(providerKey),
      false,
    );
    assert.equal(
      providerDataforrestLiveIntegrationRegistry.resolveProvider(providerKey),
      null,
    );
  }
});

test("adapter profiles never resolve across provider boundaries", () => {
  const providerKeys: readonly LaunchProviderKey[] = [
    "clutchpacks",
    "collector_crypt",
    "courtyard",
    "phygitals",
  ];
  const profiles = [
    {
      providerKey: "clutchpacks" as const,
      adapterKey: DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
    },
    ...dualProfiles.flatMap((profile) => [
      { providerKey: profile.providerKey, adapterKey: profile.baselineAdapterKey },
      { providerKey: profile.providerKey, adapterKey: profile.catalogAdapterKey },
    ]),
    {
      providerKey: "collector_crypt" as const,
      adapterKey: DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_VERSION,
    },
  ];

  for (const profile of profiles) {
    for (const providerKey of providerKeys) {
      assert.equal(
        providerDataforrestLiveIntegrationRegistry.resolve(
          providerKey,
          profile.adapterKey,
        ) !== null,
        providerKey === profile.providerKey,
      );
    }
  }
  assert.equal(
    providerDataforrestLiveIntegrationRegistry.resolve(
      "unknown_provider",
      DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION,
    ),
    null,
  );
  assert.equal(
    providerDataforrestLiveIntegrationRegistry.resolve(
      "courtyard",
      "dataforrest-events-adapter-v3",
    ),
    null,
  );
});

test("installed live integrations expose the exact closed profile set", () => {
  assert.deepEqual(
    providerDataforrestLiveIntegrationRegistry.entries().map(
      ({ providerKey, manifest }) => [providerKey, manifest.adapterVersion],
    ),
    [
      ["clutchpacks", DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION],
      ["courtyard", DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION],
      ["courtyard", DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION],
      ["courtyard", DATAFORREST_COURTYARD_CATALOG_ADAPTER_V2_VERSION],
      [
        "collector_crypt",
        DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_VERSION,
      ],
      [
        "collector_crypt",
        DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V2_VERSION,
      ],
      ["collector_crypt", DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION],
      ["collector_crypt", DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V3_VERSION],
      ["phygitals", DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION],
      ["phygitals", DATAFORREST_PHYGITALS_CATALOG_ADAPTER_VERSION],
      ["phygitals", DATAFORREST_PHYGITALS_CATALOG_ADAPTER_V2_VERSION],
    ],
  );
});
