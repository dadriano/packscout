import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DashboardKpis,
  PublicRepackViewSummaryV3,
} from "@packscout/contracts";
import {
  buildV3CurrentEv,
  buildV3ViewSummary,
} from "@/lib/packscout-ev-fixtures.test-support";
import type { RepackSummaryGroupV3 } from "@/lib/public-repacks-v3";
import { resolvePackScoutEvV3AtTime } from "@/lib/packscout-ev-deadline.client";
import {
  presentCatalogSummaries,
  presentDashboardKpis,
  presentOpportunityRow,
  resolveOverviewSelection,
} from "./overview-presentation";

test("always presents four overview KPIs with buyback-adjusted meaning", () => {
  const kpis: DashboardKpis = {
    totalRepacks: 1_248,
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
  assert.match(presentation[1]?.helper ?? "", /EV \$ above zero/);
  assert.match(
    presentation[1]?.accessibleLabel ?? "",
    /Excludes unavailable, expired, and sold-out repacks/,
  );
  assert.match(presentation[2]?.helper ?? "", /high confidence/i);
  assert.equal(presentation[3]?.reasonCopy, "Collectible value unavailable.");
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

test("a deadline-resolved estimate flows into the row unchanged in shape", () => {
  const repack = buildV3ViewSummary();
  const current = buildV3CurrentEv(8_500);
  assert.equal(current.status, "current");
  const deadline =
    current.status === "current" ? Date.parse(current.expiresAt) : 0;
  const expired = resolvePackScoutEvV3AtTime(current, deadline + 1);

  const row = presentOpportunityRow(repack, 1, expired);
  assert.equal(row.packScoutEv.status, "expired");
  assert.equal(row.packScoutEv.evDollars.displayValue, "Unavailable");
  assert.equal(
    row.packScoutEv.reasonCopy,
    "Expired: source data is older than 60 minutes.",
  );
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
