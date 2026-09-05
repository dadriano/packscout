import {
  parsePackScoutBuybackEvTimestampMillisV1,
  providerPackEvEvidenceV1Schema,
  sha256CanonicalJson,
  type PackScoutBuybackEvEvidenceOutcomeV1,
} from "@packscout/contracts";
import {
  finalizePackScoutBuybackEvEvidenceV1,
  packScoutBuybackEvBasisPointsFromPercentV1,
  packScoutBuybackEvMoneyClaimFromNumberV1,
  packScoutBuybackEvOutcomeKeyFromLabelV1,
  type PackScoutBuybackEvRationalClaimV1,
  type PackScoutBuybackEvOutcomeClaimV1,
  type PackScoutBuybackEvUniformRateClaimV1,
} from "./buyback-ev-evidence.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class PublishedProbabilityPromotionEvEvidenceError extends Error {
  constructor(readonly code: "EVIDENCE_INVALID" | "EVIDENCE_SNAPSHOT_MISMATCH") {
    super("Published probability promotion evidence does not match the canonical pack snapshot.");
    this.name = "PublishedProbabilityPromotionEvEvidenceError";
  }
}

export type PublishedProbabilityPromotionEvInputV1 = Readonly<{
  organizationId: string;
  providerId: string;
  packId: string;
  packKey: string;
  rowVersion: string;
  priceUsdMinor: number;
  buybackRateBasisPoints: number | null;
  sourceUpdatedAt: string;
  snapshotAt: string;
  readAt: string;
  evidence: unknown;
}>;

export type PublishedProbabilityPromotionEvPolicyV1 = Readonly<{
  providerKey: string;
  poolKind: "finite" | "non_finite";
  sourceAdapterVersions: readonly string[];
  mapperKey: string;
  bucketHomogeneityHashDomain: string;
  collectionGuardHashDomain: string;
  probabilityFromNumber(value: number | null | undefined): PackScoutBuybackEvRationalClaimV1 | null;
}>;

