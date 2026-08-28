import type { PackScoutBuybackEvEvidenceOutcomeV1 } from "@packscout/contracts";
import {
  finalizePackScoutBuybackEvEvidenceV1,
  packScoutBuybackEvMoneyClaimFromNumberV1,
  packScoutBuybackEvOutcomeKeyFromLabelV1,
  packScoutBuybackEvProbabilityFromPercentNumberV1,
  packScoutBuybackEvSanitizedIdentifierV1,
  type PackScoutBuybackEvEvidenceContextV1,
  type PackScoutBuybackEvOutcomeBuybackClaimV1,
  type PackScoutBuybackEvOutcomeClaimV1,
  type PackScoutBuybackEvProviderCapabilityProfileV1,
  type PackScoutBuybackEvPublishedOddsClaimV1,
  type PackScoutBuybackEvStatedValueClaimV1,
} from "../buyback-ev-evidence.ts";

export const GAMESTOP_BUYBACK_EV_PROVIDER_KEY = "gamestop" as const;

/**
 * Sanitized GameStop repack listing slice. GameStop lists a USD price,
 * publishes hit-tier odds with exact estimated USD values, and documents no
 * product-wide buyback rate. When a tier carries a guaranteed cash trade
 * credit it is a fixed guaranteed offer; a tier without documented trade
 * credit has unknown eligibility, which fails closed. Many listings document
 * no trade credit at all and stay discoverable without a PackScout EV.
 */
export interface GamestopBuybackEvSourceV1 {
  readonly skuId: string | null;
  readonly skuRevisionId: string | null;
  readonly storefrontRevisionId: string | null;
  readonly sourceManifestSha256: string | null;
  readonly observedAt: string | null;
  readonly listPriceUsd: number | null;
  readonly hitTiers: readonly {
    readonly tierLabel: string | null;
    readonly oddsPercent: number | null;
    readonly estimatedValueUsd: number | null;
    readonly tradeCredit: {
      readonly kind: "guaranteed_cash_offer" | "not_offered" | "unknown";
      readonly offerUsd: number | null;
    } | null;
  }[];
}

const USD = "USD";
const USD_PRECISION = 2;

function statedValue(
  tier: GamestopBuybackEvSourceV1["hitTiers"][number],
): PackScoutBuybackEvStatedValueClaimV1 {
  if (tier.estimatedValueUsd === null) return { kind: "missing" };
  const amount = packScoutBuybackEvMoneyClaimFromNumberV1(
    tier.estimatedValueUsd,
    USD,
    USD_PRECISION,
  );
  return amount === null ? { kind: "missing" } : { kind: "exact", amount };
}

function tierBuyback(
  tier: GamestopBuybackEvSourceV1["hitTiers"][number],
): PackScoutBuybackEvOutcomeBuybackClaimV1 {
  const credit = tier.tradeCredit;
  if (credit === null || credit.kind === "unknown") {
    return { kind: "unknown_eligibility" };
  }
  if (credit.kind === "not_offered") return { kind: "explicitly_ineligible" };
  const amount = packScoutBuybackEvMoneyClaimFromNumberV1(
    credit.offerUsd,
    USD,
    USD_PRECISION,
  );
  // A guaranteed offer without a stated amount cannot price a payout.
  return amount === null
    ? { kind: "unknown_eligibility" }
    : { kind: "fixed_guaranteed_offer", amount };
}

/** Normalize one sanitized GameStop listing revision into EV evidence. */
export function normalizeGamestopBuybackEvEvidenceV1(
  source: GamestopBuybackEvSourceV1,
  context: PackScoutBuybackEvEvidenceContextV1,
): PackScoutBuybackEvEvidenceOutcomeV1 {
  const skuId = packScoutBuybackEvSanitizedIdentifierV1(source.skuId);
  const outcomes: PackScoutBuybackEvOutcomeClaimV1[] = [];
  const publishedEntries: {
    outcomeKey: string;
    probability: { numerator: number; denominator: number };
  }[] = [];
  source.hitTiers.forEach((tier, index) => {
    const outcomeKey = packScoutBuybackEvOutcomeKeyFromLabelV1(
      tier.tierLabel,
      `tier-${index + 1}`,
    );
    outcomes.push({
      outcomeKey,
      representation: { kind: "atomic_outcome" },
      valueBasis: "stated_collectible_value",
      statedValue: statedValue(tier),
      buyback: tierBuyback(tier),
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
        providerKey: GAMESTOP_BUYBACK_EV_PROVIDER_KEY,
        sourceRevisionId: source.storefrontRevisionId,
        sourceManifestSha256: source.sourceManifestSha256,
        observedAt: source.observedAt,
        coherence: { kind: "provider_revision" },
      },
      product:
        skuId !== null && source.skuRevisionId !== null
          ? {
              productKey: `gamestop:${skuId}`,
              productRevisionId: source.skuRevisionId,
            }
          : null,
      packPrice: packScoutBuybackEvMoneyClaimFromNumberV1(
        source.listPriceUsd,
        USD,
        USD_PRECISION,
      ),
      unitBasis: { kind: "per_pack" },
      odds: { poolKind: "finite", currentPool: null, published },
      uniformBuybackRate: { kind: "none_documented" },
      outcomes,
    },
    context,
  );
}

export const GAMESTOP_BUYBACK_EV_CAPABILITY_PROFILE_V1: PackScoutBuybackEvProviderCapabilityProfileV1 =
  Object.freeze({
    providerKey: GAMESTOP_BUYBACK_EV_PROVIDER_KEY,
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
      uniformBuybackRate: "unsupported",
      outcomeSpecificBuybackRates: "unsupported",
      fixedGuaranteedOffers: "supported",
      buybackEligibility: "supported",
      mandatoryFees: "unsupported",
      payoutCaps: "unsupported",
      payoutFloors: "unsupported",
    }),
    oddsClassification: "complete_platform_published",
    sourceValueBasis: "stated_collectible_value",
  });
