import { Prisma } from "@prisma/client";
import type { RecomputationRecoveryOutcome } from "@packscout/contracts";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutTransactionClient,
} from "./database.ts";

/**
 * Read and recovery access to the pipeline's background work that is not a
 * provider import run: the estimated-EV recomputation queue and the
 * protected-payload retention executions.
 *
 * Recovery is deliberately conditional. Every write matches the durable state
 * it claims to act on, so a worker that completes an entry concurrently wins
 * and the operator receives a conflict outcome instead of a second execution.
 */

export type RecomputationDurableState =
  | "queued"
  | "running"
  | "completed"
  | "failed";

export type RetentionExecutionDurableState = "running" | "succeeded" | "failed";

export interface RecomputationQueueRecord {
  readonly id: string;
  readonly providerId: string;
  readonly platformKey: string;
  readonly packExternalId: string;
  readonly evInputExternalId: string;
  readonly state: RecomputationDurableState;
  readonly attemptCount: number;
  readonly createdAt: Date;
  readonly availableAt: Date;
  /**
   * Last durable transition. A claim is the only write that leaves an entry in
   * `running`, so for a claimed entry this is the moment the claim was taken.
   */
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
  readonly claimedBy: string | null;
  readonly claimExpiresAt: Date | null;
  readonly failureCode: string | null;
}

export interface RecomputationQueueAggregate {
  readonly pending: number;
  readonly readyPending: number;
  readonly claimed: number;
  readonly expiredClaims: number;
  readonly failed: number;
  readonly oldestPendingAvailableAt: Date | null;
}

export interface RetentionExecutionRecord {
  readonly id: string;
  readonly state: RetentionExecutionDurableState;
  readonly cutoffAt: Date;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly pagesExpired: number;
  readonly sourceRecordsExpired: number;
  readonly quarantinesExpired: number;
  readonly alreadyExpired: number;
  readonly remaining: number;
  readonly failureCode: string | null;
  readonly sanitizedSummary: string | null;
}

export interface BackgroundWorkCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface BackgroundWorkPage<T> {
  readonly items: readonly T[];
  readonly hasMore: boolean;
}

export interface RecomputationRecoveryResolution {
  readonly outcome: RecomputationRecoveryOutcome;
  readonly record: RecomputationQueueRecord | null;
}

interface AggregateRow {
  readonly pending: bigint;
  readonly ready_pending: bigint;
  readonly claimed: bigint;
  readonly expired_claims: bigint;
  readonly failed: bigint;
  readonly oldest_pending_available_at: Date | null;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const requestSelection = {
  id: true,
  provider_id: true,
  platform_key: true,
  pack_external_id: true,
  ev_input_external_id: true,
  state: true,
  attempt_count: true,
  created_at: true,
  available_at: true,
  updated_at: true,
  completed_at: true,
  claimed_by: true,
  claim_expires_at: true,
  failure_code: true,
} as const;

type RequestRow = {
  readonly [Key in keyof typeof requestSelection]: unknown;
};

function assertIdentity(...values: readonly string[]): void {
  for (const value of values) {
    if (!uuidPattern.test(value)) {
      throw new RangeError("Background work identity is invalid.");
    }
  }
}

function assertLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError("Background work page limit is invalid.");
  }
  return limit;
}

function assertTimestamp(value: Date): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new RangeError("Background work timestamp is invalid.");
  }
  return value;
}

function count(value: bigint | number | null | undefined): number {
  return Number(value ?? 0);
}

function toQueueRecord(row: RequestRow): RecomputationQueueRecord {
  const record = row as unknown as {
    id: string;
    provider_id: string;
    platform_key: string;
    pack_external_id: string;
    ev_input_external_id: string;
    state: RecomputationDurableState;
    attempt_count: number;
    created_at: Date;
    available_at: Date;
    updated_at: Date;
    completed_at: Date | null;
    claimed_by: string | null;
    claim_expires_at: Date | null;
    failure_code: string | null;
  };
  return {
    id: record.id,
    providerId: record.provider_id,
    platformKey: record.platform_key,
    packExternalId: record.pack_external_id,
    evInputExternalId: record.ev_input_external_id,
    state: record.state,
    attemptCount: record.attempt_count,
    createdAt: record.created_at,
    availableAt: record.available_at,
    updatedAt: record.updated_at,
    completedAt: record.completed_at,
    claimedBy: record.claimed_by,
    claimExpiresAt: record.claim_expires_at,
    failureCode: record.failure_code,
  };
}

