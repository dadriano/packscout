import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_ADAPTER_V2_VERSION,
  DATAFORREST_EVENTS_V1_LEGACY_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
  launchProviderKeys,
} from "@packscout/contracts";
import {
  createProductionSourceAdapterRegistry,
  productionSourceAdapterManifests,
} from "./production-source-adapter-registry.ts";
import { SourceAdapterRegistryError } from "./source-adapter-registry.ts";

test("production registry preserves v1 and v2 pins and advertises only adapter v3", () => {
  const registry = createProductionSourceAdapterRegistry();
  assert.deepEqual(registry.keys(), [DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY]);
  assert.deepEqual(
    productionSourceAdapterManifests.map(({ adapterVersion }) => adapterVersion),
    [DATAFORREST_EVENTS_V1_ADAPTER_VERSION],
  );
  const current = launchProviderKeys.map((provider) => registry.resolve(
    DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
    DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
    provider,
  ));
  const legacy = launchProviderKeys.map((provider) => registry.resolve(
    DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
    DATAFORREST_EVENTS_V1_LEGACY_ADAPTER_VERSION,
    provider,
  ));
  const v2 = launchProviderKeys.map((provider) => registry.resolve(
    DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
    DATAFORREST_EVENTS_V1_ADAPTER_V2_VERSION,
    provider,
  ));
  assert.equal(new Set(current).size, 1);
  assert.equal(new Set(legacy).size, 1);
  assert.equal(new Set(v2).size, 1);
  assert.notEqual(current[0], legacy[0]);
  assert.notEqual(current[0], v2[0]);
  assert.notEqual(v2[0], legacy[0]);
  assert.deepEqual(
    current[0]?.manifest.supportedProviders.map(({ provider }) => provider),
    [...launchProviderKeys],
  );
  assert.equal(
    registry.resolveCurrentVersion(DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY),
    current[0],
  );
  assert.throws(
    () => registry.resolve(
      DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
      "dataforrest-events-adapter-v4",
      "courtyard",
    ),
    (error) =>
      error instanceof SourceAdapterRegistryError &&
      error.code === "adapter_version_mismatch",
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
