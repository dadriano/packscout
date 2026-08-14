import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderMappingAdapter } from "./provider-adapter.ts";
import {
  ProviderAdapterRegistryError,
  ProviderMappingAdapterRegistry,
  ProviderTransportAdapterRegistry,
} from "./provider-adapter-registry.ts";
import { HttpCursorAdapter } from "./http-cursor-adapter.ts";

const platform = "fixture-platform";
const fixturePull = {
  stream: "pulls" as const,
  platform,
  record_id: "fixture-pull-001",
  pack_id: "fixture-pack-001",
  card_id: null,
  occurred_at: "2026-08-13T00:00:00Z",
  collected_at: "2026-08-13T00:00:02Z",
  data: {},
};

class FixtureMappingAdapter implements ProviderMappingAdapter {
  readonly key = "fixture-mapper-v2";
  readonly platformKey = platform;

  mapRecord(input: Parameters<ProviderMappingAdapter["mapRecord"]>[0]) {
    return {
      status: "mapped" as const,
      source: {
        platform: input.record.platform,
        recordKind: "pull" as const,
        recordIndex: input.recordIndex,
        externalId: input.record.record_id,
        collectedAt: input.record.collected_at,
        sourceTimestamp: input.record.occurred_at ?? input.record.collected_at,
      },
      candidates: [],
    };
  }
}

const decoder = {
  decode: () => ({
    ok: true as const,
    page: {
      rawPage: {},
      records: [],
      nextCursor: "fixture-head",
      hasMore: false,
    },
  }),
};

test("real mapping and transport capabilities register through separate generic registries", () => {
  const mappingAdapter = new FixtureMappingAdapter();
  const mappingRegistry = new ProviderMappingAdapterRegistry();
  mappingRegistry.register(mappingAdapter);
  assert.equal(mappingRegistry.resolve(mappingAdapter.key, platform), mappingAdapter);
  assert.equal(mappingRegistry.resolveForPlatform(platform), mappingAdapter);
  assert.deepEqual(
    mappingRegistry.resolve(mappingAdapter.key, platform).mapRecord({
      configuration: {
        providerId: "fixture-provider",
        configurationRevisionId: "fixture-revision",
        platform,
        adapterKey: mappingAdapter.key,
      },
      record: fixturePull,
      recordIndex: 4,
    }),
    {
      status: "mapped",
      source: {
        platform,
        recordKind: "pull",
        recordIndex: 4,
        externalId: fixturePull.record_id,
        collectedAt: fixturePull.collected_at,
        sourceTimestamp: fixturePull.occurred_at,
      },
      candidates: [],
    },
  );

  const transportAdapter = new HttpCursorAdapter({
    decoder,
    resolveHost: async () => ["93.184.216.34"],
  });
  const transportRegistry = new ProviderTransportAdapterRegistry();
  transportRegistry.register(transportAdapter);
  assert.equal(
    transportRegistry.resolve(transportAdapter.key, platform),
    transportAdapter,
  );
  assert.deepEqual(mappingRegistry.keys(), ["fixture-mapper-v2"]);
  assert.deepEqual(transportRegistry.keys(), ["http-cursor-v2"]);
});

test("registries reject missing capabilities and incompatible platforms", () => {
  const mappingRegistry = new ProviderMappingAdapterRegistry();
  assert.throws(
    () =>
      mappingRegistry.register(
        { key: "fixture-mapper-v2", platformKey: platform } as ProviderMappingAdapter,
      ),
    (error) =>
      error instanceof ProviderAdapterRegistryError &&
      error.code === "invalid_adapter_capability",
  );

  const mappingAdapter = new FixtureMappingAdapter();
  mappingRegistry.register(mappingAdapter);
  assert.equal(mappingRegistry.has(mappingAdapter.key, platform), true);
  assert.equal(mappingRegistry.has(mappingAdapter.key, "another-platform"), false);
  assert.throws(
    () => mappingRegistry.resolve(mappingAdapter.key, "another-platform"),
    (error) =>
      error instanceof ProviderAdapterRegistryError &&
      error.code === "unsupported_adapter_platform",
  );

  const transportRegistry = new ProviderTransportAdapterRegistry();
  assert.throws(
    () =>
      transportRegistry.register({
        key: "fixture-transport-v2",
        supportsPlatform: () => true,
      } as never),
    (error) =>
      error instanceof ProviderAdapterRegistryError &&
      error.code === "invalid_adapter_capability",
  );
});

test("duplicate, unknown, and executable-looking adapter keys fail closed", () => {
  const adapter = new FixtureMappingAdapter();
  const registry = new ProviderMappingAdapterRegistry([adapter]);
  assert.throws(
    () => registry.register(adapter),
    (error) =>
      error instanceof ProviderAdapterRegistryError &&
      error.code === "duplicate_adapter_key",
  );
  assert.throws(
    () => registry.resolve("missing-v2", platform),
    (error) =>
      error instanceof ProviderAdapterRegistryError &&
      error.code === "unknown_adapter_key",
  );
  for (const key of ["../provider.ts", "provider/module", "load()"] as const) {
    assert.throws(
      () => registry.resolve(key, platform),
      (error) =>
        error instanceof ProviderAdapterRegistryError &&
        error.code === "invalid_adapter_key",
    );
  }
});

test("mapping registry permits exactly one mapper per platform", () => {
  const registry = new ProviderMappingAdapterRegistry([new FixtureMappingAdapter()]);
  assert.throws(
    () =>
      registry.register({
        key: "another-mapper-v2",
        platformKey: platform,
        mapRecord: () => ({
          status: "invalid",
          source: {
            platform,
            recordKind: "pull",
            recordIndex: 0,
            externalId: "fixture-record",
            collectedAt: "2026-08-13T00:00:00Z",
            sourceTimestamp: "2026-08-13T00:00:00Z",
          },
          failure: { reasonCode: "FIXTURE", fieldPath: "data" },
        }),
      }),
    (error) =>
      error instanceof ProviderAdapterRegistryError &&
      error.code === "duplicate_mapping_platform",
  );
});
