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
  normalizeGamestopBuybackEvEvidenceV1,
  type GamestopBuybackEvSourceV1,
} from "./buyback-ev-evidence.ts";

const context = buildBuybackEvFixtureContext();

function baseSource(
  overrides: Partial<GamestopBuybackEvSourceV1> = {},
): GamestopBuybackEvSourceV1 {
  return {
    skuId: "SKU-123",
    skuRevisionId: "sku-rev-1",
    storefrontRevisionId: "store-rev-55",
    sourceManifestSha256: BUYBACK_EV_FIXTURE_MANIFEST_SHA256,
    observedAt: BUYBACK_EV_FIXTURE_OBSERVED_AT,
    listPriceUsd: 49.99,
    hitTiers: [
      {
        tierLabel: "Chase",
        oddsPercent: 10,
        estimatedValueUsd: 300,
        tradeCredit: { kind: "guaranteed_cash_offer", offerUsd: 150 },
      },
      {
        tierLabel: "Premium",
        oddsPercent: 30,
        estimatedValueUsd: 80,
        tradeCredit: { kind: "guaranteed_cash_offer", offerUsd: 40 },
      },
      {
        tierLabel: "Base",
        oddsPercent: 60,
        estimatedValueUsd: 20,
        tradeCredit: { kind: "not_offered", offerUsd: null },
      },
    ],
    ...overrides,
  };
}

test("gamestop: guaranteed trade credit normalizes as fixed final payouts", () => {
  const input = expectBuybackEvCompleteV1(
    normalizeGamestopBuybackEvEvidenceV1(baseSource(), context),
  );
  packScoutBuybackEvInputV1Schema.parse(input);
  assert.deepEqual(input.product, {
    productKey: "gamestop:sku-123",
    productRevisionId: "sku-rev-1",
  });
  assert.deepEqual(input.packPrice.canonicalUsdCents, {
    numerator: 4_999,
    denominator: 1,
  });
  assert.equal(input.uniformBuybackRate, null);
  const chase = input.outcomes.find(({ outcomeKey }) => outcomeKey === "chase")!;
  assert.deepEqual(chase.buyback, {
    eligibility: "eligible",
    payout: {
      kind: "exact_final_payout",
      evidenceKind: "fixed_guaranteed_offer",
      amount: {
        sourceAmount: { minorUnits: 15_000, currency: "USD", precision: 2 },
        canonicalUsdCents: { numerator: 15_000, denominator: 1 },
        normalization: { kind: "usd_direct" },
      },
    },
  });
  const base = input.outcomes.find(({ outcomeKey }) => outcomeKey === "base")!;
  // The ineligible tier keeps its probability and contributes zero payout.
  assert.deepEqual(base.buyback, { eligibility: "ineligible", payout: null });
  assert.deepEqual(base.probability, { numerator: 3, denominator: 5 });
});

test("gamestop: a listing without any trade credit stays discoverable", () => {
  const base = baseSource();
  const outcome = expectBuybackEvUnavailableV1(
    normalizeGamestopBuybackEvEvidenceV1(
      baseSource({
        hitTiers: base.hitTiers.map((tier) => ({ ...tier, tradeCredit: null })),
      }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["UNKNOWN_BUYBACK_ELIGIBILITY"]);
  assert.equal(outcome.publicPrimaryReason, "BUYBACK_UNAVAILABLE");
  assert.equal(outcome.product.state, "known");
  assert.notEqual(outcome.observation, null);
});

test("gamestop: an unrecognized trade-credit state fails closed", () => {
  const base = baseSource();
  const outcome = expectBuybackEvUnavailableV1(
    normalizeGamestopBuybackEvEvidenceV1(
      baseSource({
        hitTiers: base.hitTiers.map((tier) =>
          tier.tierLabel === "Premium"
            ? { ...tier, tradeCredit: { kind: "unknown" as const, offerUsd: null } }
            : tier,
        ),
      }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["UNKNOWN_BUYBACK_ELIGIBILITY"]);
});

test("gamestop: a guaranteed offer without an amount cannot price a payout", () => {
  const base = baseSource();
  const outcome = expectBuybackEvUnavailableV1(
    normalizeGamestopBuybackEvEvidenceV1(
      baseSource({
        hitTiers: base.hitTiers.map((tier) =>
          tier.tierLabel === "Chase"
            ? {
                ...tier,
                tradeCredit: {
                  kind: "guaranteed_cash_offer" as const,
                  offerUsd: null,
                },
              }
            : tier,
        ),
      }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["UNKNOWN_BUYBACK_ELIGIBILITY"]);
});

test("gamestop: a tier without published odds is incomplete probabilities", () => {
  const base = baseSource();
  const outcome = expectBuybackEvUnavailableV1(
    normalizeGamestopBuybackEvEvidenceV1(
      baseSource({
        hitTiers: base.hitTiers.map((tier) =>
          tier.tierLabel === "Base" ? { ...tier, oddsPercent: null } : tier,
        ),
      }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["INCOMPLETE_PROBABILITIES"]);
  assert.equal(outcome.publicPrimaryReason, "ODDS_UNAVAILABLE");
});
