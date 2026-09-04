import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DashboardKpis,
  PublicRepackViewSummaryV3,
} from "@packscout/contracts";
import {
  buildV3CurrentEv,
  buildV3LastKnownEv,
  buildV3ViewSummary,
} from "@/lib/packscout-ev-fixtures.test-support";
import type { RepackSummaryGroupV3 } from "@/lib/public-repacks-v3";
import { resolvePackScoutEvV3AtTime } from "@/lib/packscout-ev-clock.client";
import {
  presentCatalogSummaries,
  presentDashboardKpis,
  presentOpportunityRow,
  resolveOverviewSelection,
} from "./overview-presentation";

test("presents the three overview KPIs using displayed EV", () => {
  const kpis: DashboardKpis = {
    totalRepacks: 1_248,
    medianPackScoutEvPercent: { status: "available", basisPoints: -180 },
    highestChaseValueUsdMinor: null,
    highConfidenceRepacks: 500,
  };

  const presentation = presentDashboardKpis(kpis, "packscout");

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
    "PackScout EV · 500 high confidence",
  );
  assert.equal(
    presentation[1]?.accessibleLabel,
    "Median EV %: -1.80%. Negative. PackScout EV. 500 high-confidence repacks.",
  );
  assert.equal(presentation[1]?.tone, "positive");
  assert.equal(presentation[2]?.reasonCopy, "Collectible value unavailable.");
});

test("positive source-derived medians remain visible in headline and group summaries", () => {
  const metric = { status: "available" as const, basisPoints: 800 };
  const kpis = presentDashboardKpis({ totalRepacks: 1, medianPackScoutEvPercent: metric,
    highestChaseValueUsdMinor: null, highConfidenceRepacks: 0 }, "provider_reported");
  const summaries = presentCatalogSummaries([{ key: "phygitals", label: "Phygitals",
    repackCount: 1, medianPackScoutEvPercent: metric }], [{ key: "phygitals", source: "provider_reported" }]);
  assert.equal(kpis[1]?.value, "+8.00%");
  assert.equal(kpis[1]?.tone, "positive");
  assert.equal(kpis[1]?.state, "plain");
  assert.equal(summaries[0]?.medianEvPercent.displayValue, "+8.00%");
  assert.equal(summaries[0]?.medianEvPercent.tone, "positive");
  assert.match(summaries[0]!.accessibleLabel, /Median EV %: \+8\.00%.*Platform EV × buyback/);
  assert.equal(summaries[0]?.sourceLabel, "Platform EV × buyback");
  assert.match(kpis[1]!.helper, /^Platform EV × buyback/);
});

test("negative and mixed medians retain explicit sources, and independent positives stay unavailable", () => {
  const metric = { status: "available" as const, basisPoints: -1500 };
  for (const [source, label] of [["provider_reported", "Platform EV × buyback"], ["mixed", "Mixed sources"], ["packscout", "PackScout EV"]] as const) {
    const result = presentCatalogSummaries([{ key: "sample", label: "Sample", repackCount: 1,
      medianPackScoutEvPercent: metric }], [{ key: "sample", source }]);
    assert.equal(result[0]?.medianEvPercent.displayValue, "-15.00%");
    assert.equal(result[0]?.sourceLabel, label);
    assert.ok(result[0]?.accessibleLabel.includes(label));
  }
  const result = presentDashboardKpis({ totalRepacks: 1,
    medianPackScoutEvPercent: { status: "available", basisPoints: 800 },
    highestChaseValueUsdMinor: null, highConfidenceRepacks: 0 }, "packscout");
  assert.equal(result[1]?.value, "Unavailable");
});

test("overview opportunity rows retain server-presented last-known EV", () => {
  const repack = buildV3ViewSummary({
    evEstimates: { ...buildV3ViewSummary().evEstimates, packScout: buildV3LastKnownEv() },
  });
  const row = presentOpportunityRow(repack, 1);

  assert.equal(row.packScoutEv.status, "last_known");
  assert.equal(row.packScoutEv.statusLabel, "Last-known estimate");
  assert.equal(row.packScoutEv.evDollars.displayValue, "-$15.00");
  assert.equal(row.packScoutEv.confidence.displayValue, "Medium · 50%");
  assert.equal(row.packScoutEv.tone, "negative");
  assert.equal(row.packScoutEv.confidence.tone, "caution");
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
  assert.equal(row.packScoutEv.evPercent.tone, "negative");
  assert.equal(row.packScoutEv.grossEvDollars.displayValue, "$85.00");
  assert.equal(row.packScoutEv.confidence.displayValue, "High · 100%");
  assert.equal(row.packScoutEv.confidence.tone, "positive");
  assert.equal(row.buyback.displayValue, "85%");
  assert.equal(row.topChaseValue.displayValue, "$850.00");
  assert.equal(row.simulated, false);
});

test("a clock-resolved estimate retains its values in the server-ranked row", () => {
  const repack = buildV3ViewSummary();
  const current = buildV3CurrentEv(8_500);
  assert.equal(current.status, "current");
  const deadline =
    current.status === "current" ? Date.parse(current.expiresAt) : 0;
  const expired = resolvePackScoutEvV3AtTime(current, repack.price, deadline + 1);

  const row = presentOpportunityRow(repack, 1, expired);
  assert.equal(row.packScoutEv.status, "last_known");
  assert.equal(row.packScoutEv.evDollars.displayValue, "-$15.00");
  assert.equal(
    row.packScoutEv.freshness.sourceAgeLabel,
    "Source data over 60 minutes old; last known values retained",
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

  const presentation = presentCatalogSummaries(summaries, [{ key: "collector_crypt", source: "packscout" }, { key: "courtyard", source: null }]);

  assert.deepEqual(presentation.map(({ barRatio }) => barRatio), [1, 0.5]);
  assert.equal(presentation[0]?.medianEvPercent.displayValue, "-2.30%");
  assert.equal(presentation[0]?.medianEvPercent.tone, "positive");
  assert.equal(presentation[1]?.medianEvPercent.displayValue, "Unavailable");
  assert.equal(presentation[1]?.medianEvPercent.tone, "unavailable");
});

test("overview medians propagate selective EV tones", () => {
  const kpis = presentDashboardKpis({
    totalRepacks: 1,
    medianPackScoutEvPercent: { status: "available", basisPoints: -1_000 },
    highestChaseValueUsdMinor: null,
    highConfidenceRepacks: 0,
  }, "packscout");
  const summaries = presentCatalogSummaries([
    {
      key: "collector_crypt",
      label: "Collector Crypt",
      repackCount: 1,
      medianPackScoutEvPercent: { status: "available", basisPoints: -500 },
    },
  ], [{ key: "collector_crypt", source: "packscout" }]);

  assert.equal(kpis[1]?.state, "negative");
  assert.equal(kpis[1]?.tone, "warning");
  assert.equal(summaries[0]?.medianEvPercent.semanticState, "negative");
  assert.equal(summaries[0]?.medianEvPercent.tone, "caution");
});
