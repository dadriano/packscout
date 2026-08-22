import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_SOURCE_CONTRACT_VERSION,
  dataforrestEventsV1SourceAdapterManifest,
  launchRecordIdScopeDeclarations,
  sourceAdapterManifestV1Schema,
} from "@packscout/contracts";
import type { SourceAdapter } from "./source-adapter.ts";
import {
  SourceAdapterRegistry,
  SourceAdapterRegistryError,
} from "./source-adapter-registry.ts";

function fixtureAdapter(
  sourceTypeKey: string,
  adapterVersion = `${sourceTypeKey}-adapter`,
): SourceAdapter {
  const manifest = sourceAdapterManifestV1Schema.parse({
    providerSourceContractVersion: PROVIDER_SOURCE_CONTRACT_VERSION,
    sourceTypeKey,
    adapterVersion,
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    compatibleConnectionTypeKey: `${sourceTypeKey}-connection`,
    checkpointCodecKey: `${sourceTypeKey}-checkpoint`,
    operatorLabel: "Alternate fixture source",
    requestBounds: {
      pageLimit: 250,
      maximumResponseBytes: 2_097_152,
      timeoutMilliseconds: 10_000,
    },
    maximumConnectionRequestCap: 2,
    capabilities: {
      connectionTest: true,
      sourceTest: true,
      pageRead: true,
      cancellation: true,
    },
    supportedProviders: [{
      provider: "courtyard",
      identityNamespaceKey: "dataforrest-courtyard-records-v1",
      recordIdScopes: [...launchRecordIdScopeDeclarations],
    }],
  });
  return {
    manifest,
    validateConnectionConfiguration: (value) => ({
      ok: true,
      value: Object.freeze(value as Record<string, unknown>),
    }),
    validateSourceConfiguration: (_provider, value) => ({
      ok: true,
      value: Object.freeze(value as Record<string, unknown>),
    }),
    captureUnboundRequest: async () => {
      throw new Error("fixture.not_executable");
    },
    interpretConnectionTest: async () => {
      throw new Error("fixture.not_executable");
    },
    interpretSourceTest: async () => {
      throw new Error("fixture.not_executable");
    },
    interpretPage: async () => { throw new Error("fixture.not_executable"); },
    cancelRequest: (lease) => lease.cancel(),
  };
}

test("compile-time registry resolves two differently shaped source implementations generically", () => {
  const dataforrest = fixtureAdapter(dataforrestEventsV1SourceAdapterManifest.sourceTypeKey);
  const alternate = fixtureAdapter("alternate-bookmark-v1");
  const registry = new SourceAdapterRegistry([dataforrest, alternate]);
  assert.equal(
    registry.resolve(
      "dataforrest-events-v1",
      "dataforrest-events-v1-adapter",
      "courtyard",
    ).manifest.sourceTypeKey,
    dataforrest.manifest.sourceTypeKey,
  );
  assert.equal(
    registry.resolve(
      "alternate-bookmark-v1",
      "alternate-bookmark-v1-adapter",
      "courtyard",
    ).manifest.sourceTypeKey,
    alternate.manifest.sourceTypeKey,
  );
  assert.deepEqual(registry.keys(), ["alternate-bookmark-v1", "dataforrest-events-v1"]);
  assert.equal(JSON.stringify(alternate.manifest).includes("bookmark"), true);
  assert.equal("bookmark" in alternate.manifest, false);
});

test("registry rejects duplicates, invalid manifests, and unsupported providers", () => {
  const adapter = fixtureAdapter("fixture-source-v1");
  const registry = new SourceAdapterRegistry([adapter]);
  assert.throws(
    () => registry.register(adapter),
    (error) =>
      error instanceof SourceAdapterRegistryError &&
      error.code === "duplicate_adapter_registration",
  );
  assert.throws(
    () => registry.resolve(
      "fixture-source-v1",
      "fixture-source-v1-adapter",
      "phygitals",
    ),
    (error) =>
      error instanceof SourceAdapterRegistryError &&
      error.code === "unsupported_provider",
  );
  assert.throws(
    () => registry.resolve("missing-source-v1", "missing-adapter-v1", "courtyard"),
    (error) =>
      error instanceof SourceAdapterRegistryError &&
      error.code === "unknown_source_type",
  );
  assert.throws(
    () => registry.resolve("fixture-source-v1", "stale-adapter-v1", "courtyard"),
    (error) =>
      error instanceof SourceAdapterRegistryError &&
      error.code === "adapter_version_mismatch",
  );
  assert.throws(
    () => new SourceAdapterRegistry([{ ...adapter, manifest: {} } as SourceAdapter]),
    (error) =>
      error instanceof SourceAdapterRegistryError &&
      error.code === "invalid_adapter_manifest",
  );
});

test("pinned runs can resolve two immutable adapter versions for one source type", () => {
  const first = fixtureAdapter("fixture-source-v1", "fixture-adapter-v1");
  const second = fixtureAdapter("fixture-source-v1", "fixture-adapter-v2");
  const registry = new SourceAdapterRegistry([first, second]);

  assert.equal(
    registry.resolve("fixture-source-v1", "fixture-adapter-v1", "courtyard")
      .manifest.adapterVersion,
    first.manifest.adapterVersion,
  );
  assert.equal(
    registry.resolve("fixture-source-v1", "fixture-adapter-v2", "courtyard")
      .manifest.adapterVersion,
    second.manifest.adapterVersion,
  );
  assert.deepEqual(registry.keys(), ["fixture-source-v1"]);
});

test("registration snapshots manifest identity against later mutation", () => {
  const adapter = fixtureAdapter("fixture-source-v1", "fixture-adapter-v1");
  const registry = new SourceAdapterRegistry([adapter]);
  const mutableManifest = adapter.manifest as {
    adapterVersion: string;
    supportedProviders: Array<{ provider: string }>;
  };
  mutableManifest.adapterVersion = "tampered-adapter-v2";
  mutableManifest.supportedProviders.splice(0);

  const resolved = registry.resolve(
    "fixture-source-v1",
    "fixture-adapter-v1",
    "courtyard",
  );
  assert.equal(resolved.manifest.adapterVersion, "fixture-adapter-v1");
  assert.equal(resolved.manifest.supportedProviders[0]?.provider, "courtyard");
  assert.equal(Object.isFrozen(resolved.manifest), true);
  assert.equal(Object.isFrozen(resolved.manifest.supportedProviders), true);
});
