import { canonicalJson } from "@packscout/contracts";
import {
  PROMOTION_JOB_MAX_RECENT_OPERATIONS,
  PromotionJobPersistenceError,
  assertProgress,
  assertPromotionJobSha256,
  assertPromotionJobUuid,
  assertSafeFailureCode,
  normalizePromotionAttemptSnapshots,
  promotionJobSha256,
  validDate,
  type ManifestReconciliationWakeCause,
  type PromotionInvocationAttemptEvidence,
  type PromotionInvocationAttemptSnapshot,
  type PromotionJobOutcome,
  type PromotionJobProgress,
  type PromotionJobTriggerKind,
} from "./promotion-job-persistence-types.ts";

const OPAQUE_LOCAL_ID_PATTERN = /^[\u0021-\u007e]{1,512}$/u;

export interface ManifestGateIntent {
  readonly providerId: string;
  readonly requestedGeneration: bigint;
  readonly acknowledgedGeneration: bigint;
  readonly latestCause: ManifestReconciliationWakeCause | null;
  readonly latestEvidenceDigest: string | null;
  readonly latestRequestedAt: Date | null;
  readonly pending: boolean;
}

export interface ProjectProviderPromotionInvocationInput {
  readonly providerId: string;
  /** Provider-local identity is digested and never stored in central. */
  readonly opaqueProviderInvocationId: string;
  readonly triggerKind: PromotionJobTriggerKind;
  readonly outcome: PromotionJobOutcome;
  readonly scheduledCheckinAt: Date | null;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly progress: PromotionJobProgress;
  readonly safeFailureCode: string | null;
  readonly attempts: readonly PromotionInvocationAttemptEvidence[];
  readonly projectedAt: Date;
}

export interface ProviderPromotionInvocationProjection {
  readonly id: string;
  readonly providerId: string;
  readonly providerInvocationIdDigest: string;
  readonly projectionDigest: string;
  readonly triggerKind: PromotionJobTriggerKind;
  readonly outcome: PromotionJobOutcome;
  readonly scheduledCheckinAt: Date | null;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly progress: PromotionJobProgress;
  readonly safeFailureCode: string | null;
  readonly canonicalDetailBody: string;
  readonly canonicalDetailDigest: string;
  readonly projectedAt: Date;
}

export interface ProviderPromotionProjectionRecord {
  readonly providerInvocationIdDigest: string;
  readonly projectionDigest: string;
  readonly canonicalDetailBody: string;
  readonly canonicalDetailDigest: string;
  readonly snapshots: readonly PromotionInvocationAttemptSnapshot[];
}

