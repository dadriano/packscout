import { createHash } from "node:crypto";
import { canonicalJson } from "@packscout/contracts";

export const PROMOTION_JOB_DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const PROMOTION_JOB_INVOCATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const PROMOTION_JOB_INVOCATION_LIMIT = 50_000;
export const PROMOTION_JOB_MAX_RELATED_ATTEMPTS = 25;
export const PROMOTION_JOB_MAX_RECENT_OPERATIONS = 25;
export const PROMOTION_JOB_SCHEDULE_CADENCE_SECONDS = 60;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_CODE_PATTERN = /^[A-Z0-9_]{1,128}$/u;
const SAFE_STATE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const SAFE_OPERATION_KIND_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const OWNERSHIP_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const OPAQUE_DELIVERY_KEY_PATTERN = /^[\u0021-\u007e]{1,512}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_COUNTER = 1_000_000;

export type PromotionJobAuthority =
  | "provider_publication"
  | "manifest_reconciliation";

export type ProviderPromotionWakeCause =
  | "canonical_settlement"
  | "central_invalidation"
  | "continuation";

export type ManifestReconciliationWakeCause =
  | "provider_completion"
  | "manifest_eligibility_change"
  | "continuation";

export type PromotionWakeCause =
  | ProviderPromotionWakeCause
  | ManifestReconciliationWakeCause;

export type PromotionWakeDeliveryState =
  | "pending"
  | "accepted"
  | "delivered"
  | "retry_wait"
  | "failed";

export type PromotionJobTriggerKind =
  | "change_wake"
  | "reconciliation_cron"
  | "manual"
  | "continuation";

export type PromotionJobOutcome =
  | "caught_up"
  | "no_change"
  | "coalesced"
  | "continuation_required"
  | "deferred"
  | "blocked"
  | "failed";

export type PromotionJobAdmissionDisposition =
  | "started"
  | "existing"
  | "existing_pruned";

export type PromotionJobScheduleLifecycle =
  | "pending_activation"
  | "active"
  | "paused";

export interface PromotionJobDeliveryEnvelope {
  /** Opaque transport identity. Only its authority-scoped digest is stored. */
  readonly opaqueKey: string;
  readonly issuedAt: Date;
  /** Must be exactly 30 days after issuedAt. */
  readonly expiresAt: Date;
}

export type PromotionInvocationTriggerRequest = Readonly<
  | {
      kind: "change_wake" | "continuation";
      observedWakeGeneration: bigint;
    }
  | {
      kind: "reconciliation_cron";
      scheduleEpoch: bigint;
      scheduleWindowIndex: bigint;
      scheduledDueAt: Date;
    }
  | { kind: "manual" }
>;

export type PromotionInvocationTrigger = Readonly<
  | Extract<PromotionInvocationTriggerRequest,
      { kind: "change_wake" | "continuation" }>
  | (Extract<PromotionInvocationTriggerRequest,
      { kind: "reconciliation_cron" }> & {
      readonly observedWakeGeneration: bigint | null;
    })
  | {
      readonly kind: "manual";
      readonly observedWakeGeneration: bigint | null;
    }
>;

export interface PromotionWakeIntent {
  readonly authority: PromotionJobAuthority;
  readonly requestedGeneration: bigint;
  readonly acknowledgedGeneration: bigint;
  readonly latestCause: PromotionWakeCause | null;
  readonly latestRequestedAt: Date | null;
  readonly pending: boolean;
  readonly latestDeliveryGeneration: bigint | null;
  readonly latestDeliveryState: PromotionWakeDeliveryState | null;
  readonly lastDeliveryAttemptAt: Date | null;
  readonly latestDeliveryFailureCode: string | null;
}

export interface PromotionJobSchedule {
  readonly authority: PromotionJobAuthority;
  readonly lifecycle: PromotionJobScheduleLifecycle;
  readonly scheduleEpoch: bigint;
  readonly cadenceSeconds: number;
  readonly baselineAt: Date | null;
  readonly activatedAt: Date | null;
  readonly pausedAt: Date | null;
  readonly lastAdmittedWindowIndex: bigint | null;
  readonly lastScheduledCheckinAt: Date | null;
  readonly nextExpectedCheckinAt: Date | null;
}

export interface ActivatePromotionJobScheduleInput {
  readonly scheduleEpoch: bigint;
  readonly baselineAt: Date;
  readonly activatedAt: Date;
}

export interface PausePromotionJobScheduleInput {
  readonly scheduleEpoch: bigint;
  readonly pausedAt: Date;
}

