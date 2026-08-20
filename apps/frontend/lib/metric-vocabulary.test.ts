import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMPARISON_GLOSSARY,
  EXPECTED_VALUE_ARTICLE_HREF,
  getGlossaryDefinition,
  getPublicReasonCopy,
  METRIC_TRUST_COPY,
  PUBLIC_REASON_COPY,
} from "./metric-vocabulary";

const expectedGlossary = [
  ["vendor", "Vendor", "The vendor offering the repack"],
  ["category", "Category", "A subject branch represented by the repack"],
  ["repack", "Repack", "The vendor’s public repack or gacha listing name"],
  [
    "heat",
    "Heat",
    "A timing signal comparing recent activity with this repack’s own baseline. Heat does not mean profit, positive EV, or a predicted outcome.",
  ],
  ["repackPrice", "Repack Price", "The amount charged to open or buy the repack"],
  ["evDollars", "EV $", "Gross EV minus Repack Price"],
  [
    "evPercent",
    "EV %",
    "The difference between Gross EV and Repack Price, shown as a percentage of Repack Price",
  ],
  [
    "evConfidence",
    "EV Confidence",
    "How reliable the EV estimate is based on supported evidence; it does not indicate whether EV is positive",
  ],
  [
    "vendorReportedEv",
    "Vendor-reported EV",
    "An EV estimate reported by the vendor and kept separate from estimated EV",
  ],
  [
    "buybackPercent",
    "Buyback %",
    "Vendor-supported buyback coverage relative to Repack Price, reported directly or derived by PackScout from documented terms",
  ],
  [
    "grossEv",
    "Gross EV",
    "Estimated value of contents before fees and shipping",
  ],
  [
    "topChase",
    "Top Chase",
    "The highest-valued eligible related collectible currently identified",
  ],
  [
    "topChaseValue",
    "Top Chase Value",
    "The supported canonical representative value attached to that collectible",
  ],
  ["promoCode", "Promo Code", "A public vendor-approved code available to copy"],
  ["repackLink", "Repack Link", "The tracked outbound link to the vendor listing"],
] as const;

test("defines all repack comparison fields with canonical shared wording", () => {
  assert.equal(COMPARISON_GLOSSARY.length, 15);
  assert.deepEqual(
    COMPARISON_GLOSSARY.map(({ key, label, definition }) => [
      key,
      label,
      definition,
    ]),
    expectedGlossary,
  );
  assert.ok(COMPARISON_GLOSSARY.every(({ enabledByDefault }) => enabledByDefault));
});

test("links both EV sources and confidence to the approved Learn article", () => {
  assert.equal(EXPECTED_VALUE_ARTICLE_HREF, "/learn/expected-value");
  assert.deepEqual(
    COMPARISON_GLOSSARY.filter(
      (entry) => "learnHref" in entry,
    ).map((entry) => entry.key),
    [
      "evDollars",
      "evPercent",
      "evConfidence",
      "vendorReportedEv",
      "grossEv",
    ],
  );
  assert.equal(getGlossaryDefinition("evConfidence").label, "EV Confidence");
});

test("maps V2 reason codes to bounded public copy", () => {
  assert.deepEqual(PUBLIC_REASON_COPY, {
    ESTIMATE_INPUT_INCOMPLETE:
      "Estimate unavailable: supported evidence is incomplete.",
    PRICE_UNAVAILABLE: "Estimate unavailable: repack price is unavailable.",
    CURRENCY_UNSUPPORTED: "Estimate unavailable: currency is not supported.",
    ESTIMATE_UNAVAILABLE: "Estimate unavailable.",
    BUYBACK_UNAVAILABLE:
      "Buyback unavailable: supported coverage is not available.",
    VALUATION_UNAVAILABLE: "Collectible value unavailable.",
    NOT_REPORTED: "The vendor has not reported an EV estimate.",
  });
  assert.equal(
    getPublicReasonCopy("CURRENCY_UNSUPPORTED"),
    "Estimate unavailable: currency is not supported.",
  );
  for (const [reason, copy] of Object.entries(PUBLIC_REASON_COPY)) {
    assert.doesNotMatch(copy, new RegExp(reason, "i"));
  }
});

test("keeps the metric trust language canonical for Dashboard and Learn", () => {
  assert.deepEqual(METRIC_TRUST_COPY, {
    dashboardDisclaimer: "EV · Estimated · Not financial advice.",
    estimateLabel: "Estimated EV",
    financialDisclaimer: "Not financial advice.",
    longRunExplanation:
      "EV is a long-run estimate. It does not predict the contents or outcome of one repack.",
    sourceExplanation:
      "Vendor-reported EV and estimated EV are separate estimates and are never averaged.",
    confidenceExplanation:
      "Confidence describes the reliability of the estimate, not whether its EV is positive or negative.",
    unavailableExplanation:
      "Unavailable means there is not enough supported evidence to show the value.",
  });
});
