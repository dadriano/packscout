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
  ["platform", "Platform", "The marketplace or provider offering the pack"],
  ["category", "Category", "The collectible family represented by the pack"],
  ["pack", "Pack", "The provider’s public listing name"],
  ["packPrice", "Pack Price", "The amount charged to open or buy the pack"],
  ["evDollars", "EV $", "PackScout Gross EV minus Pack Price"],
  [
    "evPercent",
    "EV %",
    "The percentage PackScout Gross EV is above or below Pack Price",
  ],
  [
    "buybackPercent",
    "Buyback %",
    "Provider-supported buyback coverage relative to Pack Price, supplied directly or derived from documented provider terms",
  ],
  [
    "grossEv",
    "Gross EV",
    "PackScout’s estimated value of contents before fees and shipping",
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
  ["promoCode", "Promo Code", "A public platform-approved code available to copy"],
  ["packLink", "Pack Link", "The tracked outbound link to the provider listing"],
] as const;

test("defines all twelve All Packs fields with the approved shared wording", () => {
  assert.equal(COMPARISON_GLOSSARY.length, 12);
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

test("links EV glossary education to the one approved Learn article", () => {
  assert.equal(EXPECTED_VALUE_ARTICLE_HREF, "/learn/expected-value");
  assert.deepEqual(
    COMPARISON_GLOSSARY.filter(
      (entry) => "learnHref" in entry,
    ).map((entry) => [entry.key, entry.learnHref]),
    [
      ["evDollars", EXPECTED_VALUE_ARTICLE_HREF],
      ["evPercent", EXPECTED_VALUE_ARTICLE_HREF],
      ["grossEv", EXPECTED_VALUE_ARTICLE_HREF],
    ],
  );
  assert.equal(getGlossaryDefinition("evPercent").label, "EV %");
});

test("maps internal reason codes to bounded public copy", () => {
  assert.deepEqual(PUBLIC_REASON_COPY, {
    ESTIMATE_INPUT_INCOMPLETE:
      "Estimate unavailable: supported evidence is incomplete.",
    PRICE_UNAVAILABLE: "Estimate unavailable: pack price is unavailable.",
    CURRENCY_UNSUPPORTED: "Estimate unavailable: currency is not supported.",
    BUYBACK_UNAVAILABLE:
      "Buyback unavailable: supported coverage is not available.",
    CHASE_UNAVAILABLE: "Top chase value unavailable.",
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
    dashboardDisclaimer: "Estimated EV · Not financial advice.",
    estimateLabel: "PackScout Estimated EV",
    financialDisclaimer: "Not financial advice.",
    longRunExplanation:
      "EV is a long-run estimate. It does not predict the contents or outcome of one pack.",
    sourceExplanation:
      "Provider-reported values and PackScout estimates are different sources.",
    unavailableExplanation:
      "Unavailable means PackScout does not have enough supported evidence to show the value.",
  });
});