export interface PromotionJobProgress {
  readonly beforeLanePosition: bigint | null;
  readonly afterLanePosition: bigint | null;
  readonly beforeSettledPosition: bigint | null;
  readonly afterSettledPosition: bigint | null;
  readonly cycleCount: number;
  readonly promotionAttemptCount: number;
  readonly publicationCount: number;
  readonly operationCount: number;
}

export interface PromotionInvocationOperationSummary {
  readonly operationIndex: number;
  readonly operationKind: string;
  readonly state: "pending" | "sent" | "acknowledged";
  readonly sendCount: number;
  readonly sentAt: Date | null;
  readonly acknowledgedAt: Date | null;
  readonly operationIdDigest: string;
  readonly requestDigest: string;
  readonly receiptDigest: string | null;
}

export interface PromotionInvocationAttemptEvidence {
  readonly attemptKind: "provider" | "manifest";
  readonly attemptId: string;
  readonly observedState: string;
  readonly targetPosition: bigint;
  readonly retryCount: number;
  readonly safeFailureCode: string | null;
  readonly publicReleaseId: string | null;
  readonly releaseFingerprint: string | null;
  readonly totalOperationCount: number;
  readonly orderedOperationDigest: string;
  readonly recentOperations: readonly PromotionInvocationOperationSummary[];
  readonly observedAt: Date;
}

export interface PromotionInvocationAttemptSnapshot
  extends PromotionInvocationAttemptEvidence {
  readonly snapshotOrdinal: number;
  readonly attemptIdentityDigest: string;
  readonly truncatedOperationCount: number;
  readonly operationSummariesDigest: string;
  readonly snapshotDigest: string;
}

export interface PromotionJobInvocation {
  readonly runId: string;
  readonly authority: PromotionJobAuthority;
  readonly deliveryKeyDigest: string;
  readonly trigger: PromotionInvocationTrigger;
  readonly lifecycleState: "running" | "terminal";
  readonly outcome: PromotionJobOutcome | null;
  readonly requestedAt: Date;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly ownershipExpiresAt: Date | null;
  readonly scheduledCheckinAt: Date | null;
  readonly progress: PromotionJobProgress;
  readonly safeFailureCode: string | null;
  readonly continuationGeneration: bigint | null;
  readonly resultActiveGeneration: bigint | null;
  readonly resultPublicReleaseId: string | null;
  readonly resultReleaseFingerprint: string | null;
  readonly relatedAttemptCount: number;
  readonly relatedAttemptSetDigest: string;
  readonly retentionProtected: boolean;
  readonly attemptSnapshots?: readonly PromotionInvocationAttemptSnapshot[];
}

export interface PromotionJobAdmission {
  readonly disposition: PromotionJobAdmissionDisposition;
  readonly invocation: PromotionJobInvocation | null;
  readonly scheduledCheckinAt: Date | null;
}

export interface BeginPromotionJobInvocationInput {
  readonly delivery: PromotionJobDeliveryEnvelope;
  readonly trigger: PromotionInvocationTriggerRequest;
  readonly now: Date;
  readonly requestedAt: Date;
  readonly startedAt: Date;
  readonly ownershipKey: string;
  readonly ownershipToken: string;
  readonly ownershipExpiresAt: Date;
}

export interface RecordPromotionJobProgressInput {
  readonly runId: string;
  readonly ownershipToken: string;
  readonly now: Date;
  readonly progress: PromotionJobProgress;
  readonly attempts: readonly PromotionInvocationAttemptEvidence[];
  readonly retentionProtected?: boolean;
}

export interface TerminalizePromotionJobInvocationInput {
  readonly runId: string;
  readonly ownershipToken: string;
  readonly finishedAt: Date;
  readonly outcome: PromotionJobOutcome;
  readonly safeFailureCode?: string | null;
  readonly acknowledgeObservedWake?: boolean;
  readonly continuation?: Readonly<{
    requestedGeneration: bigint;
    requestedAt: Date;
  }>;
  readonly resultActiveGeneration?: bigint | null;
  readonly resultPublicReleaseId?: string | null;
  readonly resultReleaseFingerprint?: string | null;
  readonly retentionProtected?: boolean;
}

export interface ReconcileInterruptedPromotionJobInvocationInput {
  readonly runId: string;
  readonly reconciledAt: Date;
  readonly resolution: "continuation_required" | "failed";
  readonly safeFailureCode: string;
  readonly continuation?: Readonly<{
    requestedGeneration: bigint;
    requestedAt: Date;
  }>;
  readonly retentionProtected?: boolean;
}

