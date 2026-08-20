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
  type LearnGuide,
  type LearnGuideSlug,
  type LearnSection,
} from "./learn-articles/types";

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

if (LEARN_GUIDES.length !== LEARN_GUIDE_SLUGS.length) {
  throw new Error("Every approved Learn slug must have one full article.");
}