export function providerPromotionInvocationProjectionRecord(
  input: ProjectProviderPromotionInvocationInput,
): ProviderPromotionProjectionRecord {
  assertProjectProviderPromotionInvocationInput(input);
  const snapshots = normalizePromotionAttemptSnapshots(input.attempts, "provider");
  if (snapshots.length !== input.progress.promotionAttemptCount) {
    throw new PromotionJobPersistenceError("PROMOTION_JOB_ATTEMPT_CONFLICT");
  }
  const providerInvocationIdDigest = promotionJobSha256(canonicalJson({
    domain: "packscout/provider-promotion-invocation/v1",
    providerId: input.providerId.toLowerCase(),
    opaqueProviderInvocationId: input.opaqueProviderInvocationId,
  }));
  const canonicalDetailBody = canonicalJson(snapshots.map((snapshot) => ({
    snapshotOrdinal: snapshot.snapshotOrdinal,
    attemptIdentityDigest: snapshot.attemptIdentityDigest,
    snapshotDigest: snapshot.snapshotDigest,
    observedState: snapshot.observedState,
    targetPosition: snapshot.targetPosition.toString(),
    retryCount: snapshot.retryCount,
    safeFailureCode: snapshot.safeFailureCode,
    releaseFingerprint: snapshot.releaseFingerprint,
    totalOperationCount: snapshot.totalOperationCount,
    orderedOperationDigest: snapshot.orderedOperationDigest,
    truncatedOperationCount: snapshot.truncatedOperationCount,
    operationSummariesDigest: snapshot.operationSummariesDigest,
    observedAt: snapshot.observedAt.toISOString(),
    recentOperations: snapshot.recentOperations.slice(
      -PROMOTION_JOB_MAX_RECENT_OPERATIONS,
    ).map((operation) => ({
      operationIndex: operation.operationIndex,
      operationKind: operation.operationKind,
      state: operation.state,
      sendCount: operation.sendCount,
      sentAt: operation.sentAt?.toISOString() ?? null,
      acknowledgedAt: operation.acknowledgedAt?.toISOString() ?? null,
      operationIdDigest: operation.operationIdDigest,
      requestDigest: operation.requestDigest,
      receiptDigest: operation.receiptDigest,
    })),
  })));
  if (Buffer.byteLength(canonicalDetailBody, "utf8") > 65_536) {
    throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
  }
  const canonicalDetailDigest = promotionJobSha256(canonicalDetailBody);
  const projectionDigest = promotionJobSha256(canonicalJson({
    domain: "packscout/provider-promotion-projection/v1",
    providerId: input.providerId.toLowerCase(),
    providerInvocationIdDigest,
    triggerKind: input.triggerKind,
    outcome: input.outcome,
    scheduledCheckinAt: input.scheduledCheckinAt?.toISOString() ?? null,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    progress: {
      beforeLanePosition: input.progress.beforeLanePosition?.toString() ?? null,
      afterLanePosition: input.progress.afterLanePosition?.toString() ?? null,
      beforeSettledPosition:
        input.progress.beforeSettledPosition?.toString() ?? null,
      afterSettledPosition:
        input.progress.afterSettledPosition?.toString() ?? null,
      cycleCount: input.progress.cycleCount,
      promotionAttemptCount: input.progress.promotionAttemptCount,
      publicationCount: input.progress.publicationCount,
      operationCount: input.progress.operationCount,
    },
    safeFailureCode: input.safeFailureCode,
    canonicalDetailDigest,
  }));
  return {
    providerInvocationIdDigest,
    projectionDigest,
    canonicalDetailBody,
    canonicalDetailDigest,
    snapshots,
  };
}

export function assertManifestGateIntentInput(input: Readonly<{
  providerId: string;
  requestedGeneration: bigint;
  cause: ManifestReconciliationWakeCause;
  evidenceDigest: string;
  requestedAt: Date;
}>): void {
  assertPromotionJobUuid(input.providerId);
  assertPromotionJobSha256(input.evidenceDigest);
  if (input.requestedGeneration < 1n || !validDate(input.requestedAt)
    || !["provider_completion", "manifest_eligibility_change", "continuation"]
      .includes(input.cause)) {
    throw new PromotionJobPersistenceError("PROMOTION_JOB_GATE_INTENT_INVALID");
  }
}

function assertProjectProviderPromotionInvocationInput(
  input: ProjectProviderPromotionInvocationInput,
): void {
  assertPromotionJobUuid(input.providerId);
  assertProgress(input.progress);
  assertSafeFailureCode(input.safeFailureCode);
  if (!OPAQUE_LOCAL_ID_PATTERN.test(input.opaqueProviderInvocationId)
    || !["change_wake", "reconciliation_cron", "manual", "continuation"]
      .includes(input.triggerKind)
    || !["caught_up", "no_change", "coalesced", "continuation_required",
      "deferred", "blocked", "failed"].includes(input.outcome)
    || !validDate(input.startedAt) || !validDate(input.finishedAt)
    || !validDate(input.projectedAt)
    || input.finishedAt.getTime() < input.startedAt.getTime()
    || input.projectedAt.getTime() < input.finishedAt.getTime()
    || (input.scheduledCheckinAt !== null
      && !validDate(input.scheduledCheckinAt))
    || (input.triggerKind === "reconciliation_cron")
      !== (input.scheduledCheckinAt !== null)) {
    throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
  }
}
