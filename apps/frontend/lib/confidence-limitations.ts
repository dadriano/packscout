import type { PackScoutEv } from "@packscout/contracts";

export type PackScoutConfidenceLimitationCode = Extract<
  PackScoutEv,
  { status: "available" }
>["confidence"]["limitationCodes"][number];

export const PUBLIC_CONFIDENCE_LIMITATION_COPY = Object.freeze({
  incomplete_outcome_pool:
    "The known outcome pool is incomplete.",
  estimated_value_ranges:
    "Some collectible values use estimated ranges.",
  partial_probability_coverage:
    "Probabilities cover only part of the supported outcomes.",
  sparse_valuation_data:
    "Some collectibles have limited valuation evidence.",
  stale_valuation_data:
    "Some collectible valuations may be out of date.",
  unresolved_collectibles:
    "Some collectibles could not be matched with confidence.",
  currency_normalization_applied:
    "Some values were converted to USD for comparison.",
  vendor_odds_unverified:
    "Vendor-provided odds have not been independently verified.",
  vendor_probability_inputs:
    "This estimate includes probabilities reported by the vendor.",
} satisfies Readonly<Record<PackScoutConfidenceLimitationCode, string>>);

export function presentConfidenceLimitations(
  codes: readonly PackScoutConfidenceLimitationCode[],
): readonly string[] {
  return Object.freeze(
    codes.map((code) => PUBLIC_CONFIDENCE_LIMITATION_COPY[code]),
  );
}
