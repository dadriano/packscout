import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
  PROVIDER_PACK_EV_EVIDENCE_SCHEMA_VERSION,
  providerPackEvEvidenceV1Schema,
  type ProviderPackEvEvidenceV1,
} from "@packscout/contracts";
import { createPackScoutBuybackEvPromotionEligibilityV1 } from "../../buyback-adjusted-ev-promotion.ts";
import {
  ClutchpacksPromotionEvEvidenceError,
  normalizeClutchpacksPromotionEvEvidenceV1,
} from "./promotion-ev-evidence.ts";

// Acceptance map (Automated): exact canonical scope, price, and terms bind
// retained evidence; source gaps fail closed; repeated promotions do not
// renew the collection clock; the original bucket and confidence rules apply.
const ORGANIZATION_ID = "61000000-0000-4000-8000-000000000001";
const PROVIDER_ID = "61000000-0000-4000-8000-000000000002";
const PACK_ID = "61000000-0000-4000-8000-000000000003";
const RECORD_ID = "61000000-0000-4000-8000-000000000004";
const PACK_KEY = `pack:${RECORD_ID}`;
const EFFECTIVE_AT = "2026-08-01T18:00:00.000Z";
const COLLECTED_AT = "2026-08-27T18:50:00.000Z";
const SNAPSHOT_AT = "2026-08-27T18:51:00.000Z";
const READ_AT = "2026-08-27T18:55:00.000Z";

function evidence(): ProviderPackEvEvidenceV1 {
  return providerPackEvEvidenceV1Schema.parse({
    schemaVersion: PROVIDER_PACK_EV_EVIDENCE_SCHEMA_VERSION,
    organizationId: ORGANIZATION_ID,
    providerId: PROVIDER_ID,
    providerKey: "clutchpacks",
    providerRecordId: RECORD_ID,
    recordIdScopeKey: "catalog-pack-v1",
    sourceTypeKey: "dataforrest-events-v1",
    sourceAdapterVersion: DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
    normalizedContractVersion: "packscout.provider-observation.v1",
    mapperKey: "clutchpacks-provider-observation",
    mapperVersion: "1",
    identityNamespaceKey: "dataforrest-clutchpacks-records-v1",
    effectiveAt: EFFECTIVE_AT,
    collectedAt: COLLECTED_AT,
    price: { state: "present", value: { amount: 100, currency: "USD" } },
    buybackPercent: { state: "present", value: 90 },
    drawCount: { state: "present", value: 1 },
    evInput: {
      state: "present",
      value: {
        approved: true,
        currency: "USD",
        unitBasis: "per_pack",
        drawCount: 1,
        buybackPercent: 90,
        totalQuantity: 4,
        buckets: [
          { bucketId: "base", label: null, quantity: 3, probability: 0.75, lowerValue: 30, upperValue: 50 },
          { bucketId: "chase", label: null, quantity: 1, probability: 0.25, lowerValue: 80, upperValue: 120 },
        ],
      },
    },
  });
}

function request(retained: unknown = evidence()) {
  return {
    organizationId: ORGANIZATION_ID,
    providerId: PROVIDER_ID,
    packId: PACK_ID,
    packKey: PACK_KEY,
    rowVersion: "7",
    priceUsdMinor: 10_000,
    buybackRateBasisPoints: 9_000 as number | null,
    sourceUpdatedAt: EFFECTIVE_AT,
    snapshotAt: SNAPSHOT_AT,
    readAt: READ_AT,
    evidence: retained,
  };
}

function evInput(retained: ProviderPackEvEvidenceV1) {
  if (retained.evInput.state !== "present") throw new Error("Expected fixture EV input");
  return retained.evInput.value;
}

function hasCode(code: ClutchpacksPromotionEvEvidenceError["code"]) {
  return (error: unknown) => error instanceof ClutchpacksPromotionEvEvidenceError && error.code === code;
}

