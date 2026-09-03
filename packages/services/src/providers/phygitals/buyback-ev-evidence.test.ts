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
  normalizePhygitalsBuybackEvEvidenceV1,
  type PhygitalsBuybackEvSourceV1,
} from "./buyback-ev-evidence.ts";

const context = buildBuybackEvFixtureContext();

function baseSource(
  overrides: Partial<PhygitalsBuybackEvSourceV1> = {},
): PhygitalsBuybackEvSourceV1 {
  return {
    dropId: "Drop-5",
    dropRevisionId: "drop-rev-1",
    marketplaceRevisionId: "market-rev-10",
    sourceManifestSha256: BUYBACK_EV_FIXTURE_MANIFEST_SHA256,
    observedAt: BUYBACK_EV_FIXTURE_OBSERVED_AT,
    priceUsd: 75,
    drawsPerPack: 3,
    buybackPercentRatio: 0.8,
    buybackDocumentedForAllRarities: true,
    rarities: [
      { rarity: "Mythic", oddsPercent: 5, fairMarketValueUsd: 500 },
      { rarity: "Rare", oddsPercent: 35, fairMarketValueUsd: 90 },
      { rarity: "Common", oddsPercent: 60, fairMarketValueUsd: 25 },
    ],
    ...overrides,
  };
}

test("phygitals: a complete drop normalizes ratio, draws, and exact values", () => {
  const input = expectBuybackEvCompleteV1(
    normalizePhygitalsBuybackEvEvidenceV1(baseSource(), context),
  );
  packScoutBuybackEvInputV1Schema.parse(input);
  assert.deepEqual(input.product, {
    productKey: "phygitals:drop-5",
    productRevisionId: "drop-rev-1",
  });
  assert.deepEqual(input.unitBasis, { kind: "per_draw", drawCount: 3 });
  assert.equal(input.uniformBuybackRate?.terms.rateBasisPoints, 8_000);
  assert.equal(input.uniformBuybackRate?.scope, "every_eligible_outcome");
  assert.deepEqual(input.oddsEvidence, {
    sourceKind: "platform_published",
    poolKind: "finite",
    currentPoolEvidence: "unavailable",
    probabilityCoverage: "complete",
  });
  const mythic = input.outcomes.find(
    ({ outcomeKey }) => outcomeKey === "mythic",
  )!;
  assert.deepEqual(mythic.probability, { numerator: 1, denominator: 20 });
  assert.equal(mythic.statedValue.kind, "exact");
});

test("phygitals: a drop without a draw count has ambiguous semantics", () => {
  const outcome = expectBuybackEvUnavailableV1(
    normalizePhygitalsBuybackEvEvidenceV1(
      baseSource({ drawsPerPack: null }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["AMBIGUOUS_DRAW_SEMANTICS"]);
  assert.equal(outcome.publicPrimaryReason, "SOURCE_EVIDENCE_UNAVAILABLE");
});

test("phygitals: a buyback ratio above one is invalid terms", () => {
  const outcome = expectBuybackEvUnavailableV1(
    normalizePhygitalsBuybackEvEvidenceV1(
      baseSource({ buybackPercentRatio: 1.2 }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["INVALID_BUYBACK_TERMS"]);
});

test("phygitals: a ratio without documented scope fails closed", () => {
  const outcome = expectBuybackEvUnavailableV1(
    normalizePhygitalsBuybackEvEvidenceV1(
      baseSource({ buybackDocumentedForAllRarities: false }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["INVALID_BUYBACK_TERMS"]);
  assert.equal(outcome.publicPrimaryReason, "BUYBACK_UNAVAILABLE");
});

test("phygitals: a rarity without a fair market value is incomplete", () => {
  const base = baseSource();
  const outcome = expectBuybackEvUnavailableV1(
    normalizePhygitalsBuybackEvEvidenceV1(
      baseSource({
        rarities: base.rarities.map((rarity) =>
          rarity.rarity === "Rare"
            ? { ...rarity, fairMarketValueUsd: null }
            : rarity,
        ),
      }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["INCOMPLETE_VALUES"]);
});
