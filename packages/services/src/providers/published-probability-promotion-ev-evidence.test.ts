import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V4_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V4_VERSION,
  PROVIDER_PACK_EV_EVIDENCE_SCHEMA_VERSION,
  dataforrestEventRecordV1Schema,
  normalizeDataforrestEventRecordForAdapter,
  providerIdentityNamespaceByLaunchProvider,
  providerPackEvEvidenceV1Schema,
  type ProviderPackEvEvidenceV1,
} from "@packscout/contracts";
import { createPackScoutBuybackEvPromotionEligibilityV1 } from "../buyback-adjusted-ev-promotion.ts";
import { normalizeProviderPromotionEvEvidenceV1 } from "./provider-promotion-ev-evidence.ts";
import { createProviderObservationMapperRegistryFromManifest } from "./provider-mapper-manifest.ts";
import { mapperInput } from "./provider-observation-mapper.test-support.ts";

const ORGANIZATION_ID = "62000000-0000-4000-8000-000000000001";
const PROVIDER_ID = "62000000-0000-4000-8000-000000000002";
const PACK_ID = "62000000-0000-4000-8000-000000000003";
const EFFECTIVE_AT = "2026-09-04T18:00:00.000Z";
const COLLECTED_AT = "2026-09-04T18:05:00.000Z";
const SNAPSHOT_AT = "2026-09-04T18:06:00.000Z";
const READ_AT = "2026-09-04T18:10:00.000Z";
const fixtures = [
  { providerKey: "courtyard", adapterVersion: DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V4_VERSION,
    poolKind: "finite", currentPoolEvidence: "unavailable",
    rateBasisPoints: 8460, grossEvMinor: 8460,
    native: { title: "Sample pack", saleDetails: { salePriceUsd: 100, expectedValueUsd: 9999 }, buybackRatio: 0.846,
      odds: { buckets: [{ oddsPercent: 33.333, minValueUsd: 100, maxValueUsd: 100 },
        { oddsPercent: 66.667, minValueUsd: 100, maxValueUsd: 100 }] } } },
  { providerKey: "collector_crypt", adapterVersion: DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V4_VERSION,
    poolKind: "non_finite", currentPoolEvidence: "not_applicable",
    rateBasisPoints: 9000, grossEvMinor: 12780,
    native: { name: "Sample pack", price: { amount: 100 }, targetEV: 9999,
      instantBuyback: { percentageOfValue: 90 }, contains: 1,
      weightMultipliers: { common: 0.7, uncommon: 0.2, rare: 0.08, epic: 0.02 },
      tierRanges: { common: { start: 100, end: 100 }, uncommon: { start: 200, end: 200 },
        rare: { start: 300, end: 300 }, epic: { start: 400, end: 400 } } } },
] as const;
type Fixture = typeof fixtures[number];

function retained(fixture: Fixture, data: Record<string, unknown> = fixture.native): ProviderPackEvEvidenceV1 {
  const observation = normalizeDataforrestEventRecordForAdapter(dataforrestEventRecordV1Schema.parse({
    stream: "catalog", entity: "pack", platform: fixture.providerKey, record_id: "sample-pack",
    occurred_at: EFFECTIVE_AT, collected_at: COLLECTED_AT, first_seen_at: EFFECTIVE_AT, available: true, data,
  }), fixture.providerKey, "evidence:published-probability-test", fixture.adapterVersion);
  const facts = observation.providerFacts;
  if (facts.kind !== "pack") throw new Error("Expected pack facts");
  const mapped = createProviderObservationMapperRegistryFromManifest().map(mapperInput(fixture.providerKey, observation));
  assert.equal(mapped.status, "mapped");
  if (mapped.status !== "mapped") throw new Error("Expected mapped pack");
  assert.equal(mapped.evInputCandidate, null, "probabilities never become item quantities");
  assert.equal(facts.packMembership, undefined);
  return providerPackEvEvidenceV1Schema.parse({
    schemaVersion: PROVIDER_PACK_EV_EVIDENCE_SCHEMA_VERSION,
    organizationId: ORGANIZATION_ID, providerId: PROVIDER_ID, providerKey: fixture.providerKey,
    providerRecordId: "sample-pack", recordIdScopeKey: "catalog-pack-v1",
    sourceTypeKey: "dataforrest-events-v1", sourceAdapterVersion: fixture.adapterVersion,
    normalizedContractVersion: "packscout.provider-observation.v1",
    mapperKey: fixture.providerKey === "courtyard" ? "courtyard-provider-observation" : "collector-crypt-provider-observation",
    mapperVersion: "1", identityNamespaceKey: providerIdentityNamespaceByLaunchProvider[fixture.providerKey],
    effectiveAt: observation.effectiveAt, collectedAt: observation.collectedAt,
    price: facts.price, buybackPercent: facts.buybackPercent, drawCount: facts.drawCount, evInput: facts.evInput,
  });
}
function request(fixture: Fixture, evidence: unknown = retained(fixture)) {
  return { organizationId: ORGANIZATION_ID, providerId: PROVIDER_ID, packId: PACK_ID,
    packKey: "pack:sample-pack", rowVersion: "7", priceUsdMinor: 10_000,
    buybackRateBasisPoints: fixture.rateBasisPoints as number | null, sourceUpdatedAt: EFFECTIVE_AT,
    snapshotAt: SNAPSHOT_AT, readAt: READ_AT, evidence };
}

