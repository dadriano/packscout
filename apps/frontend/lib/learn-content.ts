import {
  getGlossaryDefinition,
  METRIC_TRUST_COPY,
  type GlossaryFieldKey,
} from "./metric-vocabulary";
import {
  BREAK_EVEN_GROSS_EV_PERCENT_LABEL,
  CANONICAL_BUYBACK_EQUATION,
} from "./packscout-ev-examples";
import { EXPECTED_VALUE_GUIDE } from "./learn-articles/expected-value";
import { PACKSCOUT_METHODOLOGY_GUIDE } from "./learn-articles/packscout-methodology";
import { REPACK_RED_FLAGS_GUIDE } from "./learn-articles/repack-red-flags";
import {
  LEARN_GUIDE_SLUGS,
  type LearnGuide,
  type LearnGuideSlug,
} from "./learn-articles/types";
import { WHAT_IS_A_REPACK_GUIDE } from "./learn-articles/what-is-a-repack";

export {
  LEARN_GUIDE_SLUGS,
  type LearnArticleBlock,
  type LearnChecklistItem,
  type LearnGuide,
  type LearnGuideSlug,
  type LearnSection,
} from "./learn-articles/types";
export { EXPECTED_VALUE_METRIC_KEYS } from "./learn-articles/expected-value";

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

export const LEARN_GUIDES = Object.freeze([
  PACKSCOUT_METHODOLOGY_GUIDE,
  WHAT_IS_A_REPACK_GUIDE,
  EXPECTED_VALUE_GUIDE,
  REPACK_RED_FLAGS_GUIDE,
] as const satisfies readonly LearnGuide[]);

const guideBySlug = new Map<LearnGuideSlug, LearnGuide>(
  LEARN_GUIDES.map((guide) => [guide.slug, guide]),
);

export function findLearnGuide(slug: string): LearnGuide | undefined {
  return guideBySlug.get(slug as LearnGuideSlug);
}

export function formatReadingTime(minutes: number): string {
  return `${minutes} min read`;
}

export function learnGuideHref(
  slug: LearnGuideSlug,
): `/learn/${LearnGuideSlug}` {
  return `/learn/${slug}`;
}

export function getLearnMetricDefinitions(
  keys: readonly GlossaryFieldKey[],
) {
  return keys.map((key) => getGlossaryDefinition(key));
}

if (LEARN_GUIDES.length !== LEARN_GUIDE_SLUGS.length) {
  throw new Error("Every approved Learn slug must have one full article.");
}