async function calculate(retained: ProviderPackEvEvidenceV1, readAt = READ_AT) {
  const normalized = await normalizeClutchpacksPromotionEvEvidenceV1({ ...request(retained), readAt });
  const port = createPackScoutBuybackEvPromotionEligibilityV1({
    organizationId: ORGANIZATION_ID,
    readAt,
    products: [{ platformKey: "clutchpacks", productKey: PACK_KEY, evidence: normalized }],
  });
  const result = await port.getPublicationEligibleRevision({
    organizationId: ORGANIZATION_ID, platformKey: "clutchpacks", productKey: PACK_KEY, readAt,
  });
  assert.ok(result);
  return { normalized, projection: result.projection };
}

test("promotion binds the exact pack row and uses existing midpoint and 90% buyback rules", async () => {
  const retained = evidence();
  const before = structuredClone(retained);
  const { normalized, projection } = await calculate(retained);
  assert.equal(normalized.status, "complete");
  if (normalized.status !== "complete") throw new Error("Expected complete evidence");
  assert.deepEqual(normalized.input.product, {
    productKey: PACK_KEY,
    productRevisionId: `pack:${PACK_ID}:row:7`,
  });
  assert.equal(normalized.input.observation.observedAt, COLLECTED_AT);
  assert.deepEqual(normalized.input.outcomes.map((outcome) => outcome.probability), [
    { numerator: 3, denominator: 4 }, { numerator: 1, denominator: 4 },
  ]);
  assert.equal(projection.status, "available");
  if (projection.status !== "available") throw new Error("Expected available EV");
  assert.deepEqual(projection.metrics, {
    grossEvMoney: { minorUnits: 4_950, currency: "USD" },
    grossReturnBasisPoints: 4_950,
    evDollars: { minorUnits: -5_050, currency: "USD" },
    evPercentBasisPoints: -5_050,
  });
  assert.equal(projection.confidence.scoreBasisPoints, 8_000);
  assert.deepEqual(projection.confidence.limitationCodes, ["closed_range_midpoint"]);
  assert.deepEqual(retained, before);
});

test("missing buyback stays unavailable and one-sided or conflicting terms never get a default", async () => {
  const missing = evidence();
  missing.buybackPercent = { state: "absent" };
  evInput(missing).buybackPercent = null;
  const result = await normalizeClutchpacksPromotionEvEvidenceV1({ ...request(missing), buybackRateBasisPoints: null });
  assert.equal(result.status, "unavailable");
  if (result.status !== "unavailable") throw new Error("Expected unavailable buyback");
  assert.deepEqual(result.internalReasons, ["MISSING_BUYBACK"]);
  assert.equal(result.publicPrimaryReason, "BUYBACK_UNAVAILABLE");
  for (const gap of ["root", "input", "conflicting"] as const) {
    const partial = evidence();
    if (gap === "root") partial.buybackPercent = { state: "absent" };
    else evInput(partial).buybackPercent = gap === "input" ? null : 80;
    const normalized = await normalizeClutchpacksPromotionEvEvidenceV1({
      ...request(partial), buybackRateBasisPoints: gap === "root" ? null : 9_000,
    });
    assert.equal(normalized.status, "unavailable");
    if (normalized.status !== "unavailable") throw new Error("Expected invalid buyback terms");
    assert.deepEqual(normalized.internalReasons, ["INVALID_BUYBACK_TERMS"]);
  }
});

test("incomplete, unapproved, and inconsistent bucket counts never produce estimated odds", async () => {
  const changes = [
    (retained: ProviderPackEvEvidenceV1) => { retained.evInput = { state: "absent" }; },
    (retained: ProviderPackEvEvidenceV1) => { retained.evInput = { state: "malformed" }; },
    (retained: ProviderPackEvEvidenceV1) => { evInput(retained).approved = false; },
    (retained: ProviderPackEvEvidenceV1) => { evInput(retained).buckets[0]!.quantity = null; },
    (retained: ProviderPackEvEvidenceV1) => { evInput(retained).totalQuantity = 5; },
    (retained: ProviderPackEvEvidenceV1) => { evInput(retained).buckets[0]!.probability = 0.5; },
    (retained: ProviderPackEvEvidenceV1) => { evInput(retained).buckets[0]!.upperValue = null; },
  ];
  for (const change of changes) {
    const retained = evidence();
    change(retained);
    const { normalized, projection } = await calculate(retained);
    assert.equal(normalized.status, "unavailable");
    assert.equal(projection.status, "unavailable");
    assert.equal(projection.metrics, null);
  }
});

