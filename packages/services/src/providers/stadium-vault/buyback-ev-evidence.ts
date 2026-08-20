import type { PackScoutBuybackEvEvidenceOutcomeV1 } from "@packscout/contracts";
import {
  finalizePackScoutBuybackEvEvidenceV1,
  packScoutBuybackEvBasisPointsFromPercentV1,
  packScoutBuybackEvMoneyClaimFromNumberV1,
  packScoutBuybackEvOutcomeKeyFromLabelV1,
  packScoutBuybackEvProbabilityFromPercentNumberV1,
  packScoutBuybackEvSanitizedIdentifierV1,
  type PackScoutBuybackEvEvidenceContextV1,
  type PackScoutBuybackEvObservationClaimV1,
  type PackScoutBuybackEvOutcomeClaimV1,
  type PackScoutBuybackEvProviderCapabilityProfileV1,
  type PackScoutBuybackEvPublishedOddsClaimV1,
  type PackScoutBuybackEvStatedValueClaimV1,
  type PackScoutBuybackEvUniformRateClaimV1,
} from "../buyback-ev-evidence.ts";

export const STADIUM_VAULT_BUYBACK_EV_PROVIDER_KEY = "stadium_vault" as const;

/**
 * Sanitized Stadium Vault case slice. The catalog endpoint and the odds
 * endpoint are separate, so one observation is coherent only when both report
 * the same provider revision or the collector recorded one guarded collection
 * transaction; matching timestamps alone prove nothing and fail closed. Tiers
 * carry USD value ranges, some tiers are aggregate buckets with a published
 * homogeneity attestation, redemption-only tiers are explicitly ineligible,
 * and the vault documents one instant-sell percentage.
 */
export interface StadiumVaultBuybackEvSourceV1 {
  readonly caseId: string | null;
  readonly caseRevisionId: string | null;
  readonly catalogEndpointRevisionId: string | null;
  readonly oddsEndpointRevisionId: string | null;
  /** Present when both endpoints were read in one guarded collection. */
  readonly collectionGuardSha256: string | null;
  readonly sourceManifestSha256: string | null;
  readonly observedAt: string | null;
  readonly priceUsd: number | null;
  readonly instantSellPercent: number | null;
  readonly instantSellDocumentedForAllTiers: boolean;
  readonly oddsTiers: readonly {
    readonly tierLabel: string | null;
    readonly oddsPercent: number | null;
    readonly minValueUsd: number | null;
    readonly maxValueUsd: number | null;
    /** Redemption-only tiers cannot enter the instant-sell program. */
    readonly redemptionOnly: boolean;
    readonly bucket: {
      readonly memberCount: number | null;
      readonly homogeneity: "verified_same" | "unverified" | "mixed";
      readonly attestationSha256: string | null;
    } | null;
  }[];
}

const USD = "USD";
const USD_PRECISION = 2;

function observationClaim(
  source: StadiumVaultBuybackEvSourceV1,
): PackScoutBuybackEvObservationClaimV1 {
  const catalogRevision = source.catalogEndpointRevisionId;
  const oddsRevision = source.oddsEndpointRevisionId;
  const base = {
    providerKey: STADIUM_VAULT_BUYBACK_EV_PROVIDER_KEY,
    sourceManifestSha256: source.sourceManifestSha256,
    observedAt: source.observedAt,
  };
  if (
    catalogRevision !== null &&
    oddsRevision !== null &&
    catalogRevision === oddsRevision
  ) {
    return {
      ...base,
      sourceRevisionId: catalogRevision,
      coherence: { kind: "provider_revision" },
    };
  }
  if (source.collectionGuardSha256 !== null) {
    return {
      ...base,
      sourceRevisionId:
        catalogRevision !== null && oddsRevision !== null
          ? `${catalogRevision}@${oddsRevision}`
          : catalogRevision ?? oddsRevision,
      coherence: {
        kind: "guarded_collection",
        collectionGuardSha256: source.collectionGuardSha256,
      },
    };
  }
  return {
    ...base,
    sourceRevisionId: catalogRevision ?? oddsRevision,
    coherence: { kind: "timestamp_coincidence" },
  };
}

