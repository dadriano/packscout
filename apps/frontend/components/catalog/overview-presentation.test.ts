import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DashboardBundle,
  DashboardKpis,
  PublicRepackViewSummary,
} from "@packscout/contracts";
import {
  presentCatalogSummaries,
  presentDashboardKpis,
  presentOpportunityEmptyState,
  presentOpportunities,
  resolveOverviewSelection,
} from "./overview-presentation";

function opportunity(
  publicRepackId: string,
  name: string,
  priceMinorUnits: number,
  evBasisPoints: number,
): PublicRepackViewSummary {
  return {
    publicRepackId,
    publicVendorId: "00000000-0000-5000-8000-000000000001",
    vendorKey: "collector_crypt",
    vendorDisplayName: "Collector Crypt",
    vendorLogoUrl: null,
    name,
    format: "repack",
    contentMode: "focused",
    categories: [
      {
        publicCategoryId: "00000000-0000-5000-8000-000000000101",
        label: "Pokémon",
      },
    ],
    collectibleTypes: ["card"],
    availability: "available",
    price: {
      displayMoney: { minorUnits: priceMinorUnits, currency: "USD" },
      usdComparison: {
        status: "available",
        value: { minorUnits: priceMinorUnits, currency: "USD" },
      },
    },
    buyback: {
      status: "available",
      value: { basisPoints: 9_300, sourceKind: "vendor_reported" },
    },
    primaryImage: null,
    evEstimates: {
      vendorReported: {
        status: "unavailable",
        displayMoney: null,
        metrics: null,
        observedAt: null,
        reason: "NOT_REPORTED",
      },
      packScout: {
        status: "available",
        metrics: {
          grossEv: {
            minorUnits: Math.round(priceMinorUnits * (10_000 + evBasisPoints) / 10_000),
            currency: "USD",
          },
          grossReturnBasisPoints: 10_000 + evBasisPoints,
          evDollars: {
            minorUnits: Math.round(priceMinorUnits * evBasisPoints / 10_000),
            currency: "USD",
          },
          evPercentBasisPoints: evBasisPoints,
        },
        confidence: {
          scoreBasisPoints: 8_500,
          band: "high",
          limitationCodes: [],
        },
        modelVersion: "packscout-ev-v2",
        confidencePolicyVersion: "confidence-v1",
        dataAsOf: "2026-08-11T08:30:02Z",
        calculatedAt: "2026-08-11T08:31:00Z",
      },
    },
    topChase: null,
    contentSummary: {
      knownCollectibleCount: 1,
      chaseCount: 0,
      categoryCount: 1,
      collectibleTypeCount: 1,
      evidenceCompleteness: "partial",
      probabilityCoverageBasisPoints: 7_500,
    },
    actionAvailability: { promo: true, repackLink: true },
    sourceUpdatedAt: "2026-08-11T08:30:02Z",
    heat: {
      status: "unavailable",
      signal: null,
      reason: "NOT_PUBLISHED",
    },
  };
}

test("always presents four overview KPIs with PackScout EV meaning", () => {
  const kpis: DashboardKpis = {
    totalRepacks: 1_248,
    evaluatedEvRepacks: 900,
    positiveEvRepacks: 612,
    medianPackScoutEvPercent: { status: "available", basisPoints: 180 },
    highestChaseValueUsdMinor: null,
    highConfidenceRepacks: 500,
  };

  const presentation = presentDashboardKpis(kpis);

  assert.deepEqual(
    presentation.map(({ id }) => id),
    ["repacks", "positiveEv", "medianEv", "highestChase"],
  );
  assert.deepEqual(
    presentation.map(({ value }) => value),
    ["1,248", "612", "+1.80%", "Unavailable"],
  );
  assert.equal(presentation[1]?.helper, "Repacks with positive EV");
  assert.equal(
    presentation[1]?.accessibleLabel,
    "612 of 900 active evaluated repacks have positive EV.",
  );
  assert.equal(presentation[2]?.helper, "Median EV · 500 high confidence");
  assert.equal(presentation[2]?.accessibleLabel, "EV %: +1.80%. Positive.");
  assert.equal(presentation[3]?.reasonCopy, "Collectible value unavailable.");
});

