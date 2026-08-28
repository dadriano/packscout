import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutTransactionClient,
} from "./database.ts";
import {
  PROVIDER_SOURCE_DIAGNOSTIC_RETENTION_DAYS,
  PROVIDER_SOURCE_QUARANTINE_RETENTION_DAYS,
  PROVIDER_SOURCE_RAW_PAGE_RETENTION_DAYS,
  PROVIDER_SOURCE_REQUEST_ATTEMPT_RETENTION_DAYS,
} from "./provider-source-persistence-types.ts";
import { providerSourceTransactionTime } from "./provider-source-database-clock.ts";

function subtractDays(value: Date, days: number): Date {
  return new Date(value.getTime() - days * 86_400_000);
}

const RETENTION_PHASES = [
  "pages",
  "diagnostics",
  "quarantines",
  "compact_attempts",
  "delete_attempts",
  "complete",
] as const;

type RetentionPhase = (typeof RETENTION_PHASES)[number];
type WorkPhase = Exclude<RetentionPhase, "complete">;

const NEXT_PHASE: Readonly<Record<WorkPhase, RetentionPhase>> = Object.freeze({
  pages: "diagnostics",
  diagnostics: "quarantines",
  quarantines: "compact_attempts",
  compact_attempts: "delete_attempts",
  delete_attempts: "complete",
});

function requireRetentionPhase(value: string | null): RetentionPhase {
  if (value && (RETENTION_PHASES as readonly string[]).includes(value)) {
    return value as RetentionPhase;
  }
  throw new Error("Retention execution has an invalid resume phase.");
}

function requireBatchSize(batchSize: number): void {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new TypeError("Retention batch size must be an integer from 1 through 10000.");
  }
}

export interface ProviderSourceRetentionResult {
  readonly executionId: string;
  readonly pagesExpired: number;
  readonly quarantinesExpired: number;
  readonly diagnosticsDeleted: number;
  readonly attemptsCompacted: number;
  readonly attemptsDeleted: number;
}

interface RetentionExecution {
  readonly id: string;
  readonly organization_id: string;
  readonly state: "running" | "succeeded" | "failed";
  readonly batch_size: number;
  readonly resume_after_key: string | null;
  readonly pages_expired_count: number;
  readonly quarantines_expired_count: number;
  readonly diagnostics_deleted_count: number;
  readonly attempts_compacted_count: number;
  readonly attempts_deleted_count: number;
  readonly started_at: Date;
}

function toResult(execution: RetentionExecution): ProviderSourceRetentionResult {
  return {
    executionId: execution.id,
    pagesExpired: execution.pages_expired_count,
    quarantinesExpired: execution.quarantines_expired_count,
    diagnosticsDeleted: execution.diagnostics_deleted_count,
    attemptsCompacted: execution.attempts_compacted_count,
    attemptsDeleted: execution.attempts_deleted_count,
  };
}

