import {
  canonicalJson,
  globalCatalogManifestV1Schema,
  type ManifestGateMonitoring,
  type ManifestPromotionJobMonitoring,
  type PromotionJobAttemptMonitoring,
  type PromotionJobHistoryPage,
  type PromotionJobHistoryQuery,
  type PromotionJobInvocationDetail,
  type PromotionJobInvocationMonitoring,
  type PromotionJobMonitoringOverview,
  type PromotionJobOperationMonitoring,
  type PromotionJobPublicReleaseMonitoring,
  type PromotionJobScheduleMonitoring,
  type PromotionJobWakeMonitoring,
} from "@packscout/contracts";
import {
  PrismaManifestReconciliationJobRepository,
  PrismaPromotionJobLivenessRepository,
  PrismaPromotionJobLivenessRosterRepository,
  PrismaProviderPromotionJobRepository,
  providerReleaseCompletedActivityEvidence,
  promotionJobSha256,
  type BoundedProviderDatabaseGateway,
  type CentralPrismaClient,
  type PromotionJobInvocation,
  type PromotionJobLivenessEvaluatorStateRecord,
  type PromotionJobLivenessObservationRecord,
  type PromotionJobLivenessRosterSnapshotRecord,
  type PromotionJobSchedule,
  type PromotionWakeIntent,
  type ProviderDatabaseOperationResult,
  type ProviderPrismaClient,
} from "@packscout/database";
import {
  InvalidPromotionJobMonitoringCursorError,
  PromotionJobMonitoringCursorCodec,
  PromotionJobMonitoringIdCodec,
  PromotionJobMonitoringNotFoundError,
  evaluatePromotionJobScheduleLiveness,
  judgeProviderPromotionMonitoring,
  promotionJobMonitoringOrderKey,
  type ProviderPromotionMonitoringCentralFacts,
  type ProviderPromotionMonitoringLocalFacts,
} from "@packscout/services";

const PROVIDER_LIMIT = 256;
const DISTRIBUTED_READ_CONCURRENCY = 4;
const OVERVIEW_PROVIDER_READ_TIMEOUT_MS = 15_000;
const HISTORY_SIDE_LIMIT = 101;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface PromotionJobMonitoringRosterProvider {
  readonly id: string;
  readonly providerKey: string;
  readonly displayName: string;
  readonly lifecycle: "draft" | "active" | "disabled" | "archived";
}

export interface CentralPromotionJobMonitoringInvocationRecord {
  readonly kind: "manifest" | "provider";
  readonly centralId: string;
  readonly providerKey: string | null;
  readonly trigger: PromotionJobInvocationMonitoring["trigger"];
  readonly state: PromotionJobInvocationMonitoring["state"];
  readonly outcome: PromotionJobInvocationMonitoring["outcome"];
  readonly requestedAt: Date;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly cycleCount: number;
  readonly attemptCount: number;
  readonly retryCount: number;
  readonly failureCode: string | null;
  readonly continuationPending: boolean;
  readonly settledPosition: bigint | null;
  readonly attemptSetDigest: string;
  readonly canonicalDetailBody: string | null;
  readonly canonicalDetailDigest: string | null;
}

interface PromotionJobHistoryRepositoryPosition {
  readonly startedAt: Date;
  readonly monitoringId: string;
  readonly monitoringOrderKey: string;
}

export interface CentralProviderPromotionMonitoringEvidence {
  readonly observation: PromotionJobLivenessObservationRecord | null;
  readonly latestProjection: CentralPromotionJobMonitoringInvocationRecord | null;
  readonly completedRelease: PromotionJobPublicReleaseMonitoring | null;
  readonly completionObservedAt: Date | null;
  readonly activeRelease: PromotionJobPublicReleaseMonitoring | null;
  readonly pendingGate: ManifestGateMonitoring | null;
  readonly projectedAt: Date | null;
}

export interface CentralManifestPromotionMonitoringEvidence {
  readonly view: ManifestPromotionJobMonitoring;
  readonly activeReleases: ReadonlyMap<string, Readonly<{
    publicReleaseId: string;
    fingerprint: string;
  }>>;
}

export interface LiveProviderPromotionMonitoringSnapshot {
  readonly observedAt: Date;
  readonly schedule: PromotionJobSchedule;
  readonly wake: PromotionWakeIntent;
  readonly settledPosition: bigint;
  readonly completedRelease: PromotionJobPublicReleaseMonitoring | null;
  readonly executionState: ProviderPromotionMonitoringLocalFacts["executionState"];
}

function asFailureCode(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.replaceAll(/[^A-Za-z0-9]+/gu, "_").toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,127}$/u.test(normalized)
    ? normalized
    : "MONITORING_EVIDENCE_INVALID";
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function mapWake(wake: PromotionWakeIntent): PromotionJobWakeMonitoring {
  return {
    pending: wake.pending,
    requestedGeneration: wake.requestedGeneration.toString(),
    acknowledgedGeneration: wake.acknowledgedGeneration.toString(),
    latestCause: wake.latestCause,
    latestRequestedAt: iso(wake.latestRequestedAt),
    deliveryState: wake.latestDeliveryState,
    lastDeliveryAttemptAt: iso(wake.lastDeliveryAttemptAt),
    failureCode: asFailureCode(wake.latestDeliveryFailureCode),
  };
}

function mapSchedule(
  schedule: PromotionJobSchedule,
  observedAt: Date,
): PromotionJobScheduleMonitoring {
  const judgment = evaluatePromotionJobScheduleLiveness(schedule, observedAt);
  return {
    lifecycle: judgment.lifecycle,
    health: judgment.health,
    scheduleEpoch: judgment.scheduleEpoch.toString(),
    missedWindowCount: judgment.missedWindowCount.toString(),
    lastScheduledCheckinAt: iso(judgment.lastScheduledCheckinAt),
    nextExpectedCheckinAt: iso(schedule.nextExpectedCheckinAt),
  };
}

