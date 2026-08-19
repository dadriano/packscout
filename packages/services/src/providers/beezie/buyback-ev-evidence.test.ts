import assert from "node:assert/strict";
import { test } from "node:test";
import { packScoutBuybackEvInputV1Schema } from "@packscout/contracts";
import {
  BUYBACK_EV_FIXTURE_EXPIRED_USDC_PARITY,
  BUYBACK_EV_FIXTURE_MANIFEST_SHA256,
  BUYBACK_EV_FIXTURE_OBSERVED_AT,
  buildBuybackEvFixtureContext,
  expectBuybackEvCompleteV1,
  expectBuybackEvUnavailableV1,
} from "../buyback-ev-evidence.fixture.ts";
import {
  normalizeBeezieBuybackEvEvidenceV1,
  type BeezieBuybackEvSourceV1,
} from "./buyback-ev-evidence.ts";

const context = buildBuybackEvFixtureContext();

function baseSource(
  overrides: Partial<BeezieBuybackEvSourceV1> = {},
): BeezieBuybackEvSourceV1 {
  return {
    machineId: "Machine-77",
    machineRevisionId: "machine-rev-3",
    catalogRevisionId: "catalog-rev-9",
    sourceManifestSha256: BUYBACK_EV_FIXTURE_MANIFEST_SHA256,
    observedAt: BUYBACK_EV_FIXTURE_OBSERVED_AT,
    settlementCurrency: "USDC",
    priceMicroUnits: 25_000_000,
    swapFeePercents: [3, 2],
    swapDocumentedForAllTiers: true,
    oddsTiers: [
      {
        tier: "base",
        oddsPercent: 40,
        fromMicroUnits: 5_000_000,
        toMicroUnits: 20_000_000,
      },
      {
        tier: "low",
        oddsPercent: 30,
        fromMicroUnits: 20_000_000,
        toMicroUnits: 60_000_000,
      },
      {
        tier: "medium",
        oddsPercent: 20,
        fromMicroUnits: 60_000_000,
        toMicroUnits: 150_000_000,
      },
      {
        tier: "high",
        oddsPercent: 9,
        fromMicroUnits: 150_000_000,
        toMicroUnits: 400_000_000,
      },
      {
        tier: "grails",
        oddsPercent: 1,
        fromMicroUnits: 400_000_000,
        toMicroUnits: 1_200_000_000,
      },
    ],
    ...overrides,
  };
}

test("beezie: a complete USDC machine normalizes at documented 1:1 parity", () => {
  const input = expectBuybackEvCompleteV1(
    normalizeBeezieBuybackEvEvidenceV1(baseSource(), context),
  );
  packScoutBuybackEvInputV1Schema.parse(input);
  assert.deepEqual(input.product, {
    productKey: "beezie:machine-77",
    productRevisionId: "machine-rev-3",
  });
  assert.deepEqual(input.packPrice.sourceAmount, {
    minorUnits: 25_000_000,
    currency: "USDC",
    precision: 6,
  });
  assert.deepEqual(input.packPrice.canonicalUsdCents, {
    numerator: 2_500,
    denominator: 1,
  });
  assert.equal(input.packPrice.normalization.kind, "usd_equivalent_stablecoin");
  assert.equal(
    input.packPrice.normalization.kind === "usd_equivalent_stablecoin"
      ? input.packPrice.normalization.parity.configurationRevision
      : null,
    "usdc-parity-2026-08",
  );
  // The mandatory swap fee is a percentage fee on top of a 100% rate.
  assert.deepEqual(input.uniformBuybackRate?.terms.rateBasisPoints, 10_000);
  assert.deepEqual(
    input.uniformBuybackRate?.terms.percentageFeeBasisPoints,
    500,
  );
  assert.equal(input.oddsEvidence.sourceKind, "platform_published");
  assert.equal(input.oddsEvidence.poolKind, "finite");
  const grails = input.outcomes.find(({ outcomeKey }) => outcomeKey === "grails")!;
  assert.equal(grails.statedValue.kind, "closed_range");
  assert.deepEqual(grails.probability, { numerator: 1, denominator: 100 });
});

