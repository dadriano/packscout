import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_REPACKS_HEADERS } from "./all-repacks-table";
import {
  COMPARISON_GLOSSARY,
  EXPECTED_VALUE_ARTICLE_HREF,
  getGlossaryDefinition,
  getPublicReasonCopy,
  METRIC_TRUST_COPY,
  PUBLIC_REASON_COPY,
} from "./metric-vocabulary";

/**
 * Internal reason codes are SCREAMING_SNAKE_CASE. Public copy must never expose
 * one, so this matches any such token rather than only the specific reason under
 * inspection — a leak from any boundary is caught, not just a self-referencing one.
 */
const INTERNAL_CODE_PATTERN = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;

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

test("supporting links point only at the canonical Learn article", () => {
  const linked = COMPARISON_GLOSSARY.filter((entry) => "learnHref" in entry);
  assert.ok(
    linked.length > 0,
    "EV fields are expected to link to their explainer",
  );
  for (const entry of linked) {
    assert.equal(
      entry.learnHref,
      EXPECTED_VALUE_ARTICLE_HREF,
      `${entry.key} must link to the canonical article`,
    );
  }
  assert.ok(EXPECTED_VALUE_ARTICLE_HREF.startsWith("/learn/"));
});

test("every public reason has bounded copy that never leaks its code", () => {
  // Exhaustiveness over PublicMetricReason is enforced at compile time by the
  // `satisfies Readonly<Record<PublicMetricReason, string>>` on the source. What
  // the compiler cannot check is that the copy is fit to show a reader.
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

  // The dashboard label must carry the financial disclaimer verbatim, so the two
  // cannot drift apart into a compliant label and a non-compliant surface.
  assert.ok(
    METRIC_TRUST_COPY.dashboardDisclaimer.includes(
      METRIC_TRUST_COPY.financialDisclaimer,
    ),
    "the dashboard disclaimer must contain the financial disclaimer",
  );
  assert.ok(
    METRIC_TRUST_COPY.dashboardDisclaimer.includes(
      METRIC_TRUST_COPY.estimateLabel,
    ),
    "the dashboard disclaimer must name the estimate it qualifies",
  );
});
