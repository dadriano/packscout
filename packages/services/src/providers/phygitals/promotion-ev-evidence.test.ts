import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V4_VERSION,
  PROVIDER_PACK_EV_EVIDENCE_SCHEMA_VERSION,
  providerPackEvEvidenceV1Schema,
  type ProviderPackEvEvidenceV1,
} from "@packscout/contracts";
import { createPackScoutBuybackEvPromotionEligibilityV1 } from "../../buyback-adjusted-ev-promotion.ts";
import {
  PhygitalsPromotionEvEvidenceError,
  normalizePhygitalsPromotionEvEvidenceV1,
} from "./promotion-ev-evidence.ts";

const ORGANIZATION_ID = "61000000-0000-4000-8000-000000000001";
const PROVIDER_ID = "61000000-0000-4000-8000-000000000002";
const PACK_ID = "61000000-0000-4000-8000-000000000003";
const RECORD_ID = "black-football-pack";
const PACK_KEY = `pack:${RECORD_ID}`;
const EFFECTIVE_AT = "2026-09-04T18:00:00.000Z";
const COLLECTED_AT = "2026-09-04T18:05:00.000Z";
const SNAPSHOT_AT = "2026-09-04T18:06:00.000Z";
const READ_AT = "2026-09-04T18:10:00.000Z";

function evidence(): ProviderPackEvEvidenceV1 {
  return providerPackEvEvidenceV1Schema.parse({
    schemaVersion: PROVIDER_PACK_EV_EVIDENCE_SCHEMA_VERSION,
    organizationId: ORGANIZATION_ID,
    providerId: PROVIDER_ID,
    providerKey: "phygitals",
    providerRecordId: RECORD_ID,
    recordIdScopeKey: "catalog-pack-v1",
    sourceTypeKey: "dataforrest-events-v1",
    sourceAdapterVersion: DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V4_VERSION,
    normalizedContractVersion: "packscout.provider-observation.v1",
    mapperKey: "phygitals-provider-observation",
    mapperVersion: "1",
    identityNamespaceKey: "dataforrest-phygitals-records-v1",
    effectiveAt: EFFECTIVE_AT,
    collectedAt: COLLECTED_AT,
    price: { state: "present", value: { amount: 100, currency: "USD" } },
    buybackPercent: { state: "present", value: 80 },
    drawCount: { state: "present", value: 1 },
    evInput: {
      state: "present",
      value: {
        approved: true,
        currency: "USD",
        unitBasis: "per_pack",
        drawCount: 1,
        buybackPercent: 80,
        totalQuantity: null,
        buckets: [
          {
            bucketId: "base",
            label: "Base",
            probability: 0.5,
            quantity: null,
            lowerValue: 50,
            upperValue: 50,
          },
          {
            bucketId: "chase",
            label: "Chase",
            probability: 0.5,
            quantity: null,
            lowerValue: 150,
            upperValue: 150,
          },
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
    buybackRateBasisPoints: 8_000 as number | null,
    sourceUpdatedAt: EFFECTIVE_AT,
    snapshotAt: SNAPSHOT_AT,
    readAt: READ_AT,
    evidence: retained,
  };
}

test("promotion calculates retained Phygitals odds without inventing pool quantities", async () => {
  const retained = evidence();
  const before = structuredClone(retained);
  const normalized = await normalizePhygitalsPromotionEvEvidenceV1(request(retained));
  assert.equal(normalized.status, "complete");
  if (normalized.status !== "complete") throw new Error("Expected complete evidence");
  assert.deepEqual(
    normalized.input.outcomes.map(({ probability, representation }) => ({
      probability,
      memberCount: representation.kind === "homogeneous_bucket"
        ? representation.memberCount
        : null,
    })),
    [
      {
        probability: { numerator: 1, denominator: 2 },
        memberCount: { state: "not_published", value: null },
      },
      {
        probability: { numerator: 1, denominator: 2 },
        memberCount: { state: "not_published", value: null },
      },
    ],
  );
  assert.equal(normalized.input.observation.observedAt, COLLECTED_AT);
  const eligibility = createPackScoutBuybackEvPromotionEligibilityV1({
    organizationId: ORGANIZATION_ID,
    readAt: READ_AT,
    products: [{ platformKey: "phygitals", productKey: PACK_KEY, evidence: normalized }],
  });
  const result = await eligibility.getPublicationEligibleRevision({
    organizationId: ORGANIZATION_ID,
    platformKey: "phygitals",
    productKey: PACK_KEY,
    readAt: READ_AT,
  });
  assert.ok(result);
  assert.equal(result.projection.status, "available");
  if (result.projection.status !== "available") throw new Error("Expected available EV");
  assert.deepEqual(result.projection.metrics, {
    grossEvMoney: { minorUnits: 8_000, currency: "USD" },
    grossReturnBasisPoints: 8_000,
    evDollars: { minorUnits: -2_000, currency: "USD" },
    evPercentBasisPoints: -2_000,
  });
  assert.deepEqual(retained, before);
});

test("promotion refuses evidence crossing the canonical pack snapshot", async () => {
  for (const change of [
    { priceUsdMinor: 9_999 },
    { buybackRateBasisPoints: 9_000 },
    { rowVersion: "0" },
    { sourceUpdatedAt: "2026-09-04T18:00:01.000Z" },
  ]) {
    await assert.rejects(
      normalizePhygitalsPromotionEvEvidenceV1({ ...request(), ...change }),
      (error: unknown) =>
        error instanceof PhygitalsPromotionEvEvidenceError &&
        error.code === "EVIDENCE_SNAPSHOT_MISMATCH",
    );
  }
});