export interface PromotionJobPruneResult {
  readonly invocationSummariesDeleted: number;
  readonly tombstonesDeleted: number;
  readonly moreEligibleSummaries: boolean;
  readonly moreExpiredTombstones: boolean;
}

export class PromotionJobPersistenceError extends Error {
  constructor(readonly code:
    | "PROMOTION_JOB_INPUT_INVALID"
    | "PROMOTION_JOB_DELIVERY_KEY_EXPIRED"
    | "PROMOTION_JOB_DELIVERY_CONFLICT"
    | "PROMOTION_JOB_INVOCATION_NOT_FOUND"
    | "PROMOTION_JOB_INVOCATION_TERMINAL"
    | "PROMOTION_JOB_OWNERSHIP_STALE"
    | "PROMOTION_JOB_PROGRESS_REGRESSED"
    | "PROMOTION_JOB_ATTEMPT_LIMIT"
    | "PROMOTION_JOB_ATTEMPT_CONFLICT"
    | "PROMOTION_JOB_WAKE_INVALID"
    | "PROMOTION_JOB_SCHEDULE_INVALID"
    | "PROMOTION_JOB_RECONCILIATION_REQUIRED"
    | "PROMOTION_JOB_PROJECTION_CONFLICT"
    | "PROMOTION_JOB_GATE_INTENT_INVALID") {
    super("Promotion job persistence state is invalid or unavailable.");
    this.name = "PromotionJobPersistenceError";
  }
}

export function promotionJobSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export const EMPTY_PROMOTION_ATTEMPT_SET_DIGEST = promotionJobSha256(
  canonicalJson([]),
);

export function promotionJobDeliveryDigest(
  authority: PromotionJobAuthority,
  opaqueKey: string,
): string {
  if (typeof opaqueKey !== "string"
    || !OPAQUE_DELIVERY_KEY_PATTERN.test(opaqueKey)) {
    throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
  }
  return promotionJobSha256(canonicalJson({
    domain: "packscout/promotion-job-delivery/v1",
    authority,
    opaqueKey,
  }));
}

export function promotionJobTriggerEvidenceDigest(
  authority: PromotionJobAuthority,
  trigger: PromotionInvocationTriggerRequest,
): string {
  assertTrigger(trigger);
  const evidence = trigger.kind === "reconciliation_cron"
    ? {
        kind: trigger.kind,
        scheduleEpoch: trigger.scheduleEpoch.toString(),
        scheduleWindowIndex: trigger.scheduleWindowIndex.toString(),
        scheduledDueAt: trigger.scheduledDueAt.toISOString(),
      }
    : trigger.kind === "manual"
      ? { kind: trigger.kind }
      : {
          kind: trigger.kind,
          observedWakeGeneration: trigger.observedWakeGeneration.toString(),
        };
  return promotionJobSha256(canonicalJson({
    domain: "packscout/promotion-job-trigger/v1",
    authority,
    evidence,
  }));
}

export function assertDeliveryEnvelope(
  envelope: PromotionJobDeliveryEnvelope,
  now: Date,
): void {
  promotionJobDeliveryDigest("provider_publication", envelope.opaqueKey);
  if (
    !validDate(envelope.issuedAt)
    || !validDate(envelope.expiresAt)
    || !validDate(now)
    || envelope.expiresAt.getTime() - envelope.issuedAt.getTime()
      !== PROMOTION_JOB_DELIVERY_RETENTION_MS
    || envelope.issuedAt.getTime() > now.getTime()
  ) {
    throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
  }
  if (now.getTime() >= envelope.expiresAt.getTime()) {
    throw new PromotionJobPersistenceError(
      "PROMOTION_JOB_DELIVERY_KEY_EXPIRED",
    );
  }
}

export function assertTrigger(trigger: PromotionInvocationTriggerRequest): void {
  if (trigger.kind === "change_wake" || trigger.kind === "continuation") {
    if (typeof trigger.observedWakeGeneration !== "bigint"
      || trigger.observedWakeGeneration < 1n) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
    }
    return;
  }
  if (trigger.kind === "reconciliation_cron") {
    if (
      typeof trigger.scheduleEpoch !== "bigint"
      || trigger.scheduleEpoch < 1n
      || typeof trigger.scheduleWindowIndex !== "bigint"
      || trigger.scheduleWindowIndex < 1n
      || !validDate(trigger.scheduledDueAt)
    ) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
    }
    return;
  }
  if (trigger.kind !== "manual") {
    throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
  }
}

