import { DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V4_VERSION } from "@packscout/contracts";
import { packScoutBuybackEvProbabilityFromNormalizedPercentRatioV1 } from "../buyback-ev-published-probability.ts";
import {
  normalizePublishedProbabilityPromotionEvEvidenceV1,
  type PublishedProbabilityPromotionEvInputV1,
} from "../published-probability-promotion-ev-evidence.ts";

/** Courtyard pack V2 publishes one-card odds and USD ranges, never item counts. */
export function normalizeCourtyardPromotionEvEvidenceV1(input: PublishedProbabilityPromotionEvInputV1) {
  return normalizePublishedProbabilityPromotionEvEvidenceV1(input, {
    providerKey: "courtyard",
    poolKind: "finite",
    sourceAdapterVersions: [DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V4_VERSION],
    mapperKey: "courtyard-provider-observation",
    bucketHomogeneityHashDomain: "packscout.courtyard.distributed-v4.bucket-homogeneity.v1",
    collectionGuardHashDomain: "packscout.courtyard.distributed-promotion-ev-guard.v1",
    probabilityFromNumber: packScoutBuybackEvProbabilityFromNormalizedPercentRatioV1,
  });
}
