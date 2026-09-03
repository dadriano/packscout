import assert from "node:assert/strict";
import { test } from "node:test";
import { PUBLIC_CONFIDENCE_LIMITATION_COPY } from "./confidence-limitations";
import {
  EXPECTED_VALUE_METRIC_KEYS,
  findLearnGuide,
  formatReadingTime,
  getLearnMetricDefinitions,
  learnGuideHref,
  LEARN_GUIDES,
  PACKSCOUT_EV_METHOD,
  type LearnGuide,
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
import { RESPONSIBLE_PLAY_RESOURCE } from "./responsible-play";

function fullArticleText(guide: LearnGuide): string {
  const blocks = guide.sections.flatMap((section) => [
    section.heading,
    ...section.blocks.flatMap((block) => {
      if (block.type === "paragraph" || block.type === "subheading") {
        return [block.text];
      }
      if (block.type === "formula") return [block.text];
      if (block.type === "list") return [...block.items];
      return [block.caption, ...block.columns, ...block.rows.flat()];
    }),
    ...(section.callout
      ? [section.callout.label, ...section.callout.paragraphs]
      : []),
    ...(section.checklist?.flatMap(({ title, body }) => [title, body]) ?? []),
  ]);
  return [...guide.intro, ...blocks].join(" ");
}

function wordCount(text: string): number {
  return text.match(/[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

test("publishes four source-backed articles in the approved order", () => {
  assert.deepEqual(
    LEARN_GUIDES.map(({ slug, cardTitle, readingTimeMinutes }) => ({
      slug,
      cardTitle,
      readingTimeMinutes,
    })),
    [
      {
        slug: "packscout-methodology",
        cardTitle: "PackScout Methodology",
        readingTimeMinutes: 6,
      },
      {
        slug: "what-is-a-repack",
        cardTitle: "What Is a Repack?",
        readingTimeMinutes: 8,
      },
      {
        slug: "expected-value",
        cardTitle: "What Is EV (Expected Value)?",
        readingTimeMinutes: 9,
      },
      {
        slug: "repack-red-flags",
        cardTitle: "Repack Red Flags",
        readingTimeMinutes: 7,
      },
    ],
  );

  for (const guide of LEARN_GUIDES) {
    assert.ok(guide.summary.length >= 80);
    assert.equal(learnGuideHref(guide.slug), `/learn/${guide.slug}`);
    assert.ok(guide.sections.length > 0);
    assert.equal(
      new Set(guide.sections.map(({ id }) => id)).size,
      guide.sections.length,
    );
  }

  assert.equal(formatReadingTime(5), "5 min read");
  assert.equal(findLearnGuide("not-a-guide"), undefined);
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
  // The EV article teaches from the registry keys.
  const evGuide = findLearnGuide("expected-value");
  assert.ok(evGuide);
  const metricSection = evGuide.sections.find(
    (section) => section.metricKeys !== undefined,
  );
  assert.ok(metricSection);
  assert.deepEqual(
    [...(metricSection.metricKeys ?? [])],
    [...EXPECTED_VALUE_METRIC_KEYS],
  );
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

test("methodology matches the platform-sourced launch document", () => {
  const guide = findLearnGuide("packscout-methodology");
  assert.ok(guide);
  const text = fullArticleText(guide);

  assert.match(text, /does not independently value the cards or collectibles/i);
  assert.match(text, /including the platform's buyback percentage/i);
  assert.match(text, /Unavailable does not mean zero/i);
  assert.match(text, /Courtyard Collector Crypt Phygitals ClutchPacks GameStop Beezie Trove Stadium Vault/);
  assert.doesNotMatch(text, /DRAFT FOR REVIEW/);
  assert.ok(wordCount(text) >= 1_000);

  // The responsible-play section composes the one verified helpline registry
  // (release-checked in responsible-play.test.ts); no article hard-codes a
  // helpline number, so the contact can never drift between surfaces.
  assert.ok(text.includes(RESPONSIBLE_PLAY_RESOURCE.helpline.callLabel));
  assert.ok(text.includes(RESPONSIBLE_PLAY_RESOURCE.helpline.textLabel));
  assert.ok(text.includes(RESPONSIBLE_PLAY_RESOURCE.helpline.chatLabel));
  for (const paragraph of RESPONSIBLE_PLAY_RESOURCE.paragraphs) {
    assert.ok(text.includes(paragraph));
  }
  // The retired legacy number must not be reintroduced as the contact.
  assert.doesNotMatch(text, /1-800-522-4700/);
});

test("the repack article retains its history, formats, and buyer guidance", () => {
  const guide = findLearnGuide("what-is-a-repack");
  assert.ok(guide);
  const text = fullArticleText(guide);

  assert.match(text, /Where Repacks Come From: A Brief History/);
  assert.match(text, /Arena Club and Courtyard/);
  assert.match(text, /Budget repacks:/);
  assert.match(text, /Vintage repacks:/);
  assert.match(text, /Premium or breaker repacks:/);
  assert.match(text, /Digital repacks:/);
  assert.match(text, /entertainment spending, not an investment strategy/i);
  assert.equal(guide.relatedLink.href, "/packs");
  assert.ok(wordCount(text) >= 1_450);

  // Buyback % keeps the buyback-adjusted meaning: a share of stated value,
  // numeric only for a documented uniform rate, bounded summaries otherwise.
  assert.match(text, /percentage of a pull’s stated value/);
  assert.match(text, /single uniform rate governing every eligible outcome/);
  assert.match(text, /Varies by outcome/);
  assert.match(text, /Fixed\/final payout/);
  // Vendor facts stay separate from PackScout estimates.
  assert.ok(text.includes(METRIC_TRUST_COPY.sourceExplanation));
});

test("the EV article preserves formulas, examples, variance, and the worked table", () => {
  const guide = findLearnGuide("expected-value");
  assert.ok(guide);
  const text = fullArticleText(guide);
  const table = guide.sections
    .flatMap(({ blocks }) => blocks)
    .find((block) => block.type === "table");

  assert.equal(guide.showFinancialDisclaimer, true);
  assert.match(text, /Net EV = \(Sum of all probability-weighted outcomes\)/);
  assert.match(text, /\+\$25/);
  assert.match(text, /−\$0\.053/);
  assert.match(text, /variance, which is the spread of possible outcomes/i);
  assert.ok(table && table.type === "table");
  assert.deepEqual(table.columns, [
    "Tier",
    "Odds",
    "Cards in Tier",
    "Value per Card",
    "Contribution to EV",
  ]);
  assert.deepEqual(table.rows.at(-1), ["Grail card", "0.2%", "1", "$2,000", "$4.00"]);
  assert.match(text, /\$10\.50 − \$100 = −\$89\.50/);
  assert.ok(wordCount(text) >= 1_600);
});

test("the EV article teaches the buyback formula through shared values", () => {
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
  assert.ok(evCopy.includes(JSON.stringify(METRIC_TRUST_COPY.longRunExplanation).slice(1, -1)));
  assert.ok(evCopy.includes(JSON.stringify(METRIC_TRUST_COPY.sourceExplanation).slice(1, -1)));
  assert.ok(evCopy.includes(JSON.stringify(METRIC_TRUST_COPY.confidenceExplanation).slice(1, -1)));
  assert.ok(evCopy.includes(JSON.stringify(METRIC_TRUST_COPY.unavailableExplanation).slice(1, -1)));
  assert.equal(evGuide.relatedLink.href, "/");
});

test("the EV article explains evidence rules and model non-goals", () => {
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
    assert.ok(
      evCopy.includes(JSON.stringify(limitation).slice(1, -1)),
      limitation,
    );
  }
  assert.match(evCopy, /over 60 minutes old/);
  assert.match(evCopy, /stay visible and eligible available packs remain in EV rankings regardless of age/);
  assert.match(evCopy, /confidence continues to decay/);
  assert.match(evCopy, /retains its last valid estimate/);
  assert.match(evCopy, /previous supported estimate remains visible with zero confidence/);
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

test("the red-flags article includes all eight checks and the pre-purchase list", () => {
  const guide = findLearnGuide("repack-red-flags");
  assert.ok(guide);
  const redFlagSections = guide.sections.filter(({ heading }) =>
    heading.startsWith("Red Flag "),
  );
  const checklist = guide.sections
    .find(({ heading }) => heading === "A Quick Pre-Purchase Checklist")
    ?.blocks.find((block) => block.type === "list");

  assert.equal(redFlagSections.length, 8);
  assert.deepEqual(
    redFlagSections.map(({ heading }) => heading),
    [
      "Red Flag 1: No Published Checklist",
      "Red Flag 2: No Disclosed Odds",
      "Red Flag 3: Marketing That Leans Entirely on the Ceiling",
      "Red Flag 4: Raw Cards With No Condition Disclosure",
      "Red Flag 5: Fake Urgency and Manufactured Scarcity",
      "Red Flag 6: No Verifiable Track Record",
      "Red Flag 7: No Clear Return, Authenticity, or Grading Policy",
      "Red Flag 8: Price That Doesn't Match the Checklist",
    ],
  );
  assert.ok(checklist && checklist.type === "list");
  assert.equal(checklist.style, "numbered");
  assert.equal(checklist.items.length, 8);
  assert.equal(guide.relatedLink.href, "/packs");
  assert.ok(wordCount(fullArticleText(guide)) >= 1_300);

  // PackScout's evidence-gap behavior stays evidence-based and source-checked.
  const evidenceGaps = guide.sections.find(
    ({ id }) => id === "how-packscout-handles-evidence-gaps",
  );
  assert.ok(evidenceGaps);
  assert.deepEqual(evidenceGaps.callout?.paragraphs, [
    METRIC_TRUST_COPY.sourceExplanation,
    METRIC_TRUST_COPY.unavailableExplanation,
  ]);
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
