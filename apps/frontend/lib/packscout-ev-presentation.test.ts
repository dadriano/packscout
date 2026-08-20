import assert from "node:assert/strict";
import { test } from "node:test";
import { containsProtectedEvPublicationKeyV3 } from "@packscout/contracts";
import {
  MetricPresentationConsistencyError,
  formatMoneyMinorUnits,
  formatSignedEvPercent,
  isSimulatedRepackListing,
  packScoutMetricConsistencyIssuesV3,
  presentBuybackSummaryV3,
  presentPackScoutConfidence,
  presentPackScoutEvV3,
  presentReleaseDataAsOf,
  presentRepackPrice,
  presentSignedEvPercentMetric,
  presentVendorReportedEvV3,
  type PackScoutEvV3PresentationInput,
} from "./packscout-ev-presentation";
import {
  buildV3CurrentEv,
  buildV3DelayedEv,
  buildV3ExpiredEv,
  buildV3Price,
  buildV3ReleaseIdentity,
  buildV3SoldOutEv,
  buildV3UnavailableEv,
  buildV3UnknownTimeUnavailableEv,
} from "./packscout-ev-fixtures.test-support";

function input(
  estimate: PackScoutEvV3PresentationInput["estimate"],
  overrides: Partial<PackScoutEvV3PresentationInput> = {},
): PackScoutEvV3PresentationInput {
  return {
    estimate,
    price: buildV3Price(),
    availability: "active",
    ...overrides,
  };
}

test("renders the approved $100 / 85% example with all four exact metrics", () => {
  const presentation = presentPackScoutEvV3(input(buildV3CurrentEv(8_500)));

  assert.equal(presentation.availability, "available");
  assert.equal(presentation.status, "current");
  assert.equal(presentation.grossEvDollars.label, "Gross EV $");
  assert.equal(presentation.grossEvDollars.displayValue, "$85.00");
  assert.equal(presentation.grossEvPercent.label, "Gross EV %");
  assert.equal(presentation.grossEvPercent.displayValue, "85.00%");
  assert.equal(presentation.evDollars.label, "EV $");
  assert.equal(presentation.evDollars.displayValue, "-$15.00");
  assert.equal(presentation.evPercent.label, "EV %");
  assert.equal(presentation.evPercent.displayValue, "-15.00%");
  assert.equal(presentation.packPrice.label, "Pack Price");
  assert.equal(presentation.packPrice.displayValue, "$100.00");
  assert.equal(presentation.semanticState, "negative");
  assert.equal(presentation.semanticLabel, "Negative");
  assert.equal(
    presentation.sourceLine,
    "PackScout Gross EV — calculated from platform-provided data",
  );
  assert.equal(presentation.adviceLine, "Not financial or gambling advice");
  assert.match(presentation.accessibleLabel, /Gross EV \$: \$85\.00/);
  assert.match(presentation.accessibleLabel, /EV %: -15\.00%. Negative/);
});

test("positive estimates carry explicit plus signs on both signed metrics", () => {
  const presentation = presentPackScoutEvV3(input(buildV3CurrentEv(11_900)));

  assert.equal(presentation.evDollars.displayValue, "+$19.00");
  assert.equal(presentation.evPercent.displayValue, "+19.00%");
  assert.equal(presentation.semanticState, "positive");
  assert.equal(presentation.grossEvDollars.displayValue, "$119.00");
  assert.equal(presentation.grossEvPercent.displayValue, "119.00%");
});

test("break-even estimates present a neutral state without invented signs", () => {
  const presentation = presentPackScoutEvV3(input(buildV3CurrentEv(10_000)));

  assert.equal(presentation.evDollars.displayValue, "$0.00");
  assert.equal(presentation.evPercent.displayValue, "0.00%");
  assert.equal(presentation.semanticState, "neutral");
  assert.equal(presentation.semanticLabel, "Neutral");
  assert.equal(presentation.zeroPayout, false);
});

