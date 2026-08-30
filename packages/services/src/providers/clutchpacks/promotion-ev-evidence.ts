import {
  DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
  parsePackScoutBuybackEvTimestampMillisV1,
  providerPackEvEvidenceV1Schema,
  sha256CanonicalJson,
  type PackScoutBuybackEvEvidenceOutcomeV1,
} from "@packscout/contracts";
import {
  finalizePackScoutBuybackEvEvidenceV1,
  packScoutBuybackEvMoneyClaimFromNumberV1,
} from "../buyback-ev-evidence.ts";
import { clutchpacksNormalizedBuybackEvDraftV1 } from "./normalized-buyback-ev-evidence.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class ClutchpacksPromotionEvEvidenceError extends Error {
  constructor(readonly code: "EVIDENCE_INVALID" | "EVIDENCE_SNAPSHOT_MISMATCH") {
    super("ClutchPacks promotion evidence does not match the canonical pack snapshot.");
    this.name = "ClutchpacksPromotionEvEvidenceError";
  }
}

/**
 * Binds retained, normalized source facts to the exact provider pack being
 * promoted. The shared ClutchPacks rules interpret the atomic bucket counts;
 * this adapter never uses vendor EV as a calculated value or fetches data.
 */
export async function normalizeClutchpacksPromotionEvEvidenceV1(input: Readonly<{
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
}>): Promise<PackScoutBuybackEvEvidenceOutcomeV1> {
  const parsed = providerPackEvEvidenceV1Schema.safeParse(input.evidence);
  if (!parsed.success) throw new ClutchpacksPromotionEvEvidenceError("EVIDENCE_INVALID");
  const evidence = parsed.data;
  const price = evidence.price.state === "present"
    ? packScoutBuybackEvMoneyClaimFromNumberV1(
        evidence.price.value.amount, evidence.price.value.currency, 2,
      )
    : null;
  const rate = evidence.buybackPercent.state === "present"
    ? evidence.buybackPercent.value * 100
    : null;
  const snapshotAt = parsePackScoutBuybackEvTimestampMillisV1(input.snapshotAt);
  const readAt = parsePackScoutBuybackEvTimestampMillisV1(input.readAt);
  if (
    evidence.organizationId !== input.organizationId ||
    evidence.providerId !== input.providerId ||
    evidence.providerKey !== "clutchpacks" ||
    evidence.sourceTypeKey !== "dataforrest-events-v1" ||
    evidence.sourceAdapterVersion !== DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION ||
    evidence.mapperKey !== "clutchpacks-provider-observation" ||
    evidence.mapperVersion !== "1" ||
    input.packKey !== `pack:${evidence.providerRecordId}` ||
    !/^[1-9][0-9]*$/u.test(input.rowVersion) ||
    !UUID_PATTERN.test(input.packId) ||
    evidence.effectiveAt !== input.sourceUpdatedAt ||
    price === null || price.currency !== "USD" ||
    price.minorUnits !== input.priceUsdMinor ||
    rate !== input.buybackRateBasisPoints ||
    snapshotAt === null || readAt === null ||
    snapshotAt > readAt || Date.parse(evidence.collectedAt) > snapshotAt
  ) throw new ClutchpacksPromotionEvEvidenceError("EVIDENCE_SNAPSHOT_MISMATCH");

  const evidenceHash = await sha256CanonicalJson(
    "packscout.provider-pack-ev-evidence.v1", evidence,
  );
  const product = {
    productKey: input.packKey,
    productRevisionId: `pack:${input.packId}:row:${input.rowVersion}`,
  };
  const collectionGuardSha256 = await sha256CanonicalJson(
    "packscout.clutchpacks.distributed-promotion-ev-guard.v1",
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
  const draft = await clutchpacksNormalizedBuybackEvDraftV1({
    facts: evidence,
    product,
    normalizedContentHash: evidenceHash,
    observationId: `provider-pack:${input.packId}:row:${input.rowVersion}`,
    observation: {
      providerKey: evidence.providerKey,
      sourceRevisionId: `collection:${evidenceHash}`,
      sourceManifestSha256: evidenceHash,
      // Matches the existing canonical ClutchPacks rule: these current-pool
      // counts were observed in this authenticated source response. Promotion
      // never replaces this retained collection timestamp with its own clock.
      observedAt: evidence.collectedAt,
      coherence: { kind: "guarded_collection", collectionGuardSha256 },
    },
  });
  return finalizePackScoutBuybackEvEvidenceV1(draft, {
    evaluatedAt: input.readAt,
    stablecoinParityApprovals: [],
  });
}
