import { PUBLIC_CONFIDENCE_LIMITATION_COPY } from "./confidence-limitations";
import {
  getGlossaryDefinition,
  type GlossaryFieldKey,
  METRIC_TRUST_COPY,
} from "./metric-vocabulary";
import {
  BREAK_EVEN_GROSS_EV_PERCENT_LABEL,
  CANONICAL_BUYBACK_EQUATION,
  getPackScoutEvWorkedExample,
  PACKSCOUT_EV_WORKED_EXAMPLE_IDS,
  type PackScoutEvWorkedExampleId,
} from "./packscout-ev-examples";

const CANONICAL_EXAMPLE = getPackScoutEvWorkedExample("canonical_buyback");

export type LearnMethodPoint = Readonly<{
  title: string;
  body: string;
}>;

/**
 * The compact buyback-adjusted methodology explanation for the Learn index.
 * Shared numbers (the canonical buyback equation and the break-even percent)
 * are composed from the task-010 presentation boundary, never retyped.
 */
export const PACKSCOUT_EV_METHOD = Object.freeze({
  title: "PackScout method",
  summary:
    "PackScout Gross EV is the expected guaranteed buyback payout: platform-provided odds and stated values converted through documented buyback terms, then compared with Pack Price. It stays separate from vendor-reported EV and vendor marketing.",
  points: [
    {
      title: "Platform-provided evidence only",
      body: "PackScout calculates from platform-provided prices, odds, remaining inventory, stated values, and documented buyback terms, each labeled with when it was observed. PackScout does not independently value collectibles at launch and does not verify every underlying platform data point. Vendor-reported EV stays on its own line and is never blended into PackScout Gross EV.",
    },
    {
      title: "How the buyback math works",
      body: `Each supported outcome’s stated value is first converted into the final guaranteed buyback payout the platform’s documented terms would pay — exact outcome-specific terms first, a product-wide rate only when it is documented as uniform. Gross EV $ weights those payouts by their odds; with one uniform rate that is ${CANONICAL_BUYBACK_EQUATION}. Gross EV % divides by Pack Price, ${BREAK_EVEN_GROSS_EV_PERCENT_LABEL} is the break-even point, and EV $ and EV % sign the same result above or below Pack Price.`,
    },
    {
      title: "Confidence measures evidence, not upside",
      body: `Available estimates start at full confidence, and only the approved evidence penalties reduce it: platform-published odds used instead of verified current-pool odds, midpoint value ranges, and delayed source data. Bands are Low, Medium, and High. ${METRIC_TRUST_COPY.confidenceExplanation}`,
    },
    {
      title: "Unavailable beats a guess",
      body: `Incomplete or conflicting odds, missing stated values, unknown buyback eligibility, an unsupported currency, or source data older than 60 minutes produce Unavailable or Expired — never a partial estimate, a silent zero, or a low-confidence guess. ${METRIC_TRUST_COPY.unavailableExplanation}`,
    },
    {
      title: "What EV is not",
      body: `EV is a long-run expectation across many hypothetical openings — it never guarantees or predicts one pack, and recent hot or cold streaks never change the estimate. PackScout also does not model resale liquidity, shipping, resale fees, taxes, personalized prices, or live currency conversion. ${METRIC_TRUST_COPY.adviceLine}.`,
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

export type LearnSection = Readonly<{
  heading: string;
  paragraphs?: readonly string[];
  metricKeys?: readonly GlossaryFieldKey[];
  checklist?: readonly LearnChecklistItem[];
  /** Worked examples rendered from the shared presentation-driven registry. */
  evExampleIds?: readonly PackScoutEvWorkedExampleId[];
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

/**
 * Every EV term taught by the Expected Value guide. The definitions render
 * from the one canonical glossary registry, so Learn and every glossary hint
 * always show identical wording.
 */
export const EXPECTED_VALUE_METRIC_KEYS = [
  "repackPrice",
  "grossEv",
  "grossEvPercent",
  "evDollars",
  "evPercent",
  "evConfidence",
  "buybackPercent",
  "vendorReportedEv",
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
          "A repack is a collectible product with a listed Pack Price and contents selected from a vendor’s stated inventory. You know the price before opening, but not which eligible item you will receive.",
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
          "Some platforms document an offer to buy a pull back instead of shipping it. Buyback % is the percentage of a pull’s stated value the platform pays on that sell-back. PackScout shows one Buyback % number only when the platform documents a single uniform rate governing every eligible outcome; otherwise it shows a bounded summary such as Varies by outcome or Fixed/final payout.",
          "Documented terms can also mark outcomes ineligible and apply mandatory fees, caps, floors, or fixed offers, and a guaranteed payout is not the same as an item’s market value. Availability, timing, and conditions vary by platform and product, so confirm the current vendor terms before relying on them.",
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
    readingTimeMinutes: 9,
    sections: [
      {
        heading: "Expected Value is a long-run estimate",
        paragraphs: [
          "Expected Value (EV) is a probability-weighted estimate across many hypothetical openings under the supported odds and inventory. It is useful for comparing repack structures; it never guarantees or predicts the result of one opening, and even a positive EV loses on many individual packs.",
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
        heading: "From stated value to guaranteed payout",
        paragraphs: [
          "PackScout starts from each supported outcome’s platform-stated value. Weighting those stated values by their odds produces the Underlying Outcome EV — a protected intermediate number that stays calculation evidence and is never shown as a public metric.",
          "Documented buyback terms then convert each outcome’s stated value into the final guaranteed buyback payout the platform would actually pay. Exact outcome-specific terms take priority; a product-wide rate applies only when the platform documents that one uniform rate governs every eligible outcome — which is also the only case where Buyback % shows a number instead of a bounded summary.",
          "Mandatory fees, caps, floors, and fixed offers are applied in the approved payout order, an explicitly ineligible outcome contributes a $0.00 payout, and unknown eligibility makes the estimate Unavailable. A value the platform already states as a final buyback payout is never discounted a second time.",
          `Gross EV $ is the probability-weighted sum of those final guaranteed payouts, multiplied across a pack’s approved number of draws. With one documented uniform rate the whole conversion reads as ${CANONICAL_BUYBACK_EQUATION}.`,
        ],
      },
      {
        heading: "The metrics PackScout shows",
        paragraphs: [
          "PackScout uses the same metric definitions on Dashboard, All Repacks, and Learn, so a label keeps one meaning wherever you see it.",
          `Gross EV % of ${BREAK_EVEN_GROSS_EV_PERCENT_LABEL} is the break-even point: the expected guaranteed payout exactly equals Pack Price. EV $ and EV % are signed against Pack Price, so values above break-even carry an explicit plus sign and values below render negative — in the shared example, a Gross EV % of ${CANONICAL_EXAMPLE.presentation.grossEvPercent.displayValue} is exactly an EV % of ${CANONICAL_EXAMPLE.presentation.evPercent.displayValue}.`,
        ],
        metricKeys: EXPECTED_VALUE_METRIC_KEYS,
      },
      {
        heading: "Worked examples",
        paragraphs: [
          "These hypothetical examples do not describe a current repack or vendor listing. Every number below is rendered by the same shared presentation code that renders the catalog, so the examples cannot drift from the live formulas.",
        ],
        evExampleIds: PACKSCOUT_EV_WORKED_EXAMPLE_IDS,
      },
      {
        heading: "Where the odds and stated values come from",
        paragraphs: [
          "For a finite pool, complete current remaining-inventory odds take priority: when platform data deterministically shows what remains, PackScout calculates the odds from that pool. Complete platform-published odds are the fallback, and using them adds a confidence limitation.",
          "The supported odds must cover every outcome completely and come from one atomic observation. Partial probability coverage, a material conflict between odds sources, or a non-atomic observation makes the estimate Unavailable instead of a blended guess.",
          "Exact stated values are preferred. A closed platform range uses its midpoint and adds a confidence limitation; a missing, inverted, or open-ended range makes the estimate Unavailable.",
        ],
      },
      {
        heading: "Confidence, freshness, and Unavailable",
        paragraphs: [
          "An available estimate starts at full confidence, and only the approved evidence penalties reduce it. The published bands are Low, Medium, and High.",
          METRIC_TRUST_COPY.confidenceExplanation,
          "Evidence age uses the oldest essential source observation. Data at most 15 minutes old carries no penalty, older data is progressively penalized, and once the oldest essential evidence is over 60 minutes old an active estimate becomes Expired and leaves the EV rankings. A sold-out repack instead freezes its last valid estimate as an explicit historical state.",
          METRIC_TRUST_COPY.unavailableExplanation,
          "Missing essential evidence is never a low-confidence estimate: price, currency, probabilities, stated values, eligibility, buyback terms, draw count, provenance, and observation times must all be complete, or the estimate is Unavailable. An unavailable value is not zero.",
        ],
        callout: {
          label: "The only confidence limitations",
          paragraphs: [
            PUBLIC_CONFIDENCE_LIMITATION_COPY.platform_published_odds,
            PUBLIC_CONFIDENCE_LIMITATION_COPY.closed_range_midpoint,
            PUBLIC_CONFIDENCE_LIMITATION_COPY.source_age_over_15_through_30_minutes,
            PUBLIC_CONFIDENCE_LIMITATION_COPY.source_age_over_30_through_60_minutes,
          ],
        },
      },
      {
        heading: "Recent pulls never predict the next pack",
        paragraphs: [
          "Recent pulls change a PackScout estimate only when they deterministically update verified remaining inventory: pulled outcomes leave the pool, and the odds recalculate from what verifiably remains.",
          "Recent realized hit frequency is never odds evidence. A hot or cold streak does not estimate future odds, and PackScout never infers a realized EV from recent pulls, wallets, or historical hit rates.",
        ],
      },
      {
        heading: "Vendor-reported EV and PackScout EV stay separate",
        paragraphs: [
          "A vendor may publish its own EV using its inventory, odds, and valuation approach. PackScout independently calculates PackScout Gross EV from platform-provided evidence, and each estimate carries its own observation time.",
          METRIC_TRUST_COPY.sourceExplanation,
          "A missing estimate is never filled from the other source, and disagreement does not mean either value was silently changed.",
        ],
      },
      {
        heading: "What PackScout does not model",
        paragraphs: [
          "PackScout Gross EV is a guaranteed-payout comparison, not a net-profit forecast. These costs and adjustments are explicitly out of scope:",
        ],
        checklist: [
          {
            title: "Liquidity and resale friction",
            body: "No modeling of how quickly — or whether — an item could actually be resold.",
          },
          {
            title: "Shipping, resale fees, and taxes",
            body: "No shipping costs, marketplace or resale fees, or taxes are subtracted from any payout.",
          },
          {
            title: "Personalized prices",
            body: "Pack Price is the current public listed price before personalized, membership, or promo discounts.",
          },
          {
            title: "Unsupported currencies and live FX",
            body: "Calculations use canonical USD or an approved USD-equivalent at documented parity; mixed unnormalized money or live FX conversion makes the estimate Unavailable.",
          },
          {
            title: "Independent market valuation",
            body: "PackScout does not independently value collectibles, use external sales comps, or apply a proprietary valuation model at launch.",
          },
        ],
      },
      {
        heading: "Use EV as one comparison input",
        paragraphs: [
          "Two repacks with similar EV can still have very different odds, inventory depth, buyback terms, and ranges of possible outcomes. Review the underlying listing and evidence alongside the estimate — PackScout labels platform-derived claims with observation times and does not independently verify every underlying data point.",
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
          "A strong listing makes the Pack Price, eligible inventory, odds, valuation basis, buyback terms, availability, and vendor terms understandable. A missing detail is a reason to pause and verify, not proof that a vendor acted improperly.",
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
            body: "A stated item value should have a credible basis. Treat a headline value differently from a documented buyback payout — only documented terms guarantee what a platform pays back.",
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
          "PackScout shows Unavailable when supported evidence is not sufficient for a trustworthy value. It does not treat a missing estimate as zero, assume undocumented buyback terms, or manufacture a comparison from unsupported claims.",
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
          "Confirm the Pack Price, inventory, odds, valuation support, buyback conditions, listing freshness, and outbound destination. If a material term is unclear, wait for evidence or choose a listing you can evaluate.",
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