test("a valid zero payout renders $0.00 with an explicit zero-payout note", () => {
  const presentation = presentPackScoutEvV3(input(buildV3CurrentEv(0)));

  assert.equal(presentation.availability, "available");
  assert.equal(presentation.grossEvDollars.displayValue, "$0.00");
  assert.equal(presentation.grossEvPercent.displayValue, "0.00%");
  assert.equal(presentation.evDollars.displayValue, "-$100.00");
  assert.equal(presentation.zeroPayout, true);
  assert.match(presentation.zeroPayoutNote ?? "", /Valid \$0\.00 payout/);
  assert.equal(presentation.semanticState, "negative");
});

test("unavailable estimates never render zero, metrics, or a vendor fallback", () => {
  const presentation = presentPackScoutEvV3(
    input(buildV3UnavailableEv("BUYBACK_UNAVAILABLE")),
  );

  assert.equal(presentation.availability, "unavailable");
  assert.equal(presentation.status, "unavailable");
  assert.equal(presentation.statusLabel, "Unavailable");
  for (const metric of [
    presentation.grossEvDollars,
    presentation.grossEvPercent,
    presentation.evDollars,
    presentation.evPercent,
  ]) {
    assert.equal(metric.availability, "unavailable");
    assert.equal(metric.displayValue, "Unavailable");
    assert.doesNotMatch(metric.displayValue, /0/);
  }
  assert.equal(presentation.reason, "BUYBACK_UNAVAILABLE");
  assert.equal(
    presentation.reasonCopy,
    "Unavailable: documented buyback terms are unavailable.",
  );
  assert.equal(presentation.confidence.availability, "unavailable");
  // The Pack Price itself stays visible: unavailability is about the estimate.
  assert.equal(presentation.packPrice.displayValue, "$100.00");
});

test("every bounded unavailable reason has stable public copy", () => {
  for (const reason of [
    "SOURCE_EVIDENCE_UNAVAILABLE",
    "PRICE_UNAVAILABLE",
    "CURRENCY_UNSUPPORTED",
    "ODDS_UNAVAILABLE",
    "VALUE_UNAVAILABLE",
    "BUYBACK_UNAVAILABLE",
    "CALCULATION_UNAVAILABLE",
  ] as const) {
    const presentation = presentPackScoutEvV3(
      input(buildV3UnavailableEv(reason), {
        price: reason === "PRICE_UNAVAILABLE" ? buildV3Price(null) : buildV3Price(),
      }),
    );
    assert.equal(presentation.reason, reason);
    assert.ok((presentation.reasonCopy ?? "").length > 0, reason);
    assert.doesNotMatch(presentation.reasonCopy ?? "", new RegExp(reason));
  }
});

test("expired estimates present the distinct expired state with stale copy", () => {
  const presentation = presentPackScoutEvV3(input(buildV3ExpiredEv()));

  assert.equal(presentation.status, "expired");
  assert.equal(presentation.statusLabel, "Expired");
  assert.equal(presentation.reason, "SOURCE_DATA_STALE");
  assert.equal(
    presentation.reasonCopy,
    "Expired: source data is older than 60 minutes.",
  );
  assert.equal(presentation.availability, "unavailable");
});

test("delayed source age is a limitation with copy, never a hidden state", () => {
  const presentation = presentPackScoutEvV3(input(buildV3DelayedEv(8_500)));

  assert.equal(presentation.availability, "available");
  assert.equal(presentation.freshness.delayed, true);
  assert.equal(
    presentation.freshness.sourceAgeLabel,
    "Source data delayed (15–30 minutes old)",
  );
  assert.equal(presentation.confidence.scoreBasisPoints, 9_000);
  assert.deepEqual(presentation.confidence.limitations, [
    "Source data delayed (15–30 minutes old).",
  ]);
  assert.match(presentation.accessibleLabel, /Source data delayed/);
});

test("sold-out historical estimates keep values, timestamps, and no outbound action", () => {
  const presentation = presentPackScoutEvV3(
    input(buildV3SoldOutEv(8_500), { availability: "sold_out" }),
  );

  assert.equal(presentation.status, "sold_out_historical");
  assert.equal(presentation.statusLabel, "Sold out · historical estimate");
  assert.equal(presentation.availability, "available");
  assert.equal(presentation.grossEvDollars.displayValue, "$85.00");
  assert.equal(presentation.outboundActionAllowed, false);
  assert.equal(presentation.freshness.soldOutAt, "2026-08-19T10:05:00.000Z");
  assert.match(presentation.freshness.soldOutLabel ?? "", /^Sold out /);
  assert.match(presentation.accessibleLabel, /Sold out · historical estimate/);
});

