import { Prisma as ProviderPrisma } from
  "../prisma/generated/provider/index.js";
import type {
  ProviderPrismaClient,
  ProviderTransactionClient,
} from "./provider-database.ts";
import {
  assertProviderActivityEvent,
  assertProviderHealthObservation,
  sanitizeProviderActivityEvidence,
  type ProviderActivityBatch,
  type ProviderActivityEvent,
  type ProviderLocalHealthObservation,
} from "./provider-activity-contract.ts";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const digestPattern = /^[0-9a-f]{64}$/u;
const failureCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/u;

function requireUuid(value: string): string {
  if (!uuidPattern.test(value)) throw new TypeError("Provider activity ID is invalid.");
  return value;
}

function requireDigest(value: string): string {
  if (!digestPattern.test(value)) {
    throw new TypeError("Provider activity digest is invalid.");
  }
  return value;
}

function requireInstant(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("Provider activity timestamp is invalid.");
  }
  return value;
}

function recoveryHint(input: {
  readonly state: string;
  readonly freshness: string;
  readonly quality: string;
  readonly failures: number;
}): string {
  if (input.state === "error" || input.failures > 0) {
    return "Review the latest provider-local run and retry after mitigation.";
  }
  if (input.freshness !== "fresh") {
    return "Run the provider through its current source head.";
  }
  if (input.quality !== "healthy") {
    return "Review the provider-local quarantine queue.";
  }
  return "No recovery action required.";
}

async function loadHealth(
  transaction: ProviderTransactionClient,
  providerId: string,
  observedAt: Date,
): Promise<ProviderLocalHealthObservation> {
  const [runtime, openQuarantineCount, promotion, publication] =
    await Promise.all([
      transaction.provider_runtime.findUniqueOrThrow({
        where: { singleton_key: true },
        select: {
          central_provider_id: true,
          operating_state: true,
          freshness_state: true,
          quality_state: true,
          consecutive_failures: true,
          latest_failure_code: true,
          last_attempted_at: true,
          last_head_reached_at: true,
          last_runner_heartbeat_at: true,
          recovered_at: true,
        },
      }),
      transaction.quarantine_records.count({ where: { state: "open" } }),
      transaction.promotion_ledger.findUniqueOrThrow({
        where: { singleton_key: true },
        select: { last_sequence: true },
      }),
      transaction.provider_publication_state.findUniqueOrThrow({
        where: { singleton_key: true },
        select: { completed_through_change_sequence: true },
      }),
    ]);
  if (runtime.central_provider_id !== providerId) {
    throw new Error("Provider activity identity does not match its database.");
  }
  return assertProviderHealthObservation({
    providerId,
    observedState: runtime.operating_state,
    freshnessState: runtime.freshness_state,
    qualityState: runtime.quality_state,
    consecutiveFailures: runtime.consecutive_failures,
    openQuarantineCount,
    lastAttemptedAt: runtime.last_attempted_at,
    lastHeadReachedAt: runtime.last_head_reached_at,
    recoveredAt: runtime.recovered_at,
    lastRunnerHeartbeatAt: runtime.last_runner_heartbeat_at,
    latestFailureCode: runtime.latest_failure_code,
    recoveryHint: recoveryHint({
      state: runtime.operating_state,
      freshness: runtime.freshness_state,
      quality: runtime.quality_state,
      failures: runtime.consecutive_failures,
    }),
    publicationLag:
      promotion.last_sequence - publication.completed_through_change_sequence,
    observedAt,
  });
}

/**
 * Provider-owned at-least-once relay queue. Central event identity/digest
 * deduplication makes an exclusive claim state unnecessary: a crash after
 * central acceptance simply replays the same immutable event.
 */
export class PrismaProviderActivityOutboxRepository {
  constructor(private readonly database: ProviderPrismaClient) {}

