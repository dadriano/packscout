import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUYBACK_SUMMARY_COPY,
  getPublicReasonCopy,
  METRIC_TRUST_COPY,
} from "./metric-vocabulary";
import {
  BREAK_EVEN_GROSS_EV_PERCENT_LABEL,
  CANONICAL_BUYBACK_EQUATION,
  getPackScoutEvWorkedExample,
  PACKSCOUT_EV_WORKED_EXAMPLE_IDS,
  PACKSCOUT_EV_WORKED_EXAMPLES,
} from "./packscout-ev-examples";

function rows(pairs: ReadonlyArray<readonly [string, string]>) {
  return pairs.map(([label, value]) => ({ label, value }));
}

test("exposes exactly the six approved worked examples in teaching order", () => {
  assert.deepEqual(
    PACKSCOUT_EV_WORKED_EXAMPLES.map(({ id }) => id),
    [
      "canonical_buyback",
      "positive_above_break_even",
      "neutral_break_even",
      "negative_below_break_even",
      "valid_zero_payout",
      "unavailable_no_buyback",
    ],
  );
  assert.deepEqual(
    [...PACKSCOUT_EV_WORKED_EXAMPLE_IDS],
    PACKSCOUT_EV_WORKED_EXAMPLES.map(({ id }) => id),
  );
});

test("every example's metric rows come verbatim from the shared presentation", () => {
  for (const example of PACKSCOUT_EV_WORKED_EXAMPLES) {
    const { presentation } = example;
    assert.deepEqual(
      example.metricRows.map(({ label, value }) => ({ label, value })),
      [
        presentation.packPrice,
        presentation.grossEvDollars,
        presentation.grossEvPercent,
        presentation.evDollars,
        presentation.evPercent,
      ].map((metric) => ({ label: metric.label, value: metric.displayValue })),
      example.id,
    );
    // Accessible help stays tied to the same trust copy as the catalog.
    assert.ok(
      presentation.accessibleLabel.includes(METRIC_TRUST_COPY.adviceLine),
      example.id,
    );
    assert.ok(
      presentation.accessibleLabel.includes(METRIC_TRUST_COPY.sourceLine),
      example.id,
    );
  }
});

test("the canonical $100 × 85% example matches the shared presentation exactly", () => {
  assert.equal(BREAK_EVEN_GROSS_EV_PERCENT_LABEL, "100.00%");
  assert.equal(
    CANONICAL_BUYBACK_EQUATION,
    "$100.00 stated Outcome EV × 85% buyback = $85.00 Gross EV $",
  );

  const canonical = getPackScoutEvWorkedExample("canonical_buyback");
  assert.deepEqual(
    canonical.inputRows.map(({ label, value }) => ({ label, value })),
    rows([
      ["Stated Outcome EV", "$100.00"],
      ["Buyback %", "85%"],
    ]),
  );
  assert.deepEqual(
    canonical.metricRows.map(({ label, value }) => ({ label, value })),
    rows([
      ["Pack Price", "$100.00"],
      ["Gross EV $", "$85.00"],
      ["Gross EV %", "85.00%"],
      ["EV $", "-$15.00"],
      ["EV %", "-15.00%"],
    ]),
  );
  assert.equal(canonical.presentation.semanticLabel, "Negative");
  assert.equal(
    canonical.outcomeNote,
    "Gross EV % is 85.00%, 15.00 percentage points below the 100.00% break-even point, so EV $ is -$15.00 and EV % is -15.00% — Negative.",
  );
  assert.ok(canonical.narrative.includes(CANONICAL_BUYBACK_EQUATION));
});

