import type { PackScoutDisplayedEvConfidenceLimitationCodeV3 } from "@packscout/contracts";

export type PackScoutConfidenceLimitationCode =
  PackScoutDisplayedEvConfidenceLimitationCodeV3;

/**
 * Public copy for the supported displayed-confidence limitation vocabulary. Each
 * line describes an evidence limitation — never profit likelihood — and no
 * other limitation may be presented.
 */
export const PUBLIC_CONFIDENCE_LIMITATION_COPY = Object.freeze({
  platform_published_odds:
    "Published odds used because verified current-pool odds are unavailable.",
  closed_range_midpoint:
    "Midpoint value ranges used for at least one supported outcome.",
  source_age_over_15_through_30_minutes:
    "Source data delayed (15–30 minutes old).",
  source_age_over_30_through_60_minutes:
    "Source data delayed (30–60 minutes old).",
  source_age_over_60_minutes:
    "Source data is over 60 minutes old; confidence continues to decay.",
  latest_calculation_unavailable:
    "A fresh supported calculation is unavailable; previous values are retained.",
} satisfies Readonly<Record<PackScoutConfidenceLimitationCode, string>>);

export function presentConfidenceLimitations(
  codes: readonly PackScoutConfidenceLimitationCode[],
): readonly string[] {
  return Object.freeze(
    codes.map((code) => PUBLIC_CONFIDENCE_LIMITATION_COPY[code]),
  );
}