  async readPendingBatch(input: {
    readonly providerId: string;
    readonly limit: number;
  }): Promise<ProviderActivityBatch> {
    const providerId = requireUuid(input.providerId);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new RangeError("Provider activity batch limit is invalid.");
    }
    return this.database.$transaction(async (transaction) => {
      const [clock] = await transaction.$queryRaw<Array<{ observed_at: Date }>>(
        ProviderPrisma.sql`select clock_timestamp() as observed_at`,
      );
      if (!clock) throw new Error("Provider database clock is unavailable.");
      const rows = await transaction.provider_activity_outbox.findMany({
        where: { delivery_state: "pending" },
        orderBy: [{ created_at: "asc" }, { id: "asc" }],
        take: input.limit,
      });
      const events: ProviderActivityEvent[] = rows.map((row) =>
        assertProviderActivityEvent({
          id: row.id,
          eventDigest: row.event_digest,
          eventType: row.event_type,
          severity: row.severity,
          dedupeKey: row.dedupe_key,
          recoveryKey: row.recovery_key,
          localRunId: row.local_run_id,
          localQuarantineId: row.local_quarantine_id,
          title: row.title,
          summary: row.summary,
          evidence: sanitizeProviderActivityEvidence(row.evidence),
          eventAt: row.event_at,
          deliveryAttemptCount: row.delivery_attempt_count,
          lastFailureCode: row.last_failure_code,
        }),
      );
      return Object.freeze({
        providerId,
        health: await loadHealth(transaction, providerId, clock.observed_at),
        events: Object.freeze(events),
      });
    }, {
      isolationLevel: ProviderPrisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 5_000,
      timeout: 10_000,
    });
  }

  async markDelivered(input: {
    readonly eventId: string;
    readonly eventDigest: string;
    readonly deliveredAt: Date;
  }): Promise<"delivered" | "already_delivered" | "not_found"> {
    requireUuid(input.eventId);
    requireDigest(input.eventDigest);
    requireInstant(input.deliveredAt);
    const existing = await this.database.provider_activity_outbox.findUnique({
      where: { id: input.eventId },
      select: { event_digest: true, delivery_state: true },
    });
    if (!existing) return "not_found";
    if (existing.event_digest !== input.eventDigest) {
      throw new Error("Provider activity immutable identity conflict.");
    }
    if (existing.delivery_state === "delivered") return "already_delivered";
    const updated = await this.database.provider_activity_outbox.updateMany({
      where: {
        id: input.eventId,
        event_digest: input.eventDigest,
        delivery_state: "pending",
      },
      data: {
        delivery_state: "delivered",
        delivery_attempt_count: { increment: 1 },
        last_delivery_attempt_at: input.deliveredAt,
        delivered_at: input.deliveredAt,
        last_failure_code: null,
      },
    });
    if (updated.count === 1) return "delivered";
    const raced = await this.database.provider_activity_outbox.findUnique({
      where: { id: input.eventId },
      select: { event_digest: true, delivery_state: true },
    });
    if (!raced) return "not_found";
    if (raced.event_digest !== input.eventDigest) {
      throw new Error("Provider activity immutable identity conflict.");
    }
    return raced.delivery_state === "delivered"
      ? "already_delivered"
      : "not_found";
  }

  async markDeliveryFailed(input: {
    readonly eventId: string;
    readonly eventDigest: string;
    readonly attemptedAt: Date;
    readonly failureCode: string;
  }): Promise<"recorded" | "already_delivered" | "not_found"> {
    requireUuid(input.eventId);
    requireDigest(input.eventDigest);
    requireInstant(input.attemptedAt);
    if (!failureCodePattern.test(input.failureCode)) {
      throw new TypeError("Provider activity failure code is invalid.");
    }
    const existing = await this.database.provider_activity_outbox.findUnique({
      where: { id: input.eventId },
      select: { event_digest: true, delivery_state: true },
    });
    if (!existing) return "not_found";
    if (existing.event_digest !== input.eventDigest) {
      throw new Error("Provider activity immutable identity conflict.");
    }
    if (existing.delivery_state === "delivered") return "already_delivered";
    const updated = await this.database.provider_activity_outbox.updateMany({
      where: {
        id: input.eventId,
        event_digest: input.eventDigest,
        delivery_state: "pending",
      },
      data: {
        delivery_attempt_count: { increment: 1 },
        last_delivery_attempt_at: input.attemptedAt,
        last_failure_code: input.failureCode,
      },
    });
    return updated.count === 1 ? "recorded" : "not_found";
  }
}