test("unknown source time is an explicit state, not a fabricated timestamp", () => {
  const presentation = presentPackScoutEvV3(
    input(buildV3UnknownTimeUnavailableEv()),
  );

  assert.equal(presentation.freshness.dataAsOf, null);
  assert.equal(
    presentation.freshness.dataAsOfLabel,
    "Source observation time unknown",
  );
});

test("simulated listings surface simulated provenance on the estimate", () => {
  assert.equal(isSimulatedRepackListing("[Simulated] Pokemon Grail Gacha"), true);
  assert.equal(isSimulatedRepackListing("Pokemon Grail Gacha"), false);
  assert.equal(isSimulatedRepackListing(undefined), false);

  const simulated = presentPackScoutEvV3(
    input(buildV3CurrentEv(8_500), {
      repackName: "[Simulated] Pokemon Grail Gacha",
    }),
  );
  assert.equal(simulated.simulated, true);
  assert.equal(simulated.simulatedLabel, "Simulated data");
  assert.match(simulated.accessibleLabel, /Simulated data/);

  const canonical = presentPackScoutEvV3(
    input(buildV3CurrentEv(8_500), { repackName: "Pokemon Grail Gacha" }),
  );
  assert.equal(canonical.simulated, false);
  assert.equal(canonical.simulatedLabel, null);
});

test("confidence copy describes evidence reliability, never profit likelihood", () => {
  const current = buildV3CurrentEv(8_500);
  assert.equal(current.status, "current");
  const confidence = presentPackScoutConfidence(
    current.status === "current" ? current.confidence : null,
  );

  assert.equal(confidence.displayValue, "High · 100%");
  assert.equal(confidence.scoreBasisPoints, 10_000);
  assert.match(confidence.accessibleLabel, /reliable and fresh/);
  assert.match(
    confidence.accessibleLabel,
    /not profit likelihood or whether EV is positive/,
  );
});

test("buyback summaries show exact percent only for a documented uniform rate", () => {
  const uniform = presentBuybackSummaryV3({
    kind: "uniform_rate",
    rateBasisPoints: 8_500,
  });
  assert.equal(uniform.displayValue, "85%");
  assert.equal(uniform.availability, "available");

  const fractional = presentBuybackSummaryV3({
    kind: "uniform_rate",
    rateBasisPoints: 8_533,
  });
  assert.equal(fractional.displayValue, "85.33%");

  assert.equal(
    presentBuybackSummaryV3({ kind: "varies_by_outcome" }).displayValue,
    "Varies by outcome",
  );
  assert.equal(
    presentBuybackSummaryV3({ kind: "fixed_or_final_payout" }).displayValue,
    "Fixed/final payout",
  );
  assert.equal(
    presentBuybackSummaryV3({ kind: "not_documented" }).displayValue,
    "Not documented",
  );
  const unavailable = presentBuybackSummaryV3({ kind: "unavailable" });
  assert.equal(unavailable.displayValue, "Unavailable");
  assert.equal(unavailable.availability, "unavailable");
});

test("vendor-reported EV stays separate and is never merged into PackScout EV", () => {
  const vendor = presentVendorReportedEvV3({
    status: "available",
    sourceMoney: { minorUnits: 9_000, currency: "USD" },
    usdComparison: {
      status: "available",
      value: { minorUnits: 9_000, currency: "USD" },
    },
    observedAt: "2026-08-19T10:00:00.000Z",
  });

  assert.equal(vendor.label, "Vendor-reported EV");
  assert.equal(vendor.reported.displayValue, "$90.00");
  assert.equal(vendor.usdComparison.displayValue, "$90.00");
  assert.match(vendor.sourceNote, /separate from PackScout Gross EV/);
  assert.match(vendor.observedLabel ?? "", /^Vendor EV observed /);
  assert.doesNotMatch(vendor.reported.label, /Gross EV \$|^EV \$/);

  const unsupported = presentVendorReportedEvV3({
    status: "available",
    sourceMoney: { minorUnits: 12_345, currency: "USDC" },
    usdComparison: {
      status: "unavailable",
      value: null,
      reason: "CURRENCY_UNSUPPORTED",
    },
    observedAt: "2026-08-19T10:00:00.000Z",
  });
  assert.equal(unsupported.usdComparison.availability, "unavailable");
  assert.match(unsupported.reported.displayValue, /USDC/);

  const notReported = presentVendorReportedEvV3({
    status: "unavailable",
    sourceMoney: null,
    usdComparison: null,
    observedAt: null,
    reason: "NOT_REPORTED",
  });
  assert.equal(notReported.availability, "unavailable");
  assert.equal(
    notReported.reasonCopy,
    "The vendor has not reported an EV estimate.",
  );
});

