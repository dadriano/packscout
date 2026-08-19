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
  normalizeCollectorCryptBuybackEvEvidenceV1,
  type CollectorCryptBuybackEvSourceV1,
} from "./buyback-ev-evidence.ts";

const context = buildBuybackEvFixtureContext();

function baseSource(
  overrides: Partial<CollectorCryptBuybackEvSourceV1> = {},
): CollectorCryptBuybackEvSourceV1 {
  return {
    boxId: "Box-9",
    boxRevisionId: "box-rev-2",
    feedRevisionId: "feed-rev-88",
    sourceManifestSha256: BUYBACK_EV_FIXTURE_MANIFEST_SHA256,
    observedAt: BUYBACK_EV_FIXTURE_OBSERVED_AT,
    priceUsd: 250,
    cardsPerBox: 3,
    instantBuyback: {
      percentageOfValue: 90,
      processingFeeUsd: 5,
      minimumPayoutUsd: 10,
      maximumPayoutUsd: 5_000,
      appliesToEveryCard: true,
      marketConditionsClause: false,
    },
    slots: [
      { slotLabel: "Legendary", oddsPercent: 2, insuredValueUsd: 2_000 },
      { slotLabel: "Epic", oddsPercent: 18, insuredValueUsd: 400 },
      { slotLabel: "Standard", oddsPercent: 80, insuredValueUsd: 100 },
    ],
    ...overrides,
  };
}

test("collector crypt: a complete box normalizes fee, floor, cap, and draws", () => {
  const input = expectBuybackEvCompleteV1(
    normalizeCollectorCryptBuybackEvEvidenceV1(baseSource(), context),
  );
  packScoutBuybackEvInputV1Schema.parse(input);
  assert.deepEqual(input.product, {
    productKey: "collector-crypt:box-9",
    productRevisionId: "box-rev-2",
  });
  assert.equal(input.observation.providerKey, "collector_crypt");
  assert.deepEqual(input.unitBasis, { kind: "per_draw", drawCount: 3 });
  assert.deepEqual(input.oddsEvidence, {
    sourceKind: "platform_published",
    poolKind: "non_finite",
    currentPoolEvidence: "not_applicable",
    probabilityCoverage: "complete",
  });
  const terms = input.uniformBuybackRate!.terms;
  assert.equal(terms.rateBasisPoints, 9_000);
  assert.deepEqual(terms.fixedFee.canonicalUsdCents, {
    numerator: 500,
    denominator: 1,
  });
  assert.deepEqual(terms.floor?.canonicalUsdCents, {
    numerator: 1_000,
    denominator: 1,
  });
  assert.deepEqual(terms.cap?.canonicalUsdCents, {
    numerator: 500_000,
    denominator: 1,
  });
  const legendary = input.outcomes.find(
    ({ outcomeKey }) => outcomeKey === "legendary",
  )!;
  assert.deepEqual(legendary.statedValue, {
    kind: "exact",
    amount: {
      sourceAmount: { minorUnits: 200_000, currency: "USD", precision: 2 },
      canonicalUsdCents: { numerator: 200_000, denominator: 1 },
      normalization: { kind: "usd_direct" },
    },
  });
  assert.deepEqual(legendary.probability, { numerator: 1, denominator: 50 });
});

test("collector crypt: a missing draw count is ambiguous draw semantics", () => {
  const outcome = expectBuybackEvUnavailableV1(
    normalizeCollectorCryptBuybackEvEvidenceV1(
      baseSource({ cardsPerBox: null }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["AMBIGUOUS_DRAW_SEMANTICS"]);
  assert.equal(outcome.publicPrimaryReason, "SOURCE_EVIDENCE_UNAVAILABLE");
});

test("collector crypt: a fractional draw count fails closed", () => {
  const outcome = expectBuybackEvUnavailableV1(
    normalizeCollectorCryptBuybackEvEvidenceV1(
      baseSource({ cardsPerBox: 2.5 }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["AMBIGUOUS_DRAW_SEMANTICS"]);
});

test("collector crypt: market-condition clauses are conditional terms", () => {
  const base = baseSource();
  const outcome = expectBuybackEvUnavailableV1(
    normalizeCollectorCryptBuybackEvEvidenceV1(
      baseSource({
        instantBuyback: { ...base.instantBuyback!, marketConditionsClause: true },
      }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["CONDITIONAL_BUYBACK_TERMS"]);
  assert.equal(outcome.publicPrimaryReason, "BUYBACK_UNAVAILABLE");
});

test("collector crypt: a floor above the cap is invalid buyback terms", () => {
  const base = baseSource();
  const outcome = expectBuybackEvUnavailableV1(
    normalizeCollectorCryptBuybackEvEvidenceV1(
      baseSource({
        instantBuyback: {
          ...base.instantBuyback!,
          minimumPayoutUsd: 100,
          maximumPayoutUsd: 50,
        },
      }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["INVALID_BUYBACK_TERMS"]);
});

test("collector crypt: no instant-buyback program stays discoverable", () => {
  const outcome = expectBuybackEvUnavailableV1(
    normalizeCollectorCryptBuybackEvEvidenceV1(
      baseSource({ instantBuyback: null }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["MISSING_BUYBACK"]);
  assert.equal(outcome.product.state, "known");
});

test("collector crypt: a slot without an insured value is incomplete", () => {
  const base = baseSource();
  const outcome = expectBuybackEvUnavailableV1(
    normalizeCollectorCryptBuybackEvEvidenceV1(
      baseSource({
        slots: base.slots.map((slot) =>
          slot.slotLabel === "Epic" ? { ...slot, insuredValueUsd: null } : slot,
        ),
      }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["INCOMPLETE_VALUES"]);
  assert.equal(outcome.publicPrimaryReason, "VALUE_UNAVAILABLE");
});