test("positive, neutral, and negative companions carry exact signed values", () => {
  const positive = getPackScoutEvWorkedExample("positive_above_break_even");
  assert.deepEqual(
    positive.metricRows.map(({ label, value }) => ({ label, value })),
    rows([
      ["Pack Price", "$100.00"],
      ["Gross EV $", "$108.00"],
      ["Gross EV %", "108.00%"],
      ["EV $", "+$8.00"],
      ["EV %", "+8.00%"],
    ]),
  );
  assert.equal(positive.presentation.semanticLabel, "Positive");
  assert.deepEqual(
    positive.inputRows.map(({ value }) => value),
    ["$120.00", "90%"],
  );

  const neutral = getPackScoutEvWorkedExample("neutral_break_even");
  assert.deepEqual(
    neutral.metricRows.map(({ label, value }) => ({ label, value })),
    rows([
      ["Pack Price", "$100.00"],
      ["Gross EV $", "$100.00"],
      ["Gross EV %", "100.00%"],
      ["EV $", "$0.00"],
      ["EV %", "0.00%"],
    ]),
  );
  assert.equal(neutral.presentation.semanticLabel, "Neutral");
  assert.equal(
    neutral.outcomeNote,
    "Gross EV % is exactly 100.00%: the expected guaranteed payout equals Pack Price, EV $ is $0.00 and EV % is 0.00% — Neutral.",
  );

  const negative = getPackScoutEvWorkedExample("negative_below_break_even");
  assert.deepEqual(
    negative.metricRows.map(({ label, value }) => ({ label, value })),
    rows([
      ["Pack Price", "$50.00"],
      ["Gross EV $", "$45.00"],
      ["Gross EV %", "90.00%"],
      ["EV $", "-$5.00"],
      ["EV %", "-10.00%"],
    ]),
  );
  assert.equal(negative.presentation.semanticLabel, "Negative");
  assert.ok(
    negative.outcomeNote.includes(
      "10.00 percentage points below the 100.00% break-even point",
    ),
  );
});

test("the valid-zero example renders $0.00 with the explicit zero-payout note", () => {
  const zero = getPackScoutEvWorkedExample("valid_zero_payout");
  assert.deepEqual(
    zero.metricRows.map(({ label, value }) => ({ label, value })),
    rows([
      ["Pack Price", "$25.00"],
      ["Gross EV $", "$0.00"],
      ["Gross EV %", "0.00%"],
      ["EV $", "-$25.00"],
      ["EV %", "-100.00%"],
    ]),
  );
  assert.equal(
    zero.outcomeNote,
    "Valid $0.00 payout: every supported outcome pays no guaranteed buyback. EV $ is -$25.00 and EV % is -100.00% — Negative.",
  );
  assert.ok(zero.narrative.includes("explicitly ineligible"));
  assert.ok(zero.narrative.includes("not missing evidence"));
});

test("the unavailable example uses the bounded public reason, never a number", () => {
  const unavailable = getPackScoutEvWorkedExample("unavailable_no_buyback");
  assert.deepEqual(
    unavailable.metricRows.map(({ label, value }) => ({ label, value })),
    rows([
      ["Pack Price", "$100.00"],
      ["Gross EV $", "Unavailable"],
      ["Gross EV %", "Unavailable"],
      ["EV $", "Unavailable"],
      ["EV %", "Unavailable"],
    ]),
  );
  assert.equal(unavailable.presentation.availability, "unavailable");
  assert.equal(unavailable.presentation.reason, "BUYBACK_UNAVAILABLE");
  assert.equal(
    unavailable.outcomeNote,
    `${getPublicReasonCopy("BUYBACK_UNAVAILABLE")} PackScout never assumes a 100% buyback rate, and Unavailable is not zero.`,
  );
  assert.deepEqual(
    unavailable.inputRows.map(({ label, value }) => ({ label, value })),
    rows([
      ["Stated Outcome EV", "$100.00"],
      ["Buyback %", BUYBACK_SUMMARY_COPY.not_documented],
    ]),
  );
  assert.equal(
    unavailable.metricRows.some(({ value }) => value.includes("$0.00")),
    false,
  );
});
