import assert from "node:assert/strict";
import { test } from "node:test";
import { PUBLIC_CONFIDENCE_LIMITATION_COPY } from "./confidence-limitations";
import {
  EXPECTED_VALUE_METRIC_KEYS,
  findLearnGuide,
  formatReadingTime,
  getLearnMetricDefinitions,
  LEARN_GUIDES,
  PACKSCOUT_EV_METHOD,
} from "./learn-content";
import {
  COMPARISON_GLOSSARY,
  getGlossaryDefinition,
  METRIC_TRUST_COPY,
} from "./metric-vocabulary";
import {
  BREAK_EVEN_GROSS_EV_PERCENT_LABEL,
  CANONICAL_BUYBACK_EQUATION,
  PACKSCOUT_EV_WORKED_EXAMPLE_IDS,
} from "./packscout-ev-examples";

test("keeps exactly three version-controlled guides in the approved order", () => {
  assert.deepEqual(
    LEARN_GUIDES.map(({ slug, title, description }) => ({
      slug,
      title,
      description,
    })),
    [
      {
        slug: "what-is-a-repack",
        title: "What is a repack?",
        description:
          "How randomized collectible packs, chase items, and buyback offers work.",
      },
      {
        slug: "expected-value",
        title: "What is Expected Value (EV)?",
        description:
          "How vendor-reported EV, PackScout EV, and confidence support informed comparisons.",
      },
      {
        slug: "repack-red-flags",
        title: "Repack Red Flags",
        description: "Evidence to check before opening or buying a pack.",
      },
    ],
  );
  assert.ok(LEARN_GUIDES.every(({ readingTimeMinutes }) => readingTimeMinutes > 0));
  assert.equal(formatReadingTime(5), "5 min read");
});

test("Learn teaches every EV term from the one canonical glossary registry", () => {
  assert.deepEqual(
    [...EXPECTED_VALUE_METRIC_KEYS],
    [
      "repackPrice",
      "grossEv",
      "grossEvPercent",
      "evDollars",
      "evPercent",
      "evConfidence",
      "buybackPercent",
      "vendorReportedEv",
      "topChase",
    ],
  );
  // Identity, not copies: the Learn article renders the exact glossary
  // definition objects, so glossary hints and Learn can never diverge.
  for (const [index, definition] of getLearnMetricDefinitions(
    EXPECTED_VALUE_METRIC_KEYS,
  ).entries()) {
    assert.equal(
      definition,
      getGlossaryDefinition(EXPECTED_VALUE_METRIC_KEYS[index]!),
    );
  }
  // Every glossary term that links to the EV article is taught by it.
  for (const entry of COMPARISON_GLOSSARY) {
    if ("learnHref" in entry) {
      assert.ok(
        (EXPECTED_VALUE_METRIC_KEYS as readonly string[]).includes(entry.key),
        `glossary key ${entry.key} links to the EV article but is not taught there`,
      );
    }
  }
});

test("the Expected Value guide teaches the buyback formula through shared values", () => {
  const evGuide = findLearnGuide("expected-value");
  assert.ok(evGuide);
  const evCopy = JSON.stringify(evGuide);

  // The canonical example and break-even are composed from the shared
  // presentation boundary — the article must carry those exact strings.
  assert.ok(evCopy.includes(CANONICAL_BUYBACK_EQUATION));
  assert.ok(evCopy.includes(BREAK_EVEN_GROSS_EV_PERCENT_LABEL));
  assert.match(evCopy, /Underlying Outcome EV/);
  assert.match(evCopy, /never shown as a public metric/);
  assert.match(evCopy, /approved payout order/);
  assert.match(evCopy, /ineligible outcome contributes a \$0\.00 payout/);
  assert.match(evCopy, /unknown eligibility makes the estimate Unavailable/);
  assert.match(evCopy, /never discounted a second time/);
  assert.match(evCopy, /approved number of draws/);

  // The worked examples render from the shared registry in approved order.
  const exampleSection = evGuide.sections.find(
    (section) => section.evExampleIds !== undefined,
  );
  assert.ok(exampleSection);
  assert.deepEqual(
    [...(exampleSection.evExampleIds ?? [])],
    [...PACKSCOUT_EV_WORKED_EXAMPLE_IDS],
  );

  // Required trust copy appears verbatim from the canonical vocabulary.
  assert.ok(evCopy.includes(METRIC_TRUST_COPY.longRunExplanation));
  assert.ok(evCopy.includes(METRIC_TRUST_COPY.sourceExplanation));
  assert.ok(evCopy.includes(METRIC_TRUST_COPY.confidenceExplanation));
  assert.ok(evCopy.includes(METRIC_TRUST_COPY.unavailableExplanation));
  assert.equal(evGuide.relatedLink.href, "/");
});

