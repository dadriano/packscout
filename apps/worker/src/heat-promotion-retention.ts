import type {
  NormalizedHeatRetentionCleanupResult,
} from "@packscout/database";
import type {
  HeatPromotionRetentionPort,
} from "./heat-promotion-worker-runtime.ts";

export interface HeatRetentionRepositoryPort {
  cleanup(input: Readonly<{
    cutoffAt: Date;
    limit: number;
  }>): Promise<NormalizedHeatRetentionCleanupResult>;
}

export class HeatPromotionRetentionCoordinator
  implements HeatPromotionRetentionPort
{
  constructor(
    private readonly repository: HeatRetentionRepositoryPort,
    private readonly batchSize: number,
    private readonly maximumBatchesPerCycle: number,
  ) {
    if (
      !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000 ||
      !Number.isSafeInteger(maximumBatchesPerCycle) ||
      maximumBatchesPerCycle < 1 || maximumBatchesPerCycle > 20
    ) throw new RangeError("Heat retention limits are invalid.");
  }

  async runCycle(now: Date): Promise<Readonly<{
    batches: number;
    deletedOutcomes: number;
    deletedObservations: number;
    capReached: boolean;
  }>> {
    if (!Number.isFinite(now.getTime())) throw new RangeError("now is invalid.");
    let batches = 0;
    let deletedOutcomes = 0;
    let deletedObservations = 0;
    let hasMore = false;
    do {
      const result = await this.repository.cleanup({
        cutoffAt: now,
        limit: this.batchSize,
      });
      batches += 1;
      deletedOutcomes += result.deletedOutcomes;
      deletedObservations += result.deletedObservations;
      hasMore = result.hasMore;
    } while (hasMore && batches < this.maximumBatchesPerCycle);
    return {
      batches,
      deletedOutcomes,
      deletedObservations,
      capReached: hasMore,
    };
  }
}
