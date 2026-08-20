import type { PackScoutBuybackEvConfidenceLimitationCodeV1 } from "@packscout/contracts";

export type PackScoutConfidenceLimitationCode =
  PackScoutBuybackEvConfidenceLimitationCodeV1;

/**
 * Public copy for the exact confidence-policy V1 limitation vocabulary. Each
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
} satisfies Readonly<Record<PackScoutConfidenceLimitationCode, string>>);

export function presentConfidenceLimitations(
  codes: readonly PackScoutConfidenceLimitationCode[],
): readonly string[] {
  return Object.freeze(
    codes.map((code) => PUBLIC_CONFIDENCE_LIMITATION_COPY[code]),
  );
}