test("repeated promotion preserves collection identity while confidence ages and EV expires", async () => {
  const retained = evidence();
  const first = await calculate(retained);
  const repeated = await calculate(retained);
  const later = await calculate(retained, "2026-08-27T19:10:00.000Z");
  const expired = await calculate(retained, "2026-08-27T19:50:00.001Z");
  assert.deepEqual(first, repeated);
  assert.deepEqual(first.normalized, later.normalized);
  assert.deepEqual(first.normalized, expired.normalized);
  assert.equal(first.projection.confidence?.scoreBasisPoints, 8_000);
  assert.equal(later.projection.confidence?.scoreBasisPoints, 7_000);
  assert.equal(expired.projection.status, "unavailable");
  if (expired.projection.status !== "unavailable") throw new Error("Expected expired EV");
  assert.equal(expired.projection.publicReason, "SOURCE_DATA_STALE");
  assert.equal(expired.projection.dataAsOf.observedAt, COLLECTED_AT);
});

test("evidence cannot cross canonical organization, provider, product, price, terms, or source state", async () => {
  const changes: Partial<ReturnType<typeof request>>[] = [
    { organizationId: "61000000-0000-4000-8000-000000000005" },
    { providerId: "61000000-0000-4000-8000-000000000005" },
    { packKey: "pack:another-record" },
    { priceUsdMinor: 9_999 },
    { buybackRateBasisPoints: 8_000 },
    { sourceUpdatedAt: "2026-08-01T18:01:00.000Z" },
    { rowVersion: "0" },
    { snapshotAt: "2026-08-27T18:49:59.999Z" },
    { readAt: "2026-08-27T18:50:59.999Z" },
  ];
  for (const change of changes) {
    await assert.rejects(normalizeClutchpacksPromotionEvEvidenceV1({ ...request(), ...change }), hasCode("EVIDENCE_SNAPSHOT_MISMATCH"));
  }
  for (const change of [
    { sourceAdapterVersion: "unapproved-adapter" },
    { sourceTypeKey: "another-source" },
    { mapperVersion: "2" },
    { mapperKey: "another-mapper" },
  ]) {
    await assert.rejects(normalizeClutchpacksPromotionEvEvidenceV1(request({ ...evidence(), ...change })), hasCode("EVIDENCE_SNAPSHOT_MISMATCH"));
  }
});

test("malformed or explicitly null retained evidence fails instead of being treated as omitted", async () => {
  for (const retained of [null, undefined, {}, { ...evidence(), rawPayload: {} }, { ...evidence(), identityNamespaceKey: "other-namespace" }]) {
    const input = request();
    input.evidence = retained;
    await assert.rejects(normalizeClutchpacksPromotionEvEvidenceV1(input), hasCode("EVIDENCE_INVALID"));
  }
});

test("invalid UUIDs and noncanonical snapshot or publication clocks fail with a stable refusal", async () => {
  for (const change of [
    { packId: "-".repeat(36) },
    { packId: "61000000-0000-0000-0000-000000000003" },
    { snapshotAt: "2026-08-27T18:51:00Z" },
    { snapshotAt: "2026-08-27T18:51:00.000+00:00" },
    { readAt: "2026-08-27T18:55:00Z" },
    { readAt: "2026-08-27T18:55:00.000+00:00" },
  ]) {
    await assert.rejects(normalizeClutchpacksPromotionEvEvidenceV1({ ...request(), ...change }), hasCode("EVIDENCE_SNAPSHOT_MISMATCH"));
  }
});