function keysetFilter(before: BackgroundWorkCursor | undefined, column: "created_at" | "started_at") {
  if (!before) return {};
  return {
    OR: [
      { [column]: { lt: before.createdAt } },
      { [column]: before.createdAt, id: { lt: before.id } },
    ],
  };
}

export class PrismaBackgroundWorkRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async listRecomputations(input: {
    readonly organizationId: string;
    readonly limit: number;
    readonly state?: RecomputationDurableState;
    readonly before?: BackgroundWorkCursor;
  }): Promise<BackgroundWorkPage<RecomputationQueueRecord>> {
    assertIdentity(input.organizationId);
    const limit = assertLimit(input.limit);
    const rows = await this.database.estimated_ev_recomputation_requests.findMany({
      where: {
        organization_id: input.organizationId,
        ...(input.state ? { state: input.state } : {}),
        ...keysetFilter(input.before, "created_at"),
      },
      select: requestSelection,
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    return {
      items: rows.slice(0, limit).map((row) => toQueueRecord(row as RequestRow)),
      hasMore: rows.length > limit,
    };
  }

  /**
   * Queue depth and oldest-pending age in one statement. The counts are
   * deliberately computed by PostgreSQL rather than by paging rows, so the
   * aggregate stays accurate past the first page.
   */
  async aggregateRecomputations(input: {
    readonly organizationId: string;
    readonly now: Date;
  }): Promise<RecomputationQueueAggregate> {
    assertIdentity(input.organizationId);
    assertTimestamp(input.now);
    const [row] = await this.database.$queryRaw<AggregateRow[]>(Prisma.sql`
      select
        count(*) filter (
          where state = 'queued'::estimated_ev_recomputation_state
        ) as pending,
        count(*) filter (
          where state = 'queued'::estimated_ev_recomputation_state
            and available_at <= ${input.now}
        ) as ready_pending,
        count(*) filter (
          where state = 'running'::estimated_ev_recomputation_state
        ) as claimed,
        count(*) filter (
          where state = 'running'::estimated_ev_recomputation_state
            and claim_expires_at is not null
            and claim_expires_at <= ${input.now}
        ) as expired_claims,
        count(*) filter (
          where state = 'failed'::estimated_ev_recomputation_state
        ) as failed,
        min(available_at) filter (
          where state = 'queued'::estimated_ev_recomputation_state
        ) as oldest_pending_available_at
      from estimated_ev_recomputation_requests
      where organization_id = cast(${input.organizationId} as uuid)
    `);
    return {
      pending: count(row?.pending),
      readyPending: count(row?.ready_pending),
      claimed: count(row?.claimed),
      expiredClaims: count(row?.expired_claims),
      failed: count(row?.failed),
      oldestPendingAvailableAt: row?.oldest_pending_available_at ?? null,
    };
  }

  async listRetentionExecutions(input: {
    readonly organizationId: string;
    readonly limit: number;
    readonly before?: BackgroundWorkCursor;
  }): Promise<BackgroundWorkPage<RetentionExecutionRecord>> {
    assertIdentity(input.organizationId);
    const limit = assertLimit(input.limit);
    const rows = await this.database.retention_executions.findMany({
      where: {
        organization_id: input.organizationId,
        ...keysetFilter(input.before, "started_at"),
      },
      orderBy: [{ started_at: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    return {
      items: rows.slice(0, limit).map((row) => ({
        id: row.id,
        state: row.state,
        cutoffAt: row.cutoff_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        pagesExpired: row.pages_expired_count,
        sourceRecordsExpired: row.source_records_expired_count,
        quarantinesExpired: row.quarantines_expired_count,
        alreadyExpired: row.already_expired_count,
        remaining: row.remaining_count,
        failureCode: row.failure_code,
        sanitizedSummary: row.sanitized_summary,
      })),
      hasMore: rows.length > limit,
    };
  }

  async latestRetentionExecution(input: {
    readonly organizationId: string;
  }): Promise<RetentionExecutionRecord | null> {
    const page = await this.listRetentionExecutions({ ...input, limit: 1 });
    return page.items[0] ?? null;
  }

  /**
   * Returns an entry whose claim has already expired to the queue. The claim
   * token is cleared in the same statement, so the worker that still holds the
   * stale claim can neither complete nor fail the request afterwards.
   */
  releaseStuckClaim(input: {
    readonly organizationId: string;
    readonly requestId: string;
    readonly actorKey: string;
    readonly now: Date;
  }): Promise<RecomputationRecoveryResolution> {
    return this.recover(input, "release", (transaction) =>
      transaction.$queryRaw<{ id: string }[]>(Prisma.sql`
        update estimated_ev_recomputation_requests
        set state = 'queued'::estimated_ev_recomputation_state,
            claimed_by = null,
            claim_token = null,
            claim_expires_at = null,
            available_at = ${input.now},
            updated_at = ${input.now}
        where id = cast(${input.requestId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
          and state = 'running'::estimated_ev_recomputation_state
          and claim_expires_at is not null
          and claim_expires_at <= ${input.now}
        returning id
      `),
    );
  }

  /**
   * Returns an exhausted entry to the queue for one more worker attempt. The
   * attempt history is preserved; only the stale failure code is cleared.
   */
  requeueFailedEntry(input: {
    readonly organizationId: string;
    readonly requestId: string;
    readonly actorKey: string;
    readonly now: Date;
  }): Promise<RecomputationRecoveryResolution> {
    return this.recover(input, "requeue", (transaction) =>
      transaction.$queryRaw<{ id: string }[]>(Prisma.sql`
        update estimated_ev_recomputation_requests
        set state = 'queued'::estimated_ev_recomputation_state,
            claimed_by = null,
            claim_token = null,
            claim_expires_at = null,
            failure_code = null,
            available_at = ${input.now},
            updated_at = ${input.now}
        where id = cast(${input.requestId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
          and state = 'failed'::estimated_ev_recomputation_state
        returning id
      `),
    );
  }

  private async recover(
    input: {
      readonly organizationId: string;
      readonly requestId: string;
      readonly actorKey: string;
      readonly now: Date;
    },
    action: "release" | "requeue",
    apply: (
      transaction: PackscoutTransactionClient,
    ) => Promise<{ id: string }[]>,
  ): Promise<RecomputationRecoveryResolution> {
    assertIdentity(input.organizationId, input.requestId);
    assertTimestamp(input.now);
    if (input.actorKey.length < 1 || input.actorKey.length > 256) {
      throw new RangeError("Background work actor key is invalid.");
    }
    return this.database.$transaction(async (transaction) => {
      const applied = await apply(transaction);
      const record = await this.loadRequest(
        transaction,
        input.organizationId,
        input.requestId,
      );
      const outcome: RecomputationRecoveryOutcome =
        applied.length === 1
          ? action === "release"
            ? "released"
            : "requeued"
          : this.classifyConflict(action, record, input.now);
      await transaction.audit_events.create({
        data: {
          organization_id: input.organizationId,
          actor_key: input.actorKey,
          action: `provider.estimated_ev.${action}`,
          subject_type: "estimated_ev_recomputation_request",
          subject_id: input.requestId,
          outcome: applied.length === 1 ? "success" : "blocked",
          metadata_json: {
            result: outcome,
            observedState: record?.state ?? null,
            attemptCount: record?.attemptCount ?? null,
          },
          occurred_at: input.now,
        },
      });
      return { outcome, record };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  private classifyConflict(
    action: "release" | "requeue",
    record: RecomputationQueueRecord | null,
    now: Date,
  ): RecomputationRecoveryOutcome {
    if (record === null) return "not_found";
    if (
      action === "release" &&
      record.state === "running" &&
      record.claimExpiresAt !== null &&
      record.claimExpiresAt > now
    ) {
      return "claim_active";
    }
    return "already_resolved";
  }

  private async loadRequest(
    transaction: PackscoutTransactionClient,
    organizationId: string,
    requestId: string,
  ): Promise<RecomputationQueueRecord | null> {
    const row = await transaction.estimated_ev_recomputation_requests.findFirst({
      where: { id: requestId, organization_id: organizationId },
      select: requestSelection,
    });
    return row ? toQueueRecord(row as RequestRow) : null;
  }
}
