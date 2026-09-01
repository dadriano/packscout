import { Prisma } from "@prisma/client";
import {
  EMPTY_PROMOTION_ATTEMPT_SET_DIGEST,
  PROMOTION_JOB_INVOCATION_LIMIT,
  PROMOTION_JOB_INVOCATION_RETENTION_MS,
  PROMOTION_JOB_SCHEDULE_CADENCE_SECONDS,
  PromotionJobPersistenceError,
  assertDeliveryEnvelope,
  assertOwnership,
  assertProgress,
  assertPromotionJobSha256,
  assertPromotionJobUuid,
  assertSafeFailureCode,
  assertTrigger,
  canonicalPromotionAttemptDetail,
  normalizePromotionAttemptSnapshots,
  promotionAttemptSetDigest,
  promotionJobDeliveryDigest,
  promotionJobSha256,
  promotionJobTriggerEvidenceDigest,
  validDate,
  type ActivatePromotionJobScheduleInput,
  type BeginPromotionJobInvocationInput,
  type PausePromotionJobScheduleInput,
  type PromotionInvocationAttemptSnapshot,
  type PromotionInvocationOperationSummary,
  type PromotionInvocationTrigger,
  type PromotionInvocationTriggerRequest,
  type PromotionJobAdmission,
  type PromotionJobAuthority,
  type PromotionJobInvocation,
  type PromotionJobOutcome,
  type PromotionJobProgress,
  type PromotionJobPruneResult,
  type PromotionJobSchedule,
  type PromotionWakeCause,
  type PromotionWakeDeliveryState,
  type PromotionWakeIntent,
  type ReconcileInterruptedPromotionJobInvocationInput,
  type RecordPromotionJobProgressInput,
  type TerminalizePromotionJobInvocationInput,
} from "./promotion-job-persistence-types.ts";

export interface PromotionJobSqlClient {
  query<T>(statement: Prisma.Sql): Promise<T[]>;
  execute(statement: Prisma.Sql): Promise<number>;
}

interface StoreConfiguration {
  readonly authority: PromotionJobAuthority;
  readonly wakeTable: string;
  readonly scheduleTable: string;
  readonly invocationTable: string;
  readonly tombstoneTable: string;
  readonly detailTable: string;
  readonly attemptKind: "provider" | "manifest";
  readonly wakeCauses: ReadonlySet<PromotionWakeCause>;
  readonly storesManifestResult: boolean;
}

interface WakeRow {
  requestedGeneration: bigint;
  acknowledgedGeneration: bigint;
  latestCause: PromotionWakeCause | null;
  latestRequestedAt: Date | null;
  latestDeliveryGeneration: bigint | null;
  latestDeliveryState: PromotionWakeDeliveryState | null;
  lastDeliveryAttemptAt: Date | null;
  latestDeliveryFailureCode: string | null;
}

interface ScheduleRow {
  lifecycle: "pending_activation" | "active" | "paused";
  scheduleEpoch: bigint;
  cadenceSeconds: number;
  baselineAt: Date | null;
  activatedAt: Date | null;
  pausedAt: Date | null;
  lastAdmittedWindowIndex: bigint | null;
  lastScheduledCheckinAt: Date | null;
  nextExpectedCheckinAt: Date | null;
}

interface InvocationRow {
  runId: string;
  deliveryKeyDigest: string;
  triggerKind: PromotionInvocationTrigger["kind"];
  observedWakeGeneration: bigint | null;
  scheduleEpoch: bigint | null;
  scheduleWindowIndex: bigint | null;
  scheduledDueAt: Date | null;
  scheduledCheckinAt: Date | null;
  lifecycleState: "running" | "terminal";
  outcome: PromotionJobOutcome | null;
  requestedAt: Date;
  startedAt: Date;
  finishedAt: Date | null;
  ownershipExpiresAt: Date | null;
  beforeLanePosition: bigint | null;
  afterLanePosition: bigint | null;
  beforeSettledPosition: bigint | null;
  afterSettledPosition: bigint | null;
  cycleCount: number;
  promotionAttemptCount: number;
  publicationCount: number;
  operationCount: number;
  relatedAttemptCount: number;
  relatedAttemptSetDigest: string;
  safeFailureCode: string | null;
  continuationGeneration: bigint | null;
  resultActiveGeneration: bigint | null;
  resultPublicReleaseId: string | null;
  resultReleaseFingerprint: string | null;
  retentionProtected: boolean;
}

interface LockedInvocationRow extends InvocationRow {
  ownershipToken: string | null;
}

interface TombstoneRow {
  invocationRunId: string | null;
  triggerKind: PromotionInvocationTrigger["kind"];
  triggerEvidenceDigest: string;
  issuedAt: Date;
  expiresAt: Date;
}

interface DetailRow {
  attemptCount: number;
  operationCount: number;
  attemptSetDigest: string;
  canonicalDetailBody: string;
  canonicalDetailDigest: string;
}

const DELIVERY_STATE_RANK: Readonly<Record<PromotionWakeDeliveryState, number>> =
  Object.freeze({
    pending: 0,
    accepted: 1,
    retry_wait: 2,
    failed: 3,
    delivered: 4,
  });

const TABLE_PATTERN = /^[a-z][a-z0-9_]{0,127}$/u;

export const PROVIDER_PROMOTION_JOB_STORE_CONFIGURATION = Object.freeze({
  authority: "provider_publication",
  wakeTable: "provider_promotion_job_wake",
  scheduleTable: "provider_promotion_job_schedule",
  invocationTable: "provider_promotion_job_invocations",
  tombstoneTable: "provider_promotion_job_delivery_tombstones",
  detailTable: "provider_promotion_invocation_details",
  attemptKind: "provider",
  wakeCauses: new Set<PromotionWakeCause>([
    "canonical_settlement",
    "central_invalidation",
    "continuation",
  ]),
  storesManifestResult: false,
} satisfies StoreConfiguration);

export const MANIFEST_PROMOTION_JOB_STORE_CONFIGURATION = Object.freeze({
  authority: "manifest_reconciliation",
  wakeTable: "manifest_reconciliation_job_wake",
  scheduleTable: "manifest_reconciliation_job_schedule",
  invocationTable: "manifest_reconciliation_job_invocations",
  tombstoneTable: "manifest_reconciliation_job_delivery_tombstones",
  detailTable: "manifest_reconciliation_invocation_details",
  attemptKind: "manifest",
  wakeCauses: new Set<PromotionWakeCause>([
    "provider_completion",
    "manifest_eligibility_change",
    "continuation",
  ]),
  storesManifestResult: true,
} satisfies StoreConfiguration);

/** Shared SQL behavior; authority wrappers supply only their physical client. */
export class SplitPromotionJobStore {
  readonly authority: PromotionJobAuthority;
  readonly #wake: Prisma.Sql;
  readonly #schedule: Prisma.Sql;
  readonly #invocations: Prisma.Sql;
  readonly #tombstones: Prisma.Sql;
  readonly #details: Prisma.Sql;

