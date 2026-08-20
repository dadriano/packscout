import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findLearnGuide,
  formatReadingTime,
  learnGuideHref,
  LEARN_GUIDES,
  type LearnGuide,
} from "./learn-content";

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

test("methodology matches the platform-sourced launch document", () => {
  const guide = findLearnGuide("packscout-methodology");
  assert.ok(guide);
  const text = fullArticleText(guide);

  assert.match(text, /does not independently value the cards or collectibles/i);
  assert.match(text, /including the platform's buyback percentage/i);
  assert.match(text, /Unavailable does not mean zero/i);
  assert.match(text, /Courtyard Collector Crypt Phygitals ClutchPacks GameStop Beezie Trove Stadium Vault/);
  assert.match(text, /1-800-522-4700/);
  assert.match(text, /ncpgambling\.org/);
  assert.doesNotMatch(text, /DRAFT FOR REVIEW/);
  assert.ok(wordCount(text) >= 1_000);
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
});