/** Bind a provider-reviewed published distribution to the exact canonical pack row. */
export async function normalizePublishedProbabilityPromotionEvEvidenceV1(
  input: PublishedProbabilityPromotionEvInputV1,
  policy: PublishedProbabilityPromotionEvPolicyV1,
): Promise<PackScoutBuybackEvEvidenceOutcomeV1> {
  const parsed = providerPackEvEvidenceV1Schema.safeParse(input.evidence);
  if (!parsed.success) throw new PublishedProbabilityPromotionEvEvidenceError("EVIDENCE_INVALID");
  const evidence = parsed.data;
  const price = evidence.price.state === "present"
    ? packScoutBuybackEvMoneyClaimFromNumberV1(
        evidence.price.value.amount,
        evidence.price.value.currency,
        2,
      )
    : null;
  const rateBasisPoints = evidence.buybackPercent.state === "present"
    ? packScoutBuybackEvBasisPointsFromPercentV1(evidence.buybackPercent.value)
    : null;
  const snapshotAt = parsePackScoutBuybackEvTimestampMillisV1(input.snapshotAt);
  const readAt = parsePackScoutBuybackEvTimestampMillisV1(input.readAt);
  if (
    evidence.organizationId !== input.organizationId ||
    evidence.providerId !== input.providerId ||
    evidence.providerKey !== policy.providerKey ||
    evidence.sourceTypeKey !== "dataforrest-events-v1" ||
    !policy.sourceAdapterVersions.includes(evidence.sourceAdapterVersion) ||
    evidence.mapperKey !== policy.mapperKey ||
    evidence.mapperVersion !== "1" ||
    input.packKey !== `pack:${evidence.providerRecordId}` ||
    !/^[1-9][0-9]*$/u.test(input.rowVersion) ||
    !UUID_PATTERN.test(input.packId) ||
    evidence.effectiveAt !== input.sourceUpdatedAt ||
    price === null ||
    price.currency !== "USD" ||
    price.minorUnits !== input.priceUsdMinor ||
    rateBasisPoints !== input.buybackRateBasisPoints ||
    snapshotAt === null ||
    readAt === null ||
    snapshotAt > readAt ||
    Date.parse(evidence.effectiveAt) > Date.parse(evidence.collectedAt) ||
    Date.parse(evidence.collectedAt) > snapshotAt
  ) {
    throw new PublishedProbabilityPromotionEvEvidenceError("EVIDENCE_SNAPSHOT_MISMATCH");
  }

  const evidenceHash = await sha256CanonicalJson(
    "packscout.provider-pack-ev-evidence.v1",
    evidence,
  );
  const product = {
    productKey: input.packKey,
    productRevisionId: `pack:${input.packId}:row:${input.rowVersion}`,
  };
  const collectionGuardSha256 = await sha256CanonicalJson(
    policy.collectionGuardHashDomain,
    {
      organizationId: input.organizationId,
      providerId: input.providerId,
      product,
      evidenceHash,
      priceUsdMinor: input.priceUsdMinor,
      buybackRateBasisPoints: input.buybackRateBasisPoints,
      sourceUpdatedAt: input.sourceUpdatedAt,
    },
  );
  const evInput = evidence.evInput.state === "present"
    ? evidence.evInput.value
    : null;
  const outcomes: PackScoutBuybackEvOutcomeClaimV1[] = await Promise.all(
    (evInput?.buckets ?? []).map(async (bucket, index) => {
      const outcomeKey = packScoutBuybackEvOutcomeKeyFromLabelV1(
        bucket.bucketId,
        `bucket-${index + 1}`,
      );
      const homogeneityEvidenceSha256 = await sha256CanonicalJson(
        policy.bucketHomogeneityHashDomain,
        {
          evidenceHash,
          product,
          bucket: {
            bucketId: bucket.bucketId,
            lowerValue: bucket.lowerValue,
            upperValue: bucket.upperValue,
          },
          buybackPercent: evInput?.buybackPercent ?? null,
        },
      );
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
          memberCount: null,
          eligibilityHomogeneity: "verified_same",
          payoutFunctionHomogeneity: "verified_same",
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
  const publishedEntries = (evInput?.buckets ?? []).flatMap((bucket, index) => {
    const probability = policy.probabilityFromNumber(
      bucket.probability,
    );
    return probability === null
      ? []
      : [{
          outcomeKey: packScoutBuybackEvOutcomeKeyFromLabelV1(
            bucket.bucketId,
            `bucket-${index + 1}`,
          ),
          probability,
        }];
  });
  let uniformBuybackRate: PackScoutBuybackEvUniformRateClaimV1;
  if (
    evidence.buybackPercent.state === "absent" &&
    evInput?.buybackPercent === null
  ) {
    uniformBuybackRate = { kind: "none_documented" };
  } else if (
    rateBasisPoints !== null &&
    evidence.buybackPercent.state === "present" &&
    evInput?.buybackPercent === evidence.buybackPercent.value
  ) {
    uniformBuybackRate = {
      kind: "documented",
      scope: "every_eligible_outcome",
      terms: {
        rateBasisPoints,
        percentageFeeBasisPoints: 0,
        fixedFee: null,
        floor: null,
        cap: null,
      },
    };
  } else {
    uniformBuybackRate = { kind: "unsupported_terms" };
  }

  return finalizePackScoutBuybackEvEvidenceV1(
    {
      observation: {
        providerKey: evidence.providerKey,
        sourceRevisionId: `collection:${evidenceHash}`,
        sourceManifestSha256: evidenceHash,
        observedAt: evidence.collectedAt,
        coherence: { kind: "guarded_collection", collectionGuardSha256 },
      },
      product,
      packPrice: price,
      unitBasis:
        evInput?.approved === true &&
        evInput.unitBasis === "per_pack" &&
        evInput.drawCount === 1 &&
        evidence.drawCount.state === "present" &&
        evidence.drawCount.value === 1
          ? { kind: "per_pack" }
          : { kind: "ambiguous" },
      odds: {
        ...(policy.poolKind === "finite"
          ? { poolKind: policy.poolKind, currentPool: null }
          : { poolKind: policy.poolKind }),
        published: publishedEntries.length === 0 || evInput?.totalQuantity !== null ||
          evInput.buckets.some((bucket) => bucket.quantity !== null)
          ? null
          : {
              entries: publishedEntries,
              documentedRoundingPrecisionPartsPerMillion: 100,
              revisionAgreement: "same_source_revision",
            },
      },
      uniformBuybackRate,
      outcomes,
    },
    { evaluatedAt: input.readAt, stablecoinParityApprovals: [] },
  );
}
