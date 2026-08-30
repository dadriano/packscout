import assert from "node:assert/strict";
import { test } from "node:test";
import {
  containsProtectedEvPublicationKeyV3,
  publicRepackDetailV3Schema,
} from "@packscout/contracts";
import {
  createPackScoutBuybackEvPromotionEligibilityV1,
  PackScoutBuybackEvPromotionError,
} from "./buyback-adjusted-ev-promotion.ts";
import {
  BUYBACK_EV_TEST_CALCULATED_AT,
  BUYBACK_EV_TEST_OBSERVED_AT,
  buildOutcome,
  buildUsdEvidence,
} from "./buyback-adjusted-ev-calculator.test-support.ts";
import {
  completeEvidenceOutcome,
  unavailableEvidenceOutcome,
} from "./buyback-adjusted-ev-recomputation.test-support.ts";
import { DataReleaseV3ReleaseAssembler } from "./buyback-adjusted-ev-release-assembler.ts";
import { buildReleaseProduct } from "./buyback-adjusted-ev-release.test-support.ts";

// Acceptance map (Automated): promotion calculates normalized evidence;
// retries are deterministic; later promotions age the same source evidence;
// incomplete evidence stays unavailable; scope conflicts cannot publish;
// assembly accepts promotion results without fabricated database revisions.
const ORGANIZATION_ID = "41000000-0000-4000-8000-000000000001";
const PLATFORM_KEY = "courtyard";
const PRODUCT_KEY = "courtyard-ironman-repack";
const READ_AT = BUYBACK_EV_TEST_CALCULATED_AT;

function snapshot(evidence: unknown = completeEvidenceOutcome(), readAt: string = READ_AT) {
  return {
    organizationId: ORGANIZATION_ID,
    readAt,
    products: [{ platformKey: PLATFORM_KEY, productKey: PRODUCT_KEY, evidence }],
  };
}

function query(readAt: string = READ_AT) {
  return { organizationId: ORGANIZATION_ID, platformKey: PLATFORM_KEY, productKey: PRODUCT_KEY, readAt };
}

function hasCode(code: PackScoutBuybackEvPromotionError["code"]) {
  return (error: unknown) => error instanceof PackScoutBuybackEvPromotionError && error.code === code;
}

test("promotion calculates real buyback EV and confidence without a stored revision", async () => {
  const input = snapshot();
  const before = structuredClone(input);
  const port = createPackScoutBuybackEvPromotionEligibilityV1(input);
  const eligibility = await port.getPublicationEligibleRevision(query());
  assert.ok(eligibility);
  assert.equal("revision" in eligibility, false);
  assert.equal("calculationSource" in eligibility && eligibility.calculationSource, "promotion");
  const projection = eligibility.projection;
  assert.equal(projection.status, "available");
  if (projection.status !== "available") throw new Error("Expected available calculation");
  assert.deepEqual(projection.metrics, {
    grossEvMoney: { minorUnits: 8_500, currency: "USD" },
    grossReturnBasisPoints: 8_500,
    evDollars: { minorUnits: -1_500, currency: "USD" },
    evPercentBasisPoints: -1_500,
  });
  assert.equal(projection.confidence.scoreBasisPoints, 10_000);
  assert.equal(projection.calculatedAt, READ_AT);
  assert.deepEqual(projection.dataAsOf, { state: "known", observedAt: BUYBACK_EV_TEST_OBSERVED_AT });
  assert.equal(containsProtectedEvPublicationKeyV3(eligibility), false);
  assert.deepEqual(input, before);
});

test("repeated promotion is deterministic and caller mutations cannot change its snapshot", async () => {
  const input = snapshot();
  const port = createPackScoutBuybackEvPromotionEligibilityV1(input);
  const original = await port.getPublicationEligibleRevision(query());
  const repeated = await createPackScoutBuybackEvPromotionEligibilityV1(input).getPublicationEligibleRevision(query());
  assert.deepEqual(repeated, original);
  assert.ok(repeated);
  Object.assign(repeated.projection, { calculatedAt: "corrupted" });
  input.readAt = "corrupted";
  input.products[0]!.evidence = null;
  assert.deepEqual(await port.getPublicationEligibleRevision(query()), original);
});

test("later promotions reduce confidence then expire without renewing source evidence", async () => {
  const evidence = completeEvidenceOutcome();
  const checks = [
    { readAt: "2026-08-19T18:05:00.000Z", confidence: 10_000 },
    { readAt: "2026-08-19T18:20:00.000Z", confidence: 9_000 },
    { readAt: "2026-08-19T18:40:00.000Z", confidence: 7_500 },
    { readAt: "2026-08-19T19:00:00.000Z", confidence: 7_500 },
    { readAt: "2026-08-19T19:00:00.001Z", confidence: null },
  ];
  for (const check of checks) {
    const port = createPackScoutBuybackEvPromotionEligibilityV1(snapshot(evidence, check.readAt));
    const result = await port.getPublicationEligibleRevision(query(check.readAt));
    assert.ok(result);
    assert.equal(result.projection.dataAsOf.observedAt, BUYBACK_EV_TEST_OBSERVED_AT);
    assert.equal(result.projection.calculatedAt, check.readAt);
    assert.equal(result.projection.confidence?.scoreBasisPoints ?? null, check.confidence);
    if (check.confidence === null) {
      assert.equal(result.projection.status, "unavailable");
      if (result.projection.status !== "unavailable") throw new Error("Expected expired calculation");
      assert.equal(result.projection.publicReason, "SOURCE_DATA_STALE");
      assert.equal(result.projection.metrics, null);
    }
  }
});

