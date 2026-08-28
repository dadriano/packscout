import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DashboardKpis,
  PublicRepackViewSummaryV3,
} from "@packscout/contracts";
import {
  buildV3LastKnownPresentation,
  buildV3ViewSummary,
} from "@/lib/packscout-ev-fixtures.test-support";
import type { RepackSummaryGroupV3 } from "@/lib/public-repacks-v3";
import {
  presentCatalogSummaries,
  presentDashboardKpis,
  presentOpportunityRow,
  resolveOverviewSelection,
} from "./overview-presentation";

test("presents the three nonpositive-policy overview KPIs", () => {
  const kpis: DashboardKpis = {
    totalRepacks: 1_248,
    medianPackScoutEvPercent: { status: "available", basisPoints: -180 },
    highestChaseValueUsdMinor: null,
    highConfidenceRepacks: 500,
  };

  const presentation = presentDashboardKpis(kpis);

  assert.deepEqual(
    presentation.map(({ id }) => id),
    ["repacks", "medianEv", "highestChase"],
  );
  assert.deepEqual(
    presentation.map(({ value }) => value),
    ["1,248", "-1.80%", "Unavailable"],
  );
  assert.equal(
    presentation[1]?.helper,
    "Known current + last-known EV · 500 high confidence",
  );
  assert.equal(
    presentation[1]?.accessibleLabel,
    "Median EV %: -1.80%. Negative. Includes known current and last-known estimates. 500 high-confidence repacks.",
  );
  assert.equal(presentation[2]?.reasonCopy, "Collectible value unavailable.");
});

test("overview opportunity rows retain server-presented last-known EV", () => {
  const repack = buildV3ViewSummary({
    packScoutEvPresentation: buildV3LastKnownPresentation(),
  });
  const row = presentOpportunityRow(repack, 1);

  assert.equal(row.packScoutEv.status, "last_known");
  assert.equal(row.packScoutEv.statusLabel, "Last-known estimate");
  assert.equal(row.packScoutEv.evDollars.displayValue, "-$15.00");
  assert.equal(row.packScoutEv.confidence.displayValue, "Medium · 72%");
  assert.match(
    row.packScoutEv.freshness.dataAsOfLabel,
    /^Source evidence last observed /,
  );
});

test("presents server-ranked opportunities without re-sorting or recomputing", () => {
  const repack = buildV3ViewSummary();
  const row = presentOpportunityRow(repack, 3);

  assert.equal(row.rank, 3);
  assert.equal(row.publicRepackId, repack.publicRepackId);
  assert.equal(row.packPrice.displayValue, "$100.00");
  assert.equal(row.packScoutEv.evDollars.displayValue, "-$15.00");
  assert.equal(row.packScoutEv.evPercent.displayValue, "-15.00%");
  assert.equal(row.packScoutEv.grossEvDollars.displayValue, "$85.00");
  assert.equal(row.packScoutEv.confidence.displayValue, "High · 100%");
  assert.equal(row.buyback.displayValue, "85%");
  assert.equal(row.topChaseValue.displayValue, "$850.00");
  assert.equal(row.simulated, false);
});

test("keeps valid overview selection and otherwise falls back deterministically", () => {
  const opportunities = [
    { publicRepackId: "first" },
    { publicRepackId: "second" },
  ] as Pick<PublicRepackViewSummaryV3, "publicRepackId">[];

  assert.equal(resolveOverviewSelection(opportunities, "second"), "second");
  assert.equal(resolveOverviewSelection(opportunities, "missing"), "first");
  assert.equal(resolveOverviewSelection(opportunities, null), "first");
  assert.equal(resolveOverviewSelection([], "missing"), null);
});

test("scales repack groups and retains unavailable reasons", () => {
  const summaries: readonly RepackSummaryGroupV3[] = [
    {
      key: "collector_crypt",
      label: "Collector Crypt",
      repackCount: 732,
      medianPackScoutEvPercent: { status: "available", basisPoints: -230 },
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
  assert.equal(presentation[0]?.medianEvPercent.displayValue, "-2.30%");
  assert.equal(presentation[1]?.medianEvPercent.displayValue, "Unavailable");
});
