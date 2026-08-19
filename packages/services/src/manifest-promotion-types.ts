import {
  PRODUCTION_CATALOG_MANIFEST_PATHS,
  type ActiveCatalogManifestStateV1,
  type CatalogManifestActiveStateReceipt,
  type CatalogManifestMutationRequest,
  type CatalogManifestReceipt,
  type CatalogManifestStatusNotFoundReceipt,
  type CatalogManifestStatusRequest,
  type GlobalCatalogManifestIdentityV1,
  type GlobalCatalogProviderActiveObservationV1,
  type ProviderCatalogReleasePublishPlanV1,
  type ProviderCatalogSharedConfigurationEpochV1,
} from "@packscout/contracts";
import type {
  ProviderPromotionCheckpointIdentity,
  ProviderPromotionCompletedHead,
  ProviderPromotionHealth,
  ProviderPromotionReleaseArtifact,
  PromotionRetryExhaustionResult,
} from "./provider-promotion-types.ts";

export type ManifestPromotionMutationKind =
  | "activateManifest"
  | "refreshActiveState"
  | "rollback";

export const MANIFEST_PROMOTION_PATH_BY_KIND = Object.freeze({
  activateManifest: PRODUCTION_CATALOG_MANIFEST_PATHS.activateManifest,
  refreshActiveState: PRODUCTION_CATALOG_MANIFEST_PATHS.refreshActiveState,
  rollback: PRODUCTION_CATALOG_MANIFEST_PATHS.rollback,
} satisfies Readonly<Record<ManifestPromotionMutationKind, string>>);

export interface ManifestPromotionPreparedOperation {
  readonly operationIndex: 0;
  readonly operationId: string;
  readonly operationKind: ManifestPromotionMutationKind;
  readonly requestPath: string;
  readonly canonicalRequestBody: string;
  readonly requestSha256: string;
}

export interface ManifestPromotionOperationRecord
  extends ManifestPromotionPreparedOperation {
  readonly state: "pending" | "sent" | "acknowledged";
  readonly sendCount: number;
  readonly lastSentAt: Date | null;
  readonly acknowledgedAt: Date | null;
  readonly canonicalReceiptBody: string | null;
  readonly receiptSha256: string | null;
  readonly exactResponseBody: string | null;
  readonly responseSha256: string | null;
}

export interface ManifestPromotionPreparedSummary {
  readonly operationKind:
    | ManifestPromotionMutationKind
    | "rollback"
    | "block"
    | "no_change";
  readonly expectedActiveState: ActiveCatalogManifestStateV1;
  readonly sharedConfigurationEpoch:
    ProviderCatalogSharedConfigurationEpochV1;
  readonly enabledPlatformKeys: readonly string[];
  readonly providerSelections: readonly ManifestPromotionSelectedProviderProof[];
  readonly evaluationSnapshotSha256: string;
  readonly manifestIdentity: GlobalCatalogManifestIdentityV1 | null;
}

export interface ManifestPromotionSelectedProviderProof {
  readonly platformKey: string;
  readonly source: "completed_head" | "active_fallback";
  /** Completed-head body digest or persisted active-selection digest. */
  readonly proofDigest: string;
  readonly publicProviderReleaseId: string;
  readonly providerReleaseFingerprint: string;
  readonly selectedCheckpoint: string;
  readonly terminalReceiptSha256: string;
}

export interface ManifestPromotionClaim {
  readonly attemptId: string;
  readonly claimToken: string;
  readonly claimExpiresAt: Date;
  readonly claimCount: number;
  readonly retryCount: number;
  readonly recovered: boolean;
  readonly evaluationSequence: bigint;
  readonly state: "assembling" | "ready" | "in_progress" | "retry_wait";
  readonly preparedSummary: ManifestPromotionPreparedSummary | null;
  readonly pendingCasLoss: Readonly<{
    failureCode:
      | "CATALOG_MANIFEST_PREDECESSOR_CONFLICT"
      | "CATALOG_MANIFEST_STATE_CONFLICT";
    canonicalErrorBody: string;
  }> | null;
}

export interface ManifestPromotionActiveSelection {
  readonly platformKey: string;
  readonly activeGeneration: bigint;
  readonly manifestPublicReleaseId: string;
  readonly providerPublicReleaseId: string;
  readonly providerReleaseFingerprint: string;
  readonly selectedCheckpoint: bigint;
  readonly selection: GlobalCatalogProviderActiveObservationV1;
  readonly selectionBody: string;
  readonly selectionSha256: string;
  readonly providerTerminalOperationId: string;
  readonly providerTerminalReceiptSha256: string;
  readonly publishArtifactAttemptId: string;
  readonly activatedAt: Date;
}

