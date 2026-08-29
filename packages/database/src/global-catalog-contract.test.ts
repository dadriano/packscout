import assert from "node:assert/strict";
import { test } from "node:test";
import { provisionalCollectiblePublicId } from "@packscout/contracts";
import {
  CATALOG_FIXTURE_IDS,
  GLOBAL_CATALOG_CANONICAL_FIXTURES,
  catalogFixtureIdentity,
} from "./global-catalog-canonical-fixtures.ts";
import {
  correlationRequestDigest,
  normalizeCorrelationRequest,
  provisionalCollectibleId,
  resolveAliasChain,
  type CorrelateProviderCollectibleRequest,
} from "./global-catalog-contract.ts";

function propertyUuid(prefix: number, value: number): string {
  const tail = value.toString(16).padStart(12, "0");
  return `${prefix.toString(16).padStart(8, "0")}-0000-4000-8000-${tail}`;
}

test("the five canonical global-catalog fixtures freeze their expected outcomes", () => {
  assert.equal(
    GLOBAL_CATALOG_CANONICAL_FIXTURES.unmatchedProvisional.expectedGlobalCollectibleId,
    "40a85f64-ad56-5575-b21b-8024ee216651",
  );
  assert.deepEqual(
    Object.values(GLOBAL_CATALOG_CANONICAL_FIXTURES).map((fixture) => (
      "expectedOutcome" in fixture ? fixture.expectedOutcome : "merge_alias"
    )),
    ["linked", "provisional_created", "suggested", "unchanged", "merge_alias"],
  );
});

test("property: provisional IDs are stable across retries, case, and processing order", () => {
  const inputs = Array.from({ length: 256 }, (_, index) => ({
    providerId: propertyUuid(0x10000000 + (index % 7), index + 1),
    localCollectibleId: propertyUuid(0x20000000 + (index % 11), 1_000 - index),
  }));
  const forward = new Map(inputs.map((input) => [
    `${input.providerId}:${input.localCollectibleId}`,
    provisionalCollectibleId(input),
  ]));
  for (const input of [...inputs].reverse()) {
    const key = `${input.providerId}:${input.localCollectibleId}`;
    assert.equal(provisionalCollectibleId(input), forward.get(key));
    assert.equal(
      provisionalCollectibleId({
        providerId: input.providerId.toUpperCase(),
        localCollectibleId: input.localCollectibleId.toUpperCase(),
      }),
      forward.get(key),
    );
    assert.equal(provisionalCollectiblePublicId(input), forward.get(key));
  }
  assert.equal(new Set(forward.values()).size, inputs.length);
});

test("property: deterministic evidence order does not change the request digest", () => {
  const base: CorrelateProviderCollectibleRequest = {
    providerId: CATALOG_FIXTURE_IDS.provider,
    localCollectibleId: CATALOG_FIXTURE_IDS.ambiguousLocalCollectible,
    localEntityVersion: 7n,
    collectibleType: "card",
    publicIdentity: catalogFixtureIdentity("Order Property"),
    deterministicEvidence: [],
    ruleVersion: "property-v1",
    providerChangeSequence: 91n,
    observedAt: new Date("2026-08-29T21:00:00.000Z"),
  };
  const evidence = [
    CATALOG_FIXTURE_IDS.firstCanonicalCollectible,
    CATALOG_FIXTURE_IDS.secondCanonicalCollectible,
  ].map((globalCollectibleId) => ({
    providerId: base.providerId,
    localCollectibleId: base.localCollectibleId,
    localEntityVersion: base.localEntityVersion,
    globalCollectibleId,
    collectibleType: base.collectibleType,
    confidenceBasisPoints: 9_500,
  }));
  evidence.push({ ...evidence[0]!, confidenceBasisPoints: 9_000 });
  const first = correlationRequestDigest(normalizeCorrelationRequest({
    ...base,
    deterministicEvidence: evidence,
  }));
  const second = correlationRequestDigest(normalizeCorrelationRequest({
    ...base,
    deterministicEvidence: [...evidence].reverse(),
  }));
  assert.equal(first, second);
});

test("property: correlation replay digest excludes the worker processing timestamp", () => {
  const request = GLOBAL_CATALOG_CANONICAL_FIXTURES.unmatchedProvisional.request;
  const first = correlationRequestDigest(normalizeCorrelationRequest({
    ...request,
    observedAt: new Date("2026-08-29T21:00:00.000Z"),
  }));
  for (let hour = 1; hour <= 256; hour += 1) {
    const retry = correlationRequestDigest(normalizeCorrelationRequest({
      ...request,
      observedAt: new Date(Date.UTC(2026, 7, 29, 21 + hour)),
    }));
    assert.equal(first, retry);
  }
});

test("property: alias chains resolve independently of insertion order and reject cycles", () => {
  for (let length = 2; length <= 32; length += 1) {
    const ids = Array.from({ length }, (_, index) => propertyUuid(0x40000000, index + 1));
    const entries = ids.slice(0, -1).map((id, index) => [id, ids[index + 1]!] as const);
    const aliases = new Map([...entries].reverse());
    const resolution = resolveAliasChain(ids[0]!, aliases);
    assert.equal(resolution.canonicalCollectibleId, ids.at(-1));
    assert.deepEqual(resolution.path, ids);
  }
  const first = propertyUuid(0x50000000, 1);
  const second = propertyUuid(0x50000000, 2);
  assert.throws(
    () => resolveAliasChain(first, new Map([[first, second], [second, first]])),
    /cycle/,
  );
});
