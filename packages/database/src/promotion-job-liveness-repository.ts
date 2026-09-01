import { createHash, randomUUID } from "node:crypto";
import {
  canonicalJson,
  type ProviderDatabaseFailureCode,
} from "@packscout/contracts";
import { Prisma as CentralPrisma } from
  "../prisma/generated/central/index.js";
import {
  CENTRAL_TRANSACTION_OPTIONS,
  type CentralPrismaClient,
  type CentralTransactionClient,
} from "./central-database.ts";
import type { PromotionJobScheduleLifecycle } from
  "./promotion-job-persistence-types.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9_]{0,52}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;

const SERIALIZABLE_TRANSACTION = Object.freeze({
  ...CENTRAL_TRANSACTION_OPTIONS,
  isolationLevel: CentralPrisma.TransactionIsolationLevel.Serializable,
});

const REPEATABLE_READ_TRANSACTION = Object.freeze({
  ...CENTRAL_TRANSACTION_OPTIONS,
  isolationLevel: CentralPrisma.TransactionIsolationLevel.RepeatableRead,
});

export interface PromotionJobLivenessRosterEntryRecord {
  readonly organizationId: string;
  readonly providerId: string;
  readonly providerKey: string;
}

export interface PromotionJobLivenessRosterSnapshotRecord {
  readonly rosterVersion: bigint;
  readonly rosterHighWater: bigint;
  readonly rosterDigest: string;
  readonly capturedAt: Date;
  readonly providers: readonly PromotionJobLivenessRosterEntryRecord[];
}

export type PromotionJobScheduleHealthRecord =
  | "inactive"
  | "healthy"
  | "overdue"
  | "alerting";

export interface PromotionJobScheduleLivenessRecord {
  readonly lifecycle: PromotionJobScheduleLifecycle;
  readonly scheduleEpoch: bigint;
  readonly health: PromotionJobScheduleHealthRecord;
  readonly latestCountableWindowIndex: bigint;
  readonly lastAdmittedWindowIndex: bigint;
  readonly missedWindowCount: bigint;
  readonly lastScheduledCheckinAt: Date | null;
  readonly evaluatedAt: Date;
}

export interface ProviderPromotionLivenessObservationRecord {
  readonly provider: PromotionJobLivenessRosterEntryRecord;
  readonly observedAt: Date;
  readonly failureCode: ProviderDatabaseFailureCode | null;
  readonly observation:
    | Readonly<{
        evidenceSource: "live" | "last_known";
        judgment: PromotionJobScheduleLivenessRecord;
      }>
    | Readonly<{
        evidenceSource: "unavailable";
        judgment: PromotionJobScheduleLivenessRecord | null;
      }>;
}

export interface SuccessfulPromotionJobLivenessCycleRecord {
  readonly evaluatedAt: Date;
  readonly roster: PromotionJobLivenessRosterSnapshotRecord;
  readonly providerObservations:
    readonly ProviderPromotionLivenessObservationRecord[];
  readonly manifestObservation: Readonly<{
    observedAt: Date;
    judgment: PromotionJobScheduleLivenessRecord;
  }>;
  readonly summary: Readonly<{
    expectedCount: number;
    reachableCount: number;
    unavailableCount: number;
    healthyCount: number;
    overdueCount: number;
    alertingCount: number;
  }>;
}

export type PromotionJobLivenessCycleFailureCodeRecord =
  | "registry_enumeration_failed"
  | "manifest_schedule_unavailable"
  | "cycle_persistence_failed";

export type PromotionJobLivenessConditionDelivery = Readonly<{
  conditionId: string;
  eventId: string;
  action: "raise" | "recover";
  scope: "provider" | "system";
  subject: "provider_schedule" | "manifest_schedule";
  organizationId: string | null;
  providerId: string | null;
  scheduleEpoch: bigint;
  missedWindowCount: bigint;
  anchorLastScheduledCheckinAt: Date | null;
  evaluatedAt: Date;
  attemptCount: number;
}>;

export interface PromotionJobLivenessObservationRecord {
  readonly jobKey: string;
  readonly jobKind: "provider_publication" | "manifest_reconciliation";
  readonly organizationId: string | null;
  readonly providerId: string | null;
  readonly evidenceSource: "live" | "last_known" | "unavailable";
  readonly routeFailureCode: string | null;
  readonly observedAt: Date;
  readonly evaluatedAt: Date;
  readonly trustedObservedAt: Date | null;
  readonly judgment: PromotionJobScheduleLivenessRecord | null;
}

export interface PromotionJobLivenessEvaluatorStateRecord {
  readonly state: "pending" | "current" | "stale" | "failed";
  readonly lifecycle: PromotionJobScheduleLifecycle;
  readonly evaluatorEpoch: bigint;
  readonly cadenceSeconds: number;
  readonly baselineAt: Date | null;
  readonly activatedAt: Date | null;
  readonly pausedAt: Date | null;
  readonly lastSuccessfulWindowIndex: bigint | null;
  readonly lastSuccessfulEvaluationAt: Date | null;
  readonly evaluatedThrough: Date | null;
  readonly rosterVersion: bigint | null;
  readonly rosterHighWater: bigint | null;
  readonly rosterDigest: string | null;
  readonly expectedCount: number | null;
  readonly reachableCount: number | null;
  readonly unavailableCount: number | null;
  readonly healthyCount: number | null;
  readonly overdueCount: number | null;
  readonly alertingCount: number | null;
  readonly manifestEvaluated: boolean | null;
  readonly lastFailureCode: string | null;
}

export interface PromotionJobEvaluatorWatchdogEvidenceRecord {
  readonly lifecycle: PromotionJobScheduleLifecycle;
  readonly evaluatorEpoch: bigint;
  readonly cadenceSeconds: number;
  readonly baselineAt: Date | null;
  readonly lastSuccessfulWindowIndex: bigint | null;
  readonly lastSuccessfulEvaluationAt: Date | null;
  readonly evaluatedThrough: Date | null;
  readonly rosterDigest: string | null;
  readonly expectedCount: number | null;
  readonly reachableCount: number | null;
  readonly unavailableCount: number | null;
}

interface RosterMetadataRow {
  roster_version: bigint;
  roster_high_water: bigint;
  captured_at: Date;
}

interface RosterProviderRow {
  id: string;
  organization_id: string;
  provider_key: string;
  row_version: bigint;
  topology_version: bigint;
  updated_at: Date;
}