test("the Expected Value guide explains evidence rules and model non-goals", () => {
  const evGuide = findLearnGuide("expected-value");
  assert.ok(evGuide);
  const evCopy = JSON.stringify(evGuide);

  // Odds and value evidence rules.
  assert.match(evCopy, /remaining-inventory odds take priority/);
  assert.match(evCopy, /platform-published odds are the fallback/);
  assert.match(evCopy, /Partial probability coverage/);
  assert.match(evCopy, /material conflict/);
  assert.match(evCopy, /non-atomic observation/);
  assert.match(evCopy, /closed platform range uses its midpoint/);
  assert.match(evCopy, /missing, inverted, or open-ended range/);

  // Confidence, freshness, and unavailable behavior; the only limitation
  // lines are the bounded confidence-policy vocabulary, verbatim.
  for (const limitation of Object.values(PUBLIC_CONFIDENCE_LIMITATION_COPY)) {
    assert.ok(evCopy.includes(limitation), limitation);
  }
  assert.match(evCopy, /over 60 minutes old/);
  assert.match(evCopy, /becomes Expired and leaves the EV rankings/);
  assert.match(evCopy, /freezes its last valid estimate/);
  assert.match(evCopy, /never a low-confidence estimate/);
  assert.match(evCopy, /An unavailable value is not zero/);

  // Pulls, vendor separation, and excluded economics.
  assert.match(evCopy, /deterministically update verified remaining inventory/);
  assert.match(evCopy, /hot or cold streak does not estimate future odds/);
  assert.match(evCopy, /never filled from the other source/);
  assert.match(evCopy, /Liquidity and resale friction/);
  assert.match(evCopy, /Shipping, resale fees, and taxes/);
  assert.match(evCopy, /Personalized prices/);
  assert.match(evCopy, /live FX conversion/);
  assert.match(evCopy, /Independent market valuation/);
  assert.match(evCopy, /does not independently verify every underlying data point/);
});

test("keeps repack and red-flag guidance evidence-based and catalog-linked", () => {
  const repackGuide = findLearnGuide("what-is-a-repack");
  assert.ok(repackGuide);
  assert.equal(repackGuide.relatedLink.href, "/packs");
  const repackCopy = JSON.stringify(repackGuide);
  // Buyback % keeps the buyback-adjusted meaning: a share of stated value,
  // numeric only for a documented uniform rate, bounded summaries otherwise.
  assert.match(repackCopy, /percentage of a pull’s stated value/);
  assert.match(repackCopy, /single uniform rate governing every eligible outcome/);
  assert.match(repackCopy, /Varies by outcome/);
  assert.match(repackCopy, /Fixed\/final payout/);

  const redFlags = findLearnGuide("repack-red-flags");
  assert.ok(redFlags);
  assert.equal(redFlags.relatedLink.href, "/packs");
  assert.deepEqual(
    redFlags.sections.flatMap((section) =>
      section.checklist?.map(({ title }) => title) ?? [],
    ),
    [
      "Missing or incomplete odds",
      "Unclear inventory",
      "Unsupported values",
      "Stale listings",
      "Pressure-driven claims",
    ],
  );
  assert.equal(findLearnGuide("not-a-guide"), undefined);
});

test("documents the PackScout EV method in layman's terms on the learn index", () => {
  assert.equal(PACKSCOUT_EV_METHOD.title, "PackScout method");
  assert.equal(PACKSCOUT_EV_METHOD.points.length, 5);
  assert.match(PACKSCOUT_EV_METHOD.summary, /expected guaranteed buyback payout/i);
  assert.match(PACKSCOUT_EV_METHOD.points[0]?.body ?? "", /never blended/i);
  // The compact method walk-through renders the shared derived equation.
  assert.ok(
    (PACKSCOUT_EV_METHOD.points[1]?.body ?? "").includes(
      CANONICAL_BUYBACK_EQUATION,
    ),
  );
  assert.ok(
    (PACKSCOUT_EV_METHOD.points[2]?.body ?? "").includes(
      METRIC_TRUST_COPY.confidenceExplanation,
    ),
  );
  assert.ok(
    (PACKSCOUT_EV_METHOD.points[3]?.body ?? "").includes(
      METRIC_TRUST_COPY.unavailableExplanation,
    ),
  );
  // The compact methodology promise always carries the advice line.
  assert.ok(
    (PACKSCOUT_EV_METHOD.points[4]?.body ?? "").includes(
      METRIC_TRUST_COPY.adviceLine,
    ),
  );
  assert.doesNotMatch(JSON.stringify(PACKSCOUT_EV_METHOD), /\bheat\b/i);
  assert.match(PACKSCOUT_EV_METHOD.disclaimer, /negative-EV/i);
  assert.equal(PACKSCOUT_EV_METHOD.learnMoreHref, "/learn/expected-value");
});
