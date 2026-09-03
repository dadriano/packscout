import { Prisma as ProviderPrisma } from
  "../prisma/generated/provider/index.js";
import type {
  ProviderPrismaClient,
  ProviderTransactionClient,
} from "./provider-database.ts";
import {
  providerPromotionInvocationProjectionRecord,
  type ProjectProviderPromotionInvocationInput,
  type ProviderPromotionInvocationProjection,
} from "./central-promotion-job-records.ts";
import {
  assertProviderPromotionInvocationTerminalActivity,
  type ProviderActivityEvent,
} from "./provider-activity-contract.ts";
import { appendProviderActivityOutbox } from "./provider-local-evidence.ts";
import {
  PromotionJobPersistenceError,
  PROMOTION_JOB_INVOCATION_RETENTION_MS,
  type ActivatePromotionJobScheduleInput,
  type BeginPromotionJobInvocationInput,
  type PausePromotionJobScheduleInput,
  type PromotionJobAdmission,
  type PromotionJobInvocation,
  type PromotionJobPruneResult,
  type PromotionJobSchedule,
  type PromotionWakeDeliveryState,
  type PromotionWakeIntent,
  type ProviderPromotionWakeCause,
  type ReconcileExpiredPromotionJobInvocationsInput,
  type ReconcileExpiredPromotionJobInvocationsResult,
  type ReconcileInterruptedPromotionJobInvocationInput,
  type RecordPromotionJobProgressInput,
  type TerminalizePromotionJobInvocationInput,
} from "./promotion-job-persistence-types.ts";
import {
  PROVIDER_PROMOTION_JOB_STORE_CONFIGURATION,
  SplitPromotionJobStore,
} from "./split-promotion-job-store.ts";
import { providerPromotionJobSqlClient as sqlClient } from
  "./promotion-job-sql-client.ts";