export function assertProgress(progress: PromotionJobProgress): void {
  const counters = [
    progress.cycleCount,
    progress.promotionAttemptCount,
    progress.publicationCount,
    progress.operationCount,
  ];
  if (
    counters.some((value) =>
      !Number.isSafeInteger(value) || value < 0 || value > MAX_COUNTER)
    || progress.promotionAttemptCount > PROMOTION_JOB_MAX_RELATED_ATTEMPTS
    || progress.publicationCount > progress.promotionAttemptCount
    || !validPositionPair(
      progress.beforeLanePosition,
      progress.afterLanePosition,
    )
    || !validPositionPair(
      progress.beforeSettledPosition,
      progress.afterSettledPosition,
    )
  ) {
    throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
  }
}

export function assertOwnership(input: {
  readonly ownershipKey: string;
  readonly ownershipToken: string;
  readonly ownershipExpiresAt: Date;
  readonly startedAt: Date;
}): void {
  if (
    typeof input.ownershipKey !== "string"
    || !OWNERSHIP_KEY_PATTERN.test(input.ownershipKey)
    || typeof input.ownershipToken !== "string"
    || !UUID_PATTERN.test(input.ownershipToken)
    || !validDate(input.ownershipExpiresAt)
    || input.ownershipExpiresAt.getTime() <= input.startedAt.getTime()
  ) {
    throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
  }
}

export function assertSafeFailureCode(value: string | null): void {
  if (value !== null && !SAFE_CODE_PATTERN.test(value)) {
    throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
  }
}

export function assertPromotionJobUuid(value: string): void {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
  }
}

export function assertPromotionJobSha256(value: string): void {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
  }
}

export function normalizePromotionAttemptSnapshots(
  evidence: readonly PromotionInvocationAttemptEvidence[],
  expectedKind: "provider" | "manifest",
): readonly PromotionInvocationAttemptSnapshot[] {
  if (evidence.length > PROMOTION_JOB_MAX_RELATED_ATTEMPTS) {
    throw new PromotionJobPersistenceError("PROMOTION_JOB_ATTEMPT_LIMIT");
  }
  const seen = new Set<string>();
  return evidence.map((attempt, snapshotOrdinal) => {
    assertAttemptEvidence(attempt, expectedKind);
    const attemptId = attempt.attemptId.toLowerCase();
    if (seen.has(attemptId)) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_ATTEMPT_CONFLICT");
    }
    seen.add(attemptId);
    const recentOperations = attempt.recentOperations.map((operation) => ({
      ...operation,
      operationIdDigest: operation.operationIdDigest.toLowerCase(),
      requestDigest: operation.requestDigest.toLowerCase(),
      receiptDigest: operation.receiptDigest?.toLowerCase() ?? null,
    }));
    const operationSummariesDigest = promotionJobSha256(canonicalJson(
      serializeOperations(recentOperations),
    ));
    const attemptIdentityDigest = promotionJobSha256(canonicalJson({
      attemptKind: expectedKind,
      attemptId,
    }));
    const truncatedOperationCount =
      attempt.totalOperationCount - recentOperations.length;
    const normalized = {
      ...attempt,
      attemptKind: expectedKind,
      attemptId,
      publicReleaseId: attempt.publicReleaseId?.toLowerCase() ?? null,
      recentOperations,
      snapshotOrdinal,
      attemptIdentityDigest,
      truncatedOperationCount,
      operationSummariesDigest,
    };
    const snapshotDigest = promotionJobSha256(canonicalJson(
      serializeSnapshotForDigest(normalized),
    ));
    return { ...normalized, snapshotDigest };
  });
}

export function promotionAttemptSetDigest(
  snapshots: readonly PromotionInvocationAttemptSnapshot[],
): string {
  return promotionJobSha256(canonicalJson(snapshots.map((snapshot) => ({
    attemptIdentityDigest: snapshot.attemptIdentityDigest,
    snapshotDigest: snapshot.snapshotDigest,
  }))));
}

export function canonicalPromotionAttemptDetail(
  snapshots: readonly PromotionInvocationAttemptSnapshot[],
): string {
  return canonicalJson(snapshots.map((snapshot) => ({
    ...serializeSnapshotForDigest(snapshot),
    attemptKind: snapshot.attemptKind,
    attemptId: snapshot.attemptId,
    snapshotOrdinal: snapshot.snapshotOrdinal,
    snapshotDigest: snapshot.snapshotDigest,
    recentOperations: serializeOperations(snapshot.recentOperations),
  })));
}

