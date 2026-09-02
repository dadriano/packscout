import { Prisma as CentralPrisma } from
  "../prisma/generated/central/index.js";
import type {
  CentralPrismaClient,
  CentralQueryClient,
  CentralTransactionClient,
} from "./central-database.ts";
import {
  PROMOTION_JOB_INVOCATION_LIMIT,
  PROMOTION_JOB_INVOCATION_RETENTION_MS,
  PromotionJobPersistenceError,
  validDate,
  type ActivatePromotionJobScheduleInput,
  type BeginPromotionJobInvocationInput,
  type ManifestReconciliationWakeCause,
  type PausePromotionJobScheduleInput,
  type PromotionJobAdmission,
  type PromotionJobInvocation,
  type PromotionJobPruneResult,
  type PromotionJobSchedule,
  type PromotionWakeDeliveryState,
  type PromotionWakeIntent,
  type ReconcileExpiredPromotionJobInvocationsInput,
  type ReconcileExpiredPromotionJobInvocationsResult,
  type ReconcileInterruptedPromotionJobInvocationInput,
  type RecordPromotionJobProgressInput,
  type TerminalizePromotionJobInvocationInput,
} from "./promotion-job-persistence-types.ts";
import {
  MANIFEST_PROMOTION_JOB_STORE_CONFIGURATION,
  SplitPromotionJobStore,
  type PromotionJobSqlClient,
} from "./split-promotion-job-store.ts";

const TRANSACTION = Object.freeze({
  maxWait: 5_000,
  timeout: 30_000,
  isolationLevel: CentralPrisma.TransactionIsolationLevel.ReadCommitted,
});

interface PromotionJobTransactionDeadline {
  readonly deadlineAt: number;
}

function transactionOptions(
  deadline?: PromotionJobTransactionDeadline,
) {
  if (deadline === undefined) return TRANSACTION;
  const available = Math.floor(deadline.deadlineAt - Date.now() - 50);
  const maxWait = Math.min(TRANSACTION.maxWait, Math.max(1, Math.floor(available / 5)));
  const timeout = Math.min(TRANSACTION.timeout, available - maxWait);
  if (timeout < 1) {
    throw new PromotionJobPersistenceError("PROMOTION_JOB_DEADLINE_EXCEEDED");
  }
  return { ...TRANSACTION, maxWait, timeout };
}

interface ProtectedRetentionCandidate {
  readonly runId: string;
  readonly relatedAttemptSetDigest: string;
}

function sqlClient(client: CentralQueryClient): PromotionJobSqlClient {
  return {
    query: async <T>(statement: import("@prisma/client").Prisma.Sql) =>
      client.$queryRaw<T[]>(statement as CentralPrisma.Sql),
    execute: async (statement: import("@prisma/client").Prisma.Sql) =>
      client.$executeRaw(statement as CentralPrisma.Sql),
  };
}

