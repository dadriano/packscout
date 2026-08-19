import type { PackScoutBuybackEvEvidenceOutcomeV1 } from "@packscout/contracts";
import {
  finalizePackScoutBuybackEvEvidenceV1,
  packScoutBuybackEvBasisPointsFromPercentV1,
  packScoutBuybackEvMoneyClaimFromMinorUnitsV1,
  packScoutBuybackEvOutcomeKeyFromLabelV1,
  packScoutBuybackEvProbabilityFromPercentNumberV1,
  packScoutBuybackEvSanitizedIdentifierV1,
  type PackScoutBuybackEvEvidenceContextV1,
  type PackScoutBuybackEvOutcomeClaimV1,
  type PackScoutBuybackEvProviderCapabilityProfileV1,
  type PackScoutBuybackEvPublishedOddsClaimV1,
  type PackScoutBuybackEvStatedValueClaimV1,
  type PackScoutBuybackEvUniformRateClaimV1,
} from "../buyback-ev-evidence.ts";

export const BEEZIE_BUYBACK_EV_PROVIDER_KEY = "beezie" as const;

/**
 * Sanitized Beezie machine listing slice. Beezie prices machines and tier
 * value ranges in micro units of one on-chain settlement token (USDC at
 * launch), publishes per-tier odds percentages, and documents an instant swap
 * whose mandatory fee percentages are deducted from stated value. Machines
 * are finite pools but no complete remaining-inventory endpoint exists, so
 * published odds are the approved fallback.
 */
export interface BeezieBuybackEvSourceV1 {
  readonly machineId: string | null;
  readonly machineRevisionId: string | null;
  readonly catalogRevisionId: string | null;
  readonly sourceManifestSha256: string | null;
  readonly observedAt: string | null;
  /** Settlement token symbol for every money field, for example `USDC`. */
  readonly settlementCurrency: string | null;
  /** Machine price in settlement-token micro units (precision 6). */
  readonly priceMicroUnits: number | null;
  /** Null when the source documents no swap program at all. */
  readonly swapFeePercents: readonly number[] | null;
  readonly swapDocumentedForAllTiers: boolean;
  readonly oddsTiers: readonly {
    readonly tier: string | null;
    readonly oddsPercent: number | null;
    readonly fromMicroUnits: number | null;
    readonly toMicroUnits: number | null;
  }[];
}

const MICRO_PRECISION = 6;

function settlementCurrency(source: BeezieBuybackEvSourceV1): string {
  const sanitized = packScoutBuybackEvSanitizedIdentifierV1(
    source.settlementCurrency,
    12,
  );
  // An absent or oversized symbol fails the shared currency pattern closed.
  return sanitized === null ? "" : sanitized.toUpperCase();
}

function statedValue(
  tier: BeezieBuybackEvSourceV1["oddsTiers"][number],
  currency: string,
): PackScoutBuybackEvStatedValueClaimV1 {
  if (tier.fromMicroUnits === null && tier.toMicroUnits === null) {
    return { kind: "missing" };
  }
  const lower = packScoutBuybackEvMoneyClaimFromMinorUnitsV1(
    tier.fromMicroUnits,
    currency,
    MICRO_PRECISION,
  );
  const upper = packScoutBuybackEvMoneyClaimFromMinorUnitsV1(
    tier.toMicroUnits,
    currency,
    MICRO_PRECISION,
  );
  if (lower === null || upper === null) return { kind: "open_ended_range" };
  return { kind: "closed_range", lower, upper };
}

const MAX_SWAP_FEE_COMPONENTS = 16;

function uniformRateClaim(
  source: BeezieBuybackEvSourceV1,
): PackScoutBuybackEvUniformRateClaimV1 {
  if (source.swapFeePercents === null) return { kind: "none_documented" };
  if (source.swapFeePercents.length > MAX_SWAP_FEE_COMPONENTS) {
    return { kind: "unsupported_terms" };
  }
  let feeBasisPoints = 0;
  for (const percent of source.swapFeePercents) {
    const basisPoints = packScoutBuybackEvBasisPointsFromPercentV1(percent);
    if (basisPoints === null) return { kind: "unsupported_terms" };
    feeBasisPoints += basisPoints;
  }
  if (feeBasisPoints > 10_000) return { kind: "unsupported_terms" };
  return {
    kind: "documented",
    scope: source.swapDocumentedForAllTiers
      ? "every_eligible_outcome"
      : "undocumented_scope",
    terms: {
      rateBasisPoints: 10_000,
      percentageFeeBasisPoints: feeBasisPoints,
      fixedFee: null,
      floor: null,
      cap: null,
    },
  };
}