function mapObservedSchedule(
  observation: PromotionJobLivenessObservationRecord | null,
): PromotionJobScheduleMonitoring | null {
  const judgment = observation?.judgment;
  if (judgment === null || judgment === undefined) return null;
  return {
    lifecycle: judgment.lifecycle,
    health: judgment.health,
    scheduleEpoch: judgment.scheduleEpoch.toString(),
    missedWindowCount: judgment.missedWindowCount.toString(),
    lastScheduledCheckinAt: iso(judgment.lastScheduledCheckinAt),
    nextExpectedCheckinAt: null,
  };
}

function invocationJob(record: CentralPromotionJobMonitoringInvocationRecord): PromotionJobInvocationMonitoring["job"] {
  return record.kind === "manifest"
    ? "manifest"
    : `provider:${record.providerKey!}`;
}

function mapInvocation(
  record: CentralPromotionJobMonitoringInvocationRecord,
  codec: PromotionJobMonitoringIdCodec,
  scope: { readonly organizationId: string; readonly deployment: string },
): PromotionJobInvocationMonitoring {
  return {
    monitoringId: codec.encode(scope, {
      kind: record.kind,
      centralId: record.centralId,
    }),
    job: invocationJob(record),
    trigger: record.trigger,
    state: record.state,
    outcome: record.outcome,
    requestedAt: record.requestedAt.toISOString(),
    startedAt: record.startedAt.toISOString(),
    finishedAt: iso(record.finishedAt),
    durationMs: record.finishedAt === null
      ? null
      : Math.max(0, record.finishedAt.getTime() - record.startedAt.getTime()),
    cycleCount: record.cycleCount,
    attemptCount: record.attemptCount,
    retryCount: record.retryCount,
    failureCode: asFailureCode(record.failureCode),
    continuationPending: record.continuationPending,
  };
}

function invocationFromManifest(
  row: Readonly<{
    run_id: string;
    trigger_kind: string;
    lifecycle_state: string;
    outcome: string | null;
    requested_at: Date;
    started_at: Date;
    finished_at: Date | null;
    cycle_count: number;
    promotion_attempt_count: number;
    operation_count: number;
    publication_count: number;
    safe_failure_code: string | null;
    continuation_generation: bigint | null;
    related_attempt_set_digest: string;
    detail?: Readonly<{
      canonical_detail_body: string;
      canonical_detail_digest: string;
      attempt_set_digest: string;
    }> | null;
  }>,
): CentralPromotionJobMonitoringInvocationRecord {
  return {
    kind: "manifest",
    centralId: row.run_id,
    providerKey: null,
    trigger: row.trigger_kind as PromotionJobInvocationMonitoring["trigger"],
    state: row.lifecycle_state as PromotionJobInvocationMonitoring["state"],
    outcome: row.outcome as PromotionJobInvocationMonitoring["outcome"],
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    cycleCount: row.cycle_count,
    attemptCount: row.promotion_attempt_count,
    retryCount: detailRetryCount(row.detail?.canonical_detail_body ?? null),
    failureCode: row.safe_failure_code,
    continuationPending: row.continuation_generation !== null,
    settledPosition: null,
    attemptSetDigest:
      row.detail?.attempt_set_digest ?? row.related_attempt_set_digest,
    canonicalDetailBody: row.detail?.canonical_detail_body ?? null,
    canonicalDetailDigest: row.detail?.canonical_detail_digest ?? null,
  };
}

function invocationFromProjection(
  row: Readonly<{
    id: string;
    trigger_kind: string;
    outcome: string;
    scheduled_checkin_at: Date | null;
    started_at: Date;
    finished_at: Date;
    cycle_count: number;
    promotion_attempt_count: number;
    operation_count: number;
    publication_count: number;
    after_settled_position: bigint | null;
    safe_failure_code: string | null;
    canonical_detail_body: string;
    canonical_detail_digest: string;
    provider: Readonly<{ provider_key: string }>;
  }>,
): CentralPromotionJobMonitoringInvocationRecord {
  return {
    kind: "provider",
    centralId: row.id,
    providerKey: row.provider.provider_key,
    trigger: row.trigger_kind as PromotionJobInvocationMonitoring["trigger"],
    state: "terminal",
    outcome: row.outcome as PromotionJobInvocationMonitoring["outcome"],
    requestedAt: row.scheduled_checkin_at ?? row.started_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    cycleCount: row.cycle_count,
    attemptCount: row.promotion_attempt_count,
    retryCount: detailRetryCount(row.canonical_detail_body),
    failureCode: row.safe_failure_code,
    continuationPending: row.outcome === "continuation_required",
    settledPosition: row.after_settled_position,
    attemptSetDigest: projectedAttemptSetDigest(row.canonical_detail_body),
    canonicalDetailBody: row.canonical_detail_body,
    canonicalDetailDigest: row.canonical_detail_digest,
  };
}

function projectedAttemptSetDigest(canonicalDetailBody: string): string {
  const parsed: unknown = JSON.parse(canonicalDetailBody);
  if (!Array.isArray(parsed) || canonicalJson(parsed) !== canonicalDetailBody) {
    throw new Error("Provider promotion projection detail is invalid.");
  }
  return promotionJobSha256(canonicalJson(parsed.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Provider promotion projection attempt is invalid.");
    }
    const row = value as Record<string, unknown>;
    if (
      typeof row.attemptIdentityDigest !== "string"
      || !SHA256_PATTERN.test(row.attemptIdentityDigest)
      || typeof row.snapshotDigest !== "string"
      || !SHA256_PATTERN.test(row.snapshotDigest)
    ) throw new Error("Provider promotion projection digest is invalid.");
    return {
      attemptIdentityDigest: row.attemptIdentityDigest,
      snapshotDigest: row.snapshotDigest,
    };
  })));
}

function detailRetryCount(canonicalDetailBody: string | null): number {
  if (canonicalDetailBody === null) return 0;
  const parsed: unknown = JSON.parse(canonicalDetailBody);
  if (!Array.isArray(parsed) || parsed.length > 25) {
    throw new Error("Promotion attempt retry evidence is invalid.");
  }
  let count = 0;
  for (const value of parsed) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Promotion attempt retry evidence is invalid.");
    }
    const retryCount = (value as Record<string, unknown>).retryCount;
    if (!Number.isSafeInteger(retryCount) || (retryCount as number) < 0) {
      throw new Error("Promotion attempt retry evidence is invalid.");
    }
    count += retryCount as number;
    if (!Number.isSafeInteger(count)) {
      throw new Error("Promotion attempt retry evidence is invalid.");
    }
  }
  return count;
}

