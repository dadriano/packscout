import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
  DATAFORREST_EVENTS_V2_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V3_ADAPTER_VERSION,
  launchProviderKeys,
} from "@packscout/contracts";
import {
  createProductionSourceAdapterRegistry,
  productionSourceAdapterManifests,
} from "./production-source-adapter-registry.ts";
import { SourceAdapterRegistryError } from "./source-adapter-registry.ts";

test("production registry retains v1/v2 pins and selects DataForrest v3 for new work", () => {
  const registry = createProductionSourceAdapterRegistry();
  assert.deepEqual(registry.keys(), [DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY]);
  assert.equal(productionSourceAdapterManifests.length, 1);
  assert.equal(
    productionSourceAdapterManifests[0]?.adapterVersion,
    DATAFORREST_EVENTS_V3_ADAPTER_VERSION,
  );
  const v1 = launchProviderKeys.map((provider) => registry.resolve(
    DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
    DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
    provider,
  ));
  const v2 = launchProviderKeys.map((provider) => registry.resolve(
    DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
    DATAFORREST_EVENTS_V2_ADAPTER_VERSION,
    provider,
  ));
  const v3 = launchProviderKeys.map((provider) => registry.resolve(
    DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
    DATAFORREST_EVENTS_V3_ADAPTER_VERSION,
    provider,
  ));
  assert.equal(new Set(v1).size, 1);
  assert.equal(new Set(v2).size, 1);
  assert.equal(new Set(v3).size, 1);
  assert.notEqual(v1[0], v2[0]);
  assert.deepEqual(
    v3[0]?.manifest.supportedProviders.map(({ provider }) => provider),
    [...launchProviderKeys],
  );
  assert.equal(
    registry.resolveCurrentVersion(DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY),
    v3[0],
  );
});

test("production registry rejects uncompiled alternate source types", () => {
  const registry = createProductionSourceAdapterRegistry();
  assert.throws(
    () => registry.resolve(
      "alternate-bookmark-v1",
      "alternate-bookmark-adapter-v1",
      "courtyard",
    ),
    (error) =>
      error instanceof SourceAdapterRegistryError &&
      error.code === "unknown_source_type",
  );
});

test("production registry composition has no dynamic loading boundary", async () => {
  const source = await readFile(
    new URL("production-source-adapter-registry.ts", import.meta.url),
    "utf8",
  );
  assert.equal(/import\s*\(/u.test(source), false);
  assert.equal(/alternate|bookmark/u.test(source), false);
});
