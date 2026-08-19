import {
  getGlossaryDefinition,
  type GlossaryFieldKey,
  METRIC_TRUST_COPY,
} from "./metric-vocabulary";

export type LearnMethodPoint = Readonly<{
  title: string;
  body: string;
}>;

export const PACKSCOUT_EV_METHOD = Object.freeze({
  title: "PackScout method",
  summary:
    "PackScout EV estimates long-run value from supported public odds, inventory, and prices. It stays separate from vendor-reported EV and vendor marketing.",
  points: [
    {
      title: "Public evidence only",
      body: "We use supported listing data: stated odds, eligible inventory, repack price, and representative collectible values. Vendor-reported EV stays on its own line and is never blended into PackScout EV.",
    },
    {
      title: "How EV math works",
      body: "For each published outcome tier, multiply how likely it is by what that tier is worth. Add those up to get Gross EV. Subtract repack price for EV $ and EV %. When a tier is published as a range, we use the midpoint. Multi-card packs apply the same logic across each draw.",
    },
    {
      title: "EV confidence is about evidence, not upside",
      body: "EV confidence scores how complete the supported evidence is—odds coverage, inventory depth, and value support—not whether EV is positive. Thin or partial evidence lowers confidence; it does not silently fill gaps.",
    },
    {
      title: "Unavailable beats a guess",
      body: "Missing odds, incomplete inventory, unsupported currency, or other evidence gaps produce Unavailable instead of a fabricated comparison. An unavailable value is not zero.",
    },
    {
      title: "What EV is not",
      body: "EV is a long-run average, not a forecast for one pack. It does not change your odds on the next open. Not financial or gambling advice.",
    },
  ] as const satisfies readonly LearnMethodPoint[],
  disclaimer:
    "Most repacks are negative-EV by design. PackScout helps you compare how negative—and how trustworthy the estimate is—not promise an edge.",
  learnMoreHref: "/learn/expected-value",
  learnMoreLabel: "Read the full EV guide",
});

export const LEARN_GUIDE_SLUGS = [
  "what-is-a-repack",
  "expected-value",
  "repack-red-flags",
] as const;

export type LearnGuideSlug = (typeof LEARN_GUIDE_SLUGS)[number];

export type LearnChecklistItem = Readonly<{
  title: string;
  body: string;
}>;

export type LearnExampleRow = Readonly<{
  label: string;
  value: string;
}>;

export type LearnSection = Readonly<{
  heading: string;
  paragraphs?: readonly string[];
  metricKeys?: readonly GlossaryFieldKey[];
  checklist?: readonly LearnChecklistItem[];
  example?: Readonly<{
    heading: string;
    rows: readonly LearnExampleRow[];
    explanation: string;
  }>;
  callout?: Readonly<{
    label: string;
    paragraphs: readonly string[];
  }>;
}>;

export type LearnGuide = Readonly<{
  slug: LearnGuideSlug;
  title: string;
  description: string;
  readingTimeMinutes: number;
  sections: readonly LearnSection[];
  relatedLink: Readonly<{
    href: "/" | "/packs";
    label: string;
    description: string;
  }>;
}>;

export const EXPECTED_VALUE_METRIC_KEYS = [
  "grossEv",
  "evDollars",
  "evPercent",
  "buybackPercent",
  "topChase",
] as const satisfies readonly GlossaryFieldKey[];