  constructor(private readonly configuration: StoreConfiguration) {
    for (const table of [
      configuration.wakeTable,
      configuration.scheduleTable,
      configuration.invocationTable,
      configuration.tombstoneTable,
      configuration.detailTable,
    ]) {
      if (!TABLE_PATTERN.test(table)) throw new TypeError("Invalid job table.");
    }
    this.authority = configuration.authority;
    this.#wake = Prisma.raw(`public.${configuration.wakeTable}`);
    this.#schedule = Prisma.raw(`public.${configuration.scheduleTable}`);
    this.#invocations = Prisma.raw(`public.${configuration.invocationTable}`);
    this.#tombstones = Prisma.raw(`public.${configuration.tombstoneTable}`);
    this.#details = Prisma.raw(`public.${configuration.detailTable}`);
  }

  async loadWakeIntent(client: PromotionJobSqlClient): Promise<PromotionWakeIntent> {
    return this.#mapWake(await this.#loadWake(client, false));
  }

  async coalesceWake(
    client: PromotionJobSqlClient,
    input: Readonly<{
      requestedGeneration: bigint;
      cause: PromotionWakeCause;
      requestedAt: Date;
    }>,
  ): Promise<PromotionWakeIntent> {
    this.#assertWakeRequest(input);
    const rows = await client.query<WakeRow>(Prisma.sql`
      insert into ${this.#wake} (
        singleton_key, requested_generation, acknowledged_generation,
        latest_cause, latest_requested_at, row_version, created_at, updated_at
      ) values (
        true, ${input.requestedGeneration}, 0, ${input.cause},
        ${input.requestedAt}, 1, ${input.requestedAt}, ${input.requestedAt}
      )
      on conflict (singleton_key) do update set
        requested_generation = greatest(
          ${this.#wake}.requested_generation, excluded.requested_generation
        ),
        latest_cause = case
          when excluded.requested_generation > ${this.#wake}.requested_generation
            then excluded.latest_cause
          when excluded.requested_generation = ${this.#wake}.requested_generation
            and excluded.latest_requested_at > ${this.#wake}.latest_requested_at
            then excluded.latest_cause
          when excluded.requested_generation = ${this.#wake}.requested_generation
            and excluded.latest_requested_at = ${this.#wake}.latest_requested_at
            then greatest(${this.#wake}.latest_cause, excluded.latest_cause)
          else ${this.#wake}.latest_cause
        end,
        latest_requested_at = case
          when excluded.requested_generation > ${this.#wake}.requested_generation
            then excluded.latest_requested_at
          when excluded.requested_generation = ${this.#wake}.requested_generation
            then greatest(${this.#wake}.latest_requested_at,
              excluded.latest_requested_at)
          else ${this.#wake}.latest_requested_at
        end,
        row_version = ${this.#wake}.row_version + 1,
        updated_at = greatest(
          ${this.#wake}.updated_at + interval '1 microsecond',
          excluded.updated_at
        )
      where excluded.requested_generation > ${this.#wake}.requested_generation
        or (
          excluded.requested_generation = ${this.#wake}.requested_generation
          and excluded.latest_requested_at > ${this.#wake}.latest_requested_at
        )
        or (
          excluded.requested_generation = ${this.#wake}.requested_generation
          and excluded.latest_requested_at = ${this.#wake}.latest_requested_at
          and excluded.latest_cause > ${this.#wake}.latest_cause
        )
      returning ${this.#wakeProjection()}
    `);
    return this.#mapWake(rows[0] ?? await this.#loadWake(client, false));
  }

