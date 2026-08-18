import {
  PRODUCTION_PROVIDER_RELEASE_PATHS,
  type ProductionPublicationPath,
  type ProviderCatalogReleasePlanV1,
  type ProviderReleaseCompletedHeadResultV1,
  type ProviderReleaseExpectedCompletedHeadV1,
  type ProviderReleaseImmutableProofV1,
  type ProviderReleaseReceipt,
  type ProviderReleaseStatusNotFoundReceipt,
  type ProviderReleaseStatusOperationKind,
  type ProviderReleaseStatusRequest,
} from "@packscout/contracts";
import type { ProviderCatalogCheckpoint } from "./provider-catalog-settlement-service.ts";

export type ProviderPromotionOperationKind = Extract<
  ProviderReleaseStatusOperationKind,
  "start" | "applyBatch" | "finalize" | "confirmReuse"
>;

export const PROVIDER_PROMOTION_PATH_BY_KIND: Readonly<
  Record<ProviderPromotionOperationKind, ProductionPublicationPath>
> = Object.freeze({
  start: PRODUCTION_PROVIDER_RELEASE_PATHS.start,
  applyBatch: PRODUCTION_PROVIDER_RELEASE_PATHS.applyBatch,
  finalize: PRODUCTION_PROVIDER_RELEASE_PATHS.finalize,
  confirmReuse: PRODUCTION_PROVIDER_RELEASE_PATHS.confirmReuse,
});

export interface ProviderPromotionPreparedOperation {
  readonly operationIndex: number;
  readonly operationId: string;
  readonly operationKind: ProviderPromotionOperationKind;
  readonly requestPath: ProductionPublicationPath;
  readonly canonicalRequestBody: string;
  readonly requestSha256: string;
}

export interface ProviderPromotionOperationRecord
  extends ProviderPromotionPreparedOperation {
  readonly state: "pending" | "sent" | "acknowledged";
  readonly sendCount: number;
  readonly lastSentAt: Date | null;
  readonly acknowledgedAt: Date | null;
  readonly canonicalReceiptBody: string | null;
  readonly receiptSha256: string | null;
  readonly exactResponseBody: string | null;
  readonly responseSha256: string | null;
}

export interface ProviderPromotionPreparedSummary {
  readonly classification: "publish" | "reuse";
  readonly platformKey: string;
  readonly targetCheckpoint: bigint;
  readonly publicProviderReleaseId: string;
  readonly providerReleaseFingerprint: string;
  readonly immutableProof: ProviderReleaseImmutableProofV1;
  readonly providerCheckpoint: Readonly<{
    settledSequence: string;
    settledAt: string | null;
  }>;
  readonly observation: Readonly<{
    sourceHeadSequence: string;
    lastSuccessfulObservationAt: string;
    staleAt: string;
    freshness: "fresh" | "delayed";
  }>;
  readonly expectedCompletedHead: ProviderReleaseExpectedCompletedHeadV1;
  readonly operationCount: number;
  readonly checkpointSha256: string;
}

export interface ProviderPromotionClaim {
  readonly attemptId: string;
  readonly claimToken: string;
  readonly claimExpiresAt: Date;
  readonly claimCount: number;
  readonly retryCount: number;
  readonly recovered: boolean;
  readonly evaluationSequence: bigint;
  readonly checkpointSha256: string;
  readonly platformKey: string;
  readonly checkpoint: ProviderPromotionCheckpointIdentity;
  readonly state: "assembling" | "ready" | "in_progress" | "retry_wait";
  readonly preparedSummary: ProviderPromotionPreparedSummary | null;
}

export interface ProviderPromotionCompletedHead {
  readonly platformKey: string;
  readonly targetCheckpoint: bigint;
  readonly publicProviderReleaseId: string;
  readonly providerReleaseFingerprint: string;
  readonly completedHead: ProviderReleaseCompletedHeadResultV1;
  readonly completedHeadBody: string;
  readonly completedHeadSha256: string;
  readonly terminalOperationKind: "finalize" | "confirmReuse";
  readonly terminalOperationId: string;
  readonly terminalReceiptSha256: string;
  readonly canonicalReceiptBody: string;
  readonly exactResponseBody: string | null;
  readonly responseSha256: string | null;
  readonly completedAt: Date;
  readonly publishArtifactAttemptId: string;
}

export interface ProviderPromotionReleaseArtifact {
  readonly platformKey: string;
  readonly publicProviderReleaseId: string;
  readonly providerReleaseFingerprint: string;
  readonly immutableProof: ProviderReleaseImmutableProofV1;
  readonly immutableProofBody: string;
  readonly immutableProofSha256: string;
  readonly publishAttemptId: string;
  readonly operations: readonly ProviderPromotionOperationRecord[];
  readonly terminalReceiptBody: string;
  readonly terminalReceiptSha256: string;
  readonly completedAt: Date;
}

export interface ProviderPromotionHealth {
  readonly platformKey: string;
  readonly lifecycleState: "active" | "disabled" | "archived" | null;
  readonly settledCheckpoint: bigint;
  readonly sourceHeadCheckpoint: bigint;
  readonly requestedEvaluationSequence: bigint;
  readonly confirmedEvaluationSequence: bigint;
  readonly completedCheckpoint: bigint;
  readonly completedPublicProviderReleaseId: string | null;
  readonly activeCheckpoint: bigint | null;
  readonly activePublicProviderReleaseId: string | null;
  readonly activeManifestPublicReleaseId: string | null;
  readonly activeAttemptId: string | null;
  readonly activeAttemptState: string | null;
  readonly activeAttemptStartedAt: Date | null;
  readonly retryAt: Date | null;
  readonly completedAt: Date | null;
}

