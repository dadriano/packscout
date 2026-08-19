import type { PackScoutBuybackEvEvidenceOutcomeV1 } from "@packscout/contracts";
import {
  finalizePackScoutBuybackEvEvidenceV1,
  packScoutBuybackEvBasisPointsFromPercentV1,
  packScoutBuybackEvMoneyClaimFromDecimalTextV1,
  packScoutBuybackEvOutcomeKeyFromLabelV1,
  packScoutBuybackEvProbabilityFromPercentTextV1,
  packScoutBuybackEvSanitizedIdentifierV1,
  type PackScoutBuybackEvCurrentPoolClaimV1,
  type PackScoutBuybackEvEvidenceContextV1,
  type PackScoutBuybackEvOutcomeBuybackClaimV1,
  type PackScoutBuybackEvOutcomeClaimV1,
  type PackScoutBuybackEvProviderCapabilityProfileV1,
  type PackScoutBuybackEvPublishedOddsClaimV1,
  type PackScoutBuybackEvStatedValueClaimV1,
  type PackScoutBuybackEvUniformRateClaimV1,
} from "../buyback-ev-evidence.ts";

export const CLUTCHPACKS_BUYBACK_EV_PROVIDER_KEY = "clutchpacks" as const;

/**
 * Sanitized ClutchPacks pack listing slice. ClutchPacks prices in USD decimal
 * text, exposes price buckets with per-bucket buyback terms, publishes rounded
 * live-pool percentages, and exposes a remaining-count endpoint plus a pull
 * ledger. Remaining counts are usable as current-pool odds only when the pool
 * snapshot is one atomic revision that provably matches the catalog revision;
 * pull-ledger rows apply only as deterministic remaining-inventory updates
 * proven to belong to the same revision.
 */
export interface ClutchpacksBuybackEvSourceV1 {
  readonly packId: string | null;
  readonly packRevisionId: string | null;
  readonly siteRevisionId: string | null;
  readonly sourceManifestSha256: string | null;
  readonly observedAt: string | null;
  /** Major-unit USD decimal text, optional `$` and comma separators. */
  readonly packPriceText: string | null;
  readonly buckets: readonly {
    readonly bucketId: string | null;
    readonly name: string | null;
    readonly minPriceText: string | null;
    /** Null models an "and up" bucket with no published ceiling. */
    readonly maxPriceText: string | null;
    /** Outcome-specific buyback percentage of stated value. */
    readonly buybackPercentText: string | null;
    /** False is explicit ineligibility; null is unknown eligibility. */
    readonly buybackEligible: boolean | null;
    readonly memberCount: number | null;
    readonly homogeneityAttestationSha256: string | null;
    readonly publishedPoolPercentText: string | null;
  }[];
  readonly livePool: {
    readonly poolRevisionId: string | null;
    readonly snapshotKind: "atomic_revision" | "assembled_pages";
    readonly countsChangedDuringCollection: boolean;
    readonly coversAllBuckets: boolean;
    readonly remainingByBucket: readonly {
      readonly bucketId: string | null;
      readonly remaining: number | null;
    }[];
  } | null;
  readonly pullLedger:
    | readonly {
        readonly bucketId: string | null;
        readonly pulls: number | null;
        readonly ledgerRevisionId: string | null;
      }[]
    | null;
  /** Decimal places of the published pool percentages, when documented. */
  readonly publishedOddsRoundingPercentDecimals: number | null;
}

const USD = "USD";
const USD_PRECISION = 2;

function statedValue(bucket: {
  readonly minPriceText: string | null;
  readonly maxPriceText: string | null;
}): PackScoutBuybackEvStatedValueClaimV1 {
  if (bucket.minPriceText === null && bucket.maxPriceText === null) {
    return { kind: "missing" };
  }
  const lower = packScoutBuybackEvMoneyClaimFromDecimalTextV1(
    bucket.minPriceText,
    USD,
    USD_PRECISION,
  );
  const upper = packScoutBuybackEvMoneyClaimFromDecimalTextV1(
    bucket.maxPriceText,
    USD,
    USD_PRECISION,
  );
  if (lower === null || upper === null) return { kind: "open_ended_range" };
  return { kind: "closed_range", lower, upper };
}

