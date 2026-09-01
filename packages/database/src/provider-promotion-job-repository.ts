import { Prisma as ProviderPrisma } from
  "../prisma/generated/provider/index.js";
import type {
  ProviderPrismaClient,
  ProviderQueryClient,
  ProviderTransactionClient,
} from "./provider-database.ts";
import type {
  ActivatePromotionJobScheduleInput,
  BeginPromotionJobInvocationInput,
  PausePromotionJobScheduleInput,
  PromotionJobAdmission,
  PromotionJobInvocation,
  PromotionJobPruneResult,
  PromotionJobSchedule,
  PromotionWakeDeliveryState,
  PromotionWakeIntent,
  ProviderPromotionWakeCause,
  ReconcileInterruptedPromotionJobInvocationInput,
  RecordPromotionJobProgressInput,
  TerminalizePromotionJobInvocationInput,
} from "./promotion-job-persistence-types.ts";
import {
  PROVIDER_PROMOTION_JOB_STORE_CONFIGURATION,
  SplitPromotionJobStore,
  type PromotionJobSqlClient,
} from "./split-promotion-job-store.ts";

const TRANSACTION = Object.freeze({
  maxWait: 5_000,
  timeout: 30_000,
  isolationLevel: ProviderPrisma.TransactionIsolationLevel.ReadCommitted,
});

function sqlClient(client: ProviderQueryClient): PromotionJobSqlClient {
  return {
    query: async <T>(statement: import("@prisma/client").Prisma.Sql) =>
      client.$queryRaw<T[]>(statement as ProviderPrisma.Sql),
    execute: async (statement: import("@prisma/client").Prisma.Sql) =>
      client.$executeRaw(statement as ProviderPrisma.Sql),
  };
}

/**
 * Durable admission ledger for the one publication job in this physical
 * provider database. No caller-selected provider or database identity exists.
 */
export class PrismaProviderPromotionJobRepository {
  readonly #store = new SplitPromotionJobStore(
    PROVIDER_PROMOTION_JOB_STORE_CONFIGURATION,
  );

  constructor(private readonly provider: ProviderPrismaClient) {}

  loadWakeIntent(): Promise<PromotionWakeIntent> {
    return this.#store.loadWakeIntent(sqlClient(this.provider));
  }

  coalesceWake(input: Readonly<{
    requestedGeneration: bigint;
    cause: ProviderPromotionWakeCause;
    requestedAt: Date;
  }>, transaction?: ProviderTransactionClient): Promise<PromotionWakeIntent> {
    return this.#store.coalesceWake(
      sqlClient(transaction ?? this.provider),
      input,
    );
  }

  recordWakeDelivery(input: Readonly<{
    generation: bigint;
    state: PromotionWakeDeliveryState;
    attemptedAt: Date;
    safeFailureCode?: string | null;
  }>): Promise<PromotionWakeIntent> {
    return this.provider.$transaction((transaction) =>
      this.#store.recordWakeDelivery(sqlClient(transaction), input),
    TRANSACTION);
  }

  loadSchedule(): Promise<PromotionJobSchedule> {
    return this.#store.loadSchedule(sqlClient(this.provider));
  }

  activateSchedule(
    input: ActivatePromotionJobScheduleInput,
  ): Promise<PromotionJobSchedule> {
    return this.provider.$transaction((transaction) =>
      this.#store.activateSchedule(sqlClient(transaction), input),
    TRANSACTION);
  }

  pauseSchedule(
    input: PausePromotionJobScheduleInput,
  ): Promise<PromotionJobSchedule> {
    return this.provider.$transaction((transaction) =>
      this.#store.pauseSchedule(sqlClient(transaction), input),
    TRANSACTION);
  }

  beginOrRecoverInvocation(
    input: BeginPromotionJobInvocationInput,
  ): Promise<PromotionJobAdmission> {
    return this.provider.$transaction((transaction) =>
      this.#store.beginOrRecoverInvocation(sqlClient(transaction), input),
    TRANSACTION);
  }

  recordProgress(
    input: RecordPromotionJobProgressInput,
  ): Promise<PromotionJobInvocation> {
    return this.provider.$transaction((transaction) =>
      this.#store.recordProgress(sqlClient(transaction), input),
    TRANSACTION);
  }

  terminalize(
    input: TerminalizePromotionJobInvocationInput,
  ): Promise<PromotionJobInvocation> {
    return this.provider.$transaction((transaction) =>
      this.#store.terminalize(sqlClient(transaction), input),
    TRANSACTION);
  }

  reconcileInterrupted(
    input: ReconcileInterruptedPromotionJobInvocationInput,
  ): Promise<PromotionJobInvocation> {
    return this.provider.$transaction((transaction) =>
      this.#store.reconcileInterrupted(sqlClient(transaction), input),
    TRANSACTION);
  }

  loadInvocation(
    runId: string,
    options: Readonly<{ includeAttempts?: boolean }> = {},
  ): Promise<PromotionJobInvocation | null> {
    return this.#store.loadInvocation(
      sqlClient(this.provider),
      runId,
      options.includeAttempts ?? false,
    );
  }

  releaseRetentionProtection(input: Readonly<{
    runId: string;
    releasedAt: Date;
    expectedRelatedAttemptSetDigest: string;
    validateRelease: (
      transaction: ProviderTransactionClient,
      relatedAttemptSetDigest: string,
    ) => Promise<void>;
  }>): Promise<boolean> {
    return this.provider.$transaction((transaction) =>
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
    return this.provider.$transaction((transaction) =>
      this.#store.prune(sqlClient(transaction), input),
    TRANSACTION);
  }
}