test("beezie: an unapproved settlement token stays discoverable without EV", () => {
  const outcome = expectBuybackEvUnavailableV1(
    normalizeBeezieBuybackEvEvidenceV1(
      baseSource({ settlementCurrency: "FLOW" }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["UNSUPPORTED_CURRENCY"]);
  assert.equal(outcome.publicPrimaryReason, "CURRENCY_UNSUPPORTED");
  assert.equal(outcome.product.state, "known");
  assert.notEqual(outcome.observation, null);
});

test("beezie: a missing settlement token fails closed as unsupported currency", () => {
  const outcome = expectBuybackEvUnavailableV1(
    normalizeBeezieBuybackEvEvidenceV1(
      baseSource({ settlementCurrency: null }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["UNSUPPORTED_CURRENCY"]);
});

test("beezie: parity approval outside the observation window is expired", () => {
  const outcome = expectBuybackEvUnavailableV1(
    normalizeBeezieBuybackEvEvidenceV1(
      baseSource(),
      buildBuybackEvFixtureContext({
        stablecoinParityApprovals: [BUYBACK_EV_FIXTURE_EXPIRED_USDC_PARITY],
      }),
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["EXPIRED_PARITY_APPROVAL"]);
  assert.equal(outcome.publicPrimaryReason, "CURRENCY_UNSUPPORTED");
});

test("beezie: an undocumented swap program is missing buyback evidence", () => {
  const outcome = expectBuybackEvUnavailableV1(
    normalizeBeezieBuybackEvEvidenceV1(
      baseSource({ swapFeePercents: null }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["MISSING_BUYBACK"]);
  assert.equal(outcome.publicPrimaryReason, "BUYBACK_UNAVAILABLE");
});

test("beezie: swap fees above 100% are unsupported buyback terms", () => {
  const outcome = expectBuybackEvUnavailableV1(
    normalizeBeezieBuybackEvEvidenceV1(
      baseSource({ swapFeePercents: [60, 55] }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["INVALID_BUYBACK_TERMS"]);
});

test("beezie: an unbounded fee schedule is not a supportable term sheet", () => {
  const outcome = expectBuybackEvUnavailableV1(
    normalizeBeezieBuybackEvEvidenceV1(
      baseSource({ swapFeePercents: Array.from({ length: 17 }, () => 0.1) }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["INVALID_BUYBACK_TERMS"]);
});

test("beezie: a swap without documented tier-wide scope fails closed", () => {
  const outcome = expectBuybackEvUnavailableV1(
    normalizeBeezieBuybackEvEvidenceV1(
      baseSource({ swapDocumentedForAllTiers: false }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["INVALID_BUYBACK_TERMS"]);
});

test("beezie: a tier without published odds leaves probabilities incomplete", () => {
  const tiers = baseSource().oddsTiers.map((tier) =>
    tier.tier === "grails" ? { ...tier, oddsPercent: null } : tier,
  );
  const outcome = expectBuybackEvUnavailableV1(
    normalizeBeezieBuybackEvEvidenceV1(
      baseSource({ oddsTiers: tiers }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["INCOMPLETE_PROBABILITIES"]);
  assert.equal(outcome.publicPrimaryReason, "ODDS_UNAVAILABLE");
});

test("beezie: a tier missing one range bound is an open-ended range", () => {
  const tiers = baseSource().oddsTiers.map((tier) =>
    tier.tier === "high" ? { ...tier, toMicroUnits: null } : tier,
  );
  const outcome = expectBuybackEvUnavailableV1(
    normalizeBeezieBuybackEvEvidenceV1(
      baseSource({ oddsTiers: tiers }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["INVALID_VALUE_RANGE"]);
});