export class ProviderSourceRetentionRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async runBatch(input: Readonly<{
    organizationId: string;
    batchSize: number;
    now: Date;
    resumeExecutionId?: string;
  }>): Promise<ProviderSourceRetentionResult> {
    requireBatchSize(input.batchSize);
    const resumeExecutionId = input.resumeExecutionId;
    const execution = resumeExecutionId
      ? await this.#resumeExecution({ ...input, resumeExecutionId })
      : await this.#createExecution(input);
    if (execution.state === "succeeded") return toResult(execution);

    let phase = requireRetentionPhase(execution.resume_after_key);
    try {
      while (phase !== "complete") {
        await this.#runPhase(execution, phase);
        phase = NEXT_PHASE[phase];
      }
      const finalized = await this.database.$transaction(async (transaction) => {
        const databaseNow = await providerSourceTransactionTime(transaction);
        return transaction.source_retention_executions.updateMany({
          where: {
            id: execution.id,
            organization_id: input.organizationId,
            state: "running",
            resume_after_key: "complete",
          },
          data: {
            state: "succeeded",
            resume_after_key: null,
            failure_code: null,
            sanitized_summary: null,
            finished_at: databaseNow,
          },
        });
      }, PACKSCOUT_TRANSACTION_OPTIONS);
      if (finalized.count !== 1) {
        throw new Error("Retention execution lost its progress fence.");
      }
      const completed = await this.database.source_retention_executions.findFirstOrThrow({
        where: { id: execution.id, organization_id: input.organizationId, state: "succeeded" },
      });
      return toResult(completed);
    } catch {
      await this.database.$transaction(async (transaction) => {
        const databaseNow = await providerSourceTransactionTime(transaction);
        await transaction.source_retention_executions.updateMany({
          where: {
            id: execution.id,
            organization_id: input.organizationId,
            state: "running",
            resume_after_key: phase,
          },
          data: {
            state: "failed",
            failure_code: "RETENTION_PHASE_FAILED",
            sanitized_summary: `Provider-source retention phase ${phase} failed.`,
            finished_at: databaseNow,
          },
        });
      }, PACKSCOUT_TRANSACTION_OPTIONS).catch(() => undefined);
      throw new Error("Provider-source retention batch failed.");
    }
  }

  async #createExecution(input: Readonly<{
    organizationId: string;
    batchSize: number;
    now: Date;
  }>): Promise<RetentionExecution> {
    return this.database.$transaction(async (transaction) => {
      const databaseNow = await providerSourceTransactionTime(transaction);
      const cutoffs = {
        raw: subtractDays(databaseNow, PROVIDER_SOURCE_RAW_PAGE_RETENTION_DAYS),
        quarantine: subtractDays(databaseNow, PROVIDER_SOURCE_QUARANTINE_RETENTION_DAYS),
        diagnostic: subtractDays(databaseNow, PROVIDER_SOURCE_DIAGNOSTIC_RETENTION_DAYS),
        attempt: subtractDays(databaseNow, PROVIDER_SOURCE_REQUEST_ATTEMPT_RETENTION_DAYS),
      };
      return transaction.source_retention_executions.create({
        data: {
          organization_id: input.organizationId,
          batch_size: input.batchSize,
          raw_page_cutoff_at: cutoffs.raw,
          quarantine_cutoff_at: cutoffs.quarantine,
          diagnostic_cutoff_at: cutoffs.diagnostic,
          request_attempt_cutoff_at: cutoffs.attempt,
          resume_after_key: "pages",
          started_at: databaseNow,
        },
      });
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async #resumeExecution(input: Readonly<{
    organizationId: string;
    batchSize: number;
    now: Date;
    resumeExecutionId: string;
  }>): Promise<RetentionExecution> {
    return this.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<RetentionExecution[]>(Prisma.sql`
        select *
        from public.source_retention_executions
        where id = cast(${input.resumeExecutionId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
        for update
      `);
      const execution = rows[0];
      if (!execution) throw new Error("Retention execution was not found in tenant scope.");
      if (execution.batch_size !== input.batchSize) {
        throw new TypeError("A resumed retention execution must keep its original batch size.");
      }
      if (execution.state === "succeeded") return execution;
      requireRetentionPhase(execution.resume_after_key);
      // An explicitly named running execution may be left by a dead process.
      // Every phase mutates data and advances this key in one transaction, so
      // a concurrent stale runner loses the phase CAS and rolls its work back.
      if (execution.state === "running") return execution;
      return transaction.source_retention_executions.update({
        where: { id: execution.id },
        data: {
          state: "running",
          failure_code: null,
          sanitized_summary: null,
          finished_at: null,
        },
      });
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async #runPhase(
    execution: RetentionExecution,
    phase: WorkPhase,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const owned = await transaction.source_retention_executions.findFirst({
        where: {
          id: execution.id,
          organization_id: execution.organization_id,
          state: "running",
          resume_after_key: phase,
        },
        select: { id: true },
      });
      if (!owned) throw new Error("Retention execution lost its progress fence.");

      const completedAt = await providerSourceTransactionTime(transaction);
      const count = await this.#applyPhase(transaction, execution, phase, completedAt);
      const countField = phase === "pages"
        ? "pages_expired_count"
        : phase === "diagnostics"
          ? "diagnostics_deleted_count"
          : phase === "quarantines"
            ? "quarantines_expired_count"
            : phase === "compact_attempts"
              ? "attempts_compacted_count"
              : "attempts_deleted_count";
      const advanced = await transaction.source_retention_executions.updateMany({
        where: {
          id: execution.id,
          organization_id: execution.organization_id,
          state: "running",
          resume_after_key: phase,
        },
        data: {
          resume_after_key: NEXT_PHASE[phase],
          [countField]: { increment: count },
        },
      });
      if (advanced.count !== 1) throw new Error("Retention execution lost its progress fence.");
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async #applyPhase(
    transaction: PackscoutTransactionClient,
    execution: RetentionExecution,
    phase: WorkPhase,
    completedAt: Date,
  ): Promise<number> {
    if (phase === "pages") {
      return transaction.$executeRaw(Prisma.sql`
        with selected as (
          select id
          from public.import_pages
          where organization_id = cast(${execution.organization_id} as uuid)
            and source_instance_id is not null
            and (
              payload_json is not null
              or protected_raw_response is not null
            )
            and expires_at <= ${execution.started_at}
          order by expires_at, id
          limit ${execution.batch_size}
          for update skip locked
        )
        update public.import_pages as page
        set payload_json = null,
            protected_raw_response = null,
            payload_expired_at = ${completedAt}
        from selected
        where page.id = selected.id
      `);
    }
    if (phase === "diagnostics") {
      return transaction.$executeRaw(Prisma.sql`
        delete from public.source_processor_diagnostic_events
        where id in (
          select id
          from public.source_processor_diagnostic_events
          where organization_id = cast(${execution.organization_id} as uuid)
            and expires_at <= ${execution.started_at}
          order by expires_at, id
          limit ${execution.batch_size}
          for update skip locked
        )
      `);
    }
    if (phase === "quarantines") {
      // Legacy quarantines without a delivery occurrence share this guarded
      // sweep, so pre-occurrence rows drain instead of sitting open forever.
      // Rows with a running retry are deferred; only open rows flip to
      // expired, while retained payloads are scrubbed regardless of state.
      return transaction.$executeRaw(Prisma.sql`
        with selected as (
          select quarantine.id
          from public.quarantine_records as quarantine
          where quarantine.organization_id = cast(${execution.organization_id} as uuid)
            and quarantine.payload_json is not null
            and quarantine.expires_at <= ${execution.started_at}
            and not exists (
              select 1
              from public.quarantine_attempts as attempts
              where attempts.organization_id = quarantine.organization_id
                and attempts.quarantine_id = quarantine.id
                and attempts.state = 'running'::public.quarantine_attempt_state
            )
          order by quarantine.expires_at, quarantine.id
          limit ${execution.batch_size}
          for update of quarantine skip locked
        )
        update public.quarantine_records as quarantine
        set payload_json = null,
            payload_expired_at = ${completedAt},
            state = case
              when quarantine.state = 'open'::public.quarantine_state
                then 'expired'::public.quarantine_state
              else quarantine.state
            end
        from selected
        where quarantine.id = selected.id
      `);
    }
    if (phase === "compact_attempts") {
      const compactable = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        select id
        from public.source_request_attempts
        where organization_id = cast(${execution.organization_id} as uuid)
          and state <> 'in_flight'
          and expires_at <= ${execution.started_at}
          and compacted_at is null
          and exists (
            select 1
            from public.compact_source_request_attempts lineage
            where lineage.request_attempt_id = source_request_attempts.id
          )
        order by expires_at, id
        limit ${execution.batch_size}
        for update skip locked
      `);
      const ids = compactable.map(({ id }) => id);
      if (ids.length > 0) {
        await transaction.source_request_attempts.updateMany({
          where: { id: { in: ids }, organization_id: execution.organization_id },
          data: { compacted_at: completedAt },
        });
        await transaction.compact_source_request_attempts.updateMany({
          where: { request_attempt_id: { in: ids }, organization_id: execution.organization_id },
          data: { compacted_at: completedAt },
        });
      }
      return ids.length;
    }
    return transaction.$executeRaw(Prisma.sql`
      delete from public.source_request_attempts as attempt
      where attempt.id in (
        select candidate.id
        from public.source_request_attempts as candidate
        where candidate.organization_id = cast(${execution.organization_id} as uuid)
          and candidate.compacted_at is not null
          and candidate.expires_at <= ${execution.started_at}
        order by candidate.expires_at, candidate.id
        limit ${execution.batch_size}
        for update skip locked
      )
    `);
  }
}
