import type { PackScoutBuybackEvEvidenceOutcomeV1 } from "@packscout/contracts";
import {
  finalizePackScoutBuybackEvEvidenceV1,
  packScoutBuybackEvBasisPointsFromRatioNumberV1,
  packScoutBuybackEvMoneyClaimFromNumberV1,
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

export const COURTYARD_BUYBACK_EV_PROVIDER_KEY = "courtyard" as const;

/**
 * Sanitized Courtyard catalog listing slice. Courtyard publishes one catalog
 * payload per listing: a USD sale price, a product-wide `buybackRatio`, and
 * published odds buckets with USD value ranges. Its inventory endpoint is a
 * sample that is never proven complete, so no current-pool claim exists.
 */
export interface CourtyardBuybackEvSourceV1 {
  readonly listingId: string | null;
  readonly productRevisionId: string | null;
  readonly catalogRevisionId: string | null;
  readonly sourceManifestSha256: string | null;
  readonly observedAt: string | null;
  readonly salePriceUsd: number | null;
  readonly buybackRatio: number | null;
  readonly buybackScopeDocumented: boolean;
  readonly oddsBuckets: readonly {
    readonly tier: string | null;
    readonly oddsPercent: number | null;
    readonly minValueUsd: number | null;
    readonly maxValueUsd: number | null;
  }[];
}

function statedValue(bucket: {
  readonly minValueUsd: number | null;
  readonly maxValueUsd: number | null;
}): PackScoutBuybackEvStatedValueClaimV1 {
  if (bucket.minValueUsd === null && bucket.maxValueUsd === null) {
    return { kind: "missing" };
  }
  const lower = packScoutBuybackEvMoneyClaimFromNumberV1(
    bucket.minValueUsd,
    "USD",
    2,
  );
  const upper = packScoutBuybackEvMoneyClaimFromNumberV1(
    bucket.maxValueUsd,
    "USD",
    2,
  );
  if (lower === null || upper === null) return { kind: "open_ended_range" };
  return { kind: "closed_range", lower, upper };
}

function uniformRateClaim(
  source: CourtyardBuybackEvSourceV1,
): PackScoutBuybackEvUniformRateClaimV1 {
  if (source.buybackRatio === null) return { kind: "none_documented" };
  const rateBasisPoints = packScoutBuybackEvBasisPointsFromRatioNumberV1(
    source.buybackRatio,
  );
  if (rateBasisPoints === null) return { kind: "unsupported_terms" };
  return {
    kind: "documented",
    scope: source.buybackScopeDocumented
      ? "every_eligible_outcome"
      : "undocumented_scope",
    terms: {
      rateBasisPoints,
      percentageFeeBasisPoints: 0,
      fixedFee: null,
      floor: null,
      cap: null,
    },
  };
}

/** Normalize one sanitized Courtyard listing revision into EV evidence. */
export function normalizeCourtyardBuybackEvEvidenceV1(
  source: CourtyardBuybackEvSourceV1,
  context: PackScoutBuybackEvEvidenceContextV1,
): PackScoutBuybackEvEvidenceOutcomeV1 {
  const listingId = packScoutBuybackEvSanitizedIdentifierV1(source.listingId);
  const outcomes: PackScoutBuybackEvOutcomeClaimV1[] = [];
  const publishedEntries: {
    outcomeKey: string;
    probability: { numerator: number; denominator: number };
  }[] = [];
  source.oddsBuckets.forEach((bucket, index) => {
    const outcomeKey = packScoutBuybackEvOutcomeKeyFromLabelV1(
      bucket.tier,
      `bucket-${index + 1}`,
    );
    outcomes.push({
      outcomeKey,
      representation: { kind: "atomic_outcome" },
      valueBasis: "stated_collectible_value",
      statedValue: statedValue(bucket),
      buyback: { kind: "defer_to_product_terms" },
    });
    const probability = packScoutBuybackEvProbabilityFromPercentNumberV1(
      bucket.oddsPercent,
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
        providerKey: COURTYARD_BUYBACK_EV_PROVIDER_KEY,
        sourceRevisionId: source.catalogRevisionId,
        sourceManifestSha256: source.sourceManifestSha256,
        observedAt: source.observedAt,
        coherence: { kind: "provider_revision" },
      },
      product:
        listingId !== null && source.productRevisionId !== null
          ? {
              productKey: `courtyard:${listingId}`,
              productRevisionId: source.productRevisionId,
            }
          : null,
      packPrice: packScoutBuybackEvMoneyClaimFromNumberV1(
        source.salePriceUsd,
        "USD",
        2,
      ),
      unitBasis: { kind: "per_pack" },
      odds: { poolKind: "finite", currentPool: null, published },
      uniformBuybackRate: uniformRateClaim(source),
      outcomes,
    },
    context,
  );
}

export const COURTYARD_BUYBACK_EV_CAPABILITY_PROFILE_V1: PackScoutBuybackEvProviderCapabilityProfileV1 =
  Object.freeze({
    providerKey: COURTYARD_BUYBACK_EV_PROVIDER_KEY,
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
      mandatoryFees: "unsupported",
      payoutCaps: "unsupported",
      payoutFloors: "unsupported",
    }),
    oddsClassification: "complete_platform_published",
    sourceValueBasis: "stated_collectible_value",
  });