function bucketBuyback(bucket: {
  readonly buybackPercentText: string | null;
  readonly buybackEligible: boolean | null;
}): PackScoutBuybackEvOutcomeBuybackClaimV1 {
  if (bucket.buybackEligible === false) return { kind: "explicitly_ineligible" };
  if (bucket.buybackEligible === null) return { kind: "unknown_eligibility" };
  if (bucket.buybackPercentText === null) {
    // Eligible with no bucket terms defers to product terms; ClutchPacks
    // documents none, so the shared rulebook fails this closed.
    return { kind: "defer_to_product_terms" };
  }
  const rateBasisPoints = packScoutBuybackEvBasisPointsFromPercentV1(
    bucket.buybackPercentText,
  );
  return {
    kind: "outcome_specific_rate",
    terms: {
      // An unparseable percent carries an out-of-range rate so the shared
      // rulebook fails it closed as invalid buyback terms.
      rateBasisPoints: rateBasisPoints ?? -1,
      percentageFeeBasisPoints: 0,
      fixedFee: null,
      floor: null,
      cap: null,
    },
  };
}

function roundingPartsPerMillion(decimals: number | null): number {
  return decimals !== null &&
      Number.isInteger(decimals) &&
      decimals >= 0 &&
      decimals <= 4
    ? 10 ** (4 - decimals)
    : 0;
}

interface LedgerResult {
  readonly pullsByKey: ReadonlyMap<string, number>;
  readonly contradiction: boolean;
}

function ledgerPulls(
  source: ClutchpacksBuybackEvSourceV1,
  outcomeKeys: ReadonlySet<string>,
): LedgerResult {
  const none: LedgerResult = { pullsByKey: new Map(), contradiction: false };
  const ledger = source.pullLedger;
  if (ledger === null || ledger.length === 0) return none;
  const provenSameRevision =
    source.siteRevisionId !== null &&
    ledger.every((entry) => entry.ledgerRevisionId === source.siteRevisionId);
  // Pull records from another or unproven revision cannot deterministically
  // update remaining inventory, so they are never applied.
  if (!provenSameRevision) return none;
  const pullsByKey = new Map<string, number>();
  for (const entry of ledger) {
    const key =
      entry.bucketId === null
        ? null
        : packScoutBuybackEvOutcomeKeyFromLabelV1(entry.bucketId, "");
    if (
      key === null ||
      key.length === 0 ||
      !outcomeKeys.has(key) ||
      entry.pulls === null ||
      !Number.isSafeInteger(entry.pulls) ||
      entry.pulls < 0
    ) {
      return { pullsByKey: new Map(), contradiction: true };
    }
    pullsByKey.set(key, (pullsByKey.get(key) ?? 0) + entry.pulls);
  }
  return { pullsByKey, contradiction: false };
}

function currentPoolClaim(
  source: ClutchpacksBuybackEvSourceV1,
  outcomeKeys: ReadonlySet<string>,
): PackScoutBuybackEvCurrentPoolClaimV1 | null {
  const pool = source.livePool;
  if (pool === null) return null;
  const ledger = ledgerPulls(source, outcomeKeys);
  const remainingByKey = new Map<string, number>();
  let allRowsMapped = true;
  for (const row of pool.remainingByBucket) {
    const key =
      row.bucketId === null
        ? null
        : packScoutBuybackEvOutcomeKeyFromLabelV1(row.bucketId, "");
    if (
      key === null ||
      key.length === 0 ||
      !outcomeKeys.has(key) ||
      remainingByKey.has(key) ||
      row.remaining === null ||
      !Number.isSafeInteger(row.remaining) ||
      row.remaining < 0
    ) {
      allRowsMapped = false;
      continue;
    }
    remainingByKey.set(key, row.remaining);
  }
  let overdraw = false;
  for (const [key, pulls] of ledger.pullsByKey) {
    const remaining = remainingByKey.get(key);
    if (remaining === undefined) continue;
    if (pulls > remaining) {
      overdraw = true;
      continue;
    }
    remainingByKey.set(key, remaining - pulls);
  }
  const complete =
    pool.coversAllBuckets &&
    allRowsMapped &&
    remainingByKey.size === outcomeKeys.size;
  const atomic =
    pool.snapshotKind === "atomic_revision" &&
    pool.poolRevisionId !== null &&
    pool.poolRevisionId === source.siteRevisionId;
  const stable =
    !pool.countsChangedDuringCollection && !ledger.contradiction && !overdraw;
  return {
    completeness: complete ? "complete" : "partial",
    snapshotAtomicity: atomic ? "atomic" : "assembled_without_proof",
    countsStability: stable ? "stable" : "changed_during_collection",
    remainingUnits: [...remainingByKey.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([outcomeKey, units]) => ({ outcomeKey, units })),
  };
}