  async recordWakeDelivery(
    client: PromotionJobSqlClient,
    input: Readonly<{
      generation: bigint;
      state: PromotionWakeDeliveryState;
      attemptedAt: Date;
      safeFailureCode?: string | null;
    }>,
  ): Promise<PromotionWakeIntent> {
    const failureCode = input.safeFailureCode ?? null;
    if (
      input.generation < 1n
      || !validDate(input.attemptedAt)
      || !Object.hasOwn(DELIVERY_STATE_RANK, input.state)
    ) throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
    assertSafeFailureCode(failureCode);
    if ((input.state === "retry_wait" || input.state === "failed")
      !== (failureCode !== null)) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
    }
    const current = await this.#loadWake(client, true);
    if (!current || input.generation > current.requestedGeneration) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_WAKE_INVALID");
    }
    if (!this.#deliveryProgresses(current, input, failureCode)) {
      return this.#mapWake(current);
    }
    const rows = await client.query<WakeRow>(Prisma.sql`
      update ${this.#wake}
      set latest_delivery_generation = ${input.generation},
          latest_delivery_state = ${input.state},
          last_delivery_attempt_at = ${input.attemptedAt},
          latest_delivery_failure_code = ${failureCode},
          row_version = row_version + 1,
          updated_at = greatest(
            updated_at + interval '1 microsecond', ${input.attemptedAt}
          )
      where singleton_key = true
      returning ${this.#wakeProjection()}
    `);
    return this.#mapWake(rows[0] ?? null);
  }

  async loadSchedule(client: PromotionJobSqlClient): Promise<PromotionJobSchedule> {
    return this.#mapSchedule(await this.#loadSchedule(client, false));
  }

  async activateSchedule(
    client: PromotionJobSqlClient,
    input: ActivatePromotionJobScheduleInput,
  ): Promise<PromotionJobSchedule> {
    if (
      input.scheduleEpoch < 1n
      || !validDate(input.baselineAt)
      || !validDate(input.activatedAt)
      || input.baselineAt.getTime() > input.activatedAt.getTime()
    ) throw new PromotionJobPersistenceError("PROMOTION_JOB_SCHEDULE_INVALID");
    const current = await this.#loadSchedule(client, true);
    if (!current) throw new PromotionJobPersistenceError("PROMOTION_JOB_SCHEDULE_INVALID");
    if (
      current.lifecycle === "active"
      && current.scheduleEpoch === input.scheduleEpoch
      && current.baselineAt?.getTime() === input.baselineAt.getTime()
      && current.activatedAt?.getTime() === input.activatedAt.getTime()
    ) return this.#mapSchedule(current);
    if (input.scheduleEpoch <= current.scheduleEpoch) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_SCHEDULE_INVALID");
    }
    const previousLifecycleAt = current.pausedAt ?? current.activatedAt;
    if (previousLifecycleAt
      && input.activatedAt.getTime() < previousLifecycleAt.getTime()) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_SCHEDULE_INVALID");
    }
    const firstDueAt = this.#scheduledDueAt(input.baselineAt, 1n);
    const rows = await client.query<ScheduleRow>(Prisma.sql`
      update ${this.#schedule}
      set lifecycle = 'active', schedule_epoch = ${input.scheduleEpoch},
          cadence_seconds = ${PROMOTION_JOB_SCHEDULE_CADENCE_SECONDS},
          baseline_at = ${input.baselineAt}, activated_at = ${input.activatedAt},
          paused_at = null, last_admitted_window_index = null,
          last_scheduled_checkin_at = null,
          next_expected_checkin_at = ${firstDueAt},
          row_version = row_version + 1,
          updated_at = greatest(
            updated_at + interval '1 microsecond', ${input.activatedAt}
          )
      where singleton_key = true
      returning ${this.#scheduleProjection()}
    `);
    return this.#mapSchedule(rows[0] ?? null);
  }

  async pauseSchedule(
    client: PromotionJobSqlClient,
    input: PausePromotionJobScheduleInput,
  ): Promise<PromotionJobSchedule> {
    if (input.scheduleEpoch < 1n || !validDate(input.pausedAt)) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_SCHEDULE_INVALID");
    }
    const current = await this.#loadSchedule(client, true);
    if (!current || current.scheduleEpoch !== input.scheduleEpoch
      || current.lifecycle === "pending_activation"
      || input.pausedAt.getTime() < (current.activatedAt?.getTime() ?? Infinity)) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_SCHEDULE_INVALID");
    }
    if (current.lifecycle === "paused") return this.#mapSchedule(current);
    const rows = await client.query<ScheduleRow>(Prisma.sql`
      update ${this.#schedule}
      set lifecycle = 'paused', paused_at = ${input.pausedAt},
          next_expected_checkin_at = null,
          row_version = row_version + 1,
          updated_at = greatest(
            updated_at + interval '1 microsecond', ${input.pausedAt}
          )
      where singleton_key = true
      returning ${this.#scheduleProjection()}
    `);
    return this.#mapSchedule(rows[0] ?? null);
  }

  async beginOrRecoverInvocation(
    client: PromotionJobSqlClient,
    input: BeginPromotionJobInvocationInput,
  ): Promise<PromotionJobAdmission> {
    assertDeliveryEnvelope(input.delivery, input.now);
    this.#assertBegin(input);
    const deliveryKeyDigest = promotionJobDeliveryDigest(
      this.authority,
      input.delivery.opaqueKey,
    );
    const triggerEvidenceDigest = promotionJobTriggerEvidenceDigest(
      this.authority,
      input.trigger,
    );
    await client.execute(Prisma.sql`
      select pg_advisory_xact_lock(hashtextextended(
        ${`promotion-job-delivery-v1:${this.authority}:${deliveryKeyDigest}`}, 0
      ))
    `);
    const tombstone = await this.#loadTombstone(client, deliveryKeyDigest);
    if (tombstone) {
      this.#assertTombstoneMatches(tombstone, input, triggerEvidenceDigest);
      const invocation = tombstone.invocationRunId === null
        ? null
        : await this.loadInvocation(client, tombstone.invocationRunId, false);
      return invocation ? {
        disposition: "existing",
        invocation,
        scheduledCheckinAt: invocation.scheduledCheckinAt,
      } : {
        disposition: "existing_pruned",
        invocation: null,
        scheduledCheckinAt: null,
      };
    }

    let wake = await this.#loadWake(client, true);
    if (input.trigger.kind === "change_wake"
      || input.trigger.kind === "continuation") {
      if (!wake
        || input.trigger.observedWakeGeneration > wake.requestedGeneration
        || input.trigger.observedWakeGeneration <= wake.acknowledgedGeneration) {
        throw new PromotionJobPersistenceError("PROMOTION_JOB_WAKE_INVALID");
      }
    }
    const scheduledCheckinAt = input.trigger.kind === "reconciliation_cron"
      ? await this.#admitScheduleWindow(
          client,
          input.trigger,
          input.startedAt,
        )
      : null;
    wake ??= await this.#loadWake(client, false);
    const observedWakeGeneration = this.#admissionObservedGeneration(
      input.trigger,
      wake,
    );
    const rows = await client.query<InvocationRow>(Prisma.sql`
      insert into ${this.#invocations} (
        delivery_key_digest, trigger_evidence_digest, delivery_issued_at,
        delivery_expires_at, trigger_kind, observed_wake_generation,
        schedule_epoch, schedule_window_index, scheduled_due_at,
        scheduled_checkin_at, requested_at, started_at, ownership_key,
        ownership_token, ownership_expires_at, related_attempt_set_digest,
        created_at, updated_at
      ) values (
        ${deliveryKeyDigest}, ${triggerEvidenceDigest}, ${input.delivery.issuedAt},
        ${input.delivery.expiresAt}, ${input.trigger.kind},
        ${observedWakeGeneration},
        ${input.trigger.kind === "reconciliation_cron"
          ? input.trigger.scheduleEpoch : null},
        ${input.trigger.kind === "reconciliation_cron"
          ? input.trigger.scheduleWindowIndex : null},
        ${input.trigger.kind === "reconciliation_cron"
          ? input.trigger.scheduledDueAt : null},
        ${scheduledCheckinAt}, ${input.requestedAt}, ${input.startedAt},
        ${input.ownershipKey}, ${input.ownershipToken}::uuid,
        ${input.ownershipExpiresAt}, ${EMPTY_PROMOTION_ATTEMPT_SET_DIGEST},
        ${input.startedAt}, ${input.startedAt}
      ) returning ${this.#invocationProjection()}
    `);
    const invocation = this.#mapInvocation(rows[0]);
    await client.execute(Prisma.sql`
      insert into ${this.#tombstones} (
        delivery_key_digest, trigger_evidence_digest, invocation_run_id,
        trigger_kind, issued_at, expires_at, created_at
      ) values (
        ${deliveryKeyDigest}, ${triggerEvidenceDigest}, ${invocation.runId}::uuid,
        ${input.trigger.kind}, ${input.delivery.issuedAt},
        ${input.delivery.expiresAt}, ${input.startedAt}
      )
    `);
    return { disposition: "started", invocation, scheduledCheckinAt };
  }

  async recordProgress(
    client: PromotionJobSqlClient,
    input: RecordPromotionJobProgressInput,
  ): Promise<PromotionJobInvocation> {
    this.#assertRunMutation(input);
    assertProgress(input.progress);
    const snapshots = normalizePromotionAttemptSnapshots(
      input.attempts,
      this.configuration.attemptKind,
    );
    if (input.progress.promotionAttemptCount !== snapshots.length) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_ATTEMPT_CONFLICT");
    }
    const current = await this.#requireLockedInvocation(client, input.runId);
    if (current.lifecycleState === "terminal") return this.#mapInvocation(current);
    this.#assertLiveOwnership(current, input.ownershipToken, input.now);
    this.#assertMonotonicProgress(current, input.progress);
    const existing = await this.#loadAttemptSnapshots(client, input.runId);
    this.#assertSnapshotProgress(existing, snapshots);
    const attemptSetDigest = promotionAttemptSetDigest(snapshots);
    if (snapshots.length > 0) {
      await this.#writeAttemptDetail(
        client,
        input.runId,
        snapshots,
        input.progress.operationCount,
        input.now,
      );
    }
    const rows = await client.query<InvocationRow>(Prisma.sql`
      update ${this.#invocations}
      set before_lane_position = ${input.progress.beforeLanePosition},
          after_lane_position = ${input.progress.afterLanePosition},
          before_settled_position = ${input.progress.beforeSettledPosition},
          after_settled_position = ${input.progress.afterSettledPosition},
          cycle_count = ${input.progress.cycleCount},
          promotion_attempt_count = ${input.progress.promotionAttemptCount},
          publication_count = ${input.progress.publicationCount},
          operation_count = ${input.progress.operationCount},
          related_attempt_count = ${snapshots.length},
          related_attempt_set_digest = ${attemptSetDigest},
          retention_protected = ${current.retentionProtected
            || (input.retentionProtected ?? false)},
          updated_at = greatest(updated_at, ${input.now})
      where run_id = ${input.runId}::uuid
      returning ${this.#invocationProjection()}
    `);
    return this.#mapInvocation(rows[0]);
  }

  async terminalize(
    client: PromotionJobSqlClient,
    input: TerminalizePromotionJobInvocationInput,
  ): Promise<PromotionJobInvocation> {
    this.#assertTerminalize(input);
    const current = await this.#requireLockedInvocation(client, input.runId);
    if (current.lifecycleState === "terminal") {
      this.#assertTerminalReplay(current, input);
      return this.#mapInvocation(current);
    }
    this.#assertLiveOwnership(current, input.ownershipToken, input.finishedAt);
    const continuationGeneration = await this.#prepareTerminalWake(
      client,
      current,
      input.outcome,
      input.continuation,
    );
    if (input.acknowledgeObservedWake && current.observedWakeGeneration !== null) {
      await this.#acknowledgeWake(
        client,
        current.observedWakeGeneration,
        input.finishedAt,
      );
    }
    return this.#writeTerminal(client, current.runId, {
      outcome: input.outcome,
      finishedAt: input.finishedAt,
      safeFailureCode: input.safeFailureCode ?? null,
      continuationGeneration,
      resultActiveGeneration: input.resultActiveGeneration ?? null,
      resultPublicReleaseId: input.resultPublicReleaseId ?? null,
      resultReleaseFingerprint: input.resultReleaseFingerprint ?? null,
      retentionProtected: current.retentionProtected
        || current.relatedAttemptCount > 0
        || input.outcome === "continuation_required"
        || (input.retentionProtected ?? false),
    });
  }

  async reconcileInterrupted(
    client: PromotionJobSqlClient,
    input: ReconcileInterruptedPromotionJobInvocationInput,
  ): Promise<PromotionJobInvocation> {
    this.#assertInterrupted(input);
    const current = await this.#requireLockedInvocation(client, input.runId);
    if (current.lifecycleState === "terminal") return this.#mapInvocation(current);
    if (current.ownershipExpiresAt === null
      || current.ownershipExpiresAt.getTime() > input.reconciledAt.getTime()) {
      throw new PromotionJobPersistenceError(
        "PROMOTION_JOB_RECONCILIATION_REQUIRED",
      );
    }
    const continuationGeneration = await this.#prepareTerminalWake(
      client,
      current,
      input.resolution,
      input.continuation,
    );
    return this.#writeTerminal(client, current.runId, {
      outcome: input.resolution,
      finishedAt: input.reconciledAt,
      safeFailureCode: input.safeFailureCode,
      continuationGeneration,
      resultActiveGeneration: null,
      resultPublicReleaseId: null,
      resultReleaseFingerprint: null,
      retentionProtected: current.retentionProtected
        || current.relatedAttemptCount > 0
        || input.resolution === "continuation_required"
        || (input.retentionProtected ?? false),
    });
  }

  async loadInvocation(
    client: PromotionJobSqlClient,
    runId: string,
    includeAttempts: boolean,
  ): Promise<PromotionJobInvocation | null> {
    assertPromotionJobUuid(runId);
    const rows = await client.query<InvocationRow>(Prisma.sql`
      select ${this.#invocationProjection()}
      from ${this.#invocations}
      where run_id = ${runId}::uuid
    `);
    if (!rows[0]) return null;
    const invocation = this.#mapInvocation(rows[0]);
    if (!includeAttempts) return invocation;
    const attemptSnapshots = await this.#loadAttemptSnapshots(client, runId);
    if (attemptSnapshots.length !== invocation.relatedAttemptCount
      || promotionAttemptSetDigest(attemptSnapshots)
        !== invocation.relatedAttemptSetDigest) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_ATTEMPT_CONFLICT");
    }
    return { ...invocation, attemptSnapshots };
  }

  async releaseRetentionProtection(
    client: PromotionJobSqlClient,
    input: Readonly<{
      runId: string;
      releasedAt: Date;
      expectedRelatedAttemptSetDigest: string;
    }>,
    validateRelease: (relatedAttemptSetDigest: string) => Promise<void>,
  ): Promise<boolean> {
    assertPromotionJobUuid(input.runId);
    assertPromotionJobSha256(input.expectedRelatedAttemptSetDigest);
    if (!validDate(input.releasedAt)) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
    }
    const current = await this.#requireLockedInvocation(client, input.runId);
    if (current.lifecycleState !== "terminal") {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_INVOCATION_TERMINAL");
    }
    if (!current.retentionProtected) return false;
    if (current.relatedAttemptSetDigest
      !== input.expectedRelatedAttemptSetDigest) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_ATTEMPT_CONFLICT");
    }
    await validateRelease(current.relatedAttemptSetDigest);
    return await client.execute(Prisma.sql`
      update ${this.#invocations}
      set retention_protected = false,
          updated_at = greatest(updated_at, ${input.releasedAt})
      where run_id = ${input.runId}::uuid
        and retention_protected = true
        and related_attempt_set_digest = ${input.expectedRelatedAttemptSetDigest}
    `) === 1;
  }

  async prune(
    client: PromotionJobSqlClient,
    input: Readonly<{ now: Date; maximumRows?: number }>,
  ): Promise<PromotionJobPruneResult> {
    const maximumRows = input.maximumRows ?? 1_000;
    if (!validDate(input.now) || !Number.isSafeInteger(maximumRows)
      || maximumRows < 1 || maximumRows > 10_000) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
    }
    const cutoff = new Date(
      input.now.getTime() - PROMOTION_JOB_INVOCATION_RETENTION_MS,
    );
    const deletedInvocations = await client.query<{ runId: string }>(Prisma.sql`
      with ranked as (
        select run_id, row_number() over (
          order by finished_at desc, run_id desc
        ) as retained_rank
        from ${this.#invocations}
        where lifecycle_state = 'terminal' and retention_protected = false
      ), eligible as (
        select invocation.run_id
        from ${this.#invocations} invocation
        join ranked on ranked.run_id = invocation.run_id
        where invocation.finished_at <= ${cutoff}
           or ranked.retained_rank > ${PROMOTION_JOB_INVOCATION_LIMIT}
        order by invocation.finished_at, invocation.run_id
        limit ${maximumRows}
      )
      delete from ${this.#invocations} invocation using eligible
      where invocation.run_id = eligible.run_id
      returning invocation.run_id::text as "runId"
    `);
    const deletedTombstones = await client.query<{ deliveryKeyDigest: string }>(
      Prisma.sql`
        delete from ${this.#tombstones}
        where ctid in (
          select ctid from ${this.#tombstones}
          where expires_at <= ${input.now}
          order by expires_at, delivery_key_digest
          limit ${maximumRows}
        )
        returning delivery_key_digest as "deliveryKeyDigest"
      `,
    );
    return {
      invocationSummariesDeleted: deletedInvocations.length,
      tombstonesDeleted: deletedTombstones.length,
      moreEligibleSummaries: deletedInvocations.length === maximumRows,
      moreExpiredTombstones: deletedTombstones.length === maximumRows,
    };
  }

  #assertBegin(input: BeginPromotionJobInvocationInput): void {
    if (!validDate(input.now) || !validDate(input.requestedAt)
      || !validDate(input.startedAt)
      || !validDate(input.ownershipExpiresAt)
      || input.requestedAt.getTime() < input.delivery.issuedAt.getTime()
      || input.startedAt.getTime() < input.requestedAt.getTime()
      || input.startedAt.getTime() > input.now.getTime()
      || input.ownershipExpiresAt.getTime() <= input.now.getTime()) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
    }
    assertTrigger(input.trigger);
    assertOwnership(input);
  }

  #assertRunMutation(input: {
    readonly runId: string;
    readonly ownershipToken: string;
    readonly now: Date;
  }): void {
    assertPromotionJobUuid(input.runId);
    assertPromotionJobUuid(input.ownershipToken);
    if (!validDate(input.now)) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
    }
  }

  #assertTerminalize(input: TerminalizePromotionJobInvocationInput): void {
    this.#assertRunMutation({
      runId: input.runId,
      ownershipToken: input.ownershipToken,
      now: input.finishedAt,
    });
    assertSafeFailureCode(input.safeFailureCode ?? null);
    const continuationInvalid = input.continuation !== undefined && (
      input.continuation.requestedGeneration < 1n
      || !validDate(input.continuation.requestedAt)
      || input.continuation.requestedAt.getTime() > input.finishedAt.getTime()
    );
    const resultActiveGeneration = input.resultActiveGeneration ?? null;
    const resultPublicReleaseId = input.resultPublicReleaseId ?? null;
    const resultReleaseFingerprint = input.resultReleaseFingerprint ?? null;
    const releasePairInvalid = (resultPublicReleaseId === null)
      !== (resultReleaseFingerprint === null);
    if (resultPublicReleaseId !== null) {
      assertPromotionJobUuid(resultPublicReleaseId);
    }
    if (resultReleaseFingerprint !== null) {
      assertPromotionJobSha256(resultReleaseFingerprint);
    }
    if ((input.outcome === "continuation_required")
        !== (input.continuation !== undefined)
      || !["caught_up", "no_change", "coalesced", "continuation_required",
        "deferred", "blocked", "failed"].includes(input.outcome)
      || continuationInvalid || releasePairInvalid
      || resultActiveGeneration !== null && resultActiveGeneration < 0n
      || resultPublicReleaseId !== null
        && (resultActiveGeneration === null || resultActiveGeneration < 1n)) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
    }
    if (!this.configuration.storesManifestResult && (
      input.resultActiveGeneration !== undefined
      || input.resultPublicReleaseId !== undefined
      || input.resultReleaseFingerprint !== undefined
    )) throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
  }

  #assertInterrupted(input: ReconcileInterruptedPromotionJobInvocationInput): void {
    assertPromotionJobUuid(input.runId);
    assertSafeFailureCode(input.safeFailureCode);
    const continuationInvalid = input.continuation !== undefined && (
      input.continuation.requestedGeneration < 1n
      || !validDate(input.continuation.requestedAt)
      || input.continuation.requestedAt.getTime() > input.reconciledAt.getTime()
    );
    if (!validDate(input.reconciledAt)
      || (input.resolution === "continuation_required")
        !== (input.continuation !== undefined)
      || continuationInvalid) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
    }
  }

  #assertWakeRequest(input: {
    readonly requestedGeneration: bigint;
    readonly cause: PromotionWakeCause;
    readonly requestedAt: Date;
  }): void {
    if (input.requestedGeneration < 1n || !validDate(input.requestedAt)
      || !this.configuration.wakeCauses.has(input.cause)) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_WAKE_INVALID");
    }
  }

  async #loadWake(
    client: PromotionJobSqlClient,
    lock: boolean,
  ): Promise<WakeRow | null> {
    const rows = await client.query<WakeRow>(Prisma.sql`
      select ${this.#wakeProjection()} from ${this.#wake}
      where singleton_key = true
      ${lock ? Prisma.sql`for update` : Prisma.empty}
    `);
    return rows[0] ?? null;
  }

  #wakeProjection(): Prisma.Sql {
    return Prisma.sql`
      requested_generation as "requestedGeneration",
      acknowledged_generation as "acknowledgedGeneration",
      latest_cause as "latestCause", latest_requested_at as "latestRequestedAt",
      latest_delivery_generation as "latestDeliveryGeneration",
      latest_delivery_state as "latestDeliveryState",
      last_delivery_attempt_at as "lastDeliveryAttemptAt",
      latest_delivery_failure_code as "latestDeliveryFailureCode"
    `;
  }

  #mapWake(row: WakeRow | null): PromotionWakeIntent {
    return {
      authority: this.authority,
      requestedGeneration: row?.requestedGeneration ?? 0n,
      acknowledgedGeneration: row?.acknowledgedGeneration ?? 0n,
      latestCause: row?.latestCause ?? null,
      latestRequestedAt: row?.latestRequestedAt ?? null,
      pending: row
        ? row.requestedGeneration > row.acknowledgedGeneration
        : false,
      latestDeliveryGeneration: row?.latestDeliveryGeneration ?? null,
      latestDeliveryState: row?.latestDeliveryState ?? null,
      lastDeliveryAttemptAt: row?.lastDeliveryAttemptAt ?? null,
      latestDeliveryFailureCode: row?.latestDeliveryFailureCode ?? null,
    };
  }

  #deliveryProgresses(
    current: WakeRow,
    input: { generation: bigint; state: PromotionWakeDeliveryState; attemptedAt: Date },
    failureCode: string | null,
  ): boolean {
    if (current.latestDeliveryGeneration === null) return true;
    if (input.generation !== current.latestDeliveryGeneration) {
      return input.generation > current.latestDeliveryGeneration;
    }
    const currentRank = DELIVERY_STATE_RANK[current.latestDeliveryState!];
    const nextRank = DELIVERY_STATE_RANK[input.state];
    if (nextRank !== currentRank) return nextRank > currentRank;
    const currentAt = current.lastDeliveryAttemptAt?.getTime() ?? -Infinity;
    if (input.attemptedAt.getTime() !== currentAt) {
      return input.attemptedAt.getTime() > currentAt;
    }
    const nextKey = `${input.state}:${failureCode ?? ""}`;
    const currentKey = `${current.latestDeliveryState}:${current.latestDeliveryFailureCode ?? ""}`;
    return nextKey > currentKey;
  }

  async #loadSchedule(
    client: PromotionJobSqlClient,
    lock: boolean,
  ): Promise<ScheduleRow | null> {
    const rows = await client.query<ScheduleRow>(Prisma.sql`
      select ${this.#scheduleProjection()} from ${this.#schedule}
      where singleton_key = true
      ${lock ? Prisma.sql`for update` : Prisma.empty}
    `);
    return rows[0] ?? null;
  }

  #scheduleProjection(): Prisma.Sql {
    return Prisma.sql`
      lifecycle, schedule_epoch as "scheduleEpoch",
      cadence_seconds as "cadenceSeconds", baseline_at as "baselineAt",
      activated_at as "activatedAt", paused_at as "pausedAt",
      last_admitted_window_index as "lastAdmittedWindowIndex",
      last_scheduled_checkin_at as "lastScheduledCheckinAt",
      next_expected_checkin_at as "nextExpectedCheckinAt"
    `;
  }

  #mapSchedule(row: ScheduleRow | null): PromotionJobSchedule {
    if (!row) throw new PromotionJobPersistenceError("PROMOTION_JOB_SCHEDULE_INVALID");
    return { authority: this.authority, ...row };
  }

  async #admitScheduleWindow(
    client: PromotionJobSqlClient,
    trigger: Extract<PromotionInvocationTriggerRequest,
      { kind: "reconciliation_cron" }>,
    startedAt: Date,
  ): Promise<Date> {
    const schedule = await this.#loadSchedule(client, true);
    if (!schedule || schedule.lifecycle !== "active"
      || schedule.scheduleEpoch !== trigger.scheduleEpoch
      || schedule.baselineAt === null
      || schedule.cadenceSeconds !== PROMOTION_JOB_SCHEDULE_CADENCE_SECONDS
      || schedule.lastAdmittedWindowIndex !== null
        && trigger.scheduleWindowIndex <= schedule.lastAdmittedWindowIndex) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_SCHEDULE_INVALID");
    }
    const dueAt = this.#scheduledDueAt(
      schedule.baselineAt,
      trigger.scheduleWindowIndex,
    );
    if (dueAt.getTime() !== trigger.scheduledDueAt.getTime()
      || dueAt.getTime() > startedAt.getTime()) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_SCHEDULE_INVALID");
    }
    const nextExpected = this.#scheduledDueAt(
      schedule.baselineAt,
      trigger.scheduleWindowIndex + 1n,
    );
    const count = await client.execute(Prisma.sql`
      update ${this.#schedule}
      set last_admitted_window_index = ${trigger.scheduleWindowIndex},
          last_scheduled_checkin_at = ${startedAt},
          next_expected_checkin_at = ${nextExpected},
          row_version = row_version + 1,
          updated_at = greatest(
            updated_at + interval '1 microsecond', ${startedAt}
          )
      where singleton_key = true and lifecycle = 'active'
        and schedule_epoch = ${trigger.scheduleEpoch}
    `);
    if (count !== 1) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_SCHEDULE_INVALID");
    }
    return startedAt;
  }

  #scheduledDueAt(baselineAt: Date, windowIndex: bigint): Date {
    const milliseconds = windowIndex
      * BigInt(PROMOTION_JOB_SCHEDULE_CADENCE_SECONDS * 1_000);
    if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_SCHEDULE_INVALID");
    }
    const timestamp = baselineAt.getTime() + Number(milliseconds);
    const dueAt = new Date(timestamp);
    if (!validDate(dueAt)) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_SCHEDULE_INVALID");
    }
    return dueAt;
  }

  async #loadTombstone(
    client: PromotionJobSqlClient,
    deliveryKeyDigest: string,
  ): Promise<TombstoneRow | null> {
    const rows = await client.query<TombstoneRow>(Prisma.sql`
      select invocation_run_id::text as "invocationRunId",
        trigger_kind as "triggerKind",
        trigger_evidence_digest as "triggerEvidenceDigest",
        issued_at as "issuedAt", expires_at as "expiresAt"
      from ${this.#tombstones}
      where delivery_key_digest = ${deliveryKeyDigest}
      for update
    `);
    return rows[0] ?? null;
  }

  #assertTombstoneMatches(
    tombstone: TombstoneRow,
    input: BeginPromotionJobInvocationInput,
    triggerEvidenceDigest: string,
  ): void {
    if (tombstone.triggerKind !== input.trigger.kind
      || tombstone.triggerEvidenceDigest !== triggerEvidenceDigest
      || tombstone.issuedAt.getTime() !== input.delivery.issuedAt.getTime()
      || tombstone.expiresAt.getTime() !== input.delivery.expiresAt.getTime()) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_DELIVERY_CONFLICT");
    }
  }

  async #requireLockedInvocation(
    client: PromotionJobSqlClient,
    runId: string,
  ): Promise<LockedInvocationRow> {
    const rows = await client.query<LockedInvocationRow>(Prisma.sql`
      select ${this.#invocationProjection()},
        ownership_token::text as "ownershipToken"
      from ${this.#invocations}
      where run_id = ${runId}::uuid
      for update
    `);
    if (!rows[0]) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_INVOCATION_NOT_FOUND");
    }
    return rows[0];
  }

  #invocationProjection(): Prisma.Sql {
    const result = this.configuration.storesManifestResult ? Prisma.sql`
      result_active_generation as "resultActiveGeneration",
      result_public_release_id::text as "resultPublicReleaseId",
      result_release_fingerprint as "resultReleaseFingerprint",
    ` : Prisma.sql`
      null::bigint as "resultActiveGeneration",
      null::text as "resultPublicReleaseId",
      null::text as "resultReleaseFingerprint",
    `;
    return Prisma.sql`
      run_id::text as "runId", delivery_key_digest as "deliveryKeyDigest",
      trigger_kind as "triggerKind",
      observed_wake_generation as "observedWakeGeneration",
      schedule_epoch as "scheduleEpoch",
      schedule_window_index as "scheduleWindowIndex",
      scheduled_due_at as "scheduledDueAt",
      scheduled_checkin_at as "scheduledCheckinAt",
      lifecycle_state as "lifecycleState", outcome,
      requested_at as "requestedAt", started_at as "startedAt",
      finished_at as "finishedAt", ownership_expires_at as "ownershipExpiresAt",
      before_lane_position as "beforeLanePosition",
      after_lane_position as "afterLanePosition",
      before_settled_position as "beforeSettledPosition",
      after_settled_position as "afterSettledPosition",
      cycle_count as "cycleCount",
      promotion_attempt_count as "promotionAttemptCount",
      publication_count as "publicationCount",
      operation_count as "operationCount",
      related_attempt_count as "relatedAttemptCount",
      related_attempt_set_digest as "relatedAttemptSetDigest",
      safe_failure_code as "safeFailureCode",
      continuation_generation as "continuationGeneration",
      ${result}
      retention_protected as "retentionProtected"
    `;
  }

  #mapInvocation(row: InvocationRow | undefined): PromotionJobInvocation {
    if (!row) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_INVOCATION_NOT_FOUND");
    }
    const trigger: PromotionInvocationTrigger = row.triggerKind
      === "reconciliation_cron" ? {
        kind: row.triggerKind,
        scheduleEpoch: row.scheduleEpoch!,
        scheduleWindowIndex: row.scheduleWindowIndex!,
        scheduledDueAt: row.scheduledDueAt!,
        observedWakeGeneration: row.observedWakeGeneration,
      } : row.triggerKind === "manual" ? {
        kind: row.triggerKind,
        observedWakeGeneration: row.observedWakeGeneration,
      } : {
        kind: row.triggerKind,
        observedWakeGeneration: row.observedWakeGeneration!,
      };
    return {
      runId: row.runId,
      authority: this.authority,
      deliveryKeyDigest: row.deliveryKeyDigest,
      trigger,
      lifecycleState: row.lifecycleState,
      outcome: row.outcome,
      requestedAt: row.requestedAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      ownershipExpiresAt: row.ownershipExpiresAt,
      scheduledCheckinAt: row.scheduledCheckinAt,
      progress: {
        beforeLanePosition: row.beforeLanePosition,
        afterLanePosition: row.afterLanePosition,
        beforeSettledPosition: row.beforeSettledPosition,
        afterSettledPosition: row.afterSettledPosition,
        cycleCount: row.cycleCount,
        promotionAttemptCount: row.promotionAttemptCount,
        publicationCount: row.publicationCount,
        operationCount: row.operationCount,
      },
      safeFailureCode: row.safeFailureCode,
      continuationGeneration: row.continuationGeneration,
      resultActiveGeneration: row.resultActiveGeneration,
      resultPublicReleaseId: row.resultPublicReleaseId,
      resultReleaseFingerprint: row.resultReleaseFingerprint,
      relatedAttemptCount: row.relatedAttemptCount,
      relatedAttemptSetDigest: row.relatedAttemptSetDigest,
      retentionProtected: row.retentionProtected,
    };
  }

  #assertLiveOwnership(
    row: LockedInvocationRow,
    ownershipToken: string,
    now: Date,
  ): void {
    if (now.getTime() < row.startedAt.getTime()) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
    }
    if (row.ownershipToken?.toLowerCase() !== ownershipToken.toLowerCase()
      || row.ownershipExpiresAt === null
      || row.ownershipExpiresAt.getTime() <= now.getTime()) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_OWNERSHIP_STALE");
    }
  }

  #assertMonotonicProgress(
    current: LockedInvocationRow,
    next: PromotionJobProgress,
  ): void {
    if (next.cycleCount < current.cycleCount
      || next.promotionAttemptCount < current.promotionAttemptCount
      || next.publicationCount < current.publicationCount
      || next.operationCount < current.operationCount
      || !this.#positionProgressed(
        current.beforeLanePosition,
        current.afterLanePosition,
        next.beforeLanePosition,
        next.afterLanePosition,
      )
      || !this.#positionProgressed(
        current.beforeSettledPosition,
        current.afterSettledPosition,
        next.beforeSettledPosition,
        next.afterSettledPosition,
      )) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_PROGRESS_REGRESSED");
    }
  }

  #positionProgressed(
    currentBefore: bigint | null,
    currentAfter: bigint | null,
    nextBefore: bigint | null,
    nextAfter: bigint | null,
  ): boolean {
    return currentBefore === null
      || currentBefore === nextBefore
        && nextAfter !== null && currentAfter !== null && nextAfter >= currentAfter;
  }

  async #loadAttemptSnapshots(
    client: PromotionJobSqlClient,
    runId: string,
  ): Promise<readonly PromotionInvocationAttemptSnapshot[]> {
    const rows = await client.query<DetailRow>(Prisma.sql`
      select attempt_count as "attemptCount", operation_count as "operationCount",
        attempt_set_digest as "attemptSetDigest",
        canonical_detail_body as "canonicalDetailBody",
        canonical_detail_digest as "canonicalDetailDigest"
      from ${this.#details} where run_id = ${runId}::uuid
    `);
    if (!rows[0]) return [];
    return this.#hydrateAttemptDetail(rows[0]);
  }

  #hydrateAttemptDetail(
    row: DetailRow,
  ): readonly PromotionInvocationAttemptSnapshot[] {
    try {
      if (promotionJobSha256(row.canonicalDetailBody)
        !== row.canonicalDetailDigest) throw new Error("detail digest mismatch");
      const parsed: unknown = JSON.parse(row.canonicalDetailBody);
      if (!Array.isArray(parsed) || parsed.length !== row.attemptCount) {
        throw new Error("detail count mismatch");
      }
      const evidence = parsed.map((entry) => this.#hydrateAttempt(entry));
      const snapshots = normalizePromotionAttemptSnapshots(
        evidence,
        this.configuration.attemptKind,
      );
      if (canonicalPromotionAttemptDetail(snapshots) !== row.canonicalDetailBody
        || promotionAttemptSetDigest(snapshots) !== row.attemptSetDigest
        || snapshots.some((snapshot, index) => {
          const stored = parsed[index] as Record<string, unknown>;
          return stored.snapshotOrdinal !== index
            || stored.snapshotDigest !== snapshot.snapshotDigest;
        })) throw new Error("detail canonical mismatch");
      return snapshots;
    } catch {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_ATTEMPT_CONFLICT");
    }
  }

  #hydrateAttempt(value: unknown) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("invalid attempt detail");
    }
    const row = value as Record<string, unknown>;
    if (!Array.isArray(row.recentOperations)) {
      throw new Error("invalid operation detail");
    }
    return {
      attemptKind: row.attemptKind as "provider" | "manifest",
      attemptId: row.attemptId as string,
      observedState: row.observedState as string,
      targetPosition: BigInt(row.targetPosition as string),
      retryCount: row.retryCount as number,
      safeFailureCode: row.safeFailureCode as string | null,
      publicReleaseId: row.publicReleaseId as string | null,
      releaseFingerprint: row.releaseFingerprint as string | null,
      totalOperationCount: row.totalOperationCount as number,
      orderedOperationDigest: row.orderedOperationDigest as string,
      recentOperations: row.recentOperations.map((operation) =>
        this.#hydrateOperation(operation)),
      observedAt: this.#hydrateDate(row.observedAt),
    };
  }

  #hydrateOperation(value: unknown): PromotionInvocationOperationSummary {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("invalid operation detail");
    }
    const row = value as Record<string, unknown>;
    return {
      operationIndex: row.operationIndex as number,
      operationKind: row.operationKind as string,
      state: row.state as PromotionInvocationOperationSummary["state"],
      sendCount: row.sendCount as number,
      sentAt: row.sentAt === null ? null : this.#hydrateDate(row.sentAt),
      acknowledgedAt: row.acknowledgedAt === null
        ? null : this.#hydrateDate(row.acknowledgedAt),
      operationIdDigest: row.operationIdDigest as string,
      requestDigest: row.requestDigest as string,
      receiptDigest: row.receiptDigest as string | null,
    };
  }

  #hydrateDate(value: unknown): Date {
    if (typeof value !== "string") throw new Error("invalid stored timestamp");
    const parsed = new Date(value);
    if (!validDate(parsed) || parsed.toISOString() !== value) {
      throw new Error("invalid stored timestamp");
    }
    return parsed;
  }

  #assertSnapshotProgress(
    existing: readonly PromotionInvocationAttemptSnapshot[],
    next: readonly PromotionInvocationAttemptSnapshot[],
  ): void {
    if (next.length < existing.length || existing.some((snapshot, index) => {
      const candidate = next[index];
      return candidate === undefined
        || snapshot.attemptIdentityDigest !== candidate.attemptIdentityDigest
        || snapshot.targetPosition !== candidate.targetPosition
        || snapshot.retryCount > candidate.retryCount
        || snapshot.totalOperationCount > candidate.totalOperationCount
        || snapshot.observedAt.getTime() > candidate.observedAt.getTime()
        || snapshot.observedAt.getTime() === candidate.observedAt.getTime()
          && snapshot.snapshotDigest !== candidate.snapshotDigest
        || snapshot.publicReleaseId !== null
          && snapshot.publicReleaseId !== candidate.publicReleaseId
        || snapshot.releaseFingerprint !== null
          && snapshot.releaseFingerprint !== candidate.releaseFingerprint
        || !this.#operationsProgressed(snapshot, candidate);
    })) throw new PromotionJobPersistenceError("PROMOTION_JOB_ATTEMPT_CONFLICT");
  }

  #operationsProgressed(
    previous: PromotionInvocationAttemptSnapshot,
    next: PromotionInvocationAttemptSnapshot,
  ): boolean {
    const byIndex = new Map(next.recentOperations.map((operation) =>
      [operation.operationIndex, operation] as const));
    const rank = { pending: 0, sent: 1, acknowledged: 2 } as const;
    return previous.recentOperations.every((operation) => {
      const candidate = byIndex.get(operation.operationIndex);
      if (!candidate) {
        return operation.operationIndex
          < next.totalOperationCount - next.recentOperations.length;
      }
      return operation.operationKind === candidate.operationKind
        && operation.operationIdDigest === candidate.operationIdDigest
        && operation.requestDigest === candidate.requestDigest
        && candidate.sendCount >= operation.sendCount
        && rank[candidate.state] >= rank[operation.state]
        && (operation.sentAt === null
          || operation.sentAt.getTime() === candidate.sentAt?.getTime())
        && (operation.acknowledgedAt === null
          || operation.acknowledgedAt.getTime()
            === candidate.acknowledgedAt?.getTime())
        && (operation.receiptDigest === null
          || operation.receiptDigest === candidate.receiptDigest);
    });
  }

  async #writeAttemptDetail(
    client: PromotionJobSqlClient,
    runId: string,
    snapshots: readonly PromotionInvocationAttemptSnapshot[],
    operationCount: number,
    observedAt: Date,
  ): Promise<void> {
    const body = canonicalPromotionAttemptDetail(snapshots);
    const setDigest = promotionAttemptSetDigest(snapshots);
    await client.execute(Prisma.sql`
      insert into ${this.#details} (
        run_id, attempt_count, operation_count, attempt_set_digest,
        canonical_detail_body, canonical_detail_digest, observed_at,
        created_at, updated_at
      ) values (
        ${runId}::uuid, ${snapshots.length}, ${operationCount}, ${setDigest},
        ${body}, ${promotionJobSha256(body)}, ${observedAt}, ${observedAt},
        ${observedAt}
      ) on conflict (run_id) do update set
        attempt_count = excluded.attempt_count,
        operation_count = excluded.operation_count,
        attempt_set_digest = excluded.attempt_set_digest,
        canonical_detail_body = excluded.canonical_detail_body,
        canonical_detail_digest = excluded.canonical_detail_digest,
        observed_at = excluded.observed_at,
        updated_at = excluded.updated_at
    `);
  }

  async #prepareTerminalWake(
    client: PromotionJobSqlClient,
    current: LockedInvocationRow,
    outcome: PromotionJobOutcome,
    continuation: Readonly<{
      requestedGeneration: bigint;
      requestedAt: Date;
    }> | undefined,
  ): Promise<bigint | null> {
    if (outcome !== "continuation_required") return null;
    if (!continuation || continuation.requestedGeneration
      <= (current.observedWakeGeneration ?? 0n)) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_WAKE_INVALID");
    }
    const wake = await this.coalesceWake(client, {
      ...continuation,
      cause: "continuation",
    });
    return wake.requestedGeneration;
  }

  async #acknowledgeWake(
    client: PromotionJobSqlClient,
    observedGeneration: bigint,
    acknowledgedAt: Date,
  ): Promise<void> {
    const count = await client.execute(Prisma.sql`
      update ${this.#wake}
      set acknowledged_generation = greatest(
            acknowledged_generation, ${observedGeneration}
          ),
          row_version = row_version + 1,
          updated_at = greatest(
            updated_at + interval '1 microsecond', ${acknowledgedAt}
          )
      where singleton_key = true
        and requested_generation >= ${observedGeneration}
        and acknowledged_generation < ${observedGeneration}
    `);
    if (count === 0) {
      const wake = await this.#loadWake(client, false);
      if (wake && wake.requestedGeneration >= observedGeneration
        && wake.acknowledgedGeneration >= observedGeneration) return;
    }
    if (count !== 1) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_WAKE_INVALID");
    }
  }

  async #writeTerminal(
    client: PromotionJobSqlClient,
    runId: string,
    input: Readonly<{
      outcome: PromotionJobOutcome;
      finishedAt: Date;
      safeFailureCode: string | null;
      continuationGeneration: bigint | null;
      resultActiveGeneration: bigint | null;
      resultPublicReleaseId: string | null;
      resultReleaseFingerprint: string | null;
      retentionProtected: boolean;
    }>,
  ): Promise<PromotionJobInvocation> {
    const result = this.configuration.storesManifestResult ? Prisma.sql`
      result_active_generation = ${input.resultActiveGeneration},
      result_public_release_id = ${input.resultPublicReleaseId}::uuid,
      result_release_fingerprint = ${input.resultReleaseFingerprint},
    ` : Prisma.empty;
    const rows = await client.query<InvocationRow>(Prisma.sql`
      update ${this.#invocations}
      set lifecycle_state = 'terminal', outcome = ${input.outcome},
          finished_at = ${input.finishedAt}, ownership_key = null,
          ownership_token = null, ownership_expires_at = null,
          safe_failure_code = ${input.safeFailureCode},
          continuation_generation = ${input.continuationGeneration},
          ${result}
          retention_protected = ${input.retentionProtected},
          updated_at = greatest(updated_at, ${input.finishedAt})
      where run_id = ${runId}::uuid and lifecycle_state = 'running'
      returning ${this.#invocationProjection()}
    `);
    if (!rows[0]) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_INVOCATION_TERMINAL");
    }
    return this.#mapInvocation(rows[0]);
  }

  #assertTerminalReplay(
    current: LockedInvocationRow,
    input: TerminalizePromotionJobInvocationInput,
  ): void {
    if (current.outcome !== input.outcome
      || current.safeFailureCode !== (input.safeFailureCode ?? null)
      || current.resultActiveGeneration !== (input.resultActiveGeneration ?? null)
      || current.resultPublicReleaseId !== (input.resultPublicReleaseId ?? null)
      || current.resultReleaseFingerprint
        !== (input.resultReleaseFingerprint ?? null)) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_INVOCATION_TERMINAL");
    }
  }

  #admissionObservedGeneration(
    trigger: PromotionInvocationTriggerRequest,
    wake: WakeRow | null,
  ): bigint | null {
    if (trigger.kind === "change_wake" || trigger.kind === "continuation") {
      return trigger.observedWakeGeneration;
    }
    return wake && wake.requestedGeneration > wake.acknowledgedGeneration
      ? wake.requestedGeneration
      : null;
  }
}
