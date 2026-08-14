import type { PackScoutEstimatedEvLimitation } from "./estimated-ev-calculator.ts";

export type PublicPackScoutConfidenceLimitation =
  | "incomplete_outcome_pool"
  | "estimated_value_ranges"
  | "vendor_probability_inputs"
  | "currency_normalization_applied";

const PUBLIC_LIMITATION_BY_PIPELINE_LIMITATION = {
  incomplete_inventory: "incomplete_outcome_pool",
  midpoint_value_ranges: "estimated_value_ranges",
  provider_supplied_probabilities: "vendor_probability_inputs",
  verified_usd_stablecoin_at_parity: "currency_normalization_applied",
} as const satisfies Readonly<
  Record<PackScoutEstimatedEvLimitation, PublicPackScoutConfidenceLimitation>
>;

export function publicConfidenceLimitationsFromPipeline(
  limitations: readonly PackScoutEstimatedEvLimitation[],
): readonly PublicPackScoutConfidenceLimitation[] {
  return Object.freeze(
    [...new Set(
      limitations.map(
        (limitation) => PUBLIC_LIMITATION_BY_PIPELINE_LIMITATION[limitation],
      ),
    )].sort(),
  );
}
