import type {
  DistributedPromotionJobProcessMode,
} from "./distributed-promotion-job-process-config.ts";

/** Shared non-secret shape consumed by the lifecycle runner. Role-specific
 * authority and gateway configuration remain in the main compositions. */
export interface DistributedPromotionJobProcessConfiguration {
  readonly mode: DistributedPromotionJobProcessMode;
  readonly manualCommandIdentity: string | null;
  readonly continuationGeneration: bigint | null;
}