export interface ProviderPromotionCheckpointIdentity {
  readonly platformKey: string;
  readonly sharedConfigurationEpoch: ProviderCatalogCheckpoint["sharedConfigurationEpoch"];
  readonly settledSequence: bigint;
  readonly sourceHeadSequence: bigint;
  readonly settledAt: Date | null;
  readonly sourceHeadAt: Date;
  readonly lastSuccessfulObservationAt: Date;
  readonly staleAt: Date;
  readonly freshness: "fresh" | "delayed";
  readonly blockedState: ProviderCatalogCheckpoint["blockedState"];
}

export type PromotionRetryExhaustionResult = Readonly<
  | { result: "status_required"; evaluationSequence: bigint }
  | { result: "requeued"; evaluationSequence: bigint }
>;

/** Constructor-bound persistence boundary; no tenant/deployment selectors cross it. */
export interface ProviderPromotionLanePort {
  enqueueEvaluation(input: Readonly<{
    checkpoint: ProviderPromotionCheckpointIdentity;
    requestedAt: Date;
  }>): Promise<Readonly<{
    evaluationSequence: bigint;
    result: "created" | "coalesced";
  }>>;
  claim(input: Readonly<{
    workerId: string;
    now: Date;
    leaseExpiresAt: Date;
  }>): Promise<ProviderPromotionClaim | null>;
  heartbeat(input: Readonly<{
    attemptId: string;
    claimToken: string;
    heartbeatAt: Date;
    leaseExpiresAt: Date;
  }>): Promise<boolean>;
  loadCompletedHead(): Promise<ProviderPromotionCompletedHead | null>;
  persistPreparedOperations(input: Readonly<{
    attemptId: string;
    claimToken: string;
    preparedAt: Date;
    summary: ProviderPromotionPreparedSummary;
    operations: readonly ProviderPromotionPreparedOperation[];
  }>): Promise<readonly ProviderPromotionOperationRecord[] | null>;
  listOperations(input: Readonly<{
    attemptId: string;
  }>): Promise<readonly ProviderPromotionOperationRecord[]>;
  markOperationSent(input: Readonly<{
    attemptId: string;
    claimToken: string;
    operationId: string;
    sentAt: Date;
  }>): Promise<boolean>;
  acknowledgeOperation(input: Readonly<{
    attemptId: string;
    claimToken: string;
    operationId: string;
    evidence: Readonly<{
      canonicalReceiptBody: string;
      exactResponseBody?: string | null;
    }>;
    acknowledgedAt: Date;
  }>): Promise<boolean>;
  scheduleRetry(input: Readonly<{
    attemptId: string;
    claimToken: string;
    failureClass: "technical" | "reconciliation";
    failureCode: string;
    failedAt: Date;
    retryAt: Date;
  }>): Promise<boolean>;
  recordRetryExhaustion(input: Readonly<{
    attemptId: string;
    claimToken: string;
    failedAt: Date;
    retryAt: Date;
    failureClass: "technical" | "deterministic" | "reconciliation" | "bootstrap";
    failureCode: string;
  }>): Promise<PromotionRetryExhaustionResult | null>;
  recordReconciliationLoss(input: Readonly<{
    attemptId: string;
    claimToken: string;
    failureCode:
      | "PROVIDER_RELEASE_PREDECESSOR_CONFLICT"
      | "PROVIDER_RELEASE_STATE_CONFLICT"
      | "PROVIDER_RELEASE_RECONCILIATION_FAILED";
    canonicalErrorBody: string;
    observedAt: Date;
  }>): Promise<Readonly<{ evaluationSequence: bigint }> | null>;
  complete(input:
    | Readonly<{
        attemptId: string;
        claimToken: string;
        outcome: "published" | "reused" | "superseded";
        completedAt: Date;
      }>
    | Readonly<{
        attemptId: string;
        claimToken: string;
        outcome: "failed";
        completedAt: Date;
        failureClass: "technical" | "deterministic" | "reconciliation" | "bootstrap";
        failureCode: string;
      }>): Promise<boolean>;
  loadHealth(input: Readonly<{ now: Date }>): Promise<ProviderPromotionHealth>;
}

export interface ProviderReleasePublicationResult<
  Receipt extends ProviderReleaseReceipt | ProviderReleaseStatusNotFoundReceipt =
    ProviderReleaseReceipt,
> {
  readonly receipt: Receipt;
  readonly canonicalReceiptBody: string;
  readonly receiptSha256: string;
  readonly exactResponseBody?: string;
  readonly exactResponseSha256?: string;
}

export interface ProviderPromotionTransport {
  sendExact(input: Readonly<{
    kind: ProviderPromotionOperationKind;
    canonicalRequestBody: string;
  }>, signal?: AbortSignal): Promise<ProviderReleasePublicationResult>;
  status(
    request: ProviderReleaseStatusRequest,
    signal?: AbortSignal,
  ): Promise<ProviderReleasePublicationResult<
    ProviderReleaseReceipt | ProviderReleaseStatusNotFoundReceipt
  >>;
}

export interface ProviderPromotionAssemblerPort {
  assemble(input: Readonly<{
    trigger: "full_rebuild" | "settled_change";
  }>): Promise<ProviderCatalogReleasePlanV1>;
}
