import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
  dataforrestIdentityNamespaceByProvider,
  launchProviderKeys,
} from "@packscout/contracts";
import {
  SourceMapperCompatibilityError,
  SourceMapperDescriptorRegistry,
  launchSourceMapperDescriptors,
} from "./source-mapper-descriptors.ts";

test("launch publishes one exact v1 and v2 mapper descriptor per provider", () => {
  assert.deepEqual(
    [...new Set(launchSourceMapperDescriptors.map(({ provider }) => provider))],
    launchProviderKeys,
  );
  assert.equal(launchSourceMapperDescriptors.length, 8);
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
      [
        ["1", PROVIDER_OBSERVATION_CONTRACT_VERSION],
        ["2", PROVIDER_OBSERVATION_CONTRACT_VERSION_V2],
      ],
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
    [{ ...valid, identityNamespaceKey: "different" }, "replacement_namespace_mismatch"],
    [{ ...valid, mapperKey: valid.sourceTypeKey }, "mapper_identity_conflicts_with_source_type"],
  ] as const;

  for (const [input, expectedCode] of cases) {
    assert.throws(
      () => registry.requireCompatible(input),
      (error) =>
        error instanceof SourceMapperCompatibilityError &&
        error.code === expectedCode,
    );
  }
  assert.equal(PROVIDER_OBSERVATION_CONTRACT_VERSION, descriptor.normalizedContractVersion);
});

test("replacement compatibility permits only exact pins and declared v1 to v2 transitions", () => {
  const registry = new SourceMapperDescriptorRegistry();
  const [v1, v2] = launchSourceMapperDescriptors.filter(
    ({ provider }) => provider === "courtyard",
  );
  assert.ok(v1 && v2);
  assert.equal(
    registry.requireReplacementCompatible({
      replacement: v2,
      predecessor: v1,
    }),
    registry.requireCompatible({
      ...v2,
      sourceTypeKey: DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
    }),
  );
  assert.throws(
    () => registry.requireReplacementCompatible({
      replacement: v2,
      predecessor: { ...v1, normalizedContractVersion: "future" },
    }),
    (error) => error instanceof SourceMapperCompatibilityError &&
      error.code === "replacement_contract_mismatch",
  );
});
