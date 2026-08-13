import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  PackScoutEv,
  PublicRepackChase,
  PublicRepackSummary,
  VendorReportedEv,
} from "@packscout/contracts";
import {
  formatBasisPoints,
  formatMoneyMinorUnits,
  MetricPresentationConsistencyError,
  packScoutMetricConsistencyIssues,
  presentBuyback,
  presentPackScoutEv,
  presentPackScoutEvPercent,
  presentTopChaseValue,
  presentVendorReportedEv,
  type PackScoutEvPresentationInput,
} from "./metric-presentation";

function availableEstimate(
  priceMinorUnits: number,
  grossMinorUnits: number,
  evPercentBasisPoints: number,
): PackScoutEvPresentationInput {
  const estimate: PackScoutEv = {
    status: "available",
    metrics: {
      grossEv: { minorUnits: grossMinorUnits, currency: "USD" },
      grossReturnBasisPoints: evPercentBasisPoints + 10_000,
      evDollars: {
        minorUnits: grossMinorUnits - priceMinorUnits,
        currency: "USD",
      },
      evPercentBasisPoints,
    },
    confidence: {
      scoreBasisPoints: 7_000,
      band: "medium",
      limitationCodes: ["partial_probability_coverage"],
    },
    modelVersion: "packscout-ev-v2",
    confidencePolicyVersion: "confidence-v1",
    dataAsOf: "2026-08-11T08:30:02Z",
    calculatedAt: "2026-08-11T08:31:00Z",
  };
  return {
    repackPrice: {
      status: "available",
      value: { minorUnits: priceMinorUnits, currency: "USD" },
    },
    estimate,
  };
}

function chaseWithValue(minorUnits: number): PublicRepackChase {
  return {
    publicRepackId: "00000000-0000-5000-8000-000000000301",
    publicCollectibleId: "00000000-0000-5000-8000-000000000201",
    role: "top_chase",
    evidenceKinds: ["vendor_inventory"],
    probabilityBasisPoints: 50,
    collectible: {
      publicCollectibleId: "00000000-0000-5000-8000-000000000201",
      name: "Celestial Nexus",
      collectibleType: "card",
      publicCategoryIds: [],
      primaryImage: null,
      valuation: {
        displayMoney: { minorUnits, currency: "USD" },
        usdComparison: {
          status: "available",
          value: { minorUnits, currency: "USD" },
        },
        valuationType: "market_estimate",
        observedAt: "2026-08-11T08:30:02Z",
      },
    },
    matchConfidence: { scoreBasisPoints: 9_500, band: "high" },
    observedAt: "2026-08-11T08:30:02Z",
    displayOrder: 0,
  };
}

