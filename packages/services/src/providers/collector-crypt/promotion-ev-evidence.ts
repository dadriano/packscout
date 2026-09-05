import { DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V4_VERSION } from "@packscout/contracts";
import { packScoutBuybackEvProbabilityFromRatioNumberV1 } from "../buyback-ev-evidence.ts";
import {
  normalizePublishedProbabilityPromotionEvEvidenceV1,
  type PublishedProbabilityPromotionEvInputV1,
} from "../published-probability-promotion-ev-evidence.ts";

/** Collector Crypt pack V2 publishes one-card tier probabilities and USD ranges. */
export function normalizeCollectorCryptPromotionEvEvidenceV1(input: PublishedProbabilityPromotionEvInputV1) {
  return normalizePublishedProbabilityPromotionEvEvidenceV1(input, {
    providerKey: "collector_crypt",
    // Collector Crypt boxes are minted on demand, as in its existing EV contract.
    poolKind: "non_finite",
    sourceAdapterVersions: [DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V4_VERSION],
    mapperKey: "collector-crypt-provider-observation",
    bucketHomogeneityHashDomain: "packscout.collector-crypt.distributed-v4.bucket-homogeneity.v1",
    collectionGuardHashDomain: "packscout.collector-crypt.distributed-promotion-ev-guard.v1",
    probabilityFromNumber: packScoutBuybackEvProbabilityFromRatioNumberV1,
  });
}
