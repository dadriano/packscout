import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_REPACKS_HEADERS } from "./all-repacks-table";
import {
  BUYBACK_SUMMARY_COPY,
  COMPARISON_GLOSSARY,
  ESTIMATE_STATUS_COPY,
  EXPECTED_VALUE_ARTICLE_HREF,
  getGlossaryDefinition,
  getPublicReasonCopy,
  METRIC_TRUST_COPY,
  PUBLIC_REASON_COPY,
  SOURCE_AGE_COPY,
} from "./metric-vocabulary";

/**
 * Internal reason codes are SCREAMING_SNAKE_CASE. Public copy must never expose
 * one, so this matches any such token rather than only the specific reason under
 * inspection — a leak from any boundary is caught, not just a self-referencing one.
 */
const INTERNAL_CODE_PATTERN = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;

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

test("every comparison table column resolves to a glossary definition", () => {
  // The repacks table renders a hint for each column from the glossary. Dropping
  // a glossary entry breaks that column at runtime, which is what this catches.
  for (const header of ALL_REPACKS_HEADERS) {
    const definition = getGlossaryDefinition(header.key);
    assert.equal(definition.key, header.key);
    assert.ok(
      definition.label.trim().length > 0,
      `${header.key} needs a label`,
    );
    assert.ok(
      definition.definition.trim().length > 0,
      `${header.key} needs a definition`,
    );
  }
});

test("glossary entries are unique and enabled by default", () => {
  const keys = COMPARISON_GLOSSARY.map((entry) => entry.key);
  assert.equal(
    new Set(keys).size,
    keys.length,
    "glossary keys must be unique",
  );
  assert.ok(COMPARISON_GLOSSARY.length > 0);
  assert.ok(
    COMPARISON_GLOSSARY.every(({ enabledByDefault }) => enabledByDefault),
    "every documented field ships enabled",
  );
});

test("glossary definitions never expose internal codes to readers", () => {
  for (const { key, label, definition } of COMPARISON_GLOSSARY) {
    assert.doesNotMatch(
      label,
      INTERNAL_CODE_PATTERN,
      `${key} label leaks an internal code`,
    );
    assert.doesNotMatch(
      definition,
      INTERNAL_CODE_PATTERN,
      `${key} definition leaks an internal code`,
    );
  }
});

test("links both EV sources and confidence to the approved Learn article", () => {
  assert.equal(EXPECTED_VALUE_ARTICLE_HREF, "/learn/expected-value");
  assert.ok(EXPECTED_VALUE_ARTICLE_HREF.startsWith("/learn/"));
  const linked = COMPARISON_GLOSSARY.filter((entry) => "learnHref" in entry);
  assert.deepEqual(
    linked.map((entry) => entry.key),
    [
      "grossEv",
      "grossEvPercent",
      "evDollars",
      "evPercent",
      "evConfidence",
      "vendorReportedEv",
    ],
  );
  for (const entry of linked) {
    assert.equal(
      entry.learnHref,
      EXPECTED_VALUE_ARTICLE_HREF,
      `${entry.key} must link to the canonical article`,
    );
  }
  assert.equal(getGlossaryDefinition("evConfidence").label, "EV Confidence");
});

test("maps the bounded v3 reason vocabulary to stable public copy", () => {
  // Exhaustiveness over PublicMetricReason is enforced at compile time by the
  // `satisfies Readonly<Record<PublicMetricReason, string>>` on the source. What
  // the compiler cannot check is that the copy is fit to show a reader.
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
    "Unavailable: supported source evidence was not retained.",
  );

  const reasons = Object.keys(PUBLIC_REASON_COPY) as Array<
    keyof typeof PUBLIC_REASON_COPY
  >;
  assert.ok(reasons.length > 0);
  for (const reason of reasons) {
    const copy = getPublicReasonCopy(reason);
    assert.equal(
      copy,
      PUBLIC_REASON_COPY[reason],
      `${reason} must resolve through the accessor`,
    );
    assert.ok(copy.trim().length > 0, `${reason} needs copy`);
    assert.doesNotMatch(copy, new RegExp(reason, "i"), `${reason} leaks itself`);
    assert.doesNotMatch(
      copy,
      INTERNAL_CODE_PATTERN,
      `${reason} copy leaks an internal code`,
    );
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
  assert.equal(ESTIMATE_STATUS_COPY.current, "Current estimate");
  assert.equal(ESTIMATE_STATUS_COPY.last_known, "Last-known estimate");
  assert.equal(ESTIMATE_STATUS_COPY.historical, "Sold out · historical estimate");
  assert.equal(ESTIMATE_STATUS_COPY.simulated, "Simulated data");
  assert.match(
    SOURCE_AGE_COPY.last_known_over_60_minutes,
    /last-known estimate/,
  );
  assert.match(
    METRIC_TRUST_COPY.unavailableExplanation,
    /Age alone does not make an estimate unavailable/,
  );
});

test("metric trust language is complete and carries the disclaimer", () => {
  const entries = Object.entries(METRIC_TRUST_COPY);
  assert.ok(entries.length > 0);

  for (const [field, copy] of entries) {
    assert.ok(
      typeof copy === "string" && copy.trim().length > 0,
      `${field} needs copy`,
    );
    assert.doesNotMatch(
      copy,
      INTERNAL_CODE_PATTERN,
      `${field} leaks an internal code`,
    );
  }

  // The dashboard label must carry the compliance disclaimer verbatim, so the
  // two cannot drift apart into a compliant label and a non-compliant surface.
  // Under data_release_v3 the compliance artifact is the advice line, and the
  // provenance artifact is the source line; the dashboard disclaimer is exactly
  // their composition, so both containments are genuine containment rules.
  assert.ok(
    METRIC_TRUST_COPY.dashboardDisclaimer.includes(METRIC_TRUST_COPY.adviceLine),
    "the dashboard disclaimer must contain the advice disclaimer",
  );
  assert.ok(
    METRIC_TRUST_COPY.dashboardDisclaimer.includes(METRIC_TRUST_COPY.sourceLine),
    "the dashboard disclaimer must contain the source provenance line",
  );

  // The disclaimer has to say what it is qualifying and where the figure comes
  // from. Asserting it contains `estimateLabel` verbatim would be a copy
  // assertion wearing an invariant's clothes — it breaks when the label is
  // reworded with identical meaning.
  assert.match(
    METRIC_TRUST_COPY.dashboardDisclaimer,
    /\bEV\b/,
    "the dashboard disclaimer must name the metric it qualifies",
  );
  assert.match(
    METRIC_TRUST_COPY.dashboardDisclaimer,
    /calculated from platform-provided data/,
    "the dashboard disclaimer must state where the figure comes from",
  );
  assert.match(
    METRIC_TRUST_COPY.estimateLabel,
    /\bEV\b/,
    "the estimate label must name the metric",
  );
  // Gross EV is a calculated, probability-weighted figure rather than a guess,
  // so the "this is an estimate, not a prediction" framing lives in the long-run
  // explanation the surfaces render beside it.
  assert.match(
    METRIC_TRUST_COPY.longRunExplanation,
    /estimat/i,
    "the long-run explanation must signal that the figure is an estimate",
  );
});
