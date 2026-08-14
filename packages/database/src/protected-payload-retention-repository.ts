import type { RetentionBatchResult } from "@packscout/contracts";
import { Prisma, type retention_executions } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutQueryClient,
  type PackscoutTransactionClient,
} from "./database.ts";

export interface RetentionClock {
  now(): Date;
}

export interface ExpiredQuarantineReference {
  readonly id: string;
  readonly providerId: string;
  readonly reasonCode: string;
}

export interface PersistedRetentionBatch {
  readonly result: RetentionBatchResult;
  readonly recovered: boolean;
  readonly expiredQuarantines: readonly ExpiredQuarantineReference[];
}

interface ClaimedQuarantineRow {
  readonly id: string;
  readonly provider_id: string;
  readonly reason_code: string;
  readonly was_open: boolean;
}

function duration(startedAt: Date, finishedAt: Date): number {
  return Math.max(0, finishedAt.getTime() - startedAt.getTime());
}

export class PrismaProtectedPayloadRetentionRepository {
  constructor(
    private readonly database: PackscoutPrismaClient,
    private readonly clock: RetentionClock,
  ) {}

  async discoverEligibleOrganizations(input: {
    cutoffAt: Date;
    limit: number;
  }): Promise<readonly string[]> {
    if (
      !Number.isFinite(input.cutoffAt.getTime()) ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 1_000
    ) {
      throw new RangeError("Retention discovery request is invalid.");
    }
    const rows = await this.database.$queryRaw<{ organization_id: string }[]>(
      Prisma.sql`
        select eligible.organization_id
        from (
          select pages.organization_id
          from import_pages as pages
          where pages.expires_at <= ${input.cutoffAt}
            and pages.payload_json is not null
            and not exists (
              select 1
              from quarantine_attempts as attempts
              inner join quarantine_records as quarantines
                on quarantines.id = attempts.quarantine_id
               and quarantines.organization_id = attempts.organization_id
              where attempts.organization_id = pages.organization_id
                and attempts.state = 'running'::quarantine_attempt_state
                and quarantines.page_id = pages.id
            )
          union
          select records.organization_id
          from source_records as records
          where records.expires_at <= ${input.cutoffAt}
            and records.payload_json is not null
            and not exists (
              select 1
              from quarantine_attempts as attempts
              inner join quarantine_records as quarantines
                on quarantines.id = attempts.quarantine_id
               and quarantines.organization_id = attempts.organization_id
              where attempts.organization_id = records.organization_id
                and attempts.state = 'running'::quarantine_attempt_state
                and quarantines.source_record_id = records.id
            )
          union
          select quarantines.organization_id
          from quarantine_records as quarantines
          where quarantines.expires_at <= ${input.cutoffAt}
            and (
              quarantines.payload_json is not null
              or quarantines.state = 'open'::quarantine_state
            )
            and not exists (
              select 1
              from quarantine_attempts as attempts
              where attempts.organization_id = quarantines.organization_id
                and attempts.quarantine_id = quarantines.id
                and attempts.state = 'running'::quarantine_attempt_state
            )
        ) as eligible
        order by eligible.organization_id asc
        limit ${input.limit}
      `,
    );
    return rows.map(({ organization_id: organizationId }) => organizationId);
  }