function executionState(
  latest: Pick<PromotionJobInvocation, "lifecycleState" | "outcome"> | null,
  wake: PromotionWakeIntent,
): ProviderPromotionMonitoringLocalFacts["executionState"] {
  if (wake.latestDeliveryState === "retry_wait") return "retry_wait";
  if (wake.latestDeliveryState === "failed") return "failed";
  if (latest?.lifecycleState !== "terminal") return "ready";
  if (latest.outcome === "blocked") return "blocked";
  if (latest.outcome === "failed") return "failed";
  return "ready";
}

function safeCompletion(value: unknown): PromotionJobPublicReleaseMonitoring | null {
  try {
    const evidence = providerReleaseCompletedActivityEvidence({
      eventType: "provider_release_completed",
      evidence: value as Readonly<Record<string, string | number | boolean | null>>,
    });
    return {
      publicReleaseId: evidence.publicProviderReleaseId,
      fingerprint: evidence.providerReleaseFingerprint,
      position: evidence.completedThroughChangeSequence,
    };
  } catch {
    return null;
  }
}

async function mapBounded<T, U>(
  values: readonly T[],
  operation: (value: T) => Promise<U>,
): Promise<readonly U[]> {
  const results = new Array<U>(values.length);
  let next = 0;
  await Promise.all(Array.from(
    { length: Math.min(DISTRIBUTED_READ_CONCURRENCY, values.length) },
    async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await operation(values[index]!);
      }
    },
  ));
  return results;
}

type DeadlineSettlement<T> =
  | { readonly state: "fulfilled"; readonly value: T }
  | { readonly state: "rejected" }
  | { readonly state: "timed_out" };

interface DeadlineLatch {
  readonly deadlineAt: number;
  readonly expired: Promise<void>;
  isExpired(): boolean;
  close(): void;
}

function createDeadlineLatch(deadlineAt: number): DeadlineLatch {
  let expired = false;
  let resolveExpired!: () => void;
  const expiration = new Promise<void>((resolve) => {
    resolveExpired = resolve;
  });
  const expire = () => {
    if (expired) return;
    expired = true;
    resolveExpired();
  };
  const remainingMs = deadlineAt - Date.now();
  const timer = remainingMs > 0 ? setTimeout(expire, remainingMs) : null;
  if (timer === null) expire();
  return {
    deadlineAt,
    expired: expiration,
    isExpired() {
      if (!expired && Date.now() >= deadlineAt) expire();
      return expired;
    },
    close() {
      if (timer !== null) clearTimeout(timer);
    },
  };
}

async function settleByDeadline<T>(
  operation: () => Promise<T>,
  deadline: DeadlineLatch,
): Promise<DeadlineSettlement<T>> {
  // Do not launch more provider work after the roster-wide budget expires.
  // Those rows still retain their central last-known evidence below.
  if (deadline.isExpired()) return { state: "timed_out" };
  let pending: Promise<T>;
  try {
    pending = Promise.resolve(operation());
  } catch {
    return { state: "rejected" };
  }
  return new Promise((resolve) => {
    let finished = false;
    void deadline.expired.then(() => {
      if (finished) return;
      finished = true;
      resolve({ state: "timed_out" });
    });
    void pending.then(
      (value) => {
        if (finished) return;
        finished = true;
        resolve({ state: "fulfilled", value });
      },
      () => {
        if (finished) return;
        finished = true;
        resolve({ state: "rejected" });
      },
    );
  });
}

/** Central-only repository; no provider route or credential enters a query. */
export class PrismaPromotionJobMonitoringReadRepository {
  readonly #roster: PrismaPromotionJobLivenessRosterRepository;
  readonly #liveness: PrismaPromotionJobLivenessRepository;

  constructor(private readonly central: CentralPrismaClient) {
    this.#roster = new PrismaPromotionJobLivenessRosterRepository(central);
    this.#liveness = new PrismaPromotionJobLivenessRepository(central);
  }

  captureEligibleRoster(): Promise<PromotionJobLivenessRosterSnapshotRecord> {
    return this.#roster.captureEligibleRoster();
  }

  readEvaluator(): Promise<PromotionJobLivenessEvaluatorStateRecord> {
    return this.#liveness.readEvaluatorState();
  }

  async listRoster(organizationId: string): Promise<readonly PromotionJobMonitoringRosterProvider[]> {
    const rows = await this.central.providers.findMany({
      where: { organization_id: organizationId },
      orderBy: [{ provider_key: "asc" }, { id: "asc" }],
      take: PROVIDER_LIMIT + 1,
      select: {
        id: true,
        provider_key: true,
        display_name: true,
        lifecycle: true,
      },
    });
    if (rows.length > PROVIDER_LIMIT) {
      throw new Error("Promotion monitoring roster exceeds its safe bound.");
    }
    return rows.map((row) => ({
      id: row.id,
      providerKey: row.provider_key,
      displayName: row.display_name,
      lifecycle: row.lifecycle,
    }));
  }