/** Central-only durable admission ledger for manifest reconciliation. */
export class PrismaManifestReconciliationJobRepository {
  readonly #store = new SplitPromotionJobStore(
    MANIFEST_PROMOTION_JOB_STORE_CONFIGURATION,
  );

  constructor(private readonly central: CentralPrismaClient) {}

  loadWakeIntent(
    transaction?: CentralTransactionClient,
  ): Promise<PromotionWakeIntent> {
    return this.#store.loadWakeIntent(sqlClient(transaction ?? this.central));
  }

  coalesceWake(input: Readonly<{
    requestedGeneration: bigint;
    cause: ManifestReconciliationWakeCause;
    requestedAt: Date;
  }>, transaction?: CentralTransactionClient): Promise<PromotionWakeIntent> {
    return this.#store.coalesceWake(
      sqlClient(transaction ?? this.central),
      input,
    );
  }

  requestNextWake(input: Readonly<{
    cause: ManifestReconciliationWakeCause;
    requestedAt: Date;
  }>, transaction?: CentralTransactionClient): Promise<PromotionWakeIntent> {
    if (transaction !== undefined) {
      return this.#store.requestNextWake(sqlClient(transaction), input);
    }
    return this.central.$transaction((centralTransaction) =>
      this.#store.requestNextWake(sqlClient(centralTransaction), input),
    TRANSACTION);
  }

  recordWakeDelivery(input: Readonly<{
    generation: bigint;
    state: PromotionWakeDeliveryState;
    attemptedAt: Date;
    safeFailureCode?: string | null;
  }>): Promise<PromotionWakeIntent> {
    return this.central.$transaction((transaction) =>
      this.#store.recordWakeDelivery(sqlClient(transaction), input),
    TRANSACTION);
  }

  loadSchedule(): Promise<PromotionJobSchedule> {
    return this.#store.loadSchedule(sqlClient(this.central));
  }

  activateSchedule(
    input: ActivatePromotionJobScheduleInput,
  ): Promise<PromotionJobSchedule> {
    return this.central.$transaction((transaction) =>
      this.#store.activateSchedule(sqlClient(transaction), input),
    TRANSACTION);
  }

  pauseSchedule(
    input: PausePromotionJobScheduleInput,
  ): Promise<PromotionJobSchedule> {
    return this.central.$transaction((transaction) =>
      this.#store.pauseSchedule(sqlClient(transaction), input),
    TRANSACTION);
  }

  beginOrRecoverInvocation(
    input: BeginPromotionJobInvocationInput,
    deadline?: PromotionJobTransactionDeadline,
  ): Promise<PromotionJobAdmission> {
    return this.central.$transaction((transaction) =>
      this.#store.beginOrRecoverInvocation(sqlClient(transaction), input),
    transactionOptions(deadline));
  }

  recordProgress(
    input: RecordPromotionJobProgressInput,
    deadline?: PromotionJobTransactionDeadline,
  ): Promise<PromotionJobInvocation> {
    return this.central.$transaction((transaction) =>
      this.#store.recordProgress(sqlClient(transaction), input),
    transactionOptions(deadline));
  }

  terminalize(
    input: TerminalizePromotionJobInvocationInput,
    deadline?: PromotionJobTransactionDeadline,
  ): Promise<PromotionJobInvocation> {
    return this.central.$transaction((transaction) =>
      this.#store.terminalize(sqlClient(transaction), input),
    transactionOptions(deadline));
  }

  reconcileInterrupted(
    input: ReconcileInterruptedPromotionJobInvocationInput,
    deadline?: PromotionJobTransactionDeadline,
  ): Promise<PromotionJobInvocation> {
    return this.central.$transaction((transaction) =>
      this.#store.reconcileInterrupted(sqlClient(transaction), input),
    transactionOptions(deadline));
  }

  reconcileExpiredInvocations(
    input: ReconcileExpiredPromotionJobInvocationsInput,
    deadline?: PromotionJobTransactionDeadline,
  ): Promise<ReconcileExpiredPromotionJobInvocationsResult> {
    return this.central.$transaction(async (transaction) => {
      const result = await this.#store.reconcileExpiredInvocations(
        sqlClient(transaction),
        {
          ...input,
          safeFailureCode: "MANIFEST_RECONCILIATION_INTERRUPTED",
        },
      );
      return {
        reconciled: result.invocations.length,
        moreEligible: result.moreEligible,
      };
    }, transactionOptions(deadline));
  }

  loadInvocation(
    runId: string,
    options: Readonly<{ includeAttempts?: boolean }> = {},
  ): Promise<PromotionJobInvocation | null> {
    return this.#store.loadInvocation(
      sqlClient(this.central),
      runId,
      options.includeAttempts ?? false,
    );
  }

  releaseRetentionProtection(input: Readonly<{
    runId: string;
    releasedAt: Date;
    expectedRelatedAttemptSetDigest: string;
    validateRelease: (
      transaction: CentralTransactionClient,
      relatedAttemptSetDigest: string,
    ) => Promise<void>;
  }>): Promise<boolean> {
    return this.central.$transaction((transaction) =>
      this.#store.releaseRetentionProtection(
        sqlClient(transaction),
        input,
        (digest) => input.validateRelease(transaction, digest),
      ),
    TRANSACTION);
  }

  /**
   * Releases only terminal history that is already eligible for the bounded
   * invocation-retention policy. Manifest mutation requests and receipts live
   * in separate immutable tables, so this validates the compact detail before
   * allowing the monitoring copy to age out.
   */
  releasePrunableRetentionProtection(input: Readonly<{
    now: Date;
    maximumRows?: number;
  }>): Promise<Readonly<{ released: number; moreEligible: boolean }>> {
    const maximumRows = input.maximumRows ?? 100;
    if (
      !validDate(input.now) || !Number.isSafeInteger(maximumRows) ||
      maximumRows < 1 || maximumRows > 1_000
    ) {
      return Promise.reject(new PromotionJobPersistenceError(
        "PROMOTION_JOB_INPUT_INVALID",
      ));
    }
    const cutoff = new Date(
      input.now.getTime() - PROMOTION_JOB_INVOCATION_RETENTION_MS,
    );
    return this.central.$transaction(async (transaction) => {
      const candidates = await transaction.$queryRaw<
        ProtectedRetentionCandidate[]
      >(CentralPrisma.sql`
        with retained_boundary as (
          select finished_at, run_id
          from public.manifest_reconciliation_job_invocations
          where lifecycle_state = 'terminal'
          order by finished_at desc, run_id desc
          offset ${PROMOTION_JOB_INVOCATION_LIMIT - 1}
          limit 1
        )
        select invocation.run_id::text as "runId",
          invocation.related_attempt_set_digest as "relatedAttemptSetDigest"
        from public.manifest_reconciliation_job_invocations invocation
        left join retained_boundary boundary on true
        where invocation.lifecycle_state = 'terminal'
          and invocation.retention_protected = true
          and (
            invocation.finished_at <= ${cutoff}
            or (
              boundary.run_id is not null
              and (invocation.finished_at, invocation.run_id) <
                (boundary.finished_at, boundary.run_id)
            )
          )
        order by invocation.finished_at, invocation.run_id
        limit ${maximumRows + 1}
        for update of invocation skip locked
      `);
      let released = 0;
      for (const candidate of candidates.slice(0, maximumRows)) {
        const changed = await this.#store.releaseRetentionProtection(
          sqlClient(transaction),
          {
            runId: candidate.runId,
            releasedAt: input.now,
            expectedRelatedAttemptSetDigest:
              candidate.relatedAttemptSetDigest,
          },
          async (digest) => {
            const invocation = await this.#store.loadInvocation(
              sqlClient(transaction),
              candidate.runId,
              true,
            );
            if (
              invocation === null || invocation.lifecycleState !== "terminal" ||
              invocation.relatedAttemptSetDigest !== digest ||
              invocation.attemptSnapshots === undefined
            ) {
              throw new PromotionJobPersistenceError(
                "PROMOTION_JOB_ATTEMPT_CONFLICT",
              );
            }
          },
        );
        if (changed) released += 1;
      }
      return {
        released,
        moreEligible: candidates.length > maximumRows,
      };
    }, TRANSACTION);
  }

  prune(input: Readonly<{
    now: Date;
    maximumRows?: number;
  }>): Promise<PromotionJobPruneResult> {
    return this.central.$transaction((transaction) =>
      this.#store.prune(sqlClient(transaction), input),
    TRANSACTION);
  }
}