const TRANSACTION = Object.freeze({
  maxWait: 5_000,
  timeout: 30_000,
  isolationLevel: ProviderPrisma.TransactionIsolationLevel.ReadCommitted,
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

function projectionInput(
  providerId: string,
  invocation: PromotionJobInvocation,
  projectedAt: Date,
): ProjectProviderPromotionInvocationInput {
  if (
    invocation.authority !== "provider_publication"
    || invocation.lifecycleState !== "terminal"
    || invocation.outcome === null
    || invocation.finishedAt === null
    || invocation.attemptSnapshots === undefined
  ) throw new PromotionJobPersistenceError("PROMOTION_JOB_PROJECTION_CONFLICT");
  return {
    providerId,
    opaqueProviderInvocationId: invocation.runId,
    triggerKind: invocation.trigger.kind,
    outcome: invocation.outcome,
    scheduledCheckinAt: invocation.scheduledCheckinAt,
    startedAt: invocation.startedAt,
    finishedAt: invocation.finishedAt,
    progress: invocation.progress,
    safeFailureCode: invocation.safeFailureCode,
    attempts: invocation.attemptSnapshots,
    projectedAt,
  };
}

export type ProviderPromotionProjectionRelayReceipt = Pick<
  ProviderPromotionInvocationProjection,
  "providerInvocationIdDigest" | "projectionDigest"
>;

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
    deadline?: PromotionJobTransactionDeadline,
  ): Promise<PromotionJobAdmission> {
    return this.provider.$transaction((transaction) =>
      this.#store.beginOrRecoverInvocation(sqlClient(transaction), input),
    transactionOptions(deadline));
  }

  recordProgress(
    input: RecordPromotionJobProgressInput,
    deadline?: PromotionJobTransactionDeadline,
  ): Promise<PromotionJobInvocation> {
    return this.provider.$transaction((transaction) =>
      this.#store.recordProgress(sqlClient(transaction), input),
    transactionOptions(deadline));
  }

  terminalize(
    input: TerminalizePromotionJobInvocationInput,
    deadline?: PromotionJobTransactionDeadline,
  ): Promise<PromotionJobInvocation> {
    return this.provider.$transaction(async (transaction) => {
      const invocation = await this.#store.terminalize(
        sqlClient(transaction),
        { ...input, retentionProtected: true },
      );
      await this.#ensureProjectionOutbox(transaction, invocation);
      return invocation;
    }, transactionOptions(deadline));
  }

  reconcileInterrupted(
    input: ReconcileInterruptedPromotionJobInvocationInput,
    deadline?: PromotionJobTransactionDeadline,
  ): Promise<PromotionJobInvocation> {
    return this.provider.$transaction(async (transaction) => {
      const invocation = await this.#store.reconcileInterrupted(
        sqlClient(transaction),
        { ...input, retentionProtected: true },
      );
      await this.#ensureProjectionOutbox(transaction, invocation);
      return invocation;
    }, transactionOptions(deadline));
  }

  reconcileExpiredInvocations(
    input: ReconcileExpiredPromotionJobInvocationsInput,
    deadline?: PromotionJobTransactionDeadline,
  ): Promise<ReconcileExpiredPromotionJobInvocationsResult> {
    return this.provider.$transaction(async (transaction) => {
      const result = await this.#store.reconcileExpiredInvocations(
        sqlClient(transaction),
        {
          ...input,
          safeFailureCode: "PROVIDER_PROMOTION_INTERRUPTED",
        },
      );
      for (const invocation of result.invocations) {
        await this.#ensureProjectionOutbox(transaction, invocation);
      }
      return {
        reconciled: result.invocations.length,
        moreEligible: result.moreEligible,
      };
    }, transactionOptions(deadline));
  }

  /** Resolves one opaque relay event to its immutable provider-local detail. */
  async loadProjectionForRelay(input: Readonly<{
    providerId: string;
    event: ProviderActivityEvent;
    projectedAt: Date;
  }>): Promise<ProjectProviderPromotionInvocationInput> {
    const evidence = assertProviderPromotionInvocationTerminalActivity(
      input.event,
    );
    const [identity, mapping] = await Promise.all([
      this.provider.database_identity.findUniqueOrThrow({
        where: { singleton_key: true },
        select: { provider_id: true },
      }),
      this.provider.provider_promotion_projection_outbox.findUnique({
        where: { activity_event_id: input.event.id },
      }),
    ]);
    if (
      identity.provider_id.toLowerCase() !== input.providerId.toLowerCase()
      || mapping === null
      || mapping.provider_invocation_id_digest !==
        evidence.providerInvocationIdDigest
      || mapping.provider_invocation_projection_digest !==
        evidence.providerInvocationProjectionDigest
    ) throw new PromotionJobPersistenceError("PROMOTION_JOB_PROJECTION_CONFLICT");
    const invocation = await this.#store.loadInvocation(
      sqlClient(this.provider),
      mapping.invocation_run_id,
      true,
    );
    if (invocation === null) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_PROJECTION_CONFLICT");
    }
    const projectedAt = invocation.finishedAt !== null
      && input.projectedAt.getTime() < invocation.finishedAt.getTime()
      ? invocation.finishedAt
      : input.projectedAt;
    const projected = projectionInput(
      identity.provider_id,
      invocation,
      projectedAt,
    );
    const record = providerPromotionInvocationProjectionRecord(projected);
    if (
      record.providerInvocationIdDigest !==
        mapping.provider_invocation_id_digest
      || record.projectionDigest !==
        mapping.provider_invocation_projection_digest
    ) throw new PromotionJobPersistenceError("PROMOTION_JOB_PROJECTION_CONFLICT");
    return projected;
  }

  /**
   * Acknowledges central projection and releases local retention protection in
   * the same provider transaction. A lost acknowledgement safely replays.
   */
  async acknowledgeProjectionDelivery(input: Readonly<{
    providerId: string;
    event: ProviderActivityEvent;
    projected: ProviderPromotionProjectionRelayReceipt;
    deliveredAt: Date;
  }>): Promise<"delivered" | "already_delivered"> {
    const evidence = assertProviderPromotionInvocationTerminalActivity(
      input.event,
    );
    return this.provider.$transaction(async (transaction) => {
      const [identity, mapping, storedEvent] = await Promise.all([
        transaction.database_identity.findUniqueOrThrow({
          where: { singleton_key: true },
          select: { provider_id: true },
        }),
        transaction.provider_promotion_projection_outbox.findUnique({
          where: { activity_event_id: input.event.id },
        }),
        transaction.provider_activity_outbox.findUnique({
          where: { id: input.event.id },
          select: { event_digest: true, delivery_state: true },
        }),
      ]);
      if (
        identity.provider_id.toLowerCase() !== input.providerId.toLowerCase()
        || mapping === null
        || storedEvent === null
        || storedEvent.event_digest !== input.event.eventDigest
        || mapping.provider_invocation_id_digest !==
          evidence.providerInvocationIdDigest
        || mapping.provider_invocation_projection_digest !==
          evidence.providerInvocationProjectionDigest
        || input.projected.providerInvocationIdDigest !==
          mapping.provider_invocation_id_digest
        || input.projected.projectionDigest !==
          mapping.provider_invocation_projection_digest
      ) throw new PromotionJobPersistenceError("PROMOTION_JOB_PROJECTION_CONFLICT");
      const invocation = await this.#store.loadInvocation(
        sqlClient(transaction),
        mapping.invocation_run_id,
        true,
      );
      if (invocation === null) {
        throw new PromotionJobPersistenceError("PROMOTION_JOB_PROJECTION_CONFLICT");
      }
      const projectedAt = invocation.finishedAt !== null
        && input.deliveredAt.getTime() < invocation.finishedAt.getTime()
        ? invocation.finishedAt
        : input.deliveredAt;
      const record = providerPromotionInvocationProjectionRecord(
        projectionInput(identity.provider_id, invocation, projectedAt),
      );
      if (
        record.providerInvocationIdDigest !==
          input.projected.providerInvocationIdDigest
        || record.projectionDigest !== input.projected.projectionDigest
      ) throw new PromotionJobPersistenceError("PROMOTION_JOB_PROJECTION_CONFLICT");
      let deliveryResult: "delivered" | "already_delivered" =
        storedEvent.delivery_state === "delivered"
          ? "already_delivered"
          : "delivered";
      if (storedEvent.delivery_state === "pending") {
        const updated = await transaction.provider_activity_outbox.updateMany({
          where: {
            id: input.event.id,
            event_digest: input.event.eventDigest,
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
        if (updated.count !== 1) {
          const concurrentlyDelivered =
            await transaction.provider_activity_outbox.findUnique({
              where: { id: input.event.id },
              select: { event_digest: true, delivery_state: true },
            });
          if (
            concurrentlyDelivered === null
            || concurrentlyDelivered.event_digest !== input.event.eventDigest
            || concurrentlyDelivered.delivery_state !== "delivered"
          ) {
            throw new PromotionJobPersistenceError(
              "PROMOTION_JOB_PROJECTION_CONFLICT",
            );
          }
          deliveryResult = "already_delivered";
        }
      } else if (storedEvent.delivery_state !== "delivered") {
        throw new PromotionJobPersistenceError(
          "PROMOTION_JOB_PROJECTION_CONFLICT",
        );
      }
      await this.#store.releaseRetentionProtection(
        sqlClient(transaction),
        {
          runId: invocation.runId,
          releasedAt: input.deliveredAt,
          expectedRelatedAttemptSetDigest:
            invocation.relatedAttemptSetDigest,
        },
        async (digest) => {
          if (digest !== invocation.relatedAttemptSetDigest) {
            throw new PromotionJobPersistenceError(
              "PROMOTION_JOB_ATTEMPT_CONFLICT",
            );
          }
        },
      );
      return deliveryResult;
    }, TRANSACTION);
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

  prune(input: Readonly<{
    now: Date;
    maximumRows?: number;
  }>): Promise<PromotionJobPruneResult> {
    return this.provider.$transaction(async (transaction) => {
      const pruned = await this.#store.prune(sqlClient(transaction), input);
      const maximumRows = input.maximumRows ?? 1_000;
      const cutoff = new Date(
        input.now.getTime() - PROMOTION_JOB_INVOCATION_RETENTION_MS,
      );
      await transaction.$queryRaw<Array<{ id: string }>>(ProviderPrisma.sql`
        delete from provider_activity_outbox as event
        where event.ctid in (
          select candidate.ctid
          from provider_activity_outbox as candidate
          where candidate.event_type =
              'provider_promotion_invocation_terminal'
            and candidate.delivery_state = 'delivered'
            and candidate.event_at <= ${cutoff}
            and not exists (
              select 1 from provider_promotion_projection_outbox as mapping
              where mapping.activity_event_id = candidate.id
            )
          order by candidate.event_at, candidate.id
          limit ${maximumRows}
        )
        returning event.id::text as id
      `);
      return pruned;
    }, TRANSACTION);
  }

  async #ensureProjectionOutbox(
    transaction: ProviderTransactionClient,
    terminal: PromotionJobInvocation,
  ): Promise<void> {
    const identity = await transaction.database_identity.findUniqueOrThrow({
      where: { singleton_key: true },
      select: { provider_id: true },
    });
    const invocation = await this.#store.loadInvocation(
      sqlClient(transaction),
      terminal.runId,
      true,
    );
    if (invocation === null || invocation.finishedAt === null) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_PROJECTION_CONFLICT");
    }
    const record = providerPromotionInvocationProjectionRecord(
      projectionInput(identity.provider_id, invocation, invocation.finishedAt),
    );
    const existing = await transaction.provider_promotion_projection_outbox
      .findUnique({ where: { invocation_run_id: invocation.runId } });
    if (existing !== null) {
      if (
        existing.provider_invocation_id_digest !==
          record.providerInvocationIdDigest
        || existing.provider_invocation_projection_digest !==
          record.projectionDigest
      ) throw new PromotionJobPersistenceError(
        "PROMOTION_JOB_PROJECTION_CONFLICT",
      );
      return;
    }
    const activityEventId = await appendProviderActivityOutbox(transaction, {
      eventType: "provider_promotion_invocation_terminal",
      severity: "info",
      dedupeKey:
        `provider-promotion-invocation:${record.providerInvocationIdDigest}`,
      recoveryKey:
        `provider-promotion-invocation:${record.providerInvocationIdDigest}`,
      title: "Provider promotion job finished",
      summary: "A provider promotion invocation reached a terminal state.",
      evidence: {
        providerInvocationIdDigest: record.providerInvocationIdDigest,
        providerInvocationProjectionDigest: record.projectionDigest,
      },
      eventAt: invocation.finishedAt,
    });
    await transaction.provider_promotion_projection_outbox.create({
      data: {
        activity_event_id: activityEventId,
        invocation_run_id: invocation.runId,
        provider_invocation_id_digest: record.providerInvocationIdDigest,
        provider_invocation_projection_digest: record.projectionDigest,
        created_at: invocation.finishedAt,
      },
    });
  }
}