  readObservation(
    job: "manifest" | Readonly<{ providerId: string }>,
  ): Promise<PromotionJobLivenessObservationRecord | null> {
    return this.#liveness.readObservation(
      job === "manifest" ? "manifest" : `provider:${job.providerId}`,
    );
  }

  async readManifestEvidence(input: Readonly<{
    organizationId: string;
    deployment: string;
    now: Date;
    idCodec: PromotionJobMonitoringIdCodec;
    evaluatorCurrent: boolean;
  }>): Promise<CentralManifestPromotionMonitoringEvidence> {
    const manifestJobs = new PrismaManifestReconciliationJobRepository(
      this.central,
    );
    const [state, schedule, wake, observation, latest, gateRows] =
      await Promise.all([
        this.central.manifest_activation_state.findUnique({
          where: { singleton_key: true },
        }),
        manifestJobs.loadSchedule(),
        manifestJobs.loadWakeIntent(),
        this.readObservation("manifest"),
        this.central.manifest_reconciliation_job_invocations.findFirst({
          orderBy: [{ started_at: "desc" }, { run_id: "desc" }],
          include: { detail: true },
        }),
        this.central.manifest_activation_operations.findMany({
          where: { state: { in: ["pending", "ambiguous"] } },
          orderBy: [{ requested_at: "asc" }, { id: "asc" }],
          take: 2,
          select: {
            operation: true,
            state: true,
            attempt_count: true,
            failure_code: true,
            provider: { select: { provider_key: true } },
          },
        }),
      ]);
    const pendingIntents = await this.central.manifest_gate_intents.findMany({
      where: { latest_requested_at: { not: null } },
      select: {
        requested_generation: true,
        acknowledged_generation: true,
        latest_requested_at: true,
      },
    });
    const pendingTimes = pendingIntents
      .filter((row) => row.requested_generation > row.acknowledged_generation)
      .flatMap((row) => row.latest_requested_at === null ? [] : [row.latest_requested_at]);
    const queueDepth = pendingIntents.filter((row) =>
      row.requested_generation > row.acknowledged_generation
    ).length;
    const oldest = pendingTimes.sort((left, right) =>
      left.getTime() - right.getTime()
    )[0] ?? null;

    let manifest = null;
    let activeReleases = new Map<string, {
      publicReleaseId: string;
      fingerprint: string;
    }>();
    if (state?.active_manifest_bytes !== null
      && state?.active_manifest_bytes !== undefined) {
      try {
        manifest = globalCatalogManifestV1Schema.parse(JSON.parse(
          Buffer.from(state.active_manifest_bytes).toString("utf8"),
        ));
        activeReleases = new Map(manifest.providerReferences.map((reference) => [
          reference.platformKey,
          {
            publicReleaseId: reference.publicProviderReleaseId,
            fingerprint: reference.providerReleaseFingerprint,
          },
        ]));
      } catch {
        manifest = null;
      }
    }
    const latestInvocation = latest === null
      ? null
      : mapInvocation(
          invocationFromManifest(latest),
          input.idCodec,
          input,
        );
    const serialized = gateRows[0];
    const observedAt = observation?.observedAt ?? input.now;
    const activeId = state?.active_manifest_id ?? null;
    const previousId = state?.previous_manifest_id ?? null;
    const activeFingerprint = state?.active_manifest_fingerprint ?? null;
    const previousFingerprint = state?.previous_manifest_fingerprint ?? null;
    const activeGeneration = state?.active_generation ?? 0n;
    const activationRows = await this.central.manifest_activation_operations.findMany({
      where: {
        state: "accepted",
        new_manifest_id: { in: [activeId, previousId].filter(
          (value): value is string => value !== null,
        ) },
      },
      orderBy: [{ completed_at: "desc" }, { id: "desc" }],
      take: 4,
      select: { new_manifest_id: true, completed_at: true },
    });
    const activatedAt = (manifestId: string | null): string | null => {
      if (manifestId === null) return null;
      return (activationRows.find((row) => row.new_manifest_id === manifestId)
        ?.completed_at ?? state?.updated_at ?? input.now).toISOString();
    };
    return {
      activeReleases,
      view: {
        evidenceSource: state === null ? "unavailable" : "live",
        observedAt: state === null ? null : observedAt.toISOString(),
        stale: !input.evaluatorCurrent || state === null ||
          (state.active_manifest_bytes !== null && manifest === null),
        schedule: mapSchedule(schedule, input.now),
        wake: mapWake(wake),
        activeManifest: activeId === null || activeFingerprint === null
          ? null
          : {
              publicManifestId: activeId,
              fingerprint: activeFingerprint,
              generation: activeGeneration.toString(),
              activatedAt: activatedAt(activeId)!,
            },
        previousManifest: previousId === null
            || previousFingerprint === null
          ? null
          : {
              publicManifestId: previousId,
              fingerprint: previousFingerprint,
              generation: activeGeneration > 0n
                ? (activeGeneration - 1n).toString()
                : "0",
              activatedAt: activatedAt(previousId)!,
            },
        gateQueueDepth: queueDepth,
        oldestGateAgeMs: oldest === null
          ? null
          : Math.max(0, input.now.getTime() - oldest.getTime()),
        serializedOperation: serialized === undefined
          ? null
          : {
              operation: serialized.operation,
              providerKey: serialized.provider.provider_key,
              state: serialized.state === "ambiguous" ? "retry_wait" : "persisted",
              attemptCount: serialized.attempt_count,
              failureCode: asFailureCode(serialized.failure_code),
            },
        lastActivationAt: activatedAt(activeId),
        lastReconciliationAt: latest?.finished_at?.toISOString() ?? null,
        latestInvocation,
      },
    };
  }

  async readProviderEvidence(input: Readonly<{
    organizationId: string;
    provider: PromotionJobMonitoringRosterProvider;
    active: CentralManifestPromotionMonitoringEvidence["activeReleases"] extends ReadonlyMap<string, infer T>
      ? T | null
      : never;
  }>): Promise<CentralProviderPromotionMonitoringEvidence> {
    const [
      observation,
      projection,
      completionEvent,
      activeCompletionEvent,
      intent,
    ] = await Promise.all([
      this.readObservation({ providerId: input.provider.id }),
      this.central.provider_promotion_invocation_projections.findFirst({
        where: { provider_id: input.provider.id },
        orderBy: [{ started_at: "desc" }, { id: "desc" }],
        include: { provider: { select: { provider_key: true } } },
      }),
      this.central.provider_activity_events.findFirst({
        where: {
          organization_id: input.organizationId,
          provider_id: input.provider.id,
          event_type: "provider_release_completed",
        },
        orderBy: [{ event_at: "desc" }, { id: "desc" }],
        select: { evidence: true, event_at: true },
      }),
      input.active === null
        ? Promise.resolve(null)
        : this.central.provider_activity_events.findFirst({
            where: {
              organization_id: input.organizationId,
              provider_id: input.provider.id,
              event_type: "provider_release_completed",
              AND: [{
                evidence: {
                  path: ["publicProviderReleaseId"],
                  equals: input.active.publicReleaseId,
                },
              }, {
                evidence: {
                  path: ["providerReleaseFingerprint"],
                  equals: input.active.fingerprint,
                },
              }],
            },
            orderBy: [{ event_at: "desc" }, { id: "desc" }],
            select: { evidence: true },
          }),
      this.central.manifest_gate_intents.findUnique({
        where: { provider_id: input.provider.id },
      }),
    ]);
    const completed = safeCompletion(completionEvent?.evidence ?? null);
    let activeRelease: PromotionJobPublicReleaseMonitoring | null = null;
    if (input.active !== null) {
      const matchingCompletion = safeCompletion(
        activeCompletionEvent?.evidence ?? null,
      );
      activeRelease = {
        publicReleaseId: input.active.publicReleaseId,
        fingerprint: input.active.fingerprint,
        position: matchingCompletion?.position ?? null,
      };
    }
    const pending = intent !== null
      && intent.requested_generation > intent.acknowledged_generation;
    const pendingGate: ManifestGateMonitoring | null = !pending
      || intent.latest_requested_at === null
      ? null
      : {
          operation: intent.requested_operation ?? "advance",
          state: intent.claim_token !== null
            ? "running"
            : intent.retry_at !== null
              ? "retry_wait"
              : intent.last_failure_code !== null
                ? "blocked"
                : "pending",
          requestedGeneration: intent.requested_generation.toString(),
          acknowledgedGeneration: intent.acknowledged_generation.toString(),
          requestedAt: intent.latest_requested_at.toISOString(),
          attemptCount: intent.attempt_count,
          retryAt: iso(intent.retry_at),
          failureCode: asFailureCode(intent.last_failure_code),
        };
    return {
      observation,
      latestProjection: projection === null
        ? null
        : invocationFromProjection(projection),
      completedRelease: completed,
      completionObservedAt: completionEvent?.event_at ?? null,
      activeRelease,
      pendingGate,
      projectedAt: projection?.projected_at ?? null,
    };
  }

  async listHistory(input: Readonly<{
    organizationId: string;
    query: PromotionJobHistoryQuery;
    before: PromotionJobHistoryRepositoryPosition | null;
  }>): Promise<readonly CentralPromotionJobMonitoringInvocationRecord[]> {
    const before = input.before === null
      ? {}
      : {
          OR: [{ started_at: { lt: input.before.startedAt } }, {
            started_at: input.before.startedAt,
            monitoring_order_key: { lt: input.before.monitoringOrderKey },
          }],
        };
    const providerFilter = input.query.filter?.startsWith("provider:")
      ? input.query.filter.slice("provider:".length)
      : null;
    const [manifest, provider] = await Promise.all([
      providerFilter !== null
        ? Promise.resolve([])
        : this.central.manifest_reconciliation_job_invocations.findMany({
            where: {
              ...before,
              ...(input.query.trigger === undefined
                ? {}
                : { trigger_kind: input.query.trigger }),
              ...(input.query.outcome === undefined
                ? {}
                : { outcome: input.query.outcome }),
            },
            orderBy: [
              { started_at: "desc" },
              { monitoring_order_key: "desc" },
            ],
            take: HISTORY_SIDE_LIMIT,
            include: { detail: true },
          }),
      input.query.filter === "manifest"
        ? Promise.resolve([])
        : this.central.provider_promotion_invocation_projections.findMany({
            where: {
              ...before,
              provider: {
                organization_id: input.organizationId,
                ...(providerFilter === null
                  ? {}
                  : { provider_key: providerFilter }),
              },
              ...(input.query.trigger === undefined
                ? {}
                : { trigger_kind: input.query.trigger }),
              ...(input.query.outcome === undefined
                ? {}
                : { outcome: input.query.outcome }),
            },
            orderBy: [
              { started_at: "desc" },
              { monitoring_order_key: "desc" },
            ],
            take: HISTORY_SIDE_LIMIT,
            include: { provider: { select: { provider_key: true } } },
          }),
    ]);
    return [
      ...manifest.map(invocationFromManifest),
      ...provider.map(invocationFromProjection),
    ];
  }

  async readDetail(input: Readonly<{
    organizationId: string;
    reference: Readonly<{ kind: "manifest" | "provider"; centralId: string }>;
  }>): Promise<CentralPromotionJobMonitoringInvocationRecord | null> {
    if (input.reference.kind === "manifest") {
      const row = await this.central.manifest_reconciliation_job_invocations
        .findUnique({
          where: { run_id: input.reference.centralId },
          include: { detail: true },
        });
      return row === null ? null : invocationFromManifest(row);
    }
    const row = await this.central.provider_promotion_invocation_projections
      .findFirst({
        where: {
          id: input.reference.centralId,
          provider: { organization_id: input.organizationId },
        },
        include: { provider: { select: { provider_key: true } } },
      });
    return row === null ? null : invocationFromProjection(row);
  }
}

