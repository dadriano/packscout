import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ProviderMappingAdapter,
  ProviderMappingOutput,
} from "./provider-adapter.ts";
import {
  ProviderAdapterRegistryError,
  ProviderMappingAdapterRegistry,
  ProviderTransportAdapterRegistry,
} from "./provider-adapter-registry.ts";
import { HttpCursorAdapter } from "./http-cursor-adapter.ts";

const platform = "fixture-platform";

class FixtureMappingAdapter implements ProviderMappingAdapter {
  readonly key = "fixture-mapper-v1";
  readonly platformKey = platform;

  mapPage(): ProviderMappingOutput {
    return { outcomes: [] };
  }
}

test("real mapping and transport capabilities register through separate generic registries", () => {
  const mappingAdapter = new FixtureMappingAdapter();
  const mappingRegistry = new ProviderMappingAdapterRegistry();
  mappingRegistry.register(mappingAdapter);
  assert.equal(mappingRegistry.resolve(mappingAdapter.key, platform), mappingAdapter);
  assert.deepEqual(
    mappingRegistry.resolve(mappingAdapter.key, platform).mapPage({
      configuration: {
        providerId: "fixture-provider",
        configurationRevisionId: "fixture-revision",
        platform,
        adapterKey: mappingAdapter.key,
      },
      page: {
        catalog: [],
        pulls: [],
        sales: [],
        next_cursor: "fixture-complete",
        has_more: false,
      },
    }),
    { outcomes: [] },
  );

  const transportAdapter = new HttpCursorAdapter({
    resolveHost: async () => ["93.184.216.34"],
  });
  const transportRegistry = new ProviderTransportAdapterRegistry();
  transportRegistry.register(transportAdapter);
  assert.equal(
    transportRegistry.resolve(transportAdapter.key, platform),
    transportAdapter,
  );
  assert.deepEqual(mappingRegistry.keys(), ["fixture-mapper-v1"]);
  assert.deepEqual(transportRegistry.keys(), ["http-cursor-v1"]);
});

test("registries reject missing capabilities and incompatible platforms", () => {
  const mappingRegistry = new ProviderMappingAdapterRegistry();
  assert.throws(
    () =>
      mappingRegistry.register(
        { key: "fixture-mapper-v1", platformKey: platform } as ProviderMappingAdapter,
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
        key: "fixture-transport-v1",
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
    () => registry.resolve("missing-v1", platform),
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
