import assert from "node:assert/strict";
import { test } from "node:test";
import { packScoutBuybackEvInputV1Schema } from "@packscout/contracts";
import {
  BUYBACK_EV_FIXTURE_MANIFEST_SHA256,
  BUYBACK_EV_FIXTURE_OBSERVED_AT,
  buildBuybackEvFixtureContext,
  expectBuybackEvCompleteV1,
  expectBuybackEvUnavailableV1,
} from "../buyback-ev-evidence.fixture.ts";
import {
  normalizeCourtyardBuybackEvEvidenceV1,
  type CourtyardBuybackEvSourceV1,
} from "./buyback-ev-evidence.ts";

const context = buildBuybackEvFixtureContext();

function baseSource(
  overrides: Partial<CourtyardBuybackEvSourceV1> = {},
): CourtyardBuybackEvSourceV1 {
  return {
    listingId: "Ironman-Repack-001",
    productRevisionId: "listing-rev-7",
    catalogRevisionId: "catalog-rev-100",
    sourceManifestSha256: BUYBACK_EV_FIXTURE_MANIFEST_SHA256,
    observedAt: BUYBACK_EV_FIXTURE_OBSERVED_AT,
    salePriceUsd: 100,
    buybackRatio: 0.85,
    buybackScopeDocumented: true,
    oddsBuckets: [
      { tier: "Grail", oddsPercent: 5, minValueUsd: 400, maxValueUsd: 800 },
      { tier: "Hit", oddsPercent: 15, minValueUsd: 120, maxValueUsd: 250 },
      { tier: "Base", oddsPercent: 80, minValueUsd: 20, maxValueUsd: 60 },
    ],
    ...overrides,
  };
}

test("courtyard: a complete listing normalizes into a valid calculator input", () => {
  const input = expectBuybackEvCompleteV1(
    normalizeCourtyardBuybackEvEvidenceV1(baseSource(), context),
  );
  packScoutBuybackEvInputV1Schema.parse(input);
  assert.deepEqual(input.product, {
    productKey: "courtyard:ironman-repack-001",
    productRevisionId: "listing-rev-7",
  });
  assert.equal(input.observation.coherenceKind, "provider_revision");
  assert.equal(input.observation.sourceRevisionId, "catalog-rev-100");
  assert.equal(input.observation.observedAt, BUYBACK_EV_FIXTURE_OBSERVED_AT);
  assert.deepEqual(input.packPrice.canonicalUsdCents, {
    numerator: 10_000,
    denominator: 1,
  });
  assert.deepEqual(input.unitBasis, { kind: "per_pack", drawCount: 1 });
  assert.deepEqual(input.oddsEvidence, {
    sourceKind: "platform_published",
    poolKind: "finite",
    currentPoolEvidence: "unavailable",
    probabilityCoverage: "complete",
  });
  assert.deepEqual(
    input.outcomes.map(({ outcomeKey, probability }) => ({
      outcomeKey,
      probability,
    })),
    [
      { outcomeKey: "base", probability: { numerator: 4, denominator: 5 } },
      { outcomeKey: "grail", probability: { numerator: 1, denominator: 20 } },
      { outcomeKey: "hit", probability: { numerator: 3, denominator: 20 } },
    ],
  );
  const base = input.outcomes[0]!;
  assert.equal(base.statedValue.kind, "closed_range");
  assert.deepEqual(base.buyback, {
    eligibility: "eligible",
    payout: { kind: "product_uniform_rate" },
  });
  assert.deepEqual(input.uniformBuybackRate, {
    scope: "every_eligible_outcome",
    terms: {
      rateBasisPoints: 8_500,
      percentageFeeBasisPoints: 0,
      fixedFee: {
        sourceAmount: { minorUnits: 0, currency: "USD", precision: 2 },
        canonicalUsdCents: { numerator: 0, denominator: 1 },
        normalization: { kind: "usd_direct" },
      },
      floor: null,
      cap: null,
    },
  });
  assert.deepStrictEqual(
    normalizeCourtyardBuybackEvEvidenceV1(baseSource(), context),
    normalizeCourtyardBuybackEvEvidenceV1(baseSource(), context),
  );
});

test("courtyard: no documented buyback stays discoverable without an EV", () => {
  const outcome = expectBuybackEvUnavailableV1(
    normalizeCourtyardBuybackEvEvidenceV1(
      baseSource({ buybackRatio: null }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["MISSING_BUYBACK"]);
  assert.equal(outcome.publicPrimaryReason, "BUYBACK_UNAVAILABLE");
  assert.equal(outcome.product.state, "known");
  assert.notEqual(outcome.observation, null);
  assert.deepEqual(outcome.dataAsOf, {
    state: "known",
    observedAt: BUYBACK_EV_FIXTURE_OBSERVED_AT,
  });
});

test("courtyard: a rate without documented product-wide scope fails closed", () => {
  const outcome = expectBuybackEvUnavailableV1(
    normalizeCourtyardBuybackEvEvidenceV1(
      baseSource({ buybackScopeDocumented: false }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["INVALID_BUYBACK_TERMS"]);
  assert.equal(outcome.publicPrimaryReason, "BUYBACK_UNAVAILABLE");
});

test("courtyard: an open-ended value range makes the value unavailable", () => {
  const outcome = expectBuybackEvUnavailableV1(
    normalizeCourtyardBuybackEvEvidenceV1(
      baseSource({
        oddsBuckets: [
          { tier: "Grail", oddsPercent: 5, minValueUsd: 400, maxValueUsd: null },
          { tier: "Hit", oddsPercent: 15, minValueUsd: 120, maxValueUsd: 250 },
          { tier: "Base", oddsPercent: 80, minValueUsd: 20, maxValueUsd: 60 },
        ],
      }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["INVALID_VALUE_RANGE"]);
  assert.equal(outcome.publicPrimaryReason, "VALUE_UNAVAILABLE");
});

test("courtyard: a bucket without any stated value is incomplete evidence", () => {
  const outcome = expectBuybackEvUnavailableV1(
    normalizeCourtyardBuybackEvEvidenceV1(
      baseSource({
        oddsBuckets: [
          { tier: "Grail", oddsPercent: 5, minValueUsd: null, maxValueUsd: null },
          { tier: "Hit", oddsPercent: 15, minValueUsd: 120, maxValueUsd: 250 },
          { tier: "Base", oddsPercent: 80, minValueUsd: 20, maxValueUsd: 60 },
        ],
      }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["INCOMPLETE_VALUES"]);
});

test("courtyard: partial published coverage never becomes normalized odds", () => {
  const outcome = expectBuybackEvUnavailableV1(
    normalizeCourtyardBuybackEvEvidenceV1(
      baseSource({
        oddsBuckets: [
          { tier: "Grail", oddsPercent: 5, minValueUsd: 400, maxValueUsd: 800 },
          { tier: "Hit", oddsPercent: 15, minValueUsd: 120, maxValueUsd: 250 },
          { tier: "Base", oddsPercent: 70, minValueUsd: 20, maxValueUsd: 60 },
        ],
      }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["INCOMPLETE_PROBABILITIES"]);
  assert.equal(outcome.publicPrimaryReason, "ODDS_UNAVAILABLE");
});

test("courtyard: missing source revision is missing provenance", () => {
  const outcome = expectBuybackEvUnavailableV1(
    normalizeCourtyardBuybackEvEvidenceV1(
      baseSource({ catalogRevisionId: null }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["MISSING_PROVENANCE"]);
  assert.equal(outcome.publicPrimaryReason, "SOURCE_EVIDENCE_UNAVAILABLE");
  assert.equal(outcome.observation, null);
});
