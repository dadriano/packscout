import {
  getGlossaryDefinition,
  type GlossaryFieldKey,
  METRIC_TRUST_COPY,
} from "./metric-vocabulary";

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
          "A repack is a collectible product with a listed pack price and contents selected from a provider’s stated inventory. You know the price before opening, but not which eligible item you will receive.",
          "Providers can use different inventory rules, odds, categories, and opening methods. Read the listing terms for the specific pack instead of assuming that one provider’s process applies to another.",
        ],
      },
      {
        heading: "Chase items and the rest of the inventory",
        paragraphs: [
          "A chase item is one of the most desirable or highly valued eligible items in a pack. PackScout calls the highest-valued eligible related collectible it can currently identify the Top Chase.",
          "A prominent chase does not describe the most likely result. Look for supported odds and a clear inventory list so you can understand both the headline item and the range of other possible outcomes.",
        ],
      },
      {
        heading: "What a buyback offer means",
        paragraphs: [
          "Some providers offer to buy an opened item back under documented terms. Buyback % is provider-supported buyback coverage relative to Pack Price, supplied directly or derived from documented provider terms.",
          "A buyback is not the same as the market value of the item, and its availability, timing, and conditions can vary. Confirm the current provider terms before relying on it.",
        ],
      },
      {
        heading: "Provider facts and PackScout estimates",
        paragraphs: [
          "Providers report listing details such as price, eligible inventory, stated odds, and buyback terms. PackScout uses supported catalog evidence to calculate comparison estimates; it does not control the opening or the item you receive.",
        ],
        callout: {
          label: "Keep the sources separate",
          paragraphs: [METRIC_TRUST_COPY.sourceExplanation],
        },
      },
    ],
    relatedLink: {
      href: "/packs",
      label: "Compare repacks in All Packs",
      description:
        "Review pack prices, supported estimates, inventory signals, and provider listings side by side.",
    },
  },
  {
    slug: "expected-value",
    title: "What is Expected Value (EV)?",
    description:
      "How PackScout estimates long-run value and why one result can differ.",
    readingTimeMinutes: 5,
    sections: [
      {
        heading: "Expected Value is a long-run estimate",
        paragraphs: [
          "Expected Value (EV) is a probability-weighted estimate of value across many hypothetical openings under the supported inventory and odds. It is useful for comparing pack structures; it is not a forecast for the next pack.",
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
          "PackScout uses the same metric definitions on Dashboard, All Packs, and Learn so a label keeps one meaning wherever you see it.",
        ],
        metricKeys: EXPECTED_VALUE_METRIC_KEYS,
      },
      {
        heading: "A worked example",
        paragraphs: [
          "This independent example is for explanation only and does not represent a current pack or provider listing.",
        ],
        example: {
          heading: "A hypothetical $100 pack",
          rows: [
            { label: "Pack Price", value: "$100.00" },
            { label: "Gross EV", value: "$108.00" },
            { label: "EV $", value: "+$8.00" },
            { label: "EV %", value: "+8.00% · Positive" },
          ],
          explanation:
            "Gross EV minus Pack Price is +$8.00. Dividing that difference by the $100.00 Pack Price produces a signed EV % of +8.00%.",
        },
      },
      {
        heading: "Coverage, evidence, and unavailable estimates",
        paragraphs: [
          "An estimate is only as useful as its supported odds, inventory, prices, and relationships. Coverage describes how much of that required evidence PackScout can support; it is not a promise that every source is complete or current.",
          METRIC_TRUST_COPY.unavailableExplanation,
          "An unavailable value is not zero. It means the comparison should wait for better evidence rather than filling a gap with an invented number.",
        ],
      },
      {
        heading: "Use EV as one comparison input",
        paragraphs: [
          "Two packs with similar EV can still have very different odds, inventory depth, buyback terms, and ranges of possible outcomes. Review the underlying listing and evidence alongside the estimate.",
        ],
      },
    ],
    relatedLink: {
      href: "/",
      label: "Explore PackScout Estimated EV on Dashboard",
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
          "A strong listing makes the pack price, eligible inventory, odds, valuation basis, availability, and provider terms understandable. A missing detail is a reason to pause and verify, not proof that a provider acted improperly.",
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
            body: "A stated item value should have a credible basis. Treat a headline value differently from a PackScout estimate or a provider buyback offer.",
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
          "Confirm the pack price, inventory, odds, valuation support, buyback conditions, listing freshness, and outbound destination. If a material term is unclear, wait for evidence or choose a listing you can evaluate.",
        ],
      },
    ],
    relatedLink: {
      href: "/packs",
      label: "Review evidence across All Packs",
      description:
        "Compare supported fields and open a provider listing only when its public action is available.",
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
