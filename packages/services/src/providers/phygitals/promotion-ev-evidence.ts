import {
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V4_VERSION,
  type PackScoutBuybackEvEvidenceOutcomeV1,
} from "@packscout/contracts";
import { packScoutBuybackEvProbabilityFromNormalizedPercentRatioV1 } from "../buyback-ev-published-probability.ts";
import {
  normalizePublishedProbabilityPromotionEvEvidenceV1,
  PublishedProbabilityPromotionEvEvidenceError,
  type PublishedProbabilityPromotionEvInputV1,
} from "../published-probability-promotion-ev-evidence.ts";

export class PhygitalsPromotionEvEvidenceError extends Error {
  constructor(readonly code: "EVIDENCE_INVALID" | "EVIDENCE_SNAPSHOT_MISMATCH") {
    super("Phygitals promotion evidence does not match the canonical pack snapshot.");
    this.name = "PhygitalsPromotionEvEvidenceError";
  }
}

/** Bind reviewed distributed-v4 rarity odds and USD ranges to the exact pack row. */
export async function normalizePhygitalsPromotionEvEvidenceV1(
  input: PublishedProbabilityPromotionEvInputV1,
): Promise<PackScoutBuybackEvEvidenceOutcomeV1> {
  try {
    return await normalizePublishedProbabilityPromotionEvEvidenceV1(input, {
      providerKey: "phygitals",
      poolKind: "finite",
      sourceAdapterVersions: [DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V4_VERSION],
      mapperKey: "phygitals-provider-observation",
      bucketHomogeneityHashDomain: "packscout.phygitals.distributed-v4.bucket-homogeneity.v1",
      collectionGuardHashDomain: "packscout.phygitals.distributed-promotion-ev-guard.v1",
      probabilityFromNumber: packScoutBuybackEvProbabilityFromNormalizedPercentRatioV1,
    });
  } catch (error) {
    if (error instanceof PublishedProbabilityPromotionEvEvidenceError) {
      throw new PhygitalsPromotionEvEvidenceError(error.code);
    }
    throw error;
  }
}
