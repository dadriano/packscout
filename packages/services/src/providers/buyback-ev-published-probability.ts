import { PACKSCOUT_BUYBACK_EV_MAX_PROBABILITY_DENOMINATOR } from "@packscout/contracts";
import {
  packScoutBuybackEvProbabilityFromPercentNumberV1,
  packScoutBuybackEvProbabilityFromRatioNumberV1,
  type PackScoutBuybackEvRationalClaimV1,
} from "./buyback-ev-evidence.ts";

/**
 * Recover a published decimal percentage retained as `percent / 100`.
 * JavaScript division can leave a binary rounding tail (66.67 / 100 becomes
 * 0.6667000000000001). A recovered percentage is accepted only when repeating
 * that exact division reproduces the retained number. This does not round
 * arbitrary probabilities, normalize a distribution, or infer missing odds.
 */
export function packScoutBuybackEvProbabilityFromNormalizedPercentRatioV1(
  value: number | null | undefined,
): PackScoutBuybackEvRationalClaimV1 | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return null;
  }
  const direct = packScoutBuybackEvProbabilityFromRatioNumberV1(value);
  if (direct !== null && direct.denominator <= PACKSCOUT_BUYBACK_EV_MAX_PROBABILITY_DENOMINATOR) {
    return direct;
  }
  // The exact decimal parser admits at most 15 fractional digits. Try the
  // shortest candidate first, always checking the original division rather
  // than accepting a numerical tolerance around the retained probability.
  for (let precision = 0; precision <= 15; precision += 1) {
    const percent: number = Number((value * 100).toFixed(precision));
    if (percent / 100 !== value) continue;
    const candidate = packScoutBuybackEvProbabilityFromPercentNumberV1(percent);
    if (candidate !== null && candidate.denominator <= PACKSCOUT_BUYBACK_EV_MAX_PROBABILITY_DENOMINATOR) {
      return candidate;
    }
  }
  return null;
}