for (const fixture of fixtures) {
  test(`${fixture.providerKey} native distribution reaches promotion EV without fabricated quantities`, async () => {
    const evidence = retained(fixture), before = structuredClone(evidence);
    const normalized = await normalizeProviderPromotionEvEvidenceV1(request(fixture, evidence));
    assert.equal(normalized?.status, "complete");
    if (normalized?.status !== "complete") throw new Error("Expected complete evidence");
    assert.equal(normalized.input.observation.observedAt, COLLECTED_AT);
    assert.equal(normalized.input.observation.providerKey, fixture.providerKey);
    assert.deepEqual(normalized.input.oddsEvidence, {
      sourceKind: "platform_published", poolKind: fixture.poolKind,
      currentPoolEvidence: fixture.currentPoolEvidence, probabilityCoverage: "complete",
    });
    assert.ok(normalized.input.outcomes.every(outcome => outcome.representation.kind === "homogeneous_bucket" &&
      outcome.representation.memberCount.state === "not_published"));
    const eligibility = createPackScoutBuybackEvPromotionEligibilityV1({ organizationId: ORGANIZATION_ID, readAt: READ_AT,
      products: [{ platformKey: fixture.providerKey, productKey: "pack:sample-pack", evidence: normalized }] });
    const result = await eligibility.getPublicationEligibleRevision({ organizationId: ORGANIZATION_ID, readAt: READ_AT,
      platformKey: fixture.providerKey, productKey: "pack:sample-pack" });
    assert.equal(result?.projection.status, "available");
    if (result?.projection.status !== "available") throw new Error("Expected available EV");
    assert.equal(result.projection.metrics.grossEvMoney.minorUnits, fixture.grossEvMinor);
    assert.deepEqual(evidence, before);
  });

  test(`${fixture.providerKey} promotion rejects crossed identities, stale adapters and incoherent chronology`, async () => {
    for (const change of [
      { organizationId: "62000000-0000-4000-8000-000000000099" },
      { providerId: "62000000-0000-4000-8000-000000000099" }, { packKey: "pack:another" },
      { rowVersion: "0" }, { packId: "invalid" }, { priceUsdMinor: 9999 }, { buybackRateBasisPoints: 1 },
      { sourceUpdatedAt: COLLECTED_AT }, { snapshotAt: EFFECTIVE_AT }, { readAt: EFFECTIVE_AT },
    ]) await assert.rejects(normalizeProviderPromotionEvEvidenceV1({ ...request(fixture), ...change }));
    for (const change of [
      { providerRecordId: "another" }, { sourceAdapterVersion: fixture.adapterVersion.replace("v4", "v3") },
      { sourceTypeKey: "foreign-source" }, { mapperKey: "foreign-mapper" }, { mapperVersion: "2" },
      { identityNamespaceKey: "foreign-namespace" }, { collectedAt: "2026-09-04T17:59:00.000Z" },
      { collectedAt: "2026-09-04T18:07:00.000Z" },
    ]) await assert.rejects(normalizeProviderPromotionEvEvidenceV1(request(fixture, { ...retained(fixture), ...change })));
    const original = await normalizeProviderPromotionEvEvidenceV1(request(fixture));
    const revised = await normalizeProviderPromotionEvEvidenceV1({ ...request(fixture), rowVersion: "8" });
    assert.equal(original?.status, "complete"); assert.equal(revised?.status, "complete");
    if (original?.status === "complete" && revised?.status === "complete") {
      assert.notDeepEqual(original.input.observation, revised.input.observation);
    }
  });

  test(`${fixture.providerKey} unavailable or malformed retained facts never publish EV`, async () => {
    assert.equal(await normalizeProviderPromotionEvEvidenceV1({ ...request(fixture), evidence: undefined }), null);
    for (const state of ["absent", "malformed"] as const) {
      assert.equal(await normalizeProviderPromotionEvEvidenceV1(request(fixture, { ...retained(fixture), evInput: { state } })), null);
    }
    for (const change of [
      { probability: 0.1234567891 }, { probability: -1 }, { probability: null },
      { lowerValue: null }, { upperValue: null }, { upperValue: -1 }, { quantity: 5 },
    ]) {
      const evidence = retained(fixture);
      if (evidence.evInput.state !== "present") throw new Error("Expected odds");
      Object.assign(evidence.evInput.value.buckets[0]!, change);
      const outcome = await normalizeProviderPromotionEvEvidenceV1(request(fixture, evidence));
      assert.equal(outcome?.status, "unavailable");
    }
    const evidence = retained(fixture);
    if (evidence.evInput.state !== "present") throw new Error("Expected odds");
    evidence.evInput.value.buybackPercent = 0;
    assert.equal((await normalizeProviderPromotionEvEvidenceV1(request(fixture, evidence)))?.status, "unavailable");
  });
}
