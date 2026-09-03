import type { RetentionBatchResult } from "@packscout/contracts";
import type {
  ProviderClock,
  ProviderIdSource,
} from "./provider-configuration-service.ts";

export interface ProtectedPayloadRetentionWorkDiscovery {
  discoverEligibleOrganizations(input: {
    cutoffAt: Date;
    limit: number;
  }): Promise<readonly string[]>;
}

export interface ProtectedPayloadRetentionRunner {
  run(input: {
    executionId: string;
    organizationId: string;
    cutoffAt: Date;
    batchSize: number;
  }): Promise<RetentionBatchResult>;
}

/**
 * A fleet-scoped record kind the retention cycle ages out alongside protected
 * payloads. Each pruner owns its own retention window and deletes at most
 * `limit` records per cycle so cleanup stays bounded.
 */
export interface RetentionRecordPruner {
  readonly kind: string;
  readonly retentionMs: number;
  prune(input: { cutoffAt: Date; limit: number }): Promise<number>;
}

export interface ProtectedPayloadRetentionCycleConfig {
  readonly batchSize: number;
  readonly maxBatchesPerCycle: number;
  readonly organizationDiscoveryLimit: number;
  readonly pruners?: readonly RetentionRecordPruner[];
}

export interface ProtectedPayloadRetentionCycleResult {
  readonly cutoffAt: string;
  readonly discoveredOrganizations: number;
  readonly attemptedOrganizations: number;
  readonly batchesRun: number;
  readonly expired: number;
  readonly failed: number;
  readonly knownRemaining: number;
  readonly deferredOrganizations: number;
  readonly capReached: boolean;
  readonly prunedRecords: number;
  readonly prunedFailures: number;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ProtectedPayloadRetentionCoordinator {
  constructor(
    private readonly discovery: ProtectedPayloadRetentionWorkDiscovery,
    private readonly retention: ProtectedPayloadRetentionRunner,
    private readonly ids: ProviderIdSource,
    private readonly clock: ProviderClock,
    private readonly config: ProtectedPayloadRetentionCycleConfig,
  ) {
    if (
      !Number.isInteger(config.batchSize) ||
      config.batchSize < 1 ||
      config.batchSize > 10_000 ||
      !Number.isInteger(config.maxBatchesPerCycle) ||
      config.maxBatchesPerCycle < 1 ||
      config.maxBatchesPerCycle > 10_000 ||
      !Number.isInteger(config.organizationDiscoveryLimit) ||
      config.organizationDiscoveryLimit < 1 ||
      config.organizationDiscoveryLimit > 1_000
    ) {
      throw new RangeError("Retention cycle configuration is invalid.");
    }
    for (const pruner of config.pruners ?? []) {
      if (
        !Number.isInteger(pruner.retentionMs) ||
        pruner.retentionMs < 1 ||
        !/^[a-z][a-z0-9_]{0,63}$/.test(pruner.kind)
      ) {
        throw new RangeError("Retention cycle configuration is invalid.");
      }
    }
  }

  async runCycle(): Promise<ProtectedPayloadRetentionCycleResult> {
    // Protected evidence already carries its policy-derived 90-day expires_at.
    // The current instant is therefore the cleanup cutoff, avoiding a second
    // 90-day subtraction that would accidentally retain evidence for 180 days.
    const cutoffAt = this.clock.now();
    const discovered = await this.discovery.discoverEligibleOrganizations({
      cutoffAt,
      limit: this.config.organizationDiscoveryLimit,
    });
    const queue = [...new Set(discovered)].filter((organizationId) =>
      uuidPattern.test(organizationId),
    );
    const discoveredOrganizations = queue.length;
    const attempted = new Set<string>();
    const remaining = new Map<string, number>();
    let batchesRun = 0;
    let expired = 0;
    let failed = 0;

    // Requeue tenants with progress so large tenants cannot starve other due
    // tenants within the same bounded cycle.
    while (queue.length > 0 && batchesRun < this.config.maxBatchesPerCycle) {
      const organizationId = queue.shift();
      if (!organizationId) break;
      attempted.add(organizationId);
      const executionId = this.ids.id();
      batchesRun += 1;
      let result: RetentionBatchResult;
      try {
        result = await this.retention.run({
          executionId,
          organizationId,
          cutoffAt,
          batchSize: this.config.batchSize,
        });
      } catch {
        failed += 1;
        continue;
      }
      if (!result.replayed) {
        expired += result.expired;
        failed += result.failed;
      }
      remaining.set(organizationId, result.remaining);
      if (
        result.failed === 0 &&
        !result.replayed &&
        result.selected > 0 &&
        result.remaining > 0
      ) {
        queue.push(organizationId);
      }
    }

    const pruned = await this.prune(cutoffAt);

    return {
      cutoffAt: cutoffAt.toISOString(),
      discoveredOrganizations,
      attemptedOrganizations: attempted.size,
      batchesRun,
      expired,
      failed,
      knownRemaining: [...remaining.values()].reduce(
        (total, count) => total + count,
        0,
      ),
      deferredOrganizations: new Set(queue).size,
      capReached:
        batchesRun === this.config.maxBatchesPerCycle && queue.length > 0,
      ...pruned,
    };
  }

  /**
   * Ages out the fleet-scoped record kinds registered with this cycle. A
   * failing pruner is counted and skipped so it cannot stop protected-payload
   * cleanup or the next kind in line.
   */
  private async prune(
    now: Date,
  ): Promise<{ prunedRecords: number; prunedFailures: number }> {
    let prunedRecords = 0;
    let prunedFailures = 0;
    for (const pruner of this.config.pruners ?? []) {
      try {
        prunedRecords += await pruner.prune({
          cutoffAt: new Date(now.getTime() - pruner.retentionMs),
          limit: this.config.batchSize,
        });
      } catch {
        prunedFailures += 1;
      }
    }
    return { prunedRecords, prunedFailures };
  }
}
