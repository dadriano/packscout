import { Prisma as CentralPrisma } from
  "../prisma/generated/central/index.js";
import type {
  CentralPrismaClient,
  CentralQueryClient,
  CentralTransactionClient,
} from "./central-database.ts";
import type {
  ActivatePromotionJobScheduleInput,
  BeginPromotionJobInvocationInput,
  ManifestReconciliationWakeCause,
  PausePromotionJobScheduleInput,
  PromotionJobAdmission,
  PromotionJobInvocation,
  PromotionJobPruneResult,
  PromotionJobSchedule,
  PromotionWakeDeliveryState,
  PromotionWakeIntent,
  ReconcileInterruptedPromotionJobInvocationInput,
  RecordPromotionJobProgressInput,
  TerminalizePromotionJobInvocationInput,
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
  ): Promise<PromotionJobAdmission> {
    return this.central.$transaction((transaction) =>
      this.#store.beginOrRecoverInvocation(sqlClient(transaction), input),
    TRANSACTION);
  }

  recordProgress(
    input: RecordPromotionJobProgressInput,
  ): Promise<PromotionJobInvocation> {
    return this.central.$transaction((transaction) =>
      this.#store.recordProgress(sqlClient(transaction), input),
    TRANSACTION);
  }

  terminalize(
    input: TerminalizePromotionJobInvocationInput,
  ): Promise<PromotionJobInvocation> {
    return this.central.$transaction((transaction) =>
      this.#store.terminalize(sqlClient(transaction), input),
    TRANSACTION);
  }

  reconcileInterrupted(
    input: ReconcileInterruptedPromotionJobInvocationInput,
  ): Promise<PromotionJobInvocation> {
    return this.central.$transaction((transaction) =>
      this.#store.reconcileInterrupted(sqlClient(transaction), input),
    TRANSACTION);
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

  prune(input: Readonly<{
    now: Date;
    maximumRows?: number;
  }>): Promise<PromotionJobPruneResult> {
    return this.central.$transaction((transaction) =>
      this.#store.prune(sqlClient(transaction), input),
    TRANSACTION);
  }
}