export interface PromotionJobMonitoringReadRepository {
  captureEligibleRoster(): Promise<PromotionJobLivenessRosterSnapshotRecord>;
  readEvaluator(): Promise<PromotionJobLivenessEvaluatorStateRecord>;
  listRoster(organizationId: string): Promise<readonly PromotionJobMonitoringRosterProvider[]>;
  readManifestEvidence(input: Readonly<{
    organizationId: string;
    deployment: string;
    now: Date;
    idCodec: PromotionJobMonitoringIdCodec;
    evaluatorCurrent: boolean;
  }>): Promise<CentralManifestPromotionMonitoringEvidence>;
  readProviderEvidence(input: Readonly<{
    organizationId: string;
    provider: PromotionJobMonitoringRosterProvider;
    active: CentralManifestPromotionMonitoringEvidence["activeReleases"] extends ReadonlyMap<string, infer T>
      ? T | null
      : never;
  }>): Promise<CentralProviderPromotionMonitoringEvidence>;
  listHistory(input: Readonly<{
    organizationId: string;
    query: PromotionJobHistoryQuery;
    before: PromotionJobHistoryRepositoryPosition | null;
  }>): Promise<readonly CentralPromotionJobMonitoringInvocationRecord[]>;
  readDetail(input: Readonly<{
    organizationId: string;
    reference: Readonly<{ kind: "manifest" | "provider"; centralId: string }>;
  }>): Promise<CentralPromotionJobMonitoringInvocationRecord | null>;
}