  async expireBatch(input: {
    executionId: string;
    organizationId: string;
    cutoffAt: Date;
    batchSize: number;
    startedAt: Date;
  }): Promise<PersistedRetentionBatch> {
    this.assertBatchSize(input.batchSize);
    return this.database.$transaction(async (transaction) => {
      const existing = await this.lockExecution(
        transaction,
        input.executionId,
        input.organizationId,
      );
      if (existing?.finished_at) {
        return {
          result: this.toResult(existing, true),
          recovered: false,
          expiredQuarantines: [],
        };
      }
      if (!existing) {
        await transaction.retention_executions.create({
          data: {
            id: input.executionId,
            organization_id: input.organizationId,
            state: "running",
            cutoff_at: input.cutoffAt,
            batch_size: input.batchSize,
            started_at: input.startedAt,
          },
        });
      }
      const previous = await transaction.retention_executions.findFirst({
        where: {
          organization_id: input.organizationId,
          id: { not: input.executionId },
          state: { not: "running" },
        },
        orderBy: [{ started_at: "desc" }, { id: "desc" }],
        select: { state: true },
      });
      const alreadyExpired = await this.countEvidence(
        transaction,
        input.organizationId,
        input.cutoffAt,
        true,
      );

      let remainingBudget = input.batchSize;
      const finishedAt = this.clock.now();
      const quarantines = remainingBudget > 0
        ? await this.expireQuarantines(
            transaction,
            input.organizationId,
            input.cutoffAt,
            remainingBudget,
            finishedAt,
          )
        : [];
      remainingBudget -= quarantines.length;
      const sourceRecordsExpired = remainingBudget > 0
        ? await this.expireSourceRecords(
            transaction,
            input.organizationId,
            input.cutoffAt,
            remainingBudget,
            finishedAt,
          )
        : 0;
      remainingBudget -= sourceRecordsExpired;
      const pagesExpired = remainingBudget > 0
        ? await this.expirePages(
            transaction,
            input.organizationId,
            input.cutoffAt,
            remainingBudget,
            finishedAt,
          )
        : 0;

      const remaining = await this.countEvidence(
        transaction,
        input.organizationId,
        input.cutoffAt,
        false,
      );
      const selected = quarantines.length + sourceRecordsExpired + pagesExpired;
      const completed = await transaction.retention_executions.updateMany({
        where: {
          id: input.executionId,
          organization_id: input.organizationId,
          state: "running",
        },
        data: {
          state: "succeeded",
          selected_count: selected,
          expired_count: selected,
          already_expired_count: alreadyExpired,
          failed_count: 0,
          remaining_count: remaining,
          pages_expired_count: pagesExpired,
          source_records_expired_count: sourceRecordsExpired,
          quarantines_expired_count: quarantines.length,
          finished_at: finishedAt,
        },
      });
      if (completed.count !== 1) {
        throw new Error("Retention execution could not be completed.");
      }
      const execution = await transaction.retention_executions.findFirst({
        where: {
          id: input.executionId,
          organization_id: input.organizationId,
        },
      });
      if (!execution) throw new Error("Retention execution could not be loaded.");
      await transaction.audit_events.create({
        data: {
          organization_id: input.organizationId,
          actor_key: "system:retention",
          action: "provider.retention.expire",
          subject_type: "retention_execution",
          subject_id: input.executionId,
          outcome: "success",
          metadata_json: {
            selected,
            expired: selected,
            alreadyExpired,
            remaining,
            pages: pagesExpired,
            sourceRecords: sourceRecordsExpired,
            quarantines: quarantines.length,
          },
          occurred_at: finishedAt,
        },
      });
      return {
        result: this.toResult(execution, false),
        recovered: previous?.state === "failed",
        expiredQuarantines: quarantines
          .filter(({ was_open: wasOpen }) => wasOpen)
          .map(({ id, provider_id: providerId, reason_code: reasonCode }) => ({
            id,
            providerId,
            reasonCode,
          })),
      };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async recordFailure(input: {
    executionId: string;
    organizationId: string;
    cutoffAt: Date;
    batchSize: number;
    startedAt: Date;
    finishedAt: Date;
    failureCode: string;
  }): Promise<RetentionBatchResult> {
    this.assertBatchSize(input.batchSize);
    const failureCode = /^[A-Z][A-Z0-9_]{0,127}$/.test(input.failureCode)
      ? input.failureCode
      : "RETENTION_FAILED";
    return this.database.$transaction(async (transaction) => {
      const existing = await this.lockExecutionById(
        transaction,
        input.executionId,
      );
      if (existing && existing.organization_id !== input.organizationId) {
        throw new Error("Retention execution identity is outside tenant scope.");
      }
      if (existing?.finished_at) return this.toResult(existing, true);
      const record = existing
        ? await transaction.retention_executions.update({
            where: { id: input.executionId },
            data: {
              state: "failed",
              failed_count: 1,
              failure_code: failureCode,
              sanitized_summary:
                "A bounded protected-data cleanup did not complete.",
              finished_at: input.finishedAt,
            },
          })
        : await transaction.retention_executions.create({
            data: {
              id: input.executionId,
              organization_id: input.organizationId,
              state: "failed",
              cutoff_at: input.cutoffAt,
              batch_size: input.batchSize,
              failed_count: 1,
              failure_code: failureCode,
              sanitized_summary:
                "A bounded protected-data cleanup did not complete.",
              started_at: input.startedAt,
              finished_at: input.finishedAt,
            },
          });
      await transaction.audit_events.create({
        data: {
          organization_id: input.organizationId,
          actor_key: "system:retention",
          action: "provider.retention.expire",
          subject_type: "retention_execution",
          subject_id: input.executionId,
          outcome: "failure",
          metadata_json: { failureCode },
          occurred_at: input.finishedAt,
        },
      });
      return this.toResult(record, false);
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  private async expireQuarantines(
    transaction: PackscoutTransactionClient,
    organizationId: string,
    cutoffAt: Date,
    limit: number,
    expiredAt: Date,
  ): Promise<ClaimedQuarantineRow[]> {
    return transaction.$queryRaw<ClaimedQuarantineRow[]>(Prisma.sql`
      with candidates as (
        select quarantines.id,
               quarantines.expires_at,
               quarantines.provider_id,
               quarantines.reason_code,
               quarantines.state = 'open'::quarantine_state as was_open
        from quarantine_records as quarantines
        where quarantines.organization_id = cast(${organizationId} as uuid)
          and quarantines.expires_at <= ${cutoffAt}
          and (
            quarantines.payload_json is not null
            or quarantines.state = 'open'::quarantine_state
          )
          and not exists (
            select 1
            from quarantine_attempts as attempts
            where attempts.organization_id = quarantines.organization_id
              and attempts.quarantine_id = quarantines.id
              and attempts.state = 'running'::quarantine_attempt_state
          )
        order by quarantines.expires_at asc, quarantines.id asc
        for update of quarantines skip locked
        limit ${limit}
      ), expired as (
        update quarantine_records as quarantines
        set payload_json = null,
            payload_expired_at = ${expiredAt},
            state = case
              when quarantines.state = 'open'::quarantine_state
                then 'expired'::quarantine_state
              else quarantines.state
            end
        from candidates
        where quarantines.id = candidates.id
          and quarantines.organization_id = cast(${organizationId} as uuid)
        returning quarantines.id
      )
      select candidates.id,
             candidates.provider_id,
             candidates.reason_code,
             candidates.was_open
      from candidates
      inner join expired on expired.id = candidates.id
      order by candidates.expires_at asc, candidates.id asc
    `);
  }

  private async expireSourceRecords(
    transaction: PackscoutTransactionClient,
    organizationId: string,
    cutoffAt: Date,
    limit: number,
    expiredAt: Date,
  ): Promise<number> {
    const expired = await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`
      with candidates as (
        select records.id, records.expires_at
        from source_records as records
        where records.organization_id = cast(${organizationId} as uuid)
          and records.expires_at <= ${cutoffAt}
          and records.payload_json is not null
          and not exists (
            select 1
            from quarantine_attempts as attempts
            inner join quarantine_records as quarantines
              on quarantines.id = attempts.quarantine_id
             and quarantines.organization_id = attempts.organization_id
            where attempts.organization_id = records.organization_id
              and attempts.state = 'running'::quarantine_attempt_state
              and quarantines.source_record_id = records.id
          )
        order by records.expires_at asc, records.id asc
        for update of records skip locked
        limit ${limit}
      ), expired as (
        update source_records as records
        set payload_json = null,
            payload_expired_at = ${expiredAt}
        from candidates
        where records.id = candidates.id
          and records.organization_id = cast(${organizationId} as uuid)
        returning records.id
      )
      select expired.id
      from expired
      inner join candidates on candidates.id = expired.id
      order by candidates.expires_at asc, candidates.id asc
    `);
    return expired.length;
  }

  private async expirePages(
    transaction: PackscoutTransactionClient,
    organizationId: string,
    cutoffAt: Date,
    limit: number,
    expiredAt: Date,
  ): Promise<number> {
    const expired = await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`
      with candidates as (
        select pages.id, pages.expires_at
        from import_pages as pages
        where pages.organization_id = cast(${organizationId} as uuid)
          and pages.expires_at <= ${cutoffAt}
          and pages.payload_json is not null
          and not exists (
            select 1
            from quarantine_attempts as attempts
            inner join quarantine_records as quarantines
              on quarantines.id = attempts.quarantine_id
             and quarantines.organization_id = attempts.organization_id
            where attempts.organization_id = pages.organization_id
              and attempts.state = 'running'::quarantine_attempt_state
              and quarantines.page_id = pages.id
          )
        order by pages.expires_at asc, pages.id asc
        for update of pages skip locked
        limit ${limit}
      ), expired as (
        update import_pages as pages
        set payload_json = null,
            payload_expired_at = ${expiredAt}
        from candidates
        where pages.id = candidates.id
          and pages.organization_id = cast(${organizationId} as uuid)
        returning pages.id
      )
      select expired.id
      from expired
      inner join candidates on candidates.id = expired.id
      order by candidates.expires_at asc, candidates.id asc
    `);
    return expired.length;
  }

  private async countEvidence(
    database: PackscoutQueryClient,
    organizationId: string,
    cutoffAt: Date,
    expired: boolean,
  ): Promise<number> {
    const [counts] = await database.$queryRaw<{
      pages: bigint;
      source_records: bigint;
      quarantines: bigint;
    }[]>(Prisma.sql`
      select
        (
          select count(*)
          from import_pages
          where organization_id = cast(${organizationId} as uuid)
            and expires_at <= ${cutoffAt}
            and ${expired
              ? Prisma.sql`payload_json is null and payload_expired_at is not null`
              : Prisma.sql`payload_json is not null`}
        ) as pages,
        (
          select count(*)
          from source_records
          where organization_id = cast(${organizationId} as uuid)
            and expires_at <= ${cutoffAt}
            and ${expired
              ? Prisma.sql`payload_json is null and payload_expired_at is not null`
              : Prisma.sql`payload_json is not null`}
        ) as source_records,
        (
          select count(*)
          from quarantine_records
          where organization_id = cast(${organizationId} as uuid)
            and expires_at <= ${cutoffAt}
            and ${expired
              ? Prisma.sql`payload_expired_at is not null`
              : Prisma.sql`(payload_json is not null or state = 'open'::quarantine_state)`}
        ) as quarantines
    `);
    return Number(counts?.pages ?? 0n) +
      Number(counts?.source_records ?? 0n) +
      Number(counts?.quarantines ?? 0n);
  }

  private async lockExecution(
    transaction: PackscoutTransactionClient,
    executionId: string,
    organizationId: string,
  ): Promise<retention_executions | null> {
    const [locked] = await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`
      select id
      from retention_executions
      where id = cast(${executionId} as uuid)
        and organization_id = cast(${organizationId} as uuid)
      for update
    `);
    return locked
      ? transaction.retention_executions.findUnique({ where: { id: locked.id } })
      : null;
  }

  private async lockExecutionById(
    transaction: PackscoutTransactionClient,
    executionId: string,
  ): Promise<retention_executions | null> {
    const [locked] = await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`
      select id
      from retention_executions
      where id = cast(${executionId} as uuid)
      for update
    `);
    return locked
      ? transaction.retention_executions.findUnique({ where: { id: locked.id } })
      : null;
  }

  private toResult(
    execution: retention_executions,
    replayed: boolean,
  ): RetentionBatchResult {
    const finishedAt = execution.finished_at ?? execution.started_at;
    return {
      executionId: execution.id,
      selected: execution.selected_count,
      expired: execution.expired_count,
      alreadyExpired: execution.already_expired_count,
      failed: execution.failed_count,
      remaining: execution.remaining_count,
      pagesExpired: execution.pages_expired_count,
      sourceRecordsExpired: execution.source_records_expired_count,
      quarantinesExpired: execution.quarantines_expired_count,
      startedAt: execution.started_at.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: duration(execution.started_at, finishedAt),
      replayed,
    };
  }

  private assertBatchSize(batchSize: number): void {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
      throw new RangeError("Retention batch size must be between 1 and 10000.");
    }
  }
}
