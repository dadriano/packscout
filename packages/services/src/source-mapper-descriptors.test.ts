import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  dataforrestIdentityNamespaceByProvider,
  launchProviderKeys,
} from "@packscout/contracts";
import {
  SourceMapperDescriptorError,
  SourceMapperDescriptorRegistry,
  launchSourceMapperDescriptors,
} from "./source-mapper-descriptors.ts";

test("launch publishes one exact v1 mapper descriptor per provider", () => {
  assert.deepEqual(
    [...new Set(launchSourceMapperDescriptors.map(({ provider }) => provider))],
    launchProviderKeys,
  );
  assert.equal(launchSourceMapperDescriptors.length, 4);
  assert.equal(new Set(launchSourceMapperDescriptors.map(({ mapperKey }) => mapperKey)).size, 4);
  for (const descriptor of launchSourceMapperDescriptors) {
    assert.notEqual(descriptor.mapperKey, DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY);
    assert.equal(
      descriptor.identityNamespaceKey,
      dataforrestIdentityNamespaceByProvider[descriptor.provider],
    );
  }
  for (const provider of launchProviderKeys) {
    const descriptors = launchSourceMapperDescriptors.filter(
      (descriptor) => descriptor.provider === provider,
    );
    assert.deepEqual(
      descriptors.map(({ mapperVersion, normalizedContractVersion }) => [
        mapperVersion,
        normalizedContractVersion,
      ]),
      [["1", PROVIDER_OBSERVATION_CONTRACT_VERSION]],
    );
  }
});

test("activation compatibility fails closed for every mismatched pin", () => {
  const registry = new SourceMapperDescriptorRegistry();
  const descriptor = launchSourceMapperDescriptors[0]!;
  const valid = {
    ...descriptor,
    sourceTypeKey: DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
  };
  assert.deepEqual(registry.requireCompatible(valid), descriptor);

  const cases = [
    [{ ...valid, mapperVersion: "missing" }, "unknown_mapper_descriptor"],
    [{ ...valid, provider: "phygitals" }, "provider_mismatch"],
    [{ ...valid, normalizedContractVersion: "future" }, "normalized_contract_mismatch"],
    [{ ...valid, identityNamespaceKey: "different" }, "identity_namespace_mismatch"],
    [{ ...valid, mapperKey: valid.sourceTypeKey }, "mapper_identity_conflicts_with_source_type"],
  ] as const;

  for (const [input, expectedCode] of cases) {
    assert.throws(
      () => registry.requireCompatible(input),
      (error) =>
        error instanceof SourceMapperDescriptorError &&
        error.code === expectedCode,
    );
  }
  assert.equal(PROVIDER_OBSERVATION_CONTRACT_VERSION, descriptor.normalizedContractVersion);
});