async function readLiveProvider(
  database: ProviderPrismaClient,
  observedAt: Date,
): Promise<LiveProviderPromotionMonitoringSnapshot> {
  const jobs = new PrismaProviderPromotionJobRepository(database);
  const [schedule, wake, ledger, completion, latest] = await Promise.all([
    jobs.loadSchedule(),
    jobs.loadWakeIntent(),
    database.promotion_ledger.findUnique({
      where: { singleton_key: true },
      select: { last_sequence: true },
    }),
    database.provider_activity_outbox.findFirst({
      where: { event_type: "provider_release_completed" },
      orderBy: [{ event_at: "desc" }, { id: "desc" }],
      select: { evidence: true },
    }),
    database.provider_promotion_job_invocations.findFirst({
      orderBy: [{ started_at: "desc" }, { run_id: "desc" }],
      select: { lifecycle_state: true, outcome: true },
    }),
  ]);
  const latestSummary = latest === null ? null : {
    lifecycleState: latest.lifecycle_state as PromotionJobInvocation["lifecycleState"],
    outcome: latest.outcome as PromotionJobInvocation["outcome"],
  };
  return {
    observedAt,
    schedule,
    wake,
    settledPosition: ledger?.last_sequence ?? 0n,
    completedRelease: safeCompletion(completion?.evidence ?? null),
    executionState: executionState(latestSummary, wake),
  };
}

function lastKnownFacts(
  central: CentralProviderPromotionMonitoringEvidence,
  idCodec: PromotionJobMonitoringIdCodec,
  scope: { readonly organizationId: string; readonly deployment: string },
): ProviderPromotionMonitoringLocalFacts | null {
  const projection = central.latestProjection;
  const observation = central.observation;
  if (projection === null && central.completedRelease === null
    && observation?.judgment === null) return null;
  const observedAt = [
    central.projectedAt,
    central.completionObservedAt,
    observation?.trustedObservedAt ?? null,
    observation?.observedAt ?? null,
  ].filter((value): value is Date => value !== null).sort((left, right) =>
    right.getTime() - left.getTime()
  )[0];
  if (observedAt === null || observedAt === undefined) return null;
  return {
    observedAt: observedAt.toISOString(),
    schedule: mapObservedSchedule(observation),
    wake: null,
    settledPosition: furthestPosition(
      projection?.settledPosition?.toString() ?? null,
      central.completedRelease?.position ?? null,
    ),
    completedRelease: central.completedRelease,
    latestInvocation: projection === null
      ? null
      : mapInvocation(projection, idCodec, scope),
    executionState: projection?.outcome === "blocked"
      ? "blocked"
      : projection?.outcome === "failed"
        ? "failed"
        : "ready",
    projectionLagMs: projectionLag(central.projectedAt, projection),
  };
}

function furthestPosition(
  first: string | null,
  second: string | null,
): string | null {
  if (first === null) return second;
  if (second === null) return first;
  return BigInt(first) >= BigInt(second) ? first : second;
}

function liveFacts(
  live: LiveProviderPromotionMonitoringSnapshot,
  central: CentralProviderPromotionMonitoringEvidence,
  idCodec: PromotionJobMonitoringIdCodec,
  scope: { readonly organizationId: string; readonly deployment: string },
): ProviderPromotionMonitoringLocalFacts {
  const projection = central.latestProjection;
  return {
    observedAt: live.observedAt.toISOString(),
    schedule: mapSchedule(live.schedule, live.observedAt),
    wake: mapWake(live.wake),
    settledPosition: live.settledPosition.toString(),
    completedRelease: live.completedRelease,
    latestInvocation: projection === null
      ? null
      : mapInvocation(projection, idCodec, scope),
    executionState: live.executionState,
    projectionLagMs: projectionLag(central.projectedAt, projection),
  };
}

function projectionLag(
  projectedAt: Date | null,
  projection: CentralPromotionJobMonitoringInvocationRecord | null,
): number | null {
  if (projectedAt === null || projection?.finishedAt === null
    || projection === null) return null;
  return Math.max(0, projectedAt.getTime() - projection.finishedAt.getTime());
}

function evaluatorView(
  evaluator: PromotionJobLivenessEvaluatorStateRecord,
  roster: PromotionJobLivenessRosterSnapshotRecord,
  now: Date,
): PromotionJobMonitoringOverview["evaluator"] {
  const expected = roster.providers.length + 1;
  const lastSuccessfulAt = evaluator.lastSuccessfulEvaluationAt?.getTime()
    ?? null;
  const evaluatorAgeMilliseconds = lastSuccessfulAt === null
    ? null
    : now.getTime() - lastSuccessfulAt;
  // The evaluator runs every minute. Keep one missed window healthy, matching
  // the liveness contract, but never let a dead active evaluator remain
  // "current" after the second missed window.
  const temporallyCurrent = evaluator.lifecycle !== "active" || (
    evaluatorAgeMilliseconds !== null
    && evaluatorAgeMilliseconds >= 0
    && evaluatorAgeMilliseconds <= evaluator.cadenceSeconds * 2_000
  );
  const current = evaluator.state === "current"
    && evaluator.rosterDigest === roster.rosterDigest
    && evaluator.expectedCount === expected
    && evaluator.manifestEvaluated === true
    && temporallyCurrent;
  return {
    state: current ? "current" : evaluator.state === "current" ? "stale" : evaluator.state,
    observedAt: iso(evaluator.lastSuccessfulEvaluationAt),
    evaluatedThrough: iso(evaluator.evaluatedThrough),
    rosterVersion: evaluator.rosterVersion?.toString() ?? null,
    rosterHighWater: evaluator.rosterHighWater?.toString() ?? null,
    rosterDigest: evaluator.rosterDigest,
    expectedCount: evaluator.expectedCount,
    reachableCount: evaluator.reachableCount,
    unavailableCount: evaluator.unavailableCount,
    manifestEvaluated: evaluator.manifestEvaluated,
    failureCode: asFailureCode(evaluator.lastFailureCode),
  };
}