interface LockedEvaluatorRow {
  state: PromotionJobLivenessEvaluatorStateRecord["state"];
  lifecycle: PromotionJobScheduleLifecycle;
  evaluator_epoch: bigint;
  cadence_seconds: number;
  baseline_at: Date | null;
  activated_at: Date | null;
  paused_at: Date | null;
  last_successful_window_index: bigint | null;
  last_successful_evaluation_at: Date | null;
  evaluated_through: Date | null;
  roster_version: bigint | null;
  roster_high_water: bigint | null;
  roster_digest: string | null;
  expected_count: number | null;
  reachable_count: number | null;
  unavailable_count: number | null;
  healthy_count: number | null;
  overdue_count: number | null;
  alerting_count: number | null;
  manifest_evaluated: boolean | null;
  last_failure_code: string | null;
}

interface ObservationRow {
  job_key: string;
  job_kind: "provider_publication" | "manifest_reconciliation";
  organization_id: string | null;
  provider_id: string | null;
  evidence_source: "live" | "last_known" | "unavailable";
  route_failure_code: string | null;
  observed_at: Date;
  evaluated_at: Date;
  trusted_observed_at: Date | null;
  schedule_lifecycle: PromotionJobScheduleLifecycle | null;
  schedule_epoch: bigint | null;
  schedule_health: PromotionJobScheduleHealthRecord | null;
  latest_countable_window_index: bigint | null;
  last_admitted_window_index: bigint | null;
  missed_window_count: bigint | null;
  last_scheduled_checkin_at: Date | null;
}