export function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function validPositionPair(before: bigint | null, after: bigint | null): boolean {
  return (before === null) === (after === null)
    && (before === null || (
      typeof before === "bigint"
      && typeof after === "bigint"
      && before >= 0n
      && after >= before
    ));
}

function assertAttemptEvidence(
  attempt: PromotionInvocationAttemptEvidence,
  expectedKind: "provider" | "manifest",
): void {
  if (
    attempt.attemptKind !== expectedKind
    || !UUID_PATTERN.test(attempt.attemptId)
    || !SAFE_STATE_PATTERN.test(attempt.observedState)
    || attempt.targetPosition < 0n
    || !Number.isSafeInteger(attempt.retryCount)
    || attempt.retryCount < 0
    || attempt.retryCount > MAX_COUNTER
    || !Number.isSafeInteger(attempt.totalOperationCount)
    || attempt.totalOperationCount < 0
    || attempt.totalOperationCount > MAX_COUNTER
    || attempt.recentOperations.length > PROMOTION_JOB_MAX_RECENT_OPERATIONS
    || attempt.recentOperations.length > attempt.totalOperationCount
    || (attempt.publicReleaseId === null) !==
      (attempt.releaseFingerprint === null)
    || (attempt.publicReleaseId !== null
      && !UUID_PATTERN.test(attempt.publicReleaseId))
    || (attempt.releaseFingerprint !== null
      && !SHA256_PATTERN.test(attempt.releaseFingerprint))
    || !SHA256_PATTERN.test(attempt.orderedOperationDigest)
    || !validDate(attempt.observedAt)
  ) {
    throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
  }
  assertSafeFailureCode(attempt.safeFailureCode);
  const firstRecentIndex =
    attempt.totalOperationCount - attempt.recentOperations.length;
  for (const [recentIndex, operation] of attempt.recentOperations.entries()) {
    if (
      !Number.isSafeInteger(operation.operationIndex)
      || operation.operationIndex !== firstRecentIndex + recentIndex
      || !SAFE_OPERATION_KIND_PATTERN.test(operation.operationKind)
      || !["pending", "sent", "acknowledged"].includes(operation.state)
      || !Number.isSafeInteger(operation.sendCount)
      || operation.sendCount < 0
      || operation.sendCount > MAX_COUNTER
      || !validOperationTimes(operation)
      || !SHA256_PATTERN.test(operation.operationIdDigest)
      || !SHA256_PATTERN.test(operation.requestDigest)
      || (operation.receiptDigest !== null
        && !SHA256_PATTERN.test(operation.receiptDigest))
    ) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
    }
  }
}

function validOperationTimes(
  operation: PromotionInvocationOperationSummary,
): boolean {
  if (
    (operation.sentAt !== null && !validDate(operation.sentAt))
    || (operation.acknowledgedAt !== null
      && !validDate(operation.acknowledgedAt))
  ) return false;
  if (operation.state === "pending") {
    return operation.sendCount === 0
      && operation.sentAt === null
      && operation.acknowledgedAt === null;
  }
  if (operation.state === "sent") {
    return operation.sendCount >= 1
      && operation.sentAt !== null
      && operation.acknowledgedAt === null;
  }
  return operation.sendCount >= 1
    && operation.sentAt !== null
    && operation.acknowledgedAt !== null
    && operation.acknowledgedAt.getTime() >= operation.sentAt.getTime();
}

function serializeOperations(
  operations: readonly PromotionInvocationOperationSummary[],
): readonly Record<string, unknown>[] {
  return operations.map((operation) => ({
    ...operation,
    sentAt: operation.sentAt?.toISOString() ?? null,
    acknowledgedAt: operation.acknowledgedAt?.toISOString() ?? null,
  }));
}

function serializeSnapshotForDigest(
  snapshot: Omit<PromotionInvocationAttemptSnapshot, "snapshotDigest">,
): Record<string, unknown> {
  return {
    attemptIdentityDigest: snapshot.attemptIdentityDigest,
    observedState: snapshot.observedState,
    targetPosition: snapshot.targetPosition.toString(),
    retryCount: snapshot.retryCount,
    safeFailureCode: snapshot.safeFailureCode,
    publicReleaseId: snapshot.publicReleaseId,
    releaseFingerprint: snapshot.releaseFingerprint,
    totalOperationCount: snapshot.totalOperationCount,
    orderedOperationDigest: snapshot.orderedOperationDigest,
    recentOperationCount: snapshot.recentOperations.length,
    truncatedOperationCount: snapshot.truncatedOperationCount,
    operationSummariesDigest: snapshot.operationSummariesDigest,
    observedAt: snapshot.observedAt.toISOString(),
  };
}