/** Normalize one sanitized Beezie machine revision into EV evidence. */
export function normalizeBeezieBuybackEvEvidenceV1(
  source: BeezieBuybackEvSourceV1,
  context: PackScoutBuybackEvEvidenceContextV1,
): PackScoutBuybackEvEvidenceOutcomeV1 {
  const machineId = packScoutBuybackEvSanitizedIdentifierV1(source.machineId);
  const currency = settlementCurrency(source);
  const outcomes: PackScoutBuybackEvOutcomeClaimV1[] = [];
  const publishedEntries: {
    outcomeKey: string;
    probability: { numerator: number; denominator: number };
  }[] = [];
  source.oddsTiers.forEach((tier, index) => {
    const outcomeKey = packScoutBuybackEvOutcomeKeyFromLabelV1(
      tier.tier,
      `tier-${index + 1}`,
    );
    outcomes.push({
      outcomeKey,
      representation: { kind: "atomic_outcome" },
      valueBasis: "stated_collectible_value",
      statedValue: statedValue(tier, currency),
      buyback: { kind: "defer_to_product_terms" },
    });
    const probability = packScoutBuybackEvProbabilityFromPercentNumberV1(
      tier.oddsPercent,
    );
    if (probability !== null) {
      publishedEntries.push({ outcomeKey, probability });
    }
  });
  const published: PackScoutBuybackEvPublishedOddsClaimV1 | null =
    publishedEntries.length > 0
      ? {
          entries: publishedEntries,
          documentedRoundingPrecisionPartsPerMillion: 100,
          revisionAgreement: "same_source_revision",
        }
      : null;
  return finalizePackScoutBuybackEvEvidenceV1(
    {
      observation: {
        providerKey: BEEZIE_BUYBACK_EV_PROVIDER_KEY,
        sourceRevisionId: source.catalogRevisionId,
        sourceManifestSha256: source.sourceManifestSha256,
        observedAt: source.observedAt,
        coherence: { kind: "provider_revision" },
      },
      product:
        machineId !== null && source.machineRevisionId !== null
          ? {
              productKey: `beezie:${machineId}`,
              productRevisionId: source.machineRevisionId,
            }
          : null,
      packPrice: packScoutBuybackEvMoneyClaimFromMinorUnitsV1(
        source.priceMicroUnits,
        currency,
        MICRO_PRECISION,
      ),
      unitBasis: { kind: "per_pack" },
      odds: { poolKind: "finite", currentPool: null, published },
      uniformBuybackRate: uniformRateClaim(source),
      outcomes,
    },
    context,
  );
}

export const BEEZIE_BUYBACK_EV_CAPABILITY_PROFILE_V1: PackScoutBuybackEvProviderCapabilityProfileV1 =
  Object.freeze({
    providerKey: BEEZIE_BUYBACK_EV_PROVIDER_KEY,
    capabilities: Object.freeze({
      packPrice: "supported",
      priceCurrency: "supported",
      unitBasis: "supported",
      drawCount: "supported",
      productIdentity: "supported",
      sourceRevision: "supported",
      observationTime: "supported",
      exactStatedValues: "unsupported",
      closedRangeStatedValues: "supported",
      finalPayoutValues: "unsupported",
      uniformBuybackRate: "supported",
      outcomeSpecificBuybackRates: "unsupported",
      fixedGuaranteedOffers: "unsupported",
      buybackEligibility: "supported",
      mandatoryFees: "supported",
      payoutCaps: "unsupported",
      payoutFloors: "unsupported",
    }),
    oddsClassification: "complete_platform_published",
    sourceValueBasis: "stated_collectible_value",
  });