export interface ManifestPromotionActiveState {
  readonly state: ActiveCatalogManifestStateV1;
  readonly canonicalStateBody: string;
  readonly stateSha256: string;
  readonly canonicalActiveStateReceiptBody: string;
  readonly activeStateReceiptSha256: string;
  readonly exactResponseBody: string | null;
  readonly responseSha256: string | null;
  readonly activeSelections: readonly ManifestPromotionActiveSelection[];
}

export interface ManifestPromotionEligibilitySnapshot {
  readonly organizationId: string;
  readonly sharedConfigurationEpoch: Readonly<{
    readonly configurationKey: string;
    readonly revision: number;
    readonly publicChangeSequence: bigint;
    readonly configurationHash: string;
  }>;
  /** Exact approved configuration value loaded in the atomic DB snapshot. */
  readonly confidencePolicyVersion: string;
  /** Exact approved configuration value loaded in the atomic DB snapshot. */
  readonly staleAfterSeconds: number;
  readonly configuredPlatformKeys: readonly string[];
  readonly enabledPlatformKeys: readonly string[];
  readonly lifecycleDecisionSequence: bigint;
  readonly checkpoints: readonly ManifestPromotionCheckpoint[];
}

export interface ManifestPromotionCheckpoint {
  readonly organizationId?: string;
  readonly platformKey: string;
  readonly sharedConfigurationEpoch:
    ProviderPromotionCheckpointIdentity["sharedConfigurationEpoch"];
  readonly settledSequence: bigint;
  readonly sourceHeadSequence: bigint;
  readonly settledAt: Date | null;
  readonly sourceHeadAt: Date;
  readonly blockedState: ProviderPromotionCheckpointIdentity["blockedState"];
}

export interface ManifestPromotionProviderFact {
  readonly platformKey: string;
  readonly checkpoint: ManifestPromotionCheckpoint;
  /** Current Task007 enable/re-enable cause; new heads must cover this point. */
  readonly minimumEligibleCheckpoint: bigint;
  readonly initialBackfillComplete: boolean;
  readonly completedBackfillAt: Date | null;
  readonly lastSuccessfulObservationAt: Date | null;
  readonly completedHead: ProviderPromotionCompletedHead | null;
  readonly activeSelection: ManifestPromotionActiveSelection | null;
}

export interface ManifestPromotionEvaluationSnapshot {
  readonly evaluationSequence: bigint;
  readonly snapshotSha256: string;
  readonly eligibility: ManifestPromotionEligibilitySnapshot;
  readonly providerFacts: readonly ManifestPromotionProviderFact[];
  readonly activeState: ManifestPromotionActiveState | null;
}

export interface ManifestPromotionHealth {
  readonly bootstrapState:
    | "unverified"
    | "verified_empty"
    | "verified_cleared"
    | "verified_active";
  readonly requestedEvaluationSequence: bigint;
  readonly confirmedEvaluationSequence: bigint;
  readonly activeGeneration: bigint;
  readonly activePublicReleaseId: string | null;
  readonly activeConfigurationEpochSequence: bigint | null;
  readonly delayedProviderCount: number;
  readonly activeAttemptId: string | null;
  readonly activeAttemptState: string | null;
  readonly activeAttemptStartedAt: Date | null;
  readonly retryAt: Date | null;
  readonly lastActivatedAt: Date | null;
  readonly lastReconciledAt: Date | null;
}

export type ManifestPromotionCause =
  | "provider_completed"
  | "provider_reused"
  | "lifecycle_settled"
  | "configuration_settled"
  | "observation_succeeded"
  | "cas_lost"
  | "bootstrap_reconcile";

