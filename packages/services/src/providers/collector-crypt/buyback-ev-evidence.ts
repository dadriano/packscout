import type { PackScoutBuybackEvEvidenceOutcomeV1 } from "@packscout/contracts";
import {
  finalizePackScoutBuybackEvEvidenceV1,
  packScoutBuybackEvBasisPointsFromPercentV1,
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

export const COLLECTOR_CRYPT_BUYBACK_EV_PROVIDER_KEY =
  "collector_crypt" as const;

/**
 * Sanitized Collector Crypt box listing slice. Boxes contain a stated number
 * of card draws, publish per-slot odds with exact insured USD values, and
 * document one instant-buyback program: a percentage of insured value with an
 * optional mandatory processing fee, minimum payout floor, and maximum payout
 * cap. Boxes are minted on demand, so odds are platform-published for a
 * non-finite pool.
 */
export interface CollectorCryptBuybackEvSourceV1 {
  readonly boxId: string | null;
  readonly boxRevisionId: string | null;
  readonly feedRevisionId: string | null;
  readonly sourceManifestSha256: string | null;
  readonly observedAt: string | null;
  readonly priceUsd: number | null;
  /** Cards per box; each card is one draw against the published odds. */
  readonly cardsPerBox: number | null;
  readonly instantBuyback: {
    readonly percentageOfValue: number | null;
    readonly processingFeeUsd: number | null;
    readonly minimumPayoutUsd: number | null;
    readonly maximumPayoutUsd: number | null;
    readonly appliesToEveryCard: boolean;
    /** True when payout depends on market conditions at redemption time. */
    readonly marketConditionsClause: boolean;
  } | null;
  readonly slots: readonly {
    readonly slotLabel: string | null;
    readonly oddsPercent: number | null;
    readonly insuredValueUsd: number | null;
  }[];
}

const USD = "USD";
const USD_PRECISION = 2;

function statedValue(
  slot: CollectorCryptBuybackEvSourceV1["slots"][number],
): PackScoutBuybackEvStatedValueClaimV1 {
  if (slot.insuredValueUsd === null) return { kind: "missing" };
  const amount = packScoutBuybackEvMoneyClaimFromNumberV1(
    slot.insuredValueUsd,
    USD,
    USD_PRECISION,
  );
  return amount === null
    ? { kind: "missing" }
    : { kind: "exact", amount };
}

function uniformRateClaim(
  source: CollectorCryptBuybackEvSourceV1,
): PackScoutBuybackEvUniformRateClaimV1 {
  const program = source.instantBuyback;
  if (program === null) return { kind: "none_documented" };
  if (program.marketConditionsClause) return { kind: "conditional_terms" };
  const rateBasisPoints = packScoutBuybackEvBasisPointsFromPercentV1(
    program.percentageOfValue,
  );
  if (rateBasisPoints === null) return { kind: "unsupported_terms" };
  const fixedFee =
    program.processingFeeUsd === null
      ? null
      : packScoutBuybackEvMoneyClaimFromNumberV1(
          program.processingFeeUsd,
          USD,
          USD_PRECISION,
        );
  const floor =
    program.minimumPayoutUsd === null
      ? null
      : packScoutBuybackEvMoneyClaimFromNumberV1(
          program.minimumPayoutUsd,
          USD,
          USD_PRECISION,
        );
  const cap =
    program.maximumPayoutUsd === null
      ? null
      : packScoutBuybackEvMoneyClaimFromNumberV1(
          program.maximumPayoutUsd,
          USD,
          USD_PRECISION,
        );
  if (
    (program.processingFeeUsd !== null && fixedFee === null) ||
    (program.minimumPayoutUsd !== null && floor === null) ||
    (program.maximumPayoutUsd !== null && cap === null)
  ) {
    return { kind: "unsupported_terms" };
  }
  return {
    kind: "documented",
    scope: program.appliesToEveryCard
      ? "every_eligible_outcome"
      : "undocumented_scope",
    terms: {
      rateBasisPoints,
      percentageFeeBasisPoints: 0,
      fixedFee,
      floor,
      cap,
    },
  };
}

function unitBasisClaim(
  source: CollectorCryptBuybackEvSourceV1,
): PackScoutBuybackEvUnitBasisClaimV1 {
  return source.cardsPerBox === null
    ? { kind: "ambiguous" }
    : { kind: "per_draw", drawCount: source.cardsPerBox };
}

/** Normalize one sanitized Collector Crypt box revision into EV evidence. */
export function normalizeCollectorCryptBuybackEvEvidenceV1(
  source: CollectorCryptBuybackEvSourceV1,
  context: PackScoutBuybackEvEvidenceContextV1,
): PackScoutBuybackEvEvidenceOutcomeV1 {
  const boxId = packScoutBuybackEvSanitizedIdentifierV1(source.boxId);
  const outcomes: PackScoutBuybackEvOutcomeClaimV1[] = [];
  const publishedEntries: {
    outcomeKey: string;
    probability: { numerator: number; denominator: number };
  }[] = [];
  source.slots.forEach((slot, index) => {
    const outcomeKey = packScoutBuybackEvOutcomeKeyFromLabelV1(
      slot.slotLabel,
      `slot-${index + 1}`,
    );
    outcomes.push({
      outcomeKey,
      representation: { kind: "atomic_outcome" },
      valueBasis: "stated_collectible_value",
      statedValue: statedValue(slot),
      buyback: { kind: "defer_to_product_terms" },
    });
    const probability = packScoutBuybackEvProbabilityFromPercentNumberV1(
      slot.oddsPercent,
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
        providerKey: COLLECTOR_CRYPT_BUYBACK_EV_PROVIDER_KEY,
        sourceRevisionId: source.feedRevisionId,
        sourceManifestSha256: source.sourceManifestSha256,
        observedAt: source.observedAt,
        coherence: { kind: "provider_revision" },
      },
      product:
        boxId !== null && source.boxRevisionId !== null
          ? {
              productKey: `collector-crypt:${boxId}`,
              productRevisionId: source.boxRevisionId,
            }
          : null,
      packPrice: packScoutBuybackEvMoneyClaimFromNumberV1(
        source.priceUsd,
        USD,
        USD_PRECISION,
      ),
      unitBasis: unitBasisClaim(source),
      odds: { poolKind: "non_finite", published },
      uniformBuybackRate: uniformRateClaim(source),
      outcomes,
    },
    context,
  );
}

export const COLLECTOR_CRYPT_BUYBACK_EV_CAPABILITY_PROFILE_V1: PackScoutBuybackEvProviderCapabilityProfileV1 =
  Object.freeze({
    providerKey: COLLECTOR_CRYPT_BUYBACK_EV_PROVIDER_KEY,
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
      mandatoryFees: "supported",
      payoutCaps: "supported",
      payoutFloors: "supported",
    }),
    oddsClassification: "complete_platform_published",
    sourceValueBasis: "stated_collectible_value",
  });
