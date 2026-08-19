import type { PackScoutBuybackEvEvidenceOutcomeV1 } from "@packscout/contracts";
import {
  finalizePackScoutBuybackEvEvidenceV1,
  packScoutBuybackEvMoneyClaimFromNumberV1,
  packScoutBuybackEvOutcomeKeyFromLabelV1,
  packScoutBuybackEvProbabilityFromPercentNumberV1,
  packScoutBuybackEvSanitizedIdentifierV1,
  type PackScoutBuybackEvEvidenceContextV1,
  type PackScoutBuybackEvOutcomeClaimV1,
  type PackScoutBuybackEvProviderCapabilityProfileV1,
  type PackScoutBuybackEvPublishedOddsClaimV1,
  type PackScoutBuybackEvUnitBasisClaimV1,
} from "../buyback-ev-evidence.ts";

export const TROVE_BUYBACK_EV_PROVIDER_KEY = "trove" as const;

/**
 * Sanitized Trove pack listing slice. Trove packs contain several card draws
 * and publish per-tier odds with one USD figure per tier. The listing states
 * which basis that figure uses: a guaranteed instant payout is already the
 * final buyback amount and must never be discounted again, while an estimated
 * market value has no documented buyback program behind it. An unstated basis
 * fails closed.
 */
export interface TroveBuybackEvSourceV1 {
  readonly packId: string | null;
  readonly packRevisionId: string | null;
  readonly catalogRevisionId: string | null;
  readonly sourceManifestSha256: string | null;
  readonly observedAt: string | null;
  readonly priceUsd: number | null;
  readonly cardsPerPack: number | null;
  readonly valueBasis:
    | "guaranteed_instant_payout"
    | "estimated_market_value"
    | null;
  readonly tiers: readonly {
    readonly tierLabel: string | null;
    readonly oddsPercent: number | null;
    readonly valueUsd: number | null;
  }[];
}

const USD = "USD";
const USD_PRECISION = 2;

function unitBasisClaim(
  source: TroveBuybackEvSourceV1,
): PackScoutBuybackEvUnitBasisClaimV1 {
  return source.cardsPerPack === null
    ? { kind: "ambiguous" }
    : { kind: "per_draw", drawCount: source.cardsPerPack };
}

function outcomeClaim(
  source: TroveBuybackEvSourceV1,
  tier: TroveBuybackEvSourceV1["tiers"][number],
  outcomeKey: string,
): PackScoutBuybackEvOutcomeClaimV1 {
  const amount =
    tier.valueUsd === null
      ? null
      : packScoutBuybackEvMoneyClaimFromNumberV1(
          tier.valueUsd,
          USD,
          USD_PRECISION,
        );
  const statedValue =
    amount === null
      ? ({ kind: "missing" } as const)
      : ({ kind: "exact", amount } as const);
  if (source.valueBasis === "guaranteed_instant_payout") {
    return {
      outcomeKey,
      representation: { kind: "atomic_outcome" },
      valueBasis: "final_guaranteed_payout",
      statedValue,
      buyback: { kind: "reflected_in_value" },
    };
  }
  return {
    outcomeKey,
    representation: { kind: "atomic_outcome" },
    valueBasis: "stated_collectible_value",
    statedValue,
    buyback:
      source.valueBasis === "estimated_market_value"
        ? { kind: "defer_to_product_terms" }
        : { kind: "unknown_eligibility" },
  };
}

/** Normalize one sanitized Trove pack revision into EV evidence. */
export function normalizeTroveBuybackEvEvidenceV1(
  source: TroveBuybackEvSourceV1,
  context: PackScoutBuybackEvEvidenceContextV1,
): PackScoutBuybackEvEvidenceOutcomeV1 {
  const packId = packScoutBuybackEvSanitizedIdentifierV1(source.packId);
  const outcomes: PackScoutBuybackEvOutcomeClaimV1[] = [];
  const publishedEntries: {
    outcomeKey: string;
    probability: { numerator: number; denominator: number };
  }[] = [];
  source.tiers.forEach((tier, index) => {
    const outcomeKey = packScoutBuybackEvOutcomeKeyFromLabelV1(
      tier.tierLabel,
      `tier-${index + 1}`,
    );
    outcomes.push(outcomeClaim(source, tier, outcomeKey));
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
        providerKey: TROVE_BUYBACK_EV_PROVIDER_KEY,
        sourceRevisionId: source.catalogRevisionId,
        sourceManifestSha256: source.sourceManifestSha256,
        observedAt: source.observedAt,
        coherence: { kind: "provider_revision" },
      },
      product:
        packId !== null && source.packRevisionId !== null
          ? {
              productKey: `trove:${packId}`,
              productRevisionId: source.packRevisionId,
            }
          : null,
      packPrice: packScoutBuybackEvMoneyClaimFromNumberV1(
        source.priceUsd,
        USD,
        USD_PRECISION,
      ),
      unitBasis: unitBasisClaim(source),
      odds: { poolKind: "finite", currentPool: null, published },
      uniformBuybackRate: { kind: "none_documented" },
      outcomes,
    },
    context,
  );
}

export const TROVE_BUYBACK_EV_CAPABILITY_PROFILE_V1: PackScoutBuybackEvProviderCapabilityProfileV1 =
  Object.freeze({
    providerKey: TROVE_BUYBACK_EV_PROVIDER_KEY,
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
      finalPayoutValues: "supported",
      uniformBuybackRate: "unsupported",
      outcomeSpecificBuybackRates: "unsupported",
      fixedGuaranteedOffers: "unsupported",
      buybackEligibility: "supported",
      mandatoryFees: "unsupported",
      payoutCaps: "unsupported",
      payoutFloors: "unsupported",
    }),
    oddsClassification: "complete_platform_published",
    sourceValueBasis: "final_guaranteed_payout",
  });