/** Normalize one sanitized ClutchPacks pack revision into EV evidence. */
export function normalizeClutchpacksBuybackEvEvidenceV1(
  source: ClutchpacksBuybackEvSourceV1,
  context: PackScoutBuybackEvEvidenceContextV1,
): PackScoutBuybackEvEvidenceOutcomeV1 {
  const packId = packScoutBuybackEvSanitizedIdentifierV1(source.packId);
  const outcomes: PackScoutBuybackEvOutcomeClaimV1[] = [];
  const publishedEntries: {
    outcomeKey: string;
    probability: { numerator: number; denominator: number };
  }[] = [];
  source.buckets.forEach((bucket, index) => {
    const outcomeKey = packScoutBuybackEvOutcomeKeyFromLabelV1(
      bucket.bucketId,
      `bucket-${index + 1}`,
    );
    const memberCountKnown =
      bucket.memberCount !== null &&
      Number.isSafeInteger(bucket.memberCount) &&
      bucket.memberCount >= 1;
    outcomes.push({
      outcomeKey,
      representation: {
        kind: "aggregate_bucket",
        memberCount: memberCountKnown ? bucket.memberCount : null,
        eligibilityHomogeneity:
          bucket.homogeneityAttestationSha256 === null
            ? "unverified"
            : "verified_same",
        payoutFunctionHomogeneity:
          bucket.homogeneityAttestationSha256 === null
            ? "unverified"
            : "verified_same",
        homogeneityEvidenceSha256: bucket.homogeneityAttestationSha256,
      },
      valueBasis: "stated_collectible_value",
      statedValue: statedValue(bucket),
      buyback: bucketBuyback(bucket),
    });
    const probability = packScoutBuybackEvProbabilityFromPercentTextV1(
      bucket.publishedPoolPercentText,
    );
    if (probability !== null) {
      publishedEntries.push({ outcomeKey, probability });
    }
  });
  const outcomeKeys = new Set(outcomes.map(({ outcomeKey }) => outcomeKey));
  const currentPool = currentPoolClaim(source, outcomeKeys);
  const sameRevision =
    source.livePool !== null &&
    source.livePool.poolRevisionId !== null &&
    source.livePool.poolRevisionId === source.siteRevisionId;
  const published: PackScoutBuybackEvPublishedOddsClaimV1 | null =
    publishedEntries.length > 0
      ? {
          entries: publishedEntries,
          documentedRoundingPrecisionPartsPerMillion: roundingPartsPerMillion(
            source.publishedOddsRoundingPercentDecimals,
          ),
          revisionAgreement: sameRevision
            ? "same_source_revision"
            : "different_or_unproven_revision",
        }
      : null;
  const uniformBuybackRate: PackScoutBuybackEvUniformRateClaimV1 = {
    kind: "none_documented",
  };
  return finalizePackScoutBuybackEvEvidenceV1(
    {
      observation: {
        providerKey: CLUTCHPACKS_BUYBACK_EV_PROVIDER_KEY,
        sourceRevisionId: source.siteRevisionId,
        sourceManifestSha256: source.sourceManifestSha256,
        observedAt: source.observedAt,
        coherence: { kind: "provider_revision" },
      },
      product:
        packId !== null && source.packRevisionId !== null
          ? {
              productKey: `clutchpacks:${packId}`,
              productRevisionId: source.packRevisionId,
            }
          : null,
      packPrice: packScoutBuybackEvMoneyClaimFromDecimalTextV1(
        source.packPriceText,
        USD,
        USD_PRECISION,
      ),
      unitBasis: { kind: "per_pack" },
      odds: { poolKind: "finite", currentPool, published },
      uniformBuybackRate,
      outcomes,
    },
    context,
  );
}

export const CLUTCHPACKS_BUYBACK_EV_CAPABILITY_PROFILE_V1: PackScoutBuybackEvProviderCapabilityProfileV1 =
  Object.freeze({
    providerKey: CLUTCHPACKS_BUYBACK_EV_PROVIDER_KEY,
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
      uniformBuybackRate: "unsupported",
      outcomeSpecificBuybackRates: "supported",
      fixedGuaranteedOffers: "unsupported",
      buybackEligibility: "supported",
      mandatoryFees: "unsupported",
      payoutCaps: "unsupported",
      payoutFloors: "unsupported",
    }),
    oddsClassification: "complete_current_remaining_inventory",
    sourceValueBasis: "stated_collectible_value",
  });
