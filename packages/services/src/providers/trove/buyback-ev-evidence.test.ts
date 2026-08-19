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
  normalizeTroveBuybackEvEvidenceV1,
  type TroveBuybackEvSourceV1,
} from "./buyback-ev-evidence.ts";

const context = buildBuybackEvFixtureContext();

function baseSource(
  overrides: Partial<TroveBuybackEvSourceV1> = {},
): TroveBuybackEvSourceV1 {
  return {
    packId: "Pack-11",
    packRevisionId: "pack-rev-2",
    catalogRevisionId: "trove-rev-31",
    sourceManifestSha256: BUYBACK_EV_FIXTURE_MANIFEST_SHA256,
    observedAt: BUYBACK_EV_FIXTURE_OBSERVED_AT,
    priceUsd: 30,
    cardsPerPack: 5,
    valueBasis: "guaranteed_instant_payout",
    tiers: [
      { tierLabel: "Gold", oddsPercent: 10, valueUsd: 100 },
      { tierLabel: "Silver", oddsPercent: 30, valueUsd: 30 },
      { tierLabel: "Bronze", oddsPercent: 60, valueUsd: 10 },
    ],
    ...overrides,
  };
}

test("trove: guaranteed payouts are final and never discounted again", () => {
  const input = expectBuybackEvCompleteV1(
    normalizeTroveBuybackEvEvidenceV1(baseSource(), context),
  );
  packScoutBuybackEvInputV1Schema.parse(input);
  assert.deepEqual(input.product, {
    productKey: "trove:pack-11",
    productRevisionId: "pack-rev-2",
  });
  assert.deepEqual(input.unitBasis, { kind: "per_draw", drawCount: 5 });
  assert.equal(input.uniformBuybackRate, null);
  for (const outcome of input.outcomes) {
    assert.equal(outcome.statedValue.kind, "exact");
    assert.equal(outcome.buyback.eligibility, "eligible");
    if (
      outcome.statedValue.kind === "exact" &&
      outcome.buyback.eligibility === "eligible"
    ) {
      assert.deepStrictEqual(outcome.buyback.payout, {
        kind: "exact_final_payout",
        evidenceKind: "documented_final_payout",
        amount: outcome.statedValue.amount,
      });
    }
  }
});

test("trove: estimated market values without a program have no buyback", () => {
  const outcome = expectBuybackEvUnavailableV1(
    normalizeTroveBuybackEvEvidenceV1(
      baseSource({ valueBasis: "estimated_market_value" }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["MISSING_BUYBACK"]);
  assert.equal(outcome.publicPrimaryReason, "BUYBACK_UNAVAILABLE");
  assert.equal(outcome.product.state, "known");
});

test("trove: an unstated payout basis fails closed", () => {
  const outcome = expectBuybackEvUnavailableV1(
    normalizeTroveBuybackEvEvidenceV1(baseSource({ valueBasis: null }), context),
  );
  assert.deepEqual(outcome.internalReasons, ["UNKNOWN_BUYBACK_ELIGIBILITY"]);
});

test("trove: a zero draw count is ambiguous draw semantics", () => {
  const outcome = expectBuybackEvUnavailableV1(
    normalizeTroveBuybackEvEvidenceV1(baseSource({ cardsPerPack: 0 }), context),
  );
  assert.deepEqual(outcome.internalReasons, ["AMBIGUOUS_DRAW_SEMANTICS"]);
});

test("trove: a tier without a payout figure is incomplete values", () => {
  const base = baseSource();
  const outcome = expectBuybackEvUnavailableV1(
    normalizeTroveBuybackEvEvidenceV1(
      baseSource({
        tiers: base.tiers.map((tier) =>
          tier.tierLabel === "Silver" ? { ...tier, valueUsd: null } : tier,
        ),
      }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["INCOMPLETE_VALUES"]);
  assert.equal(outcome.publicPrimaryReason, "VALUE_UNAVAILABLE");
});
