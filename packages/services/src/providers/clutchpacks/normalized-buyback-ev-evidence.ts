import { sha256CanonicalJson, type NormalizedPackProviderFacts } from "@packscout/contracts";
import {
  packScoutBuybackEvMoneyClaimFromNumberV1,
  packScoutBuybackEvOutcomeKeyFromLabelV1,
  type PackScoutBuybackEvEvidenceDraftV1,
  type PackScoutBuybackEvOutcomeClaimV1,
  type PackScoutBuybackEvUniformRateClaimV1,
} from "../buyback-ev-evidence.ts";

const BUCKET_HOMOGENEITY_HASH_DOMAIN =
  "packscout.clutchpacks.canonical-v3.bucket-homogeneity.v1";

export type ClutchpacksNormalizedEvFactsV1 = Pick<
  NormalizedPackProviderFacts,
  "price" | "buybackPercent" | "drawCount" | "evInput"
>;

function productUniformRate(
  facts: ClutchpacksNormalizedEvFactsV1,
): PackScoutBuybackEvUniformRateClaimV1 {
  const evInput = facts.evInput.state === "present"
    ? facts.evInput.value
    : null;
  const rootAbsent = facts.buybackPercent.state === "absent";
  const inputAbsent = evInput !== null && evInput.buybackPercent === null;
  if (rootAbsent && inputAbsent) return { kind: "none_documented" };
  if (
    facts.buybackPercent.state === "present" &&
    facts.buybackPercent.value === 90 &&
    evInput?.buybackPercent === 90
  ) {
    return {
      kind: "documented",
      scope: "every_eligible_outcome",
      terms: {
        rateBasisPoints: 9_000,
        percentageFeeBasisPoints: 0,
        fixedFee: null,
        floor: null,
        cap: null,
      },
    };
  }
  return { kind: "unsupported_terms" };
}

export function clutchpacksProbabilityMatchesCountV1(
  probability: number | null,
  quantity: number,
  totalQuantity: number,
): boolean {
  return probability !== null &&
    Number.isFinite(probability) &&
    Math.abs(probability - quantity / totalQuantity) <= Number.EPSILON * 8;
}

/** Shared provider rules for persisted canonical and promotion-time evidence. */
export async function clutchpacksNormalizedBuybackEvDraftV1(input: Readonly<{
  facts: ClutchpacksNormalizedEvFactsV1;
  product: NonNullable<PackScoutBuybackEvEvidenceDraftV1["product"]>;
  observation: NonNullable<PackScoutBuybackEvEvidenceDraftV1["observation"]>;
  normalizedContentHash: string;
  observationId: string;
}>): Promise<PackScoutBuybackEvEvidenceDraftV1> {
  const facts = input.facts;
  const evInput = facts.evInput.state === "present" ? facts.evInput.value : null;
  const totalQuantity = evInput?.totalQuantity ?? null;
  const usableCounts =
    evInput !== null &&
    evInput.approved === true &&
    totalQuantity !== null &&
    Number.isSafeInteger(totalQuantity) &&
    totalQuantity > 0 &&
    evInput.buckets.length > 0 &&
    evInput.buckets.every((bucket) =>
      bucket.quantity !== null &&
      Number.isSafeInteger(bucket.quantity) &&
      bucket.quantity > 0 &&
      clutchpacksProbabilityMatchesCountV1(
        bucket.probability,
        bucket.quantity,
        totalQuantity,
      )
    ) &&
    evInput.buckets.reduce((sum, bucket) => sum + (bucket.quantity ?? 0), 0) ===
      totalQuantity;
  const outcomes: PackScoutBuybackEvOutcomeClaimV1[] = await Promise.all(
    (evInput?.buckets ?? []).map(async (bucket, index) => {
      const outcomeKey = packScoutBuybackEvOutcomeKeyFromLabelV1(
        bucket.bucketId,
        `bucket-${index + 1}`,
      );
      const quantity =
        bucket.quantity !== null &&
          Number.isSafeInteger(bucket.quantity) &&
          bucket.quantity > 0
          ? bucket.quantity
          : null;
      const homogeneityEvidenceSha256 = quantity === null
        ? null
        : await sha256CanonicalJson(BUCKET_HOMOGENEITY_HASH_DOMAIN, {
            normalizedContentHash: input.normalizedContentHash,
            semanticObservationId: input.observationId,
            productKey: input.product.productKey,
            bucket: {
              bucketId: bucket.bucketId,
              quantity,
              lowerValue: bucket.lowerValue,
              upperValue: bucket.upperValue,
            },
            productBuyback: {
              root: facts.buybackPercent,
              evInput: evInput?.buybackPercent ?? null,
            },
          });
      const lower = packScoutBuybackEvMoneyClaimFromNumberV1(
        bucket.lowerValue,
        evInput?.currency ?? "",
        2,
      );
      const upper = packScoutBuybackEvMoneyClaimFromNumberV1(
        bucket.upperValue,
        evInput?.currency ?? "",
        2,
      );
      return {
        outcomeKey,
        representation: {
          kind: "aggregate_bucket",
          memberCount: quantity,
          eligibilityHomogeneity:
            homogeneityEvidenceSha256 === null ? "unverified" : "verified_same",
          payoutFunctionHomogeneity:
            homogeneityEvidenceSha256 === null ? "unverified" : "verified_same",
          homogeneityEvidenceSha256,
        },
        valueBasis: "stated_collectible_value",
        statedValue:
          lower !== null && upper !== null
            ? { kind: "closed_range", lower, upper }
            : lower === null && upper === null
              ? { kind: "missing" }
              : { kind: "open_ended_range" },
        buyback: { kind: "defer_to_product_terms" },
      };
    }),
  );
  const unitBasis =
    evInput?.unitBasis === "per_pack" &&
      evInput.drawCount === 1 &&
      facts.drawCount.state === "present" &&
      facts.drawCount.value === 1
      ? { kind: "per_pack" as const }
      : { kind: "ambiguous" as const };
  return {
    observation: input.observation,
    product: {
      productKey: input.product.productKey,
      productRevisionId: input.product.productRevisionId,
    },
    packPrice:
      facts.price.state === "present"
        ? packScoutBuybackEvMoneyClaimFromNumberV1(
            facts.price.value.amount,
            facts.price.value.currency,
            2,
          )
        : null,
    unitBasis,
    odds: {
      poolKind: "finite",
      currentPool:
        evInput === null
          ? null
          : {
              completeness: usableCounts ? "complete" : "partial",
              snapshotAtomicity: usableCounts
                ? "atomic"
                : "assembled_without_proof",
              countsStability: usableCounts
                ? "stable"
                : "changed_during_collection",
              remainingUnits: evInput.buckets.flatMap((bucket, index) =>
                bucket.quantity === null
                  ? []
                  : [{
                      outcomeKey: packScoutBuybackEvOutcomeKeyFromLabelV1(
                        bucket.bucketId,
                        `bucket-${index + 1}`,
                      ),
                      units: bucket.quantity,
                    }]
              ),
            },
      published: null,
    },
    uniformBuybackRate: productUniformRate(facts),
    outcomes,
  };
}
