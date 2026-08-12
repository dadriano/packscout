import type { RetentionBatchResult } from "@packscout/contracts";
import type { ProviderClock } from "./provider-configuration-service.ts";
import type {
  OperationalObservability,
  OperationalEventService,
} from "./operational-events.ts";

export interface RetentionBatchPersistenceResult {
  readonly result: RetentionBatchResult;
  readonly recovered: boolean;
  readonly expiredQuarantines: readonly {
    readonly id: string;
    readonly providerId: string;
    readonly reasonCode: string;
  }[];
}

export interface ProtectedPayloadRetentionRepository {
  expireBatch(input: {
    executionId: string;
    organizationId: string;
    cutoffAt: Date;
    batchSize: number;
    startedAt: Date;
  }): Promise<RetentionBatchPersistenceResult>;
  recordFailure(input: {
    executionId: string;
    organizationId: string;
    cutoffAt: Date;
    batchSize: number;
    startedAt: Date;
    finishedAt: Date;
    failureCode: string;
  }): Promise<RetentionBatchResult>;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ProtectedPayloadRetentionService {
  constructor(
    private readonly repository: ProtectedPayloadRetentionRepository,
    private readonly events: OperationalEventService,
    private readonly observability: OperationalObservability,
    private readonly clock: ProviderClock,
  ) {}

  async run(input: {
    executionId: string;
    organizationId: string;
    cutoffAt: Date;
    batchSize: number;
  }): Promise<RetentionBatchResult> {
    const startedAt = this.clock.now();
    this.assertInput(input, startedAt);
    let batch: RetentionBatchPersistenceResult;
    try {
      batch = await this.repository.expireBatch({ ...input, startedAt });
    } catch {
      return this.recordRepositoryFailure(input, startedAt);
    }
    if (batch.result.failed > 0) {
      this.recordMetrics(input.organizationId, batch.result, "FAILED");
      await this.reportFailure(input.organizationId);
      return batch.result;
    }
    this.recordMetrics(input.organizationId, batch.result, "SUCCEEDED");
    for (const quarantine of batch.expiredQuarantines) {
      try {
        await this.events.quarantineExpired({
          organizationId: input.organizationId,
          providerId: quarantine.providerId,
          quarantineId: quarantine.id,
          reasonCode: quarantine.reasonCode,
        });
      } catch {
        // Durable cleanup does not depend on notification delivery.
      }
    }
    if (batch.recovered) {
      try {
        await this.events.retentionRecovered({
          organizationId: input.organizationId,
          expiredCount: batch.result.expired,
          durationMs: batch.result.durationMs,
        });
      } catch {
        // Recovery delivery is best-effort after the durable transition.
      }
    }
    return batch.result;
  }

  private async recordRepositoryFailure(
    input: {
      executionId: string;
      organizationId: string;
      cutoffAt: Date;
      batchSize: number;
    },
    startedAt: Date,
  ): Promise<RetentionBatchResult> {
    const finishedAt = this.clock.now();
    let result: RetentionBatchResult;
    try {
      result = await this.repository.recordFailure({
        ...input,
        startedAt,
        finishedAt,
        failureCode: "RETENTION_BATCH_FAILED",
      });
    } catch {
      result = {
        executionId: input.executionId,
        selected: 0,
        expired: 0,
        alreadyExpired: 0,
        failed: 1,
        remaining: 0,
        pagesExpired: 0,
        sourceRecordsExpired: 0,
        quarantinesExpired: 0,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        replayed: false,
      };
    }
    this.recordMetrics(input.organizationId, result, "FAILED");
    await this.reportFailure(input.organizationId);
    return result;
  }

  private async reportFailure(organizationId: string): Promise<void> {
    try {
      await this.events.retentionFailed({
        organizationId,
        failureCode: "RETENTION_BATCH_FAILED",
      });
    } catch {
      // The sanitized failure result remains authoritative.
    }
  }

  private recordMetrics(
    organizationId: string,
    result: RetentionBatchResult,
    outcome: "SUCCEEDED" | "FAILED",
  ): void {
    const metrics = [
      ["retention_selected_total", result.selected],
      ["retention_expired_total", result.expired],
      ["retention_already_expired_total", result.alreadyExpired],
      ["retention_failed_total", result.failed],
      ["retention_remaining_total", result.remaining],
      ["retention_duration_ms", result.durationMs],
    ] as const;
    for (const [name, value] of metrics) {
      try {
        this.observability.metric({
          name,
          value,
          organizationId,
          providerId: null,
          outcomeCode: outcome,
        });
      } catch {
        // Retention results do not depend on metrics availability.
      }
    }
    try {
      this.observability.log({
        event: "retention",
        level: outcome === "FAILED" ? "error" : "info",
        organizationId,
        providerId: null,
        code: `RETENTION_${outcome}`,
        occurredAt: result.finishedAt,
      });
    } catch {
      // Retention results do not depend on log delivery.
    }
  }

  private assertInput(
    input: {
      executionId: string;
      organizationId: string;
      cutoffAt: Date;
      batchSize: number;
    },
    now: Date,
  ): void {
    if (
      !uuidPattern.test(input.executionId) ||
      !uuidPattern.test(input.organizationId) ||
      !Number.isInteger(input.batchSize) ||
      input.batchSize < 1 ||
      input.batchSize > 10_000 ||
      !Number.isFinite(input.cutoffAt.getTime()) ||
      input.cutoffAt > now
    ) {
      throw new RangeError("Retention request is invalid.");
    }
  }
}