function olderThan(
  item: PromotionJobInvocationMonitoring,
  position: PromotionJobHistoryRepositoryPosition | null,
): boolean {
  if (position === null) return true;
  const time = new Date(item.startedAt).getTime();
  return time < position.startedAt.getTime()
    || (time === position.startedAt.getTime()
      && item.monitoringId.localeCompare(position.monitoringId) < 0);
}

function operationFromUnknown(value: unknown): PromotionJobOperationMonitoring {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Promotion operation evidence is invalid.");
  }
  const row = value as Record<string, unknown>;
  return {
    operationNumber: (row.operationIndex as number) + 1,
    kind: row.operationKind as string,
    state: row.state as PromotionJobOperationMonitoring["state"],
    sendCount: row.sendCount as number,
    sentAt: row.sentAt as string | null,
    acknowledgedAt: row.acknowledgedAt as string | null,
    operationIdDigest: row.operationIdDigest as string,
    requestDigest: row.requestDigest as string,
    receiptDigest: row.receiptDigest as string | null,
  };
}

function attemptFromUnknown(
  value: unknown,
  kind: "provider" | "manifest",
): PromotionJobAttemptMonitoring {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Promotion attempt evidence is invalid.");
  }
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.recentOperations)) {
    throw new Error("Promotion attempt operations are invalid.");
  }
  return {
    attemptNumber: (row.snapshotOrdinal as number) + 1,
    kind,
    state: row.observedState as string,
    targetPosition: row.targetPosition as string,
    retryCount: row.retryCount as number,
    failureCode: asFailureCode(row.safeFailureCode as string | null),
    publicReleaseId: kind === "manifest"
      ? row.publicReleaseId as string | null
      : null,
    releaseFingerprint: row.releaseFingerprint as string | null,
    totalOperationCount: row.totalOperationCount as number,
    truncatedOperationCount: row.truncatedOperationCount as number,
    orderedOperationDigest: row.orderedOperationDigest as string,
    operationSummariesDigest: row.operationSummariesDigest as string,
    operations: row.recentOperations.slice(-25).map(operationFromUnknown),
    observedAt: row.observedAt as string,
  };
}

function detailFromRecord(
  record: CentralPromotionJobMonitoringInvocationRecord,
  invocation: PromotionJobInvocationMonitoring,
): PromotionJobInvocationDetail {
  let attempts: readonly PromotionJobAttemptMonitoring[] = [];
  if (record.canonicalDetailBody !== null) {
    if (
      record.canonicalDetailDigest === null
      || promotionJobSha256(record.canonicalDetailBody)
        !== record.canonicalDetailDigest
      || Buffer.byteLength(record.canonicalDetailBody, "utf8") > 65_536
    ) throw new Error("Promotion detail digest is invalid.");
    const parsed: unknown = JSON.parse(record.canonicalDetailBody);
    if (
      !Array.isArray(parsed)
      || parsed.length > 25
      || canonicalJson(parsed) !== record.canonicalDetailBody
    ) throw new Error("Promotion detail evidence is invalid.");
    attempts = parsed.map((attempt) =>
      attemptFromUnknown(attempt, record.kind)
    );
  }
  if (
    attempts.length !== record.attemptCount
    || !SHA256_PATTERN.test(record.attemptSetDigest)
  ) throw new Error("Promotion attempt totals are invalid.");
  return {
    invocation,
    totalAttemptCount: record.attemptCount,
    truncatedAttemptCount: record.attemptCount - attempts.length,
    attemptSetDigest: record.attemptSetDigest,
    attempts,
  };
}