test("unavailable evidence keeps its reason and unknown source time cannot become current", async () => {
  const missingBuyback = unavailableEvidenceOutcome({ internalReasons: ["MISSING_BUYBACK"] });
  const missingObservation = unavailableEvidenceOutcome({
    internalReasons: ["MISSING_PROVENANCE", "MISSING_SOURCE_TIME"],
    observationPresent: false,
    observedAt: null,
  });
  for (const [evidence, reason] of [
    [missingBuyback, "BUYBACK_UNAVAILABLE"],
    [missingObservation, "SOURCE_EVIDENCE_UNAVAILABLE"],
  ] as const) {
    const result = await createPackScoutBuybackEvPromotionEligibilityV1(snapshot(evidence))
      .getPublicationEligibleRevision(query());
    assert.equal(result?.projection.status, "unavailable");
    if (result?.projection.status !== "unavailable") throw new Error("Expected unavailable calculation");
    assert.equal(result.projection.publicReason, reason);
    assert.equal(result.projection.metrics, null);
    if (evidence === missingObservation) {
      assert.deepEqual(result.projection.dataAsOf, { state: "unknown_source_time", observedAt: null });
    }
  }
});

test("promotion rejects malformed evidence, mismatched identities, duplicate products, and invalid clocks", () => {
  assert.throws(() => createPackScoutBuybackEvPromotionEligibilityV1(snapshot({})), hasCode("EVIDENCE_INVALID"));
  const base = snapshot();
  for (const product of [
    { ...base.products[0]!, platformKey: "another-provider" },
    { ...base.products[0]!, productKey: "another-product" },
  ]) {
    assert.throws(() => createPackScoutBuybackEvPromotionEligibilityV1({ ...base, products: [product] }), hasCode("EVIDENCE_SCOPE_MISMATCH"));
  }
  assert.throws(() => createPackScoutBuybackEvPromotionEligibilityV1({ ...base, products: [...base.products, ...base.products] }), hasCode("SNAPSHOT_INVALID"));
  assert.throws(() => createPackScoutBuybackEvPromotionEligibilityV1({ ...base, readAt: "invalid" }), hasCode("SNAPSHOT_INVALID"));
  assert.throws(() => createPackScoutBuybackEvPromotionEligibilityV1({ ...base, organizationId: "invalid" }), hasCode("SNAPSHOT_INVALID"));
});

test("publication cannot cross organization or snapshot clocks and absent products remain unavailable", async () => {
  const port = createPackScoutBuybackEvPromotionEligibilityV1(snapshot());
  await assert.rejects(port.getPublicationEligibleRevision({ ...query(), organizationId: "41000000-0000-4000-8000-000000000002" }), hasCode("PUBLICATION_SCOPE_MISMATCH"));
  await assert.rejects(port.getPublicationEligibleRevision(query("2026-08-19T18:20:00.000Z")), hasCode("PUBLICATION_SCOPE_MISMATCH"));
  assert.equal(await port.getPublicationEligibleRevision({ ...query(), productKey: "absent" }), null);
  assert.equal(await port.getPublicationEligibleRevision({ ...query(), platformKey: "another-provider" }), null);
});

test("V3 assembly publishes promotion calculations and still enforces the public EV policy", async () => {
  for (const outcomeValue of [10_000, 20_000]) {
    const evidence = completeEvidenceOutcome({
      outcomes: [buildOutcome({ statedValue: { kind: "exact", amount: buildUsdEvidence(outcomeValue) } })],
    });
    const port = createPackScoutBuybackEvPromotionEligibilityV1(snapshot(evidence));
    const product = buildReleaseProduct({
      platformKey: PLATFORM_KEY,
      productKey: PRODUCT_KEY,
      categories: [],
      collectibleTypes: [],
      topChase: null,
      contentMode: "unknown",
      contentSummary: { knownCollectibleCount: 0, chaseCount: 0, categoryCount: 0, collectibleTypeCount: 0, evidenceCompleteness: "unknown", probabilityCoverageBasisPoints: null },
      sourceUpdatedAt: BUYBACK_EV_TEST_OBSERVED_AT,
    });
    const plan = await new DataReleaseV3ReleaseAssembler({
      async loadCatalogSnapshot() {
        return { organizationId: ORGANIZATION_ID, products: [product], categories: [], collectibles: [], chases: [] };
      },
    }, port).assemble({ readAt: READ_AT });
    assert.equal(plan.classification, "publish");
    if (plan.classification !== "publish") throw new Error("Expected publish plan");
    const record = plan.batches.find((batch) => batch.kind === "repacks")?.records[0];
    const detail = publicRepackDetailV3Schema.parse(record);
    assert.equal(containsProtectedEvPublicationKeyV3(detail), false);
    if (outcomeValue === 10_000) {
      assert.equal(detail.evEstimates.packScout.status, "current");
    } else {
      assert.equal(detail.evEstimates.packScout.status, "unavailable");
      if (detail.evEstimates.packScout.status !== "unavailable") throw new Error("Expected public-policy refusal");
      assert.equal(detail.evEstimates.packScout.reason, "CALCULATION_UNAVAILABLE");
    }
  }
});