export const LEARN_GUIDES = Object.freeze([
  {
    slug: "what-is-a-repack",
    title: "What is a repack?",
    description:
      "How randomized collectible packs, chase items, and buyback offers work.",
    readingTimeMinutes: 4,
    sections: [
      {
        heading: "A known price, with randomized contents",
        paragraphs: [
          "A repack is a collectible product with a listed repack price and contents selected from a vendor’s stated inventory. You know the price before opening, but not which eligible item you will receive.",
          "Vendors can use different inventory rules, odds, categories, and opening methods. Read the listing terms for the specific repack instead of assuming that one vendor’s process applies to another.",
        ],
      },
      {
        heading: "Chase items and the rest of the inventory",
        paragraphs: [
          "A chase item is one of the most desirable or highly valued eligible items in a repack. PackScout calls the highest-valued eligible related collectible it can currently identify the Top Chase.",
          "A prominent chase does not describe the most likely result. Look for supported odds and a clear inventory list so you can understand both the headline item and the range of other possible outcomes.",
        ],
      },
      {
        heading: "What a buyback offer means",
        paragraphs: [
          "Some vendors offer to buy an opened item back under documented terms. Buyback % is vendor-supported buyback coverage relative to Repack Price, reported directly or derived by PackScout from documented terms.",
          "A buyback is not the same as the market value of the item, and its availability, timing, and conditions can vary. Confirm the current vendor terms before relying on it.",
        ],
      },
      {
        heading: "Vendor facts and PackScout estimates",
        paragraphs: [
          "Vendors report listing details such as price, eligible inventory, stated odds, and buyback terms. PackScout uses supported post-processed evidence to calculate comparison estimates; it does not control the opening or the item you receive.",
        ],
        callout: {
          label: "Keep the sources separate",
          paragraphs: [METRIC_TRUST_COPY.sourceExplanation],
        },
      },
    ],
    relatedLink: {
      href: "/packs",
      label: "Compare repacks in All Repacks",
      description:
        "Review repack prices, supported estimates, inventory signals, and vendor listings side by side.",
    },
  },
  {
    slug: "expected-value",
    title: "What is Expected Value (EV)?",
    description:
      "How vendor-reported EV, PackScout EV, and confidence support informed comparisons.",
    readingTimeMinutes: 6,
    sections: [
      {
        heading: "Expected Value is a long-run estimate",
        paragraphs: [
          "Expected Value (EV) is a probability-weighted estimate of value across many hypothetical openings under the supported inventory and odds. It is useful for comparing repack structures; it is not a forecast for the next repack.",
        ],
        callout: {
          label: "Important limitation",
          paragraphs: [
            METRIC_TRUST_COPY.longRunExplanation,
            METRIC_TRUST_COPY.sourceExplanation,
          ],
        },
      },
      {
        heading: "The metrics PackScout shows",
        paragraphs: [
          "PackScout uses the same metric definitions on Dashboard, All Repacks, and Learn so a label keeps one meaning wherever you see it.",
        ],
        metricKeys: EXPECTED_VALUE_METRIC_KEYS,
      },
      {
        heading: "Vendor-reported EV and PackScout EV stay separate",
        paragraphs: [
          "A vendor may publish its own EV using its inventory, odds, and valuation approach. PackScout independently calculates PackScout EV from supported post-processed evidence.",
          METRIC_TRUST_COPY.sourceExplanation,
          "A missing estimate is not replaced with the other source, and disagreement does not mean either value was silently changed.",
        ],
      },
      {
        heading: "A worked example",
        paragraphs: [
          "This independent example is for explanation only and does not represent a current repack or vendor listing.",
        ],
        example: {
          heading: "A hypothetical $100 repack",
          rows: [
            { label: "Repack Price", value: "$100.00" },
            { label: "Gross EV", value: "$108.00" },
            { label: "EV $", value: "+$8.00" },
            { label: "EV %", value: "+8.00% · Positive" },
          ],
          explanation:
            "Gross EV minus Repack Price is +$8.00. Dividing that difference by the $100.00 Repack Price produces a signed EV % of +8.00%.",
        },
      },
      {
        heading: "Confidence, coverage, and unavailable estimates",
        paragraphs: [
          "An estimate is only as useful as its supported odds, inventory, prices, and relationships. Coverage describes how much of that required evidence PackScout can support; it is not a promise that every source is complete or current.",
          METRIC_TRUST_COPY.confidenceExplanation,
          METRIC_TRUST_COPY.unavailableExplanation,
          "An unavailable value is not zero. It means the comparison should wait for better evidence rather than filling a gap with an invented number.",
        ],
      },
      {
        heading: "Use EV as one comparison input",
        paragraphs: [
          "Two repacks with similar EV can still have very different odds, inventory depth, buyback terms, and ranges of possible outcomes. Review the underlying listing and evidence alongside the estimate.",
        ],
      },
    ],
    relatedLink: {
      href: "/",
      label: "Explore PackScout EV on Dashboard",
      description:
        "Return to Overview to compare supported long-run estimates and catalog context.",
    },
  },
  {
    slug: "repack-red-flags",
    title: "Repack Red Flags",
    description: "Evidence to check before opening or buying a pack.",
    readingTimeMinutes: 4,
    sections: [
      {
        heading: "Look for evidence, not just a headline",
        paragraphs: [
          "A strong listing makes the repack price, eligible inventory, odds, valuation basis, availability, and vendor terms understandable. A missing detail is a reason to pause and verify, not proof that a vendor acted improperly.",
        ],
      },
      {
        heading: "Five signals worth checking",
        checklist: [
          {
            title: "Missing or incomplete odds",
            body: "You cannot evaluate how likely different outcomes are when the listing does not support its probability model.",
          },
          {
            title: "Unclear inventory",
            body: "The listing should make the eligible item pool and important exclusions understandable, including whether inventory can change.",
          },
          {
            title: "Unsupported values",
            body: "A stated item value should have a credible basis. Treat a headline value differently from a PackScout estimate or a vendor buyback offer.",
          },
          {
            title: "Stale listings",
            body: "Old availability, inventory, prices, or terms may no longer describe what can be opened now. Confirm the listing is current.",
          },
          {
            title: "Pressure-driven claims",
            body: "Urgency language does not replace evidence. Take time to review the listing, odds, terms, and alternatives before acting.",
          },
        ],
      },
      {
        heading: "How PackScout handles evidence gaps",
        paragraphs: [
          "PackScout shows Unavailable when supported evidence is not sufficient for a trustworthy value. It does not treat a missing estimate as zero or manufacture a comparison from unsupported claims.",
        ],
        callout: {
          label: "Source check",
          paragraphs: [
            METRIC_TRUST_COPY.sourceExplanation,
            METRIC_TRUST_COPY.unavailableExplanation,
          ],
        },
      },
      {
        heading: "A simple pre-open review",
        paragraphs: [
          "Confirm the repack price, inventory, odds, valuation support, buyback conditions, listing freshness, and outbound destination. If a material term is unclear, wait for evidence or choose a listing you can evaluate.",
        ],
      },
    ],
    relatedLink: {
      href: "/packs",
      label: "Review evidence across All Repacks",
      description:
        "Compare supported fields and open a vendor listing only when its public action is available.",
    },
  },
] as const satisfies readonly LearnGuide[]);

export function findLearnGuide(slug: string): LearnGuide | undefined {
  return LEARN_GUIDES.find((guide) => guide.slug === slug);
}

export function formatReadingTime(minutes: number): string {
  return `${minutes} min read`;
}

export function getLearnMetricDefinitions(
  keys: readonly GlossaryFieldKey[],
) {
  return keys.map((key) => getGlossaryDefinition(key));
}
