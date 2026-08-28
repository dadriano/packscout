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
  type PackScoutBuybackEvUnitBasisClaimV1,
} from "../buyback-ev-evidence.ts";

export const PHYGITALS_BUYBACK_EV_PROVIDER_KEY = "phygitals" as const;

/**
 * Sanitized Phygitals drop listing slice. Phygitals prices in USD, states a
 * product-wide buyback ratio (`0..1`), and publishes a rarity distribution
 * with per-rarity odds and exact fair-market USD values. A drop declares how
 * many draws one pack contains; a missing draw count leaves the unit basis
 * ambiguous and fails closed.
 */
export interface PhygitalsBuybackEvSourceV1 {
  readonly dropId: string | null;
  readonly dropRevisionId: string | null;
  readonly marketplaceRevisionId: string | null;
  readonly sourceManifestSha256: string | null;
  readonly observedAt: string | null;
  readonly priceUsd: number | null;
  readonly drawsPerPack: number | null;
  /** Documented buyback ratio of stated value, for example `0.85`. */
  readonly buybackPercentRatio: number | null;
  readonly buybackDocumentedForAllRarities: boolean;
  readonly rarities: readonly {
    readonly rarity: string | null;
    readonly oddsPercent: number | null;
    readonly fairMarketValueUsd: number | null;
  }[];
}

const USD = "USD";
const USD_PRECISION = 2;

function statedValue(
  rarity: PhygitalsBuybackEvSourceV1["rarities"][number],
): PackScoutBuybackEvStatedValueClaimV1 {
  if (rarity.fairMarketValueUsd === null) return { kind: "missing" };
  const amount = packScoutBuybackEvMoneyClaimFromNumberV1(
    rarity.fairMarketValueUsd,
    USD,
    USD_PRECISION,
  );
  return amount === null ? { kind: "missing" } : { kind: "exact", amount };
}

function uniformRateClaim(
  source: PhygitalsBuybackEvSourceV1,
): PackScoutBuybackEvUniformRateClaimV1 {
  if (source.buybackPercentRatio === null) return { kind: "none_documented" };
  const rateBasisPoints = packScoutBuybackEvBasisPointsFromRatioNumberV1(
    source.buybackPercentRatio,
  );
  if (rateBasisPoints === null) return { kind: "unsupported_terms" };
  return {
    kind: "documented",
    scope: source.buybackDocumentedForAllRarities
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

function unitBasisClaim(
  source: PhygitalsBuybackEvSourceV1,
): PackScoutBuybackEvUnitBasisClaimV1 {
  return source.drawsPerPack === null
    ? { kind: "ambiguous" }
    : { kind: "per_draw", drawCount: source.drawsPerPack };
}

/** Normalize one sanitized Phygitals drop revision into EV evidence. */
export function normalizePhygitalsBuybackEvEvidenceV1(
  source: PhygitalsBuybackEvSourceV1,
  context: PackScoutBuybackEvEvidenceContextV1,
): PackScoutBuybackEvEvidenceOutcomeV1 {
  const dropId = packScoutBuybackEvSanitizedIdentifierV1(source.dropId);
  const outcomes: PackScoutBuybackEvOutcomeClaimV1[] = [];
  const publishedEntries: {
    outcomeKey: string;
    probability: { numerator: number; denominator: number };
  }[] = [];
  source.rarities.forEach((rarity, index) => {
    const outcomeKey = packScoutBuybackEvOutcomeKeyFromLabelV1(
      rarity.rarity,
      `rarity-${index + 1}`,
    );
    outcomes.push({
      outcomeKey,
      representation: { kind: "atomic_outcome" },
      valueBasis: "stated_collectible_value",
      statedValue: statedValue(rarity),
      buyback: { kind: "defer_to_product_terms" },
    });
    const probability = packScoutBuybackEvProbabilityFromPercentNumberV1(
      rarity.oddsPercent,
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
        providerKey: PHYGITALS_BUYBACK_EV_PROVIDER_KEY,
        sourceRevisionId: source.marketplaceRevisionId,
        sourceManifestSha256: source.sourceManifestSha256,
        observedAt: source.observedAt,
        coherence: { kind: "provider_revision" },
      },
      product:
        dropId !== null && source.dropRevisionId !== null
          ? {
              productKey: `phygitals:${dropId}`,
              productRevisionId: source.dropRevisionId,
            }
          : null,
      packPrice: packScoutBuybackEvMoneyClaimFromNumberV1(
        source.priceUsd,
        USD,
        USD_PRECISION,
      ),
      unitBasis: unitBasisClaim(source),
      odds: { poolKind: "finite", currentPool: null, published },
      uniformBuybackRate: uniformRateClaim(source),
      outcomes,
    },
    context,
  );
}

export const PHYGITALS_BUYBACK_EV_CAPABILITY_PROFILE_V1: PackScoutBuybackEvProviderCapabilityProfileV1 =
  Object.freeze({
    providerKey: PHYGITALS_BUYBACK_EV_PROVIDER_KEY,
    capabilities: Object.freeze({
      packPrice: "supported",
      priceCurrency: "supported",
      unitBasis: "supported",
      drawCount: "supported",
      productIdentity: "supported",
      sourceRevision: "supported",
      observationTime: "supported",
      exactStatedValues: "supported",
      closedRangeStatedValues: "unsupported",
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