test("presents positive EV as unavailable when no matching repack was evaluated", () => {
  const presentation = presentDashboardKpis({
    totalRepacks: 17,
    evaluatedEvRepacks: 0,
    positiveEvRepacks: 0,
    medianPackScoutEvPercent: {
      status: "unavailable",
      basisPoints: null,
      reason: "ESTIMATE_UNAVAILABLE",
    },
    highestChaseValueUsdMinor: 3_453_000,
    highConfidenceRepacks: 0,
  });

  assert.deepEqual(
    {
      value: presentation[1]?.value,
      state: presentation[1]?.state,
      stateLabel: presentation[1]?.stateLabel,
      reasonCopy: presentation[1]?.reasonCopy,
      accessibleLabel: presentation[1]?.accessibleLabel,
    },
    {
      value: "Unavailable",
      state: "unavailable",
      stateLabel: "Unavailable",
      reasonCopy: "Estimate unavailable.",
      accessibleLabel: "Positive EV: Unavailable. Estimate unavailable.",
    },
  );
});

test("explains an empty opportunity ranking as missing EV evidence", () => {
  assert.deepEqual(presentOpportunityEmptyState(0), {
    message:
      "PackScout EV estimates are not available for the repacks matching these filters yet.",
    actionLabel: "View matching repacks",
  });
  assert.deepEqual(presentOpportunityEmptyState(1), {
    message: "No ranked opportunities are available for these filters.",
    actionLabel: "View matching repacks",
  });
});

test("preserves PackScout-ranked opportunity order and exposes confidence", () => {
  const first = opportunity(
    "00000000-0000-5000-8000-000000000301",
    "Mythic Pokemon Gacha",
    250_000,
    750,
  );
  const second = opportunity(
    "00000000-0000-5000-8000-000000000302",
    "Legends Booster Box",
    29_900,
    210,
  );

  const presentation = presentOpportunities([second, first]);

  assert.deepEqual(
    presentation.map(({ rank, name }) => [rank, name]),
    [[1, "Legends Booster Box"], [2, "Mythic Pokemon Gacha"]],
  );
  assert.equal(presentation[0]?.repackPrice.displayValue, "$299.00");
  assert.equal(presentation[0]?.packScoutEvPercent.displayValue, "+2.10%");
  assert.equal(presentation[0]?.packScoutConfidence.displayValue, "High · 85%");
  assert.equal(presentation[0]?.buyback.displayValue, "93%");
  assert.equal(presentation[0]?.heat.status, "unavailable");
});

test("keeps valid overview selection and otherwise falls back deterministically", () => {
  const opportunities = [
    { publicRepackId: "first" },
    { publicRepackId: "second" },
  ] as Pick<PublicRepackViewSummary, "publicRepackId">[];

  assert.equal(resolveOverviewSelection(opportunities, "second"), "second");
  assert.equal(resolveOverviewSelection(opportunities, "missing"), "first");
  assert.equal(resolveOverviewSelection(opportunities, null), "first");
  assert.equal(resolveOverviewSelection([], "missing"), null);
});

test("scales repack groups and retains unavailable reasons", () => {
  const summaries: DashboardBundle["vendorSummaries"] = [
    {
      key: "collector_crypt",
      label: "Collector Crypt",
      repackCount: 732,
      medianPackScoutEvPercent: { status: "available", basisPoints: 230 },
    },
    {
      key: "courtyard",
      label: "Courtyard",
      repackCount: 366,
      medianPackScoutEvPercent: {
        status: "unavailable",
        basisPoints: null,
        reason: "ESTIMATE_UNAVAILABLE",
      },
    },
  ];

  const presentation = presentCatalogSummaries(summaries);

  assert.deepEqual(presentation.map(({ barRatio }) => barRatio), [1, 0.5]);
  assert.equal(presentation[0]?.medianEvPercent.displayValue, "+2.30%");
  assert.equal(presentation[1]?.medianEvPercent.displayValue, "Unavailable");
});
