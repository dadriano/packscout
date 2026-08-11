import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CatalogSummary,
  DashboardKpis,
  PublicPackSummary,
} from "@packscout/contracts";
import {
  presentCatalogSummaries,
  presentDashboardKpis,
  presentOpportunities,
  resolveOverviewSelection,
} from "./overview-presentation";

function available<T>(value: T) {
  return {
    status: "available" as const,
    value,
    reason: null,
    nullRank: 0 as const,
  };
}

function opportunity(
  publicPackId: string,
  name: string,
  priceMinorUnits: number,
  evBasisPoints: number,
): PublicPackSummary {
  return {
    publicPackId,
    name,
    category: "Pokemon",
    platformDisplayName: "Collector Crypt",
    platformLogoUrl: null,
    primaryImage: null,
    price: {
      displayMoney: { minorUnits: priceMinorUnits, currency: "USD" },
      usdComparison: available({ minorUnits: priceMinorUnits, currency: "USD" }),
    },
    estimatedEv: {
      evPercent: available({ basisPoints: evBasisPoints }),
    },
    buyback: available({ basisPoints: 9_300, sourceKind: "direct" }),
    topChase: available({
      displayMoney: { minorUnits: 8_500_000, currency: "USD" },
      usdComparison: available({ minorUnits: 8_500_000, currency: "USD" }),
    }),
  } as PublicPackSummary;
}

test("always presents the four overview KPIs with explicit metric meaning", () => {
  const kpis: DashboardKpis = {
    totalPacks: 1_248,
    positiveEvPacks: 612,
    medianEvPercent: available({ basisPoints: 180 }),
    highestChaseValue: {
      status: "unavailable",
      value: null,
      reason: "CHASE_UNAVAILABLE",
      nullRank: 1,
    },
  };

  const presentation = presentDashboardKpis(kpis);

  assert.deepEqual(
    presentation.map(({ id }) => id),
    ["packs", "positiveEv", "medianEv", "highestChase"],
  );
  assert.deepEqual(
    presentation.map(({ value }) => value),
    ["1,248", "612", "+1.80%", "Unavailable"],
  );
  assert.equal(presentation[2]?.stateLabel, "Positive");
  assert.equal(presentation[3]?.stateLabel, "Unavailable");
  assert.equal(
    presentation[3]?.reasonCopy,
    "Top chase value unavailable.",
  );
  assert.match(presentation[0]?.helper ?? "", /applied filters/i);
});

test("preserves the provider-ranked opportunity order and authoritative values", () => {
  const first = opportunity(
    "00000000-0000-5000-8000-000000000001",
    "Mythic Pokemon Gacha",
    250_000,
    750,
  );
  const second = opportunity(
    "00000000-0000-5000-8000-000000000002",
    "Legends Booster Box",
    29_900,
    210,
  );

  const presentation = presentOpportunities([second, first]);

  assert.deepEqual(
    presentation.map(({ rank, name }) => [rank, name]),
    [
      [1, "Legends Booster Box"],
      [2, "Mythic Pokemon Gacha"],
    ],
  );
  assert.equal(presentation[0]?.packPrice.displayValue, "$299.00");
  assert.equal(presentation[0]?.evPercent.displayValue, "+2.10%");
  assert.equal(presentation[0]?.buyback.displayValue, "93%");
  assert.equal(presentation[0]?.topChaseValue.displayValue, "$85,000.00");
});

test("keeps valid overview selection and otherwise falls back deterministically", () => {
  const opportunities = [
    { publicPackId: "first" },
    { publicPackId: "second" },
  ] as Pick<PublicPackSummary, "publicPackId">[];

  assert.equal(resolveOverviewSelection(opportunities, "second"), "second");
  assert.equal(resolveOverviewSelection(opportunities, "missing"), "first");
  assert.equal(resolveOverviewSelection(opportunities, null), "first");
  assert.equal(resolveOverviewSelection([], "missing"), null);
});

test("scales catalog summaries by the current result set and retains unavailable reasons", () => {
  const summaries: CatalogSummary[] = [
    {
      key: "collector_crypt",
      label: "Collector Crypt",
      packCount: 732,
      medianEvPercent: available({ basisPoints: 230 }),
    },
    {
      key: "courtyard",
      label: "Courtyard",
      packCount: 366,
      medianEvPercent: {
        status: "unavailable",
        value: null,
        reason: "ESTIMATE_INPUT_INCOMPLETE",
        nullRank: 1,
      },
    },
  ];

  const presentation = presentCatalogSummaries(summaries);

  assert.deepEqual(presentation.map(({ barRatio }) => barRatio), [1, 0.5]);
  assert.equal(presentation[0]?.medianEvPercent.displayValue, "+2.30%");
  assert.equal(presentation[1]?.medianEvPercent.displayValue, "Unavailable");
  const unavailableMedian = presentation[1]?.medianEvPercent;
  assert.equal(unavailableMedian?.availability, "unavailable");
  if (unavailableMedian?.availability !== "unavailable") return;
  assert.match(
    unavailableMedian.reasonCopy,
    /supported evidence is incomplete/i,
  );
});