function statedValue(
  tier: StadiumVaultBuybackEvSourceV1["oddsTiers"][number],
): PackScoutBuybackEvStatedValueClaimV1 {
  if (tier.minValueUsd === null && tier.maxValueUsd === null) {
    return { kind: "missing" };
  }
  const lower = packScoutBuybackEvMoneyClaimFromNumberV1(
    tier.minValueUsd,
    USD,
    USD_PRECISION,
  );
  const upper = packScoutBuybackEvMoneyClaimFromNumberV1(
    tier.maxValueUsd,
    USD,
    USD_PRECISION,
  );
  if (lower === null || upper === null) return { kind: "open_ended_range" };
  return { kind: "closed_range", lower, upper };
}

function representation(
  tier: StadiumVaultBuybackEvSourceV1["oddsTiers"][number],
): PackScoutBuybackEvOutcomeClaimV1["representation"] {
  if (tier.bucket === null) return { kind: "atomic_outcome" };
  return {
    kind: "aggregate_bucket",
    memberCount: tier.bucket.memberCount,
    eligibilityHomogeneity: tier.bucket.homogeneity,
    payoutFunctionHomogeneity: tier.bucket.homogeneity,
    homogeneityEvidenceSha256: tier.bucket.attestationSha256,
  };
}

function uniformRateClaim(
  source: StadiumVaultBuybackEvSourceV1,
): PackScoutBuybackEvUniformRateClaimV1 {
  if (source.instantSellPercent === null) return { kind: "none_documented" };
  const rateBasisPoints = packScoutBuybackEvBasisPointsFromPercentV1(
    source.instantSellPercent,
  );
  if (rateBasisPoints === null) return { kind: "unsupported_terms" };
  return {
    kind: "documented",
    scope: source.instantSellDocumentedForAllTiers
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

/** Normalize one sanitized Stadium Vault case observation into EV evidence. */
export function normalizeStadiumVaultBuybackEvEvidenceV1(
  source: StadiumVaultBuybackEvSourceV1,
  context: PackScoutBuybackEvEvidenceContextV1,
): PackScoutBuybackEvEvidenceOutcomeV1 {
  const caseId = packScoutBuybackEvSanitizedIdentifierV1(source.caseId);
  const outcomes: PackScoutBuybackEvOutcomeClaimV1[] = [];
  const publishedEntries: {
    outcomeKey: string;
    probability: { numerator: number; denominator: number };
  }[] = [];
  source.oddsTiers.forEach((tier, index) => {
    const outcomeKey = packScoutBuybackEvOutcomeKeyFromLabelV1(
      tier.tierLabel,
      `tier-${index + 1}`,
    );
    outcomes.push({
      outcomeKey,
      representation: representation(tier),
      valueBasis: "stated_collectible_value",
      statedValue: statedValue(tier),
      buyback: tier.redemptionOnly
        ? { kind: "explicitly_ineligible" }
        : { kind: "defer_to_product_terms" },
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
      observation: observationClaim(source),
      product:
        caseId !== null && source.caseRevisionId !== null
          ? {
              productKey: `stadium-vault:${caseId}`,
              productRevisionId: source.caseRevisionId,
            }
          : null,
      packPrice: packScoutBuybackEvMoneyClaimFromNumberV1(
        source.priceUsd,
        USD,
        USD_PRECISION,
      ),
      unitBasis: { kind: "per_pack" },
      odds: { poolKind: "finite", currentPool: null, published },
      uniformBuybackRate: uniformRateClaim(source),
      outcomes,
    },
    context,
  );
}

export const STADIUM_VAULT_BUYBACK_EV_CAPABILITY_PROFILE_V1: PackScoutBuybackEvProviderCapabilityProfileV1 =
  Object.freeze({
    providerKey: STADIUM_VAULT_BUYBACK_EV_PROVIDER_KEY,
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