test("inconsistent public values throw in development instead of rendering", () => {
  const current = buildV3CurrentEv(8_500);
  assert.equal(current.status, "current");
  const corrupted =
    current.status === "current"
      ? {
          ...current,
          metrics: {
            ...current.metrics,
            evDollars: { minorUnits: 999, currency: "USD" as const },
          },
        }
      : current;

  assert.notEqual(
    packScoutMetricConsistencyIssuesV3({
      estimate: corrupted,
      price: buildV3Price(),
      availability: "active",
    }).length,
    0,
  );
  assert.throws(
    () =>
      presentPackScoutEvV3({
        estimate: corrupted,
        price: buildV3Price(),
        availability: "active",
      }),
    MetricPresentationConsistencyError,
  );
  assert.deepEqual(
    packScoutMetricConsistencyIssuesV3(input(buildV3CurrentEv(8_500))),
    [],
  );
});

test("shared formatters keep tabular-safe precision and explicit signs", () => {
  assert.equal(
    formatMoneyMinorUnits({ minorUnits: 1_900, currency: "USD" }, { signed: true }),
    "+$19.00",
  );
  assert.equal(
    formatMoneyMinorUnits({ minorUnits: 0, currency: "USD" }, { signed: true }),
    "$0.00",
  );
  assert.equal(formatSignedEvPercent(-1_500), "-15.00%");
  assert.equal(formatSignedEvPercent(0), "0.00%");
  assert.equal(formatSignedEvPercent(1_500), "+15.00%");
});

test("server aggregates format through the same signed-percent presentation", () => {
  const available = presentSignedEvPercentMetric(
    { status: "available", basisPoints: -775 },
    "Median EV %",
  );
  assert.equal(available.displayValue, "-7.75%");
  assert.equal(available.semanticState, "negative");

  const unavailable = presentSignedEvPercentMetric(
    { status: "unavailable", basisPoints: null, reason: "ESTIMATE_UNAVAILABLE" },
    "Median EV %",
  );
  assert.equal(unavailable.availability, "unavailable");
  assert.equal(unavailable.displayValue, "Unavailable");
});

test("presentation output never carries protected calculation evidence", () => {
  for (const estimate of [
    buildV3CurrentEv(8_500),
    buildV3DelayedEv(8_500),
    buildV3SoldOutEv(8_500),
    buildV3UnavailableEv("BUYBACK_UNAVAILABLE"),
    buildV3ExpiredEv(),
  ]) {
    const presentation = presentPackScoutEvV3(
      input(estimate, {
        availability: estimate.status === "sold_out_historical" ? "sold_out" : "active",
      }),
    );
    assert.equal(containsProtectedEvPublicationKeyV3(presentation), false);
    assert.doesNotMatch(
      JSON.stringify(presentation),
      /probability|outcome[A-Z_]|underlying|rawPayload/i,
    );
  }
});

test("price and release timestamps present through the shared boundary", () => {
  assert.equal(presentRepackPrice(buildV3Price()).displayValue, "$100.00");
  assert.equal(
    presentRepackPrice(buildV3Price(null)).availability,
    "unavailable",
  );
  const release = presentReleaseDataAsOf(buildV3ReleaseIdentity());
  assert.equal(release.dataAsOf, "2026-08-19T10:00:00.000Z");
  assert.match(release.label, /^Repack data as of /);
});