test("formats authoritative minor units and basis points with stable signs", () => {
  assert.equal(
    formatMoneyMinorUnits({ minorUnits: 250_000, currency: "USD" }),
    "$2,500.00",
  );
  assert.equal(
    formatMoneyMinorUnits(
      { minorUnits: 18_455, currency: "USD" },
      { signed: true },
    ),
    "+$184.55",
  );
  assert.equal(
    formatBasisPoints(-750, {
      signed: true,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
    "-7.50%",
  );
});

test("presents PackScout EV as the primary signed estimate with confidence", () => {
  const positive = presentPackScoutEv(availableEstimate(100_00, 107_50, 750));
  const negative = presentPackScoutEv(availableEstimate(100_00, 92_50, -750));

  assert.equal(positive.evPercent.displayValue, "+7.50%");
  assert.equal(positive.evDollars.displayValue, "+$7.50");
  assert.equal(positive.semanticState, "positive");
  assert.equal(positive.confidence.displayValue, "Medium · 70%");
  assert.match(positive.confidence.accessibleLabel, /reliability, not return/i);
  assert.deepEqual(positive.confidence.limitations, [
    "Probabilities cover only part of the supported outcomes.",
  ]);
  assert.doesNotMatch(
    JSON.stringify(positive.confidence),
    /partial_probability_coverage/,
  );
  assert.equal(negative.evPercent.displayValue, "-7.50%");
  assert.equal(negative.semanticState, "negative");
});

test("keeps unavailable PackScout EV distinct from zero and vendor EV", () => {
  const estimate: PackScoutEv = {
    status: "unavailable",
    metrics: null,
    confidence: null,
    modelVersion: "packscout-ev-v2",
    confidencePolicyVersion: "confidence-v1",
    dataAsOf: null,
    calculatedAt: null,
    reason: "ESTIMATE_INPUT_INCOMPLETE",
  };
  const presentation = presentPackScoutEv({
    repackPrice: {
      status: "available",
      value: { minorUnits: 100_00, currency: "USD" },
    },
    estimate,
  });

  assert.equal(presentation.semanticLabel, "Unavailable");
  assert.equal(presentation.evPercent.displayValue, "Unavailable");
  assert.equal(presentation.confidence.displayValue, "Unavailable");
  assert.equal(
    presentation.reasonCopy,
    "Estimate unavailable: supported evidence is incomplete.",
  );
  assert.doesNotMatch(JSON.stringify(presentation), /0%|vendor-reported/i);
});

test("rejects internally inconsistent PackScout metrics in development", () => {
  const valid = availableEstimate(100_00, 107_50, 750);
  assert.equal(valid.estimate.status, "available");
  if (valid.estimate.status !== "available") return;
  const invalid: PackScoutEvPresentationInput = {
    ...valid,
    estimate: {
      ...valid.estimate,
      metrics: { ...valid.estimate.metrics, evPercentBasisPoints: 749 },
    },
  };

  assert.deepEqual(packScoutMetricConsistencyIssues(valid), []);
  assert.deepEqual(packScoutMetricConsistencyIssues(invalid), [
    "PackScout EV percent must equal gross return minus 100%",
  ]);
  assert.throws(
    () => presentPackScoutEv(invalid),
    MetricPresentationConsistencyError,
  );
});

test("keeps vendor-reported EV separate from PackScout EV", () => {
  const vendorEstimate: VendorReportedEv = {
    status: "available",
    displayMoney: { minorUnits: 85_00, currency: "USD" },
    metrics: {
      grossEv: { minorUnits: 85_00, currency: "USD" },
      grossReturnBasisPoints: 8_500,
      evDollars: { minorUnits: -15_00, currency: "USD" },
      evPercentBasisPoints: -1_500,
    },
    observedAt: "2026-08-11T08:30:02Z",
  };
  const packScout = availableEstimate(100_00, 120_00, 2_000).estimate;

  assert.equal(presentVendorReportedEv(vendorEstimate).evPercent.displayValue, "-15.00%");
  assert.equal(
    presentVendorReportedEv(vendorEstimate).reportedGrossEv.displayValue,
    "$85.00",
  );
  assert.equal(presentPackScoutEvPercent(packScout).displayValue, "+20.00%");
  assert.doesNotMatch(
    presentVendorReportedEv(vendorEstimate).accessibleLabel,
    /PackScout EV/i,
  );
});

test("retains vendor-reported source money when USD comparison is unavailable", () => {
  const vendorEstimate: VendorReportedEv = {
    status: "unavailable",
    displayMoney: { minorUnits: 1_850, currency: "USDC" },
    metrics: null,
    observedAt: "2026-08-11T08:30:02Z",
    reason: "CURRENCY_UNSUPPORTED",
  };

  const presentation = presentVendorReportedEv(vendorEstimate);

  assert.equal(presentation.availability, "unavailable");
  assert.equal(presentation.reportedGrossEv.availability, "available");
  assert.equal(presentation.reportedGrossEv.displayValue, "USDC 18.50");
  assert.equal(presentation.evPercent.displayValue, "Unavailable");
  assert.equal(presentation.observedAt, "2026-08-11T08:30:02Z");
  assert.match(presentation.reasonCopy ?? "", /cannot be compared in USD/i);
  assert.match(presentation.accessibleLabel, /USDC 18\.50/);
});

test("presents buyback and desired-chase valuation from canonical V2 fields", () => {
  const buyback: PublicRepackSummary["buyback"] = {
    status: "available",
    value: { basisPoints: 9_300, sourceKind: "packscout_derived" },
  };
  const unavailableBuyback: PublicRepackSummary["buyback"] = {
    status: "unavailable",
    value: null,
    reason: "BUYBACK_UNAVAILABLE",
  };

  assert.equal(presentBuyback(buyback).displayValue, "93%");
  assert.equal(presentBuyback(unavailableBuyback).displayValue, "Unavailable");
  assert.equal(presentTopChaseValue(chaseWithValue(8_500_000)).displayValue, "$85,000.00");
  assert.equal(presentTopChaseValue(null).displayValue, "Unavailable");
  const desired = presentTopChaseValue(
    chaseWithValue(8_500_000),
    "Desired Chase Value",
  );
  assert.equal(desired.label, "Desired Chase Value");
  assert.match(desired.accessibleLabel, /^Desired Chase Value:/);
});
