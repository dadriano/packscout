import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUYBACK_SUMMARY_COPY,
  COMPARISON_GLOSSARY,
  ESTIMATE_STATUS_COPY,
  EXPECTED_VALUE_ARTICLE_HREF,
  getGlossaryDefinition,
  getPublicReasonCopy,
  METRIC_TRUST_COPY,
  PUBLIC_REASON_COPY,
} from "./metric-vocabulary";

test("defines all repack comparison fields with buyback-adjusted wording", () => {
  assert.equal(COMPARISON_GLOSSARY.length, 16);
  assert.deepEqual(
    COMPARISON_GLOSSARY.map(({ key, label }) => [key, label]),
    [
      ["vendor", "Vendor"],
      ["category", "Category"],
      ["repack", "Repack"],
      ["heat", "Heat"],
      ["repackPrice", "Pack Price"],
      ["grossEv", "Gross EV $"],
      ["grossEvPercent", "Gross EV %"],
      ["evDollars", "EV $"],
      ["evPercent", "EV %"],
      ["evConfidence", "EV Confidence"],
      ["vendorReportedEv", "Vendor-reported EV"],
      ["buybackPercent", "Buyback %"],
      ["topChase", "Top Chase"],
      ["topChaseValue", "Top Chase Value"],
      ["promoCode", "Promo Code"],
      ["repackLink", "Repack Link"],
    ],
  );
  assert.ok(COMPARISON_GLOSSARY.every(({ enabledByDefault }) => enabledByDefault));
});

test("gross EV is defined as the expected guaranteed buyback payout", () => {
  assert.match(
    getGlossaryDefinition("grossEv").definition,
    /expected guaranteed buyback payout/,
  );
  assert.match(
    getGlossaryDefinition("grossEvPercent").definition,
    /divided by the public Pack Price/,
  );
  assert.match(
    getGlossaryDefinition("evDollars").definition,
    /Gross EV \$ minus Pack Price/,
  );
  assert.match(
    getGlossaryDefinition("evPercent").definition,
    /minus 100 percentage points/,
  );
  assert.match(
    getGlossaryDefinition("evConfidence").definition,
    /never describes profit likelihood/,
  );
  assert.match(
    getGlossaryDefinition("vendorReportedEv").definition,
    /never merged with or substituted/,
  );
  assert.match(
    getGlossaryDefinition("buybackPercent").definition,
    /uniform buyback rate/,
  );
});

test("links both EV sources and confidence to the approved Learn article", () => {
  assert.equal(EXPECTED_VALUE_ARTICLE_HREF, "/learn/expected-value");
  assert.deepEqual(
    COMPARISON_GLOSSARY.filter(
      (entry) => "learnHref" in entry,
    ).map((entry) => entry.key),
    [
      "grossEv",
      "grossEvPercent",
      "evDollars",
      "evPercent",
      "evConfidence",
      "vendorReportedEv",
    ],
  );
  assert.equal(getGlossaryDefinition("evConfidence").label, "EV Confidence");
});

test("maps the bounded v3 reason vocabulary to stable public copy", () => {
  assert.deepEqual(Object.keys(PUBLIC_REASON_COPY).sort(), [
    "BUYBACK_UNAVAILABLE",
    "CALCULATION_UNAVAILABLE",
    "CURRENCY_UNSUPPORTED",
    "ESTIMATE_UNAVAILABLE",
    "NOT_REPORTED",
    "ODDS_UNAVAILABLE",
    "PRICE_UNAVAILABLE",
    "SOURCE_DATA_STALE",
    "SOURCE_EVIDENCE_UNAVAILABLE",
    "VALUATION_UNAVAILABLE",
    "VALUE_UNAVAILABLE",
  ]);
  assert.equal(
    getPublicReasonCopy("BUYBACK_UNAVAILABLE"),
    "Unavailable: documented buyback terms are unavailable.",
  );
  assert.equal(
    getPublicReasonCopy("SOURCE_DATA_STALE"),
    "Expired: source data is older than 60 minutes.",
  );
  for (const [reason, copy] of Object.entries(PUBLIC_REASON_COPY)) {
    assert.doesNotMatch(copy, new RegExp(reason, "i"));
  }
});

test("keeps the required source, advice, and bounded-summary language canonical", () => {
  assert.equal(
    METRIC_TRUST_COPY.sourceLine,
    "PackScout Gross EV — calculated from platform-provided data",
  );
  assert.equal(METRIC_TRUST_COPY.adviceLine, "Not financial or gambling advice");
  assert.equal(METRIC_TRUST_COPY.estimateLabel, "PackScout Gross EV");
  assert.match(METRIC_TRUST_COPY.longRunExplanation, /guaranteed buyback payout/);
  assert.match(METRIC_TRUST_COPY.sourceExplanation, /never averaged or substituted/);
  assert.match(METRIC_TRUST_COPY.confidenceExplanation, /not profit likelihood/);
  assert.match(
    METRIC_TRUST_COPY.unavailableExplanation,
    /never assumes missing buyback terms/,
  );
  assert.deepEqual(BUYBACK_SUMMARY_COPY, {
    varies_by_outcome: "Varies by outcome",
    fixed_or_final_payout: "Fixed/final payout",
    not_documented: "Not documented",
    unavailable: "Unavailable",
  });
  assert.equal(ESTIMATE_STATUS_COPY.sold_out_historical, "Sold out · historical estimate");
  assert.equal(ESTIMATE_STATUS_COPY.expired, "Expired");
  assert.equal(ESTIMATE_STATUS_COPY.simulated, "Simulated data");
});
