import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_PAGE_TARGET_RECORDS,
  DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION,
} from "@packscout/contracts";
import { providerDataforrestLiveIntegrationRegistry } from
  "./provider-dataforrest-live-integration.ts";

test("the worker installs only the exact Collector Crypt 1,000-record tuple", () => {
  const integration = providerDataforrestLiveIntegrationRegistry.resolve(
    "collector_crypt",
    DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_VERSION,
  );

  assert.ok(integration);
  assert.equal(integration.providerKey, "collector_crypt");
  assert.equal(
    integration.manifest.requestBounds.pageLimit,
    DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_PAGE_TARGET_RECORDS,
  );
  assert.equal(integration.manifest.requestBounds.maximumResponseBytes, 8_388_608);
  assert.equal(providerDataforrestLiveIntegrationRegistry.resolveProvider("collector_crypt"), integration);
  assert.equal(providerDataforrestLiveIntegrationRegistry.resolve(
    "collector_crypt", DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION,
  ), null);
  for (const providerKey of ["courtyard", "clutchpacks", "phygitals"]) {
    assert.equal(providerDataforrestLiveIntegrationRegistry.resolve(
      providerKey, DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_VERSION,
    ), null);
  }
  assert.equal(integration.mapper.mapperKey, "collector-crypt-provider-observation");
  assert.equal(integration.mapper.mapperVersion, "1");
  assert.equal(
    integration.mapper.identityNamespaceKey,
    "dataforrest-collector_crypt-records-v1",
  );
  assert.equal(
    providerDataforrestLiveIntegrationRegistry.resolve(
      "collector_crypt",
      DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
    ),
    null,
  );
});

test("the worker installs the exact versioned Phygitals tuple and mapper", () => {
  const integration = providerDataforrestLiveIntegrationRegistry.resolve(
    "phygitals", DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION,
  );
  assert.ok(integration);
  assert.equal(integration.providerKey, "phygitals");
  assert.equal(integration.manifest.requestBounds.pageLimit, 100);
  assert.equal(integration.mapper.mapperKey, "phygitals-provider-observation");
  assert.equal(integration.mapper.mapperVersion, "1");
  assert.equal(integration.mapper.identityNamespaceKey, "dataforrest-phygitals-records-v1");
  assert.equal(providerDataforrestLiveIntegrationRegistry.resolve(
    "phygitals", DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
  ), null);
  assert.equal(providerDataforrestLiveIntegrationRegistry.resolve(
    "phygitals", DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION,
  ), null);
  assert.equal(providerDataforrestLiveIntegrationRegistry.resolve(
    "phygitals", "dataforrest-events-adapter-v3",
  ), null);
  assert.equal(providerDataforrestLiveIntegrationRegistry.resolve(
    "unknown_provider", DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION,
  ), null);
});

test("installed live integrations remain provider-scoped", () => {
  assert.deepEqual(
    providerDataforrestLiveIntegrationRegistry.entries().map(
      ({ providerKey }) => providerKey,
    ),
    ["clutchpacks", "courtyard", "collector_crypt", "phygitals"],
  );
});