/** Constructor-bound persistence boundary; tenant selectors never cross it. */
export interface ManifestPromotionLanePort {
  enqueueEvaluation(input: Readonly<{
    cause: ManifestPromotionCause;
    causeIdentity: string;
    requestedAt: Date;
  }>): Promise<Readonly<{
    evaluationSequence: bigint;
    result: "created" | "coalesced";
  }>>;
  claim(input: Readonly<{
    workerId: string;
    now: Date;
    leaseExpiresAt: Date;
  }>): Promise<ManifestPromotionClaim | null>;
  heartbeat(input: Readonly<{
    attemptId: string;
    claimToken: string;
    heartbeatAt: Date;
    leaseExpiresAt: Date;
  }>): Promise<boolean>;
  loadEvaluationSnapshot(input: Readonly<{
    attemptId: string;
    claimToken: string;
    now: Date;
  }>): Promise<ManifestPromotionEvaluationSnapshot | null>;
  persistPreparedOperation(input: Readonly<{
    attemptId: string;
    claimToken: string;
    preparedAt: Date;
    summary: ManifestPromotionPreparedSummary;
    operation: ManifestPromotionPreparedOperation | null;
  }>): Promise<ManifestPromotionOperationRecord | null>;
  listOperations(input: Readonly<{
    attemptId: string;
  }>): Promise<readonly ManifestPromotionOperationRecord[]>;
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
    acknowledgedAt: Date;
    evidence: Readonly<{
      canonicalReceiptBody: string;
      exactResponseBody?: string | null;
    }>;
  }>): Promise<boolean>;
  scheduleRetry(input: Readonly<{
    attemptId: string;
    claimToken: string;
    failedAt: Date;
    retryAt: Date;
    failureClass: "technical" | "reconciliation";
    failureCode: string;
  }>): Promise<boolean>;
  recordRetryExhaustion(input: Readonly<{
    attemptId: string;
    claimToken: string;
    failedAt: Date;
    retryAt: Date;
    failureClass: "technical" | "deterministic" | "reconciliation" | "bootstrap";
    failureCode: string;
  }>): Promise<PromotionRetryExhaustionResult | null>;
  deferCasLoss(input: Readonly<{
    attemptId: string;
    claimToken: string;
    canonicalErrorBody: string;
    observedAt: Date;
    retryAt: Date;
  }>): Promise<boolean>;
  complete(input:
    | Readonly<{
        attemptId: string;
        claimToken: string;
        outcome: "activated" | "refreshed" | "rolled_back" | "cleared" | "blocked";
        completedAt: Date;
      }>
    | Readonly<{
        attemptId: string;
        claimToken: string;
        outcome: "no_change";
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
  recordCasLoss(input: Readonly<{
    attemptId: string;
    claimToken: string;
    canonicalErrorBody: string;
    observedAt: Date;
    activeStateEvidence: Readonly<{
      requestBody: string;
      canonicalReceiptBody: string;
      exactResponseBody?: string | null;
    }>;
  }>): Promise<Readonly<{ evaluationSequence: bigint }> | null>;
  loadHealth(input: Readonly<{ now: Date }>): Promise<ManifestPromotionHealth>;
}

export interface ManifestProviderArtifactResolver {
  loadReleaseArtifact(input: Readonly<{
    platformKey: string;
    publicProviderReleaseId: string;
  }>): Promise<ProviderPromotionReleaseArtifact | null>;
}

export interface ManifestProviderPlanResolver {
  loadPublishPlan(input: Readonly<{
    platformKey: string;
    publicProviderReleaseId: string;
    providerReleaseFingerprint: string;
    publishArtifactAttemptId: string;
  }>): Promise<ProviderCatalogReleasePublishPlanV1 | null>;
}

export interface CatalogManifestPublicationResult<Receipt = CatalogManifestReceipt> {
  readonly receipt: Receipt;
  readonly canonicalReceiptBody: string;
  readonly receiptSha256: string;
  readonly exactResponseBody: string;
  readonly exactResponseSha256: string;
}

export interface ManifestPromotionTransport {
  sendExact(input: Readonly<{
    kind: ManifestPromotionMutationKind;
    canonicalRequestBody: string;
  }>, signal?: AbortSignal): Promise<CatalogManifestPublicationResult>;
  status(
    request: CatalogManifestStatusRequest,
    signal?: AbortSignal,
  ): Promise<CatalogManifestPublicationResult<
    CatalogManifestReceipt | CatalogManifestStatusNotFoundReceipt
  >>;
  activeState(signal?: AbortSignal): Promise<CatalogManifestPublicationResult<
    CatalogManifestActiveStateReceipt
  >>;
}

export interface ProviderPromotionRuntimeLane {
  readonly platformKey: string;
  runCycle(signal?: AbortSignal): Promise<unknown>;
  loadHealth?(): Promise<ProviderPromotionHealth>;
}

export type ManifestMutationRequest = CatalogManifestMutationRequest;