interface ConditionRow {
  id: string;
  subject_kind: "provider_schedule" | "manifest_schedule";
  subject_key: string;
  organization_id: string | null;
  provider_id: string | null;
  schedule_epoch: bigint;
  condition_state: "active" | "resolved";
  anchor_last_scheduled_checkin_at: Date | null;
  latest_missed_window_count: bigint;
  opened_at: Date;
  latest_evaluated_at: Date;
  resolved_at: Date | null;
  delivery_action: "raise" | "recover" | null;
  delivery_state: "pending" | "retry_wait" | "delivered" | null;
  delivery_event_id: string | null;
  delivery_attempt_count: number;
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function assertUuid(value: string, name: string): void {
  if (!UUID_PATTERN.test(value)) throw new TypeError(`${name} is invalid.`);
}

function safeFailureCode(value: string): string {
  const normalized = value.toUpperCase();
  if (!SAFE_FAILURE_CODE_PATTERN.test(normalized)) {
    throw new TypeError("Promotion job liveness failure code is invalid.");
  }
  return normalized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertNonnegativeBigint(value: bigint, name: string): void {
  if (typeof value !== "bigint" || value < 0n) {
    throw new TypeError(`${name} is invalid.`);
  }
}

function assertCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} is invalid.`);
  }
}

function assertJudgment(judgment: PromotionJobScheduleLivenessRecord): void {
  if (!validDate(judgment.evaluatedAt)) {
    throw new TypeError("Promotion job liveness judgment is invalid.");
  }
  for (const [name, value] of [
    ["schedule epoch", judgment.scheduleEpoch],
    ["latest countable window", judgment.latestCountableWindowIndex],
    ["last admitted window", judgment.lastAdmittedWindowIndex],
    ["missed window count", judgment.missedWindowCount],
  ] as const) assertNonnegativeBigint(value, name);
  if (
    judgment.lastScheduledCheckinAt !== null
    && !validDate(judgment.lastScheduledCheckinAt)
  ) throw new TypeError("Promotion job liveness judgment is invalid.");
  if (judgment.lifecycle === "active") {
    if (
      judgment.scheduleEpoch < 1n
      || judgment.health === "inactive"
      || judgment.missedWindowCount
        !== (judgment.latestCountableWindowIndex >
            judgment.lastAdmittedWindowIndex
          ? judgment.latestCountableWindowIndex -
            judgment.lastAdmittedWindowIndex
          : 0n)
      || (judgment.health === "healthy" && judgment.missedWindowCount > 1n)
      || (judgment.health === "overdue" && judgment.missedWindowCount !== 2n)
      || (judgment.health === "alerting" && judgment.missedWindowCount < 3n)
    ) throw new TypeError("Promotion job liveness judgment is invalid.");
    return;
  }
  if (judgment.health !== "inactive" || judgment.missedWindowCount !== 0n) {
    throw new TypeError("Promotion job liveness judgment is invalid.");
  }
}

function assertRoster(
  roster: PromotionJobLivenessRosterSnapshotRecord,
): void {
  assertNonnegativeBigint(roster.rosterVersion, "Roster version");
  assertNonnegativeBigint(roster.rosterHighWater, "Roster high water");
  if (!SHA256_PATTERN.test(roster.rosterDigest) || !validDate(roster.capturedAt)) {
    throw new TypeError("Promotion job liveness roster is invalid.");
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const provider of roster.providers) {
    assertUuid(provider.organizationId, "Organization ID");
    assertUuid(provider.providerId, "Provider ID");
    if (
      !PROVIDER_KEY_PATTERN.test(provider.providerKey)
      || ids.has(provider.providerId.toLowerCase())
      || keys.has(provider.providerKey)
    ) throw new TypeError("Promotion job liveness roster is invalid.");
    ids.add(provider.providerId.toLowerCase());
    keys.add(provider.providerKey);
  }
}

function assertCycle(cycle: SuccessfulPromotionJobLivenessCycleRecord): void {
  assertRoster(cycle.roster);
  if (
    !validDate(cycle.evaluatedAt)
    || cycle.providerObservations.length !== cycle.roster.providers.length
    || !validDate(cycle.manifestObservation.observedAt)
  ) throw new TypeError("Promotion job liveness cycle is invalid.");
  assertJudgment(cycle.manifestObservation.judgment);
  let unavailableCount = 0;
  let healthyCount = 0;
  let overdueCount = 0;
  let alertingCount = 0;
  const liveHealth = (health: PromotionJobScheduleHealthRecord): void => {
    if (health === "inactive" || health === "healthy") healthyCount += 1;
    else if (health === "overdue") overdueCount += 1;
    else alertingCount += 1;
  };
  liveHealth(cycle.manifestObservation.judgment.health);
  for (let index = 0; index < cycle.providerObservations.length; index += 1) {
    const observed = cycle.providerObservations[index]!;
    const roster = cycle.roster.providers[index]!;
    if (
      observed.provider.providerId.toLowerCase() !==
        roster.providerId.toLowerCase()
      || observed.provider.organizationId.toLowerCase() !==
        roster.organizationId.toLowerCase()
      || observed.provider.providerKey !== roster.providerKey
      || !validDate(observed.observedAt)
    ) throw new TypeError("Promotion job liveness cycle is invalid.");
    if (observed.observation.evidenceSource === "live") {
      if (observed.failureCode !== null) {
        throw new TypeError("Promotion job liveness cycle is invalid.");
      }
      assertJudgment(observed.observation.judgment);
      liveHealth(observed.observation.judgment.health);
    } else {
      if (observed.failureCode === null) {
        throw new TypeError("Promotion job liveness cycle is invalid.");
      }
      unavailableCount += 1;
    }
  }
  for (const [name, value] of Object.entries(cycle.summary)) {
    assertCount(value, name);
  }
  const expectedCount = cycle.roster.providers.length + 1;
  const reachableCount = expectedCount - unavailableCount;
  if (
    cycle.summary.expectedCount !== expectedCount
    || cycle.summary.reachableCount !== reachableCount
    || cycle.summary.unavailableCount !== unavailableCount
    || cycle.summary.healthyCount !== healthyCount
    || cycle.summary.overdueCount !== overdueCount
    || cycle.summary.alertingCount !== alertingCount
    || healthyCount + overdueCount + alertingCount !== reachableCount
  ) throw new TypeError("Promotion job liveness cycle is invalid.");
}

function mapEvaluator(row: LockedEvaluatorRow): PromotionJobLivenessEvaluatorStateRecord {
  return {
    state: row.state,
    lifecycle: row.lifecycle,
    evaluatorEpoch: row.evaluator_epoch,
    cadenceSeconds: row.cadence_seconds,
    baselineAt: row.baseline_at,
    activatedAt: row.activated_at,
    pausedAt: row.paused_at,
    lastSuccessfulWindowIndex: row.last_successful_window_index,
    lastSuccessfulEvaluationAt: row.last_successful_evaluation_at,
    evaluatedThrough: row.evaluated_through,
    rosterVersion: row.roster_version,
    rosterHighWater: row.roster_high_water,
    rosterDigest: row.roster_digest,
    expectedCount: row.expected_count,
    reachableCount: row.reachable_count,
    unavailableCount: row.unavailable_count,
    healthyCount: row.healthy_count,
    overdueCount: row.overdue_count,
    alertingCount: row.alerting_count,
    manifestEvaluated: row.manifest_evaluated,
    lastFailureCode: row.last_failure_code,
  };
}

function mapObservation(row: ObservationRow): PromotionJobLivenessObservationRecord {
  const judgment = row.schedule_lifecycle === null
    ? null
    : {
        lifecycle: row.schedule_lifecycle,
        scheduleEpoch: row.schedule_epoch!,
        health: row.schedule_health!,
        latestCountableWindowIndex: row.latest_countable_window_index!,
        lastAdmittedWindowIndex: row.last_admitted_window_index!,
        missedWindowCount: row.missed_window_count!,
        lastScheduledCheckinAt: row.last_scheduled_checkin_at,
        evaluatedAt: row.evaluated_at,
      };
  return {
    jobKey: row.job_key,
    jobKind: row.job_kind,
    organizationId: row.organization_id,
    providerId: row.provider_id,
    evidenceSource: row.evidence_source,
    routeFailureCode: row.route_failure_code,
    observedAt: row.observed_at,
    evaluatedAt: row.evaluated_at,
    trustedObservedAt: row.trusted_observed_at,
    judgment,
  };
}

function latestCountableWindow(
  baselineAt: Date,
  evaluatedAt: Date,
): bigint {
  const elapsed = evaluatedAt.getTime() - baselineAt.getTime();
  return elapsed <= 0 ? 0n : (BigInt(elapsed) - 1n) / 60_000n;
}

/** Captures a complete active-provider roster in one repeatable-read snapshot. */
export class PrismaPromotionJobLivenessRosterRepository {
  readonly #pageSize: number;
  readonly #maximumProviders: number;

  constructor(
    private readonly central: CentralPrismaClient,
    options: Readonly<{
      pageSize?: number;
      maximumProviders?: number;
    }> = {},
  ) {
    this.#pageSize = options.pageSize ?? 250;
    this.#maximumProviders = options.maximumProviders ?? 4_096;
    if (
      !Number.isInteger(this.#pageSize)
      || this.#pageSize < 1
      || this.#pageSize > 500
      || !Number.isInteger(this.#maximumProviders)
      || this.#maximumProviders < 1
      || this.#maximumProviders > 100_000
      || this.#pageSize > this.#maximumProviders
    ) throw new TypeError("Promotion job roster bounds are invalid.");
  }

  captureEligibleRoster(): Promise<PromotionJobLivenessRosterSnapshotRecord> {
    return this.central.$transaction(async (transaction) => {
      const [metadata] = await transaction.$queryRaw<readonly RosterMetadataRow[]>(
        CentralPrisma.sql`
          select
            txid_current()::bigint as roster_version,
            txid_snapshot_xmax(txid_current_snapshot())::bigint
              as roster_high_water,
            clock_timestamp() as captured_at
        `,
      );
      if (metadata === undefined) {
        throw new Error("Promotion job roster metadata is unavailable.");
      }
      const rows: RosterProviderRow[] = [];
      let afterId: string | null = null;
      for (;;) {
        const page: RosterProviderRow[] = await transaction.providers.findMany({
          where: {
            lifecycle: "active",
            ...(afterId === null ? {} : { id: { gt: afterId } }),
          },
          orderBy: { id: "asc" },
          take: this.#pageSize,
          select: {
            id: true,
            organization_id: true,
            provider_key: true,
            row_version: true,
            topology_version: true,
            updated_at: true,
          },
        });
        if (rows.length + page.length > this.#maximumProviders) {
          throw new RangeError("Promotion job roster exceeds evaluator capacity.");
        }
        rows.push(...page);
        if (page.length < this.#pageSize) break;
        afterId = page.at(-1)!.id;
      }
      const rosterDigest = sha256(canonicalJson({
        domain: "packscout/promotion-job-liveness-roster/v1",
        providers: rows.map((row) => ({
          organizationId: row.organization_id.toLowerCase(),
          providerId: row.id.toLowerCase(),
          providerKey: row.provider_key,
          rowVersion: row.row_version.toString(),
          topologyVersion: row.topology_version.toString(),
          updatedAt: row.updated_at.toISOString(),
        })),
      }));
      return {
        rosterVersion: metadata.roster_version,
        rosterHighWater: metadata.roster_high_water,
        rosterDigest,
        capturedAt: metadata.captured_at,
        providers: rows.map((row) => ({
          organizationId: row.organization_id,
          providerId: row.id,
          providerKey: row.provider_key,
        })),
      };
    }, REPEATABLE_READ_TRANSACTION);
  }
}

/**
 * Central observation/condition store. Schedule authority remains split; this
 * repository only persists trusted observations and retryable notifications.
 */
export class PrismaPromotionJobLivenessRepository {
  constructor(private readonly central: CentralPrismaClient) {}

  async commitSuccessfulCycle(
    cycle: SuccessfulPromotionJobLivenessCycleRecord,
  ): Promise<void> {
    assertCycle(cycle);
    await this.central.$transaction(async (transaction) => {
      const evaluator = await this.lockEvaluator(transaction);
      const conditions = await this.lockRelevantConditions(
        transaction,
        cycle,
      );
      for (const observation of cycle.providerObservations) {
        await this.persistProviderObservation(transaction, cycle, observation);
      }
      await this.persistManifestObservation(transaction, cycle);
      await this.reconcileConditions(transaction, cycle, conditions);
      const successfulWindow = evaluator.lifecycle === "active"
        ? latestCountableWindow(evaluator.baseline_at!, cycle.evaluatedAt)
        : evaluator.last_successful_window_index;
      await transaction.$executeRaw(CentralPrisma.sql`
        update promotion_job_liveness_evaluator_state
        set state = 'current',
            last_successful_window_index = ${successfulWindow},
            last_successful_evaluation_at = ${cycle.evaluatedAt},
            evaluated_through = ${cycle.evaluatedAt},
            roster_version = ${cycle.roster.rosterVersion},
            roster_high_water = ${cycle.roster.rosterHighWater},
            roster_digest = ${cycle.roster.rosterDigest},
            expected_count = ${cycle.summary.expectedCount},
            reachable_count = ${cycle.summary.reachableCount},
            unavailable_count = ${cycle.summary.unavailableCount},
            healthy_count = ${cycle.summary.healthyCount},
            overdue_count = ${cycle.summary.overdueCount},
            alerting_count = ${cycle.summary.alertingCount},
            manifest_evaluated = true,
            last_failure_code = null,
            row_version = row_version + 1,
            updated_at = greatest(
              ${cycle.evaluatedAt},
              updated_at + interval '1 microsecond'
            )
        where singleton_key = true
          and (
            state,
            last_successful_window_index,
            last_successful_evaluation_at,
            evaluated_through,
            roster_version,
            roster_high_water,
            roster_digest,
            expected_count,
            reachable_count,
            unavailable_count,
            healthy_count,
            overdue_count,
            alerting_count,
            manifest_evaluated,
            last_failure_code
          ) is distinct from (
            'current'::text,
            ${successfulWindow}::bigint,
            ${cycle.evaluatedAt}::timestamptz,
            ${cycle.evaluatedAt}::timestamptz,
            ${cycle.roster.rosterVersion}::bigint,
            ${cycle.roster.rosterHighWater}::bigint,
            ${cycle.roster.rosterDigest}::bpchar,
            ${cycle.summary.expectedCount}::integer,
            ${cycle.summary.reachableCount}::integer,
            ${cycle.summary.unavailableCount}::integer,
            ${cycle.summary.healthyCount}::integer,
            ${cycle.summary.overdueCount}::integer,
            ${cycle.summary.alertingCount}::integer,
            true,
            null::text
          )
      `);
    }, SERIALIZABLE_TRANSACTION);
  }

  async recordFailedCycle(input: Readonly<{
    evaluatedAt: Date;
    failureCode: PromotionJobLivenessCycleFailureCodeRecord;
    roster: PromotionJobLivenessRosterSnapshotRecord | null;
  }>): Promise<void> {
    if (!validDate(input.evaluatedAt)) {
      throw new TypeError("Promotion job liveness failure time is invalid.");
    }
    if (input.roster !== null) assertRoster(input.roster);
    const failureCode = safeFailureCode(input.failureCode);
    await this.central.$transaction(async (transaction) => {
      await this.lockEvaluator(transaction);
      await transaction.$executeRaw(CentralPrisma.sql`
        update promotion_job_liveness_evaluator_state
        set state = 'failed',
            last_failure_code = ${failureCode},
            row_version = row_version + 1,
            updated_at = greatest(
              ${input.evaluatedAt},
              updated_at + interval '1 microsecond'
            )
        where singleton_key = true
          and (state, last_failure_code)
            is distinct from ('failed'::text, ${failureCode}::text)
      `);
    }, SERIALIZABLE_TRANSACTION);
  }

  async listPendingConditionDeliveries(input: Readonly<{
    now: Date;
    limit: number;
  }>): Promise<readonly PromotionJobLivenessConditionDelivery[]> {
    if (
      !validDate(input.now)
      || !Number.isInteger(input.limit)
      || input.limit < 1
      || input.limit > 100
    ) throw new TypeError("Promotion job condition delivery bounds are invalid.");
    const rows = await this.central.$queryRaw<readonly ConditionRow[]>(
      CentralPrisma.sql`
        select id, subject_kind, subject_key, organization_id, provider_id,
          schedule_epoch, condition_state,
          anchor_last_scheduled_checkin_at, latest_missed_window_count,
          opened_at, latest_evaluated_at, resolved_at,
          delivery_action, delivery_state, delivery_event_id,
          delivery_attempt_count
        from promotion_job_liveness_conditions
        where delivery_state = 'pending'
           or (delivery_state = 'retry_wait'
             and next_delivery_attempt_at <= ${input.now})
        order by coalesce(next_delivery_attempt_at, opened_at), id
        limit ${input.limit}
      `,
    );
    return rows.map((row) => ({
      conditionId: row.id,
      eventId: row.delivery_event_id!,
      action: row.delivery_action!,
      scope: row.subject_kind === "provider_schedule" ? "provider" : "system",
      subject: row.subject_kind,
      organizationId: row.organization_id,
      providerId: row.provider_id,
      scheduleEpoch: row.schedule_epoch,
      missedWindowCount: row.latest_missed_window_count,
      anchorLastScheduledCheckinAt: row.anchor_last_scheduled_checkin_at,
      evaluatedAt: row.latest_evaluated_at,
      attemptCount: row.delivery_attempt_count,
    }));
  }

  recordConditionDeliveryAttempt(input: Readonly<{
    conditionId: string;
    eventId: string;
    attemptedAt: Date;
  }>): Promise<boolean> {
    assertUuid(input.conditionId, "Condition ID");
    assertUuid(input.eventId, "Condition event ID");
    if (!validDate(input.attemptedAt)) {
      throw new TypeError("Condition delivery time is invalid.");
    }
    return this.central.$transaction(async (transaction) => {
      const changed = await transaction.$executeRaw(CentralPrisma.sql`
        update promotion_job_liveness_conditions
        set delivery_state = 'pending',
            delivery_attempt_count = delivery_attempt_count + 1,
            last_delivery_attempt_at = ${input.attemptedAt},
            next_delivery_attempt_at = null,
            last_delivery_failure_code = null,
            row_version = row_version + 1,
            updated_at = greatest(
              ${input.attemptedAt},
              updated_at + interval '1 microsecond'
            )
        where id = ${input.conditionId}::uuid
          and delivery_event_id = ${input.eventId}::uuid
          and delivery_state in ('pending', 'retry_wait')
      `);
      return changed === 1;
    }, SERIALIZABLE_TRANSACTION);
  }

  recordConditionDeliveryResult(input: Readonly<{
    conditionId: string;
    eventId: string;
    attemptedAt: Date;
    result:
      | Readonly<{ state: "delivered" }>
      | Readonly<{
          state: "retry_wait";
          failureCode: string;
          retryAt: Date;
        }>;
  }>): Promise<boolean> {
    assertUuid(input.conditionId, "Condition ID");
    assertUuid(input.eventId, "Condition event ID");
    if (!validDate(input.attemptedAt)) {
      throw new TypeError("Condition delivery time is invalid.");
    }
    const retry = input.result.state === "retry_wait";
    const failureCode = retry
      ? safeFailureCode(input.result.failureCode)
      : null;
    const retryAt = retry ? input.result.retryAt : null;
    if (
      retryAt !== null
      && (!validDate(retryAt) || retryAt.getTime() <= input.attemptedAt.getTime())
    ) throw new TypeError("Condition delivery retry time is invalid.");
    return this.central.$transaction(async (transaction) => {
      const changed = await transaction.$executeRaw(CentralPrisma.sql`
        update promotion_job_liveness_conditions
        set delivery_state = ${input.result.state},
            last_delivery_attempt_at = ${input.attemptedAt},
            next_delivery_attempt_at = ${retryAt},
            last_delivery_failure_code = ${failureCode},
            row_version = row_version + 1,
            updated_at = greatest(
              ${input.attemptedAt},
              updated_at + interval '1 microsecond'
            )
        where id = ${input.conditionId}::uuid
          and delivery_event_id = ${input.eventId}::uuid
          and delivery_state in ('pending', 'retry_wait')
          and delivery_attempt_count > 0
      `);
      return changed === 1;
    }, SERIALIZABLE_TRANSACTION);
  }

  async readEvaluatorState(): Promise<PromotionJobLivenessEvaluatorStateRecord> {
    const [row] = await this.central.$queryRaw<readonly LockedEvaluatorRow[]>(
      CentralPrisma.sql`
        select state, lifecycle, evaluator_epoch, cadence_seconds,
          baseline_at, activated_at, paused_at,
          last_successful_window_index, last_successful_evaluation_at,
          evaluated_through, roster_version, roster_high_water, roster_digest,
          expected_count, reachable_count, unavailable_count, healthy_count,
          overdue_count, alerting_count, manifest_evaluated, last_failure_code
        from promotion_job_liveness_evaluator_state
        where singleton_key = true
      `,
    );
    if (row === undefined) throw new Error("Evaluator state is unavailable.");
    return mapEvaluator(row);
  }

  async readWatchdogEvidence(): Promise<PromotionJobEvaluatorWatchdogEvidenceRecord> {
    const state = await this.readEvaluatorState();
    // The evaluator may persist its cutover proof while it is still inert, but
    // the independent detector must not observe that proof until activation.
    // This keeps pending activation indistinguishable from an unarmed detector
    // and matches the watchdog's deliberately narrow evidence contract.
    if (state.lifecycle === "pending_activation") {
      return {
        lifecycle: state.lifecycle,
        evaluatorEpoch: state.evaluatorEpoch,
        cadenceSeconds: state.cadenceSeconds,
        baselineAt: null,
        lastSuccessfulWindowIndex: null,
        lastSuccessfulEvaluationAt: null,
        evaluatedThrough: null,
        rosterDigest: null,
        expectedCount: null,
        reachableCount: null,
        unavailableCount: null,
      };
    }
    return {
      lifecycle: state.lifecycle,
      evaluatorEpoch: state.evaluatorEpoch,
      cadenceSeconds: state.cadenceSeconds,
      baselineAt: state.baselineAt,
      lastSuccessfulWindowIndex: state.lastSuccessfulWindowIndex,
      lastSuccessfulEvaluationAt: state.lastSuccessfulEvaluationAt,
      evaluatedThrough: state.evaluatedThrough,
      rosterDigest: state.rosterDigest,
      expectedCount: state.expectedCount,
      reachableCount: state.reachableCount,
      unavailableCount: state.unavailableCount,
    };
  }

  async readObservation(
    jobKey: "manifest" | `provider:${string}`,
  ): Promise<PromotionJobLivenessObservationRecord | null> {
    if (
      jobKey !== "manifest"
      && (!jobKey.startsWith("provider:")
        || !UUID_PATTERN.test(jobKey.slice("provider:".length)))
    ) throw new TypeError("Promotion job observation key is invalid.");
    const [row] = await this.central.$queryRaw<readonly ObservationRow[]>(
      CentralPrisma.sql`
        select job_key, job_kind, organization_id, provider_id,
          evidence_source, route_failure_code, observed_at, evaluated_at,
          trusted_observed_at, schedule_lifecycle, schedule_epoch,
          schedule_health, latest_countable_window_index,
          last_admitted_window_index, missed_window_count,
          last_scheduled_checkin_at
        from promotion_job_liveness_observations
        where job_key = ${jobKey}
      `,
    );
    return row === undefined ? null : mapObservation(row);
  }

  async activateEvaluator(input: Readonly<{
    evaluatorEpoch: bigint;
    baselineAt: Date;
    activatedAt: Date;
  }>): Promise<PromotionJobLivenessEvaluatorStateRecord> {
    if (
      input.evaluatorEpoch < 1n
      || !validDate(input.baselineAt)
      || !validDate(input.activatedAt)
      || input.activatedAt.getTime() < input.baselineAt.getTime()
    ) throw new TypeError("Evaluator activation is invalid.");
    await this.central.$transaction(async (transaction) => {
      const current = await this.lockEvaluator(transaction);
      if (input.evaluatorEpoch !== current.evaluator_epoch + 1n) {
        throw new Error("Evaluator epoch is not the next monotonic epoch.");
      }
      if (
        current.lifecycle === "active"
        || current.state !== "current"
        || current.last_successful_evaluation_at === null
        || current.evaluated_through === null
        || current.roster_digest === null
        || current.expected_count === null
        || current.reachable_count === null
        || current.unavailable_count === null
        || input.baselineAt.getTime()
          > current.last_successful_evaluation_at.getTime()
        || input.activatedAt.getTime()
          < current.last_successful_evaluation_at.getTime()
      ) {
        throw new Error(
          "Evaluator activation requires one complete successful cycle.",
        );
      }
      const admittedWindow = latestCountableWindow(
        input.baselineAt,
        current.last_successful_evaluation_at,
      );
      await transaction.$executeRaw(CentralPrisma.sql`
        update promotion_job_liveness_evaluator_state
        set lifecycle = 'active',
            evaluator_epoch = ${input.evaluatorEpoch},
            baseline_at = ${input.baselineAt},
            activated_at = ${input.activatedAt},
            paused_at = null,
            last_successful_window_index = ${admittedWindow},
            row_version = row_version + 1,
            updated_at = greatest(
              ${input.activatedAt},
              updated_at + interval '1 microsecond'
            )
        where singleton_key = true
      `);
    }, SERIALIZABLE_TRANSACTION);
    return this.readEvaluatorState();
  }

  async pauseEvaluator(input: Readonly<{
    evaluatorEpoch: bigint;
    pausedAt: Date;
  }>): Promise<PromotionJobLivenessEvaluatorStateRecord> {
    if (input.evaluatorEpoch < 1n || !validDate(input.pausedAt)) {
      throw new TypeError("Evaluator pause is invalid.");
    }
    await this.central.$transaction(async (transaction) => {
      const current = await this.lockEvaluator(transaction);
      if (
        current.lifecycle !== "active"
        || current.evaluator_epoch !== input.evaluatorEpoch
        || input.pausedAt.getTime() < current.activated_at!.getTime()
      ) throw new Error("Evaluator pause does not match the active epoch.");
      await transaction.$executeRaw(CentralPrisma.sql`
        update promotion_job_liveness_evaluator_state
        set lifecycle = 'paused',
            paused_at = ${input.pausedAt},
            row_version = row_version + 1,
            updated_at = greatest(
              ${input.pausedAt},
              updated_at + interval '1 microsecond'
            )
        where singleton_key = true
      `);
    }, SERIALIZABLE_TRANSACTION);
    return this.readEvaluatorState();
  }

  private async lockEvaluator(
    transaction: CentralTransactionClient,
  ): Promise<LockedEvaluatorRow> {
    const [row] = await transaction.$queryRaw<readonly LockedEvaluatorRow[]>(
      CentralPrisma.sql`
        select state, lifecycle, evaluator_epoch, cadence_seconds,
          baseline_at, activated_at, paused_at,
          last_successful_window_index, last_successful_evaluation_at,
          evaluated_through, roster_version, roster_high_water, roster_digest,
          expected_count, reachable_count, unavailable_count, healthy_count,
          overdue_count, alerting_count, manifest_evaluated, last_failure_code
        from promotion_job_liveness_evaluator_state
        where singleton_key = true
        for update
      `,
    );
    if (row === undefined) throw new Error("Evaluator state is unavailable.");
    return row;
  }

  private persistProviderObservation(
    transaction: CentralTransactionClient,
    cycle: SuccessfulPromotionJobLivenessCycleRecord,
    observed: ProviderPromotionLivenessObservationRecord,
  ): Promise<number> {
    const jobKey = `provider:${observed.provider.providerId.toLowerCase()}`;
    if (observed.observation.evidenceSource === "live") {
      return this.upsertLiveObservation(transaction, {
        jobKey,
        jobKind: "provider_publication",
        organizationId: observed.provider.organizationId,
        providerId: observed.provider.providerId,
        observedAt: observed.observedAt,
        evaluatedAt: cycle.evaluatedAt,
        judgment: observed.observation.judgment,
      });
    }
    return transaction.$executeRaw(CentralPrisma.sql`
      insert into promotion_job_liveness_observations (
        job_key, job_kind, organization_id, provider_id, evidence_source,
        route_failure_code, observed_at, evaluated_at
      ) values (
        ${jobKey}, 'provider_publication',
        ${observed.provider.organizationId}::uuid,
        ${observed.provider.providerId}::uuid,
        'unavailable', ${safeFailureCode(observed.failureCode!)},
        ${observed.observedAt}, ${cycle.evaluatedAt}
      )
      on conflict (job_key) do update
      set organization_id = excluded.organization_id,
          provider_id = excluded.provider_id,
          evidence_source = case
            when promotion_job_liveness_observations.trusted_observed_at is null
              then 'unavailable'
            else 'last_known'
          end,
          route_failure_code = excluded.route_failure_code,
          observed_at = excluded.observed_at,
          evaluated_at = excluded.evaluated_at,
          row_version = promotion_job_liveness_observations.row_version + 1,
          updated_at = greatest(
            excluded.evaluated_at,
            promotion_job_liveness_observations.updated_at
              + interval '1 microsecond'
          )
      where (
        promotion_job_liveness_observations.organization_id,
        promotion_job_liveness_observations.provider_id,
        promotion_job_liveness_observations.evidence_source,
        promotion_job_liveness_observations.route_failure_code,
        promotion_job_liveness_observations.observed_at,
        promotion_job_liveness_observations.evaluated_at
      ) is distinct from (
        excluded.organization_id,
        excluded.provider_id,
        case
          when promotion_job_liveness_observations.trusted_observed_at is null
            then 'unavailable'
          else 'last_known'
        end,
        excluded.route_failure_code,
        excluded.observed_at,
        excluded.evaluated_at
      )
    `);
  }

  private persistManifestObservation(
    transaction: CentralTransactionClient,
    cycle: SuccessfulPromotionJobLivenessCycleRecord,
  ): Promise<number> {
    return this.upsertLiveObservation(transaction, {
      jobKey: "manifest",
      jobKind: "manifest_reconciliation",
      organizationId: null,
      providerId: null,
      observedAt: cycle.manifestObservation.observedAt,
      evaluatedAt: cycle.evaluatedAt,
      judgment: cycle.manifestObservation.judgment,
    });
  }

  private upsertLiveObservation(
    transaction: CentralTransactionClient,
    input: Readonly<{
      jobKey: string;
      jobKind: "provider_publication" | "manifest_reconciliation";
      organizationId: string | null;
      providerId: string | null;
      observedAt: Date;
      evaluatedAt: Date;
      judgment: PromotionJobScheduleLivenessRecord;
    }>,
  ): Promise<number> {
    const judgment = input.judgment;
    return transaction.$executeRaw(CentralPrisma.sql`
      insert into promotion_job_liveness_observations (
        job_key, job_kind, organization_id, provider_id, evidence_source,
        route_failure_code, observed_at, evaluated_at, trusted_observed_at,
        schedule_lifecycle, schedule_epoch, schedule_health,
        latest_countable_window_index, last_admitted_window_index,
        missed_window_count, last_scheduled_checkin_at
      ) values (
        ${input.jobKey}, ${input.jobKind},
        ${input.organizationId}::uuid, ${input.providerId}::uuid,
        'live', null, ${input.observedAt}, ${input.evaluatedAt},
        ${input.observedAt}, ${judgment.lifecycle}, ${judgment.scheduleEpoch},
        ${judgment.health}, ${judgment.latestCountableWindowIndex},
        ${judgment.lastAdmittedWindowIndex}, ${judgment.missedWindowCount},
        ${judgment.lastScheduledCheckinAt}
      )
      on conflict (job_key) do update
      set organization_id = excluded.organization_id,
          provider_id = excluded.provider_id,
          evidence_source = 'live',
          route_failure_code = null,
          observed_at = excluded.observed_at,
          evaluated_at = excluded.evaluated_at,
          trusted_observed_at = excluded.trusted_observed_at,
          schedule_lifecycle = excluded.schedule_lifecycle,
          schedule_epoch = excluded.schedule_epoch,
          schedule_health = excluded.schedule_health,
          latest_countable_window_index =
            excluded.latest_countable_window_index,
          last_admitted_window_index = excluded.last_admitted_window_index,
          missed_window_count = excluded.missed_window_count,
          last_scheduled_checkin_at = excluded.last_scheduled_checkin_at,
          row_version = promotion_job_liveness_observations.row_version + 1,
          updated_at = greatest(
            excluded.evaluated_at,
            promotion_job_liveness_observations.updated_at
              + interval '1 microsecond'
          )
      where (
        promotion_job_liveness_observations.organization_id,
        promotion_job_liveness_observations.provider_id,
        promotion_job_liveness_observations.evidence_source,
        promotion_job_liveness_observations.route_failure_code,
        promotion_job_liveness_observations.observed_at,
        promotion_job_liveness_observations.evaluated_at,
        promotion_job_liveness_observations.trusted_observed_at,
        promotion_job_liveness_observations.schedule_lifecycle,
        promotion_job_liveness_observations.schedule_epoch,
        promotion_job_liveness_observations.schedule_health,
        promotion_job_liveness_observations.latest_countable_window_index,
        promotion_job_liveness_observations.last_admitted_window_index,
        promotion_job_liveness_observations.missed_window_count,
        promotion_job_liveness_observations.last_scheduled_checkin_at
      ) is distinct from (
        excluded.organization_id, excluded.provider_id, 'live'::text,
        null::text, excluded.observed_at, excluded.evaluated_at,
        excluded.trusted_observed_at, excluded.schedule_lifecycle,
        excluded.schedule_epoch, excluded.schedule_health,
        excluded.latest_countable_window_index,
        excluded.last_admitted_window_index, excluded.missed_window_count,
        excluded.last_scheduled_checkin_at
      )
    `);
  }

  private async lockRelevantConditions(
    transaction: CentralTransactionClient,
    cycle: SuccessfulPromotionJobLivenessCycleRecord,
  ): Promise<readonly ConditionRow[]> {
    const providerIds = cycle.roster.providers.map(({ providerId }) => providerId);
    const epochs = [
      cycle.manifestObservation.judgment.scheduleEpoch,
      ...cycle.providerObservations
        .filter(({ observation }) => observation.evidenceSource === "live")
        .map(({ observation }) => observation.judgment!.scheduleEpoch),
    ];
    return transaction.$queryRaw<readonly ConditionRow[]>(CentralPrisma.sql`
      select id, subject_kind, subject_key, organization_id, provider_id,
        schedule_epoch, condition_state, anchor_last_scheduled_checkin_at,
        latest_missed_window_count, opened_at, latest_evaluated_at,
        resolved_at, delivery_action, delivery_state, delivery_event_id,
        delivery_attempt_count
      from promotion_job_liveness_conditions
      where condition_state = 'active'
        or (
          schedule_epoch in (${CentralPrisma.join(epochs)})
          and (
            subject_kind = 'manifest_schedule'
            ${providerIds.length === 0
              ? CentralPrisma.empty
              : CentralPrisma.sql`or provider_id = any(
                  array[${CentralPrisma.join(providerIds)}]::uuid[]
                )`}
          )
        )
      for update
    `);
  }

  private async reconcileConditions(
    transaction: CentralTransactionClient,
    cycle: SuccessfulPromotionJobLivenessCycleRecord,
    conditions: readonly ConditionRow[],
  ): Promise<void> {
    const eligible = new Set(
      cycle.roster.providers.map(({ providerId }) => providerId.toLowerCase()),
    );
    for (const condition of conditions) {
      if (
        condition.subject_kind === "provider_schedule"
        && condition.condition_state === "active"
        && !eligible.has(condition.provider_id!.toLowerCase())
      ) await this.resolveCondition(transaction, condition, cycle.evaluatedAt);
    }
    for (const observed of cycle.providerObservations) {
      if (observed.observation.evidenceSource !== "live") continue;
      await this.reconcileSubjectCondition(transaction, {
        subjectKind: "provider_schedule",
        subjectKey: observed.provider.providerId.toLowerCase(),
        organizationId: observed.provider.organizationId,
        providerId: observed.provider.providerId,
        judgment: observed.observation.judgment,
        conditions,
        evaluatedAt: cycle.evaluatedAt,
      });
    }
    await this.reconcileSubjectCondition(transaction, {
      subjectKind: "manifest_schedule",
      subjectKey: "manifest",
      organizationId: null,
      providerId: null,
      judgment: cycle.manifestObservation.judgment,
      conditions,
      evaluatedAt: cycle.evaluatedAt,
    });
  }

  private async reconcileSubjectCondition(
    transaction: CentralTransactionClient,
    input: Readonly<{
      subjectKind: "provider_schedule" | "manifest_schedule";
      subjectKey: string;
      organizationId: string | null;
      providerId: string | null;
      judgment: PromotionJobScheduleLivenessRecord;
      conditions: readonly ConditionRow[];
      evaluatedAt: Date;
    }>,
  ): Promise<void> {
    const subject = input.conditions.filter((condition) =>
      condition.subject_kind === input.subjectKind
      && condition.subject_key === input.subjectKey
    );
    const current = subject.find((condition) =>
      condition.schedule_epoch === input.judgment.scheduleEpoch
    );
    for (const condition of subject) {
      if (
        condition.condition_state === "active"
        && condition.schedule_epoch < input.judgment.scheduleEpoch
      ) await this.resolveCondition(transaction, condition, input.evaluatedAt);
    }
    if (
      input.judgment.lifecycle === "active"
      && input.judgment.health === "alerting"
    ) {
      if (current === undefined) {
        await transaction.$executeRaw(CentralPrisma.sql`
          insert into promotion_job_liveness_conditions (
            id, subject_kind, subject_key, organization_id, provider_id,
            schedule_epoch, condition_state,
            anchor_last_scheduled_checkin_at, latest_missed_window_count,
            opened_at, latest_evaluated_at, delivery_action, delivery_state,
            delivery_event_id
          ) values (
            ${randomUUID()}::uuid, ${input.subjectKind}, ${input.subjectKey},
            ${input.organizationId}::uuid, ${input.providerId}::uuid,
            ${input.judgment.scheduleEpoch}, 'active',
            ${input.judgment.lastScheduledCheckinAt},
            ${input.judgment.missedWindowCount}, ${input.evaluatedAt},
            ${input.evaluatedAt}, 'raise', 'pending', ${randomUUID()}::uuid
          )
          on conflict (subject_kind, subject_key, schedule_epoch) do nothing
        `);
      } else if (current.condition_state === "resolved") {
        await transaction.$executeRaw(CentralPrisma.sql`
          update promotion_job_liveness_conditions
          set condition_state = 'active',
              anchor_last_scheduled_checkin_at =
                ${input.judgment.lastScheduledCheckinAt},
              latest_missed_window_count = ${input.judgment.missedWindowCount},
              opened_at = ${input.evaluatedAt},
              latest_evaluated_at = ${input.evaluatedAt},
              resolved_at = null,
              delivery_action = 'raise',
              delivery_state = 'pending',
              delivery_event_id = ${randomUUID()}::uuid,
              delivery_attempt_count = 0,
              last_delivery_attempt_at = null,
              next_delivery_attempt_at = null,
              last_delivery_failure_code = null,
              row_version = row_version + 1,
              updated_at = greatest(
                ${input.evaluatedAt}, updated_at + interval '1 microsecond'
              )
          where id = ${current.id}::uuid
        `);
      } else {
        await transaction.$executeRaw(CentralPrisma.sql`
          update promotion_job_liveness_conditions
          set latest_missed_window_count = ${input.judgment.missedWindowCount},
              latest_evaluated_at = ${input.evaluatedAt},
              row_version = row_version + 1,
              updated_at = greatest(
                ${input.evaluatedAt}, updated_at + interval '1 microsecond'
              )
          where id = ${current.id}::uuid
            and (latest_missed_window_count, latest_evaluated_at)
              is distinct from (
                ${input.judgment.missedWindowCount}::bigint,
                ${input.evaluatedAt}::timestamptz
              )
        `);
      }
      return;
    }
    if (current?.condition_state !== "active") return;
    const newerCheckin = input.judgment.lastScheduledCheckinAt !== null
      && (
        current.anchor_last_scheduled_checkin_at === null
        || input.judgment.lastScheduledCheckinAt.getTime() >
          current.anchor_last_scheduled_checkin_at.getTime()
      );
    if (
      input.judgment.lifecycle === "paused"
      || (input.judgment.lifecycle === "active"
        && input.judgment.health === "healthy"
        && newerCheckin)
    ) await this.resolveCondition(transaction, current, input.evaluatedAt);
  }

  private resolveCondition(
    transaction: CentralTransactionClient,
    condition: ConditionRow,
    evaluatedAt: Date,
  ): Promise<number> {
    const publishedOrAmbiguous = condition.delivery_action === "raise"
      && (
        condition.delivery_state === "delivered"
        || condition.delivery_attempt_count > 0
      );
    return transaction.$executeRaw(CentralPrisma.sql`
      update promotion_job_liveness_conditions
      set condition_state = 'resolved',
          latest_evaluated_at = ${evaluatedAt},
          resolved_at = ${evaluatedAt},
          delivery_action = ${publishedOrAmbiguous ? "recover" : null},
          delivery_state = ${publishedOrAmbiguous ? "pending" : null},
          delivery_event_id = ${publishedOrAmbiguous ? randomUUID() : null}::uuid,
          delivery_attempt_count = 0,
          last_delivery_attempt_at = null,
          next_delivery_attempt_at = null,
          last_delivery_failure_code = null,
          row_version = row_version + 1,
          updated_at = greatest(
            ${evaluatedAt}, updated_at + interval '1 microsecond'
          )
      where id = ${condition.id}::uuid
        and condition_state = 'active'
    `);
  }
}