/** Joins bounded central observations and independent provider gateway reads. */
export class PromotionJobMonitoringReadService {
  readonly #cursor: PromotionJobMonitoringCursorCodec;
  readonly #ids: PromotionJobMonitoringIdCodec;
  readonly #now: () => Date;
  readonly #overviewProviderReadTimeoutMs: number;
  readonly #readLiveProvider: (
    database: ProviderPrismaClient,
    observedAt: Date,
  ) => Promise<LiveProviderPromotionMonitoringSnapshot>;

  constructor(private readonly options: Readonly<{
    repository: PromotionJobMonitoringReadRepository;
    gateway: Pick<BoundedProviderDatabaseGateway, "runWithAdminProviderDatabase">;
    deployment: string;
    secret: Uint8Array;
    now?: () => Date;
    overviewProviderReadTimeoutMs?: number;
    readLiveProvider?: (
      database: ProviderPrismaClient,
      observedAt: Date,
    ) => Promise<LiveProviderPromotionMonitoringSnapshot>;
  }>) {
    this.#cursor = new PromotionJobMonitoringCursorCodec(options.secret);
    this.#ids = new PromotionJobMonitoringIdCodec(options.secret);
    this.#now = options.now ?? (() => new Date());
    this.#overviewProviderReadTimeoutMs = options.overviewProviderReadTimeoutMs
      ?? OVERVIEW_PROVIDER_READ_TIMEOUT_MS;
    if (
      !Number.isInteger(this.#overviewProviderReadTimeoutMs)
      || this.#overviewProviderReadTimeoutMs < 1
      || this.#overviewProviderReadTimeoutMs > 60_000
    ) {
      throw new TypeError("Promotion monitoring overview timeout is invalid.");
    }
    this.#readLiveProvider = options.readLiveProvider ?? readLiveProvider;
  }

  async overview(input: Readonly<{
    organizationId: string;
  }>): Promise<PromotionJobMonitoringOverview> {
    const now = this.#now();
    const providerReadDeadline = Date.now()
      + this.#overviewProviderReadTimeoutMs;
    const [roster, providers, evaluator] = await Promise.all([
      this.options.repository.captureEligibleRoster(),
      this.options.repository.listRoster(input.organizationId),
      this.options.repository.readEvaluator(),
    ]);
    const evaluated = evaluatorView(evaluator, roster, now);
    const evaluatorCurrent = evaluated.state === "current";
    const scope = {
      organizationId: input.organizationId,
      deployment: this.options.deployment,
    };
    const manifest = await this.options.repository.readManifestEvidence({
      ...scope,
      now,
      idCodec: this.#ids,
      evaluatorCurrent,
    });
    const providerReadDeadlineLatch = createDeadlineLatch(providerReadDeadline);
    let providerViews: PromotionJobMonitoringOverview["providers"];
    try {
      providerViews = await mapBounded(providers, async (provider) => {
        const central = await this.options.repository.readProviderEvidence({
          organizationId: input.organizationId,
          provider,
          active: manifest.activeReleases.get(provider.providerKey) ?? null,
        });
        let routed: ProviderDatabaseOperationResult<LiveProviderPromotionMonitoringSnapshot>
          | null = null;
        let probeFailureCode: string | null = null;
        if (provider.lifecycle === "active") {
          const settlement = await settleByDeadline(
            () => this.options.gateway.runWithAdminProviderDatabase(
              {
                organizationId: input.organizationId,
                providerId: provider.id,
                deadlineAt: providerReadDeadlineLatch.deadlineAt,
              },
              (database) => this.#readLiveProvider(database, this.#now()),
            ),
            providerReadDeadlineLatch,
          );
          if (settlement.state === "fulfilled") {
            routed = settlement.value;
          } else {
            probeFailureCode = settlement.state === "timed_out"
              ? "MONITORING_PROBE_BUDGET_EXHAUSTED"
              : "MONITORING_PROBE_FAILED";
          }
        }
        const centralFacts: ProviderPromotionMonitoringCentralFacts = {
          activeRelease: central.activeRelease,
          pendingGate: central.pendingGate,
        };
        return judgeProviderPromotionMonitoring({
          roster: provider,
          live: routed?.state === "reachable"
            ? liveFacts(routed.value, central, this.#ids, scope)
            : null,
          lastKnown: lastKnownFacts(central, this.#ids, scope),
          central: centralFacts,
          routeFailureCode: routed?.state === "unreachable"
            ? asFailureCode(routed.failureCode)
            : probeFailureCode,
          evaluatorCurrent,
        });
      });
    } finally {
      providerReadDeadlineLatch.close();
    }
    return {
      observedAt: now.toISOString(),
      roster: {
        observedAt: roster.capturedAt.toISOString(),
        version: roster.rosterVersion.toString(),
        highWater: roster.rosterHighWater.toString(),
        digest: roster.rosterDigest,
        providerCount: providers.length,
        eligibleProviderCount: roster.providers.length,
      },
      evaluator: evaluated,
      manifest: manifest.view,
      providers: providerViews,
    };
  }

  async history(input: Readonly<{
    organizationId: string;
    query: PromotionJobHistoryQuery;
  }>): Promise<PromotionJobHistoryPage> {
    const roster = await this.options.repository.captureEligibleRoster();
    const scope = {
      organizationId: input.organizationId,
      deployment: this.options.deployment,
      rosterDigest: roster.rosterDigest,
      query: input.query,
    };
    const cursorPosition = input.query.cursor === undefined
      ? null
      : this.#cursor.decode(input.query.cursor, scope);
    const idScope = {
      organizationId: input.organizationId,
      deployment: this.options.deployment,
    };
    let position: PromotionJobHistoryRepositoryPosition | null = null;
    if (cursorPosition !== null) {
      try {
        const reference = this.#ids.decode(
          idScope,
          cursorPosition.monitoringId,
        );
        position = {
          startedAt: cursorPosition.startedAt,
          monitoringId: cursorPosition.monitoringId,
          monitoringOrderKey: promotionJobMonitoringOrderKey(reference),
        };
      } catch (error) {
        if (error instanceof PromotionJobMonitoringNotFoundError) {
          throw new InvalidPromotionJobMonitoringCursorError();
        }
        throw error;
      }
    }
    const records = await this.options.repository.listHistory({
      organizationId: input.organizationId,
      query: input.query,
      before: position,
    });
    const mapped = records.map((record) => ({
      record,
      invocation: mapInvocation(record, this.#ids, idScope),
    })).filter(({ invocation }) => olderThan(invocation, position)).sort(
      (left, right) =>
        right.record.startedAt.getTime() - left.record.startedAt.getTime()
        || right.invocation.monitoringId.localeCompare(
          left.invocation.monitoringId,
        ),
    );
    const page = mapped.slice(0, input.query.limit);
    const items = page.map(({ invocation }) => invocation);
    const last = page.at(-1);
    return {
      items,
      nextCursor: mapped.length <= input.query.limit || last === undefined
        ? null
        : this.#cursor.encode(scope, {
            startedAt: last.record.startedAt,
            monitoringId: last.invocation.monitoringId,
          }),
      rosterDigest: roster.rosterDigest,
    };
  }

  async detail(input: Readonly<{
    organizationId: string;
    monitoringId: string;
  }>): Promise<PromotionJobInvocationDetail | null> {
    const scope = {
      organizationId: input.organizationId,
      deployment: this.options.deployment,
    };
    let reference;
    try {
      reference = this.#ids.decode(scope, input.monitoringId);
    } catch (error) {
      if (error instanceof PromotionJobMonitoringNotFoundError) return null;
      throw error;
    }
    if (!UUID_PATTERN.test(reference.centralId)) return null;
    const record = await this.options.repository.readDetail({
      organizationId: input.organizationId,
      reference,
    });
    if (record === null) return null;
    const invocation = mapInvocation(record, this.#ids, scope);
    return detailFromRecord(record, invocation);
  }
}

export function createPromotionJobMonitoringRuntime(input: Readonly<{
  central: CentralPrismaClient;
  gateway: Pick<BoundedProviderDatabaseGateway, "runWithAdminProviderDatabase">;
  deployment: string;
  secret: Uint8Array;
  now?: () => Date;
}>): Pick<PromotionJobMonitoringReadService, "overview" | "history" | "detail"> {
  const service = new PromotionJobMonitoringReadService({
    repository: new PrismaPromotionJobMonitoringReadRepository(input.central),
    gateway: input.gateway,
    deployment: input.deployment,
    secret: input.secret,
    now: input.now,
  });
  return {
    overview: (request) => service.overview(request),
    history: (request) => service.history(request),
    detail: (request) => service.detail(request),
  };
}
