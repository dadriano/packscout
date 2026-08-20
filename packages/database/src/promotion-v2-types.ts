import { createHash } from "node:crypto";
import {
  canonicalJson,
  type ActiveCatalogManifestStateV1,
  type CatalogManifestMutationRequest,
  type GlobalCatalogManifestIdentityV1,
  type GlobalCatalogProviderActiveObservationV1,
  type ProviderCatalogSharedConfigurationEpochV1,
  type ProviderReleaseExpectedCompletedHeadV1,
  type ProviderReleaseImmutableProofV1,
  type ProviderReleaseStartRequest,
  type ProviderReleaseMutationRequest,
  type ProviderReleaseCompletedHeadResultV1,
  type ProviderReleaseCompletedHeadStateV1,
} from "@packscout/contracts";
import type {
  ManifestEligibilitySnapshotRecord,
  ProviderCatalogCheckpointRecord,
} from "./public-change-settlement-repository.provider-read.ts";

export const PROMOTION_V2_MAX_OPERATION_COUNT = 4_098;
export const PROMOTION_V2_MAX_REQUEST_BYTES = 128 * 1_024;
export const PROMOTION_V2_MAX_PROVIDER_RECEIPT_BYTES = 384 * 1_024;
export const PROMOTION_V2_MAX_MANIFEST_RECEIPT_BYTES = 256 * 1_024;
export const PROMOTION_V2_MAX_RESPONSE_BYTES = 512 * 1_024;
export const PROMOTION_V2_MAX_SUMMARY_BYTES = 64 * 1_024;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const deploymentKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const platformKeyPattern = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;
const workerKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const configurationKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const failureCodePattern = /^[A-Z0-9_]{1,128}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;

export type PromotionV2FailureClass =
  | "technical"
  | "deterministic"
  | "reconciliation"
  | "bootstrap";

export type PromotionRetryExhaustionResult = Readonly<
  | { result: "status_required"; evaluationSequence: bigint }
  | { result: "requeued"; evaluationSequence: bigint }
>;

export type PromotionV2OperationState =
  | "pending"
  | "sent"
  | "acknowledged";

export type ProviderPromotionReconciliationFailureCode =
  | "PROVIDER_RELEASE_PREDECESSOR_CONFLICT"
  | "PROVIDER_RELEASE_STATE_CONFLICT"
  | "PROVIDER_RELEASE_RECONCILIATION_FAILED";

export class PromotionV2PersistenceError extends Error {
  constructor(readonly code:
    | "PROMOTION_V2_INPUT_INVALID"
    | "PROMOTION_V2_SCOPE_MISMATCH"
    | "PROMOTION_V2_CHECKPOINT_REGRESSED"
    | "PROMOTION_V2_CLAIM_STALE"
    | "PROMOTION_V2_OPERATION_CONFLICT"
    | "PROMOTION_V2_OPERATION_ORDER"
    | "PROMOTION_V2_RECEIPT_INVALID"
    | "PROMOTION_V2_PREDECESSOR_CONFLICT"
    | "PROMOTION_V2_BOOTSTRAP_UNVERIFIED"
    | "PROMOTION_V2_BOOTSTRAP_UNPROVEN"
    | "PROMOTION_V2_ACTIVE_STATE_UNPROVEN"
    | "PROMOTION_V2_STATE_CONFLICT") {
    super("Promotion persistence state is invalid or unavailable.");
    this.name = "PromotionV2PersistenceError";
  }
}

export interface PromotionV2ScopeBinding {
  readonly organizationId: string;
  readonly deploymentKey: string;
}

export interface ProviderPromotionScopeBinding
  extends PromotionV2ScopeBinding {
  readonly platformKey: string;
}

export interface PromotionV2ClaimCore {
  readonly attemptId: string;
  readonly claimToken: string;
  readonly claimExpiresAt: Date;
  readonly claimCount: number;
  readonly retryCount: number;
  readonly recovered: boolean;
}

export interface ExactPromotionOperationInput {
  readonly operationIndex: number;
  readonly operationId: string;
  readonly operationKind: string;
  readonly requestPath: string;
  readonly canonicalRequestBody: string;
}

export interface ExactPromotionOperationRecord
  extends ExactPromotionOperationInput {
  readonly requestSha256: string;
  readonly state: PromotionV2OperationState;
  readonly sendCount: number;
  readonly lastSentAt: Date | null;
  readonly acknowledgedAt: Date | null;
  /** Canonical inner receipt JSON; its plain SHA is the Convex terminal SHA. */
  readonly canonicalReceiptBody: string | null;
  readonly receiptSha256: string | null;
  /** Optional exact verified response envelope/body; never a terminal SHA. */
  readonly exactResponseBody: string | null;
  readonly responseSha256: string | null;
}

export interface ExactPromotionReceiptEvidence {
  readonly canonicalReceiptBody: string;
  readonly exactResponseBody?: string | null;
}

export interface ProviderPromotionCheckpointIdentity {
  readonly platformKey: string;
  readonly sharedConfigurationEpoch: Readonly<{
    readonly configurationKey: string;
    readonly revision: number;
    readonly publicChangeSequence: bigint;
    readonly configurationHash: string;
  }>;
  readonly settledSequence: bigint;
  readonly sourceHeadSequence: bigint;
  readonly settledAt: Date | null;
  readonly sourceHeadAt: Date;
  readonly lastSuccessfulObservationAt: Date;
  readonly staleAt: Date;
  readonly freshness: "fresh" | "delayed";
  readonly blockedState:
    | Readonly<{ readonly kind: "ready" }>
    | Readonly<{
        readonly kind: "blocked";
        readonly reason: "pending_derivation" | "technical_failure";
        readonly causeSequence: bigint;
      }>;
}

export interface ProviderPromotionPreparedSummary {
  readonly classification: "publish" | "reuse";
  readonly platformKey: string;
  readonly targetCheckpoint: bigint;
  readonly checkpointSha256: string;
  readonly publicProviderReleaseId: string;
  readonly providerReleaseFingerprint: string;
  readonly immutableProof: ProviderReleaseImmutableProofV1;
  readonly providerCheckpoint: ProviderReleaseStartRequest["providerCheckpoint"];
  readonly observation: ProviderReleaseStartRequest["observation"];
  readonly expectedCompletedHead: ProviderReleaseExpectedCompletedHeadV1;
  readonly operationCount: number;
}

export interface ProviderPromotionClaim extends PromotionV2ClaimCore {
  readonly platformKey: string;
  readonly evaluationSequence: bigint;
  readonly checkpoint: ProviderPromotionCheckpointIdentity;
  readonly checkpointSha256: string;
  readonly state:
    | "assembling"
    | "ready"
    | "in_progress"
    | "retry_wait";
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
  readonly operations: readonly ExactPromotionOperationRecord[];
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

export type ManifestPromotionCause =
  | "provider_completed"
  | "provider_reused"
  | "lifecycle_settled"
  | "configuration_settled"
  | "observation_succeeded"
  | "cas_lost"
  | "retry_exhausted"
  | "bootstrap_reconcile";

export type ManifestPromotionPreparedOperationKind =
  | "activateManifest"
  | "refreshActiveState"
  | "rollback"
  | "block"
  | "no_change";

export interface ManifestPromotionSelectedProviderProof {
  readonly platformKey: string;
  readonly source: "completed_head" | "active_fallback";
  readonly proofDigest: string;
  readonly publicProviderReleaseId: string;
  readonly providerReleaseFingerprint: string;
  readonly selectedCheckpoint: string;
  readonly terminalReceiptSha256: string;
}

export interface ManifestPromotionPreparedSummary {
  readonly operationKind: ManifestPromotionPreparedOperationKind;
  readonly evaluationSnapshotSha256: string;
  readonly expectedActiveState: ActiveCatalogManifestStateV1;
  readonly sharedConfigurationEpoch:
    ProviderCatalogSharedConfigurationEpochV1;
  readonly enabledPlatformKeys: readonly string[];
  readonly providerSelections:
    readonly ManifestPromotionSelectedProviderProof[];
  readonly manifestIdentity: GlobalCatalogManifestIdentityV1 | null;
}

export interface ManifestPromotionClaim extends PromotionV2ClaimCore {
  readonly evaluationSequence: bigint;
  readonly state:
    | "assembling"
    | "ready"
    | "in_progress"
    | "retry_wait";
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

export interface ManifestPromotionProviderFact {
  readonly platformKey: string;
  readonly checkpoint: ProviderCatalogCheckpointRecord;
  /** Current active lifecycle cause that a newly selected head must cover. */
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
  readonly eligibility: ManifestEligibilitySnapshotRecord;
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

export interface CatalogPromotionBootstrapProviderProof {
  readonly platformKey: string;
  readonly activeReference: Readonly<{
    readonly publicProviderReleaseId: string;
    readonly providerReleaseFingerprint: string;
    readonly providerTerminalOperationId: string;
    readonly providerTerminalReceiptBody: string;
    readonly providerTerminalReceiptSha256: string;
    readonly providerTerminalResponseBody?: string | null;
    readonly publishArtifactAttemptId: string;
  }> | null;
  readonly completedHeadProbe: Readonly<{
    readonly requestBody: string;
    readonly receiptBody: string;
    readonly exactResponseBody?: string | null;
    readonly remoteHead: ProviderReleaseCompletedHeadStateV1;
  }>;
  readonly localCompletedHead: Readonly<{
    readonly attemptId: string;
    readonly publicProviderReleaseId: string;
    readonly providerReleaseFingerprint: string;
    readonly terminalReceiptSha256: string;
  }> | null;
}

export interface CatalogPromotionBootstrapLocalProviderCandidate {
  readonly platformKey: string;
  readonly activeReference:
    CatalogPromotionBootstrapProviderProof["activeReference"];
  readonly localCompletedHead:
    CatalogPromotionBootstrapProviderProof["localCompletedHead"];
}

export interface CatalogPromotionBootstrapLocalCandidate {
  readonly manifestDefinitionRequestBody: string | null;
  readonly manifestTerminalRequestBody: string | null;
  readonly manifestReceiptBody: string | null;
  readonly manifestExactResponseBody: string | null;
  readonly providers: readonly CatalogPromotionBootstrapLocalProviderCandidate[];
}

export interface CatalogPromotionBootstrapProof {
  readonly proofRevision: bigint;
  readonly proofKind: "empty" | "cleared" | "active";
  readonly activeStateRequestBody: string;
  readonly activeStateReceiptBody: string;
  readonly activeStateResponseBody: string | null;
  readonly activeState: ActiveCatalogManifestStateV1;
  readonly manifestDefinitionRequestBody: string | null;
  readonly manifestTerminalRequestBody: string | null;
  readonly manifestReceiptBody: string | null;
  readonly manifestResponseBody: string | null;
  readonly providers: readonly CatalogPromotionBootstrapProviderProof[];
  readonly verifiedAt: Date;
}

export function promotionV2Sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function promotionV2CanonicalJson(value: unknown): string {
  return canonicalJson(value);
}

export function assertPromotionV2Binding(
  binding: PromotionV2ScopeBinding,
): void {
  if (
    !uuidPattern.test(binding.organizationId) ||
    !deploymentKeyPattern.test(binding.deploymentKey)
  ) throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
}

export function assertProviderPromotionBinding(
  binding: ProviderPromotionScopeBinding,
): void {
  assertPromotionV2Binding(binding);
  if (
    binding.platformKey.length > 128 ||
    !platformKeyPattern.test(binding.platformKey)
  ) throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
}

export function assertPromotionV2ClaimInput(input: Readonly<{
  workerId: string;
  now: Date;
  leaseExpiresAt: Date;
}>): void {
  if (
    !workerKeyPattern.test(input.workerId) ||
    !finiteDate(input.now) ||
    !finiteDate(input.leaseExpiresAt) ||
    input.leaseExpiresAt.getTime() <= input.now.getTime()
  ) throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
}

export function assertPromotionV2Failure(
  failureClass: PromotionV2FailureClass,
  failureCode: string,
): void {
  if (!failureCodePattern.test(failureCode) || failureClass.length === 0) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
  }
}

export function assertPromotionV2Sha256(value: string): void {
  if (!sha256Pattern.test(value)) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
  }
}

export function finiteDate(value: Date | null): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export function providerCheckpointIdentityBody(
  checkpoint: ProviderPromotionCheckpointIdentity,
): string {
  const checkpointRecord = checkpoint as unknown as Record<string, unknown>;
  const epochRecord = checkpoint.sharedConfigurationEpoch as unknown as
    Record<string, unknown>;
  const blockedRecord = checkpoint.blockedState as unknown as
    Record<string, unknown>;
  if (
    !isPlainRecord(checkpointRecord) || !hasExactKeys(checkpointRecord, [
      "blockedState", "freshness", "lastSuccessfulObservationAt",
      "platformKey", "settledAt", "settledSequence", "sharedConfigurationEpoch",
      "sourceHeadAt", "sourceHeadSequence", "staleAt",
    ]) || !isPlainRecord(epochRecord) || !hasExactKeys(epochRecord, [
      "configurationHash", "configurationKey", "publicChangeSequence",
      "revision",
    ]) || !isPlainRecord(blockedRecord) ||
    (checkpoint.blockedState.kind === "ready"
      ? !hasExactKeys(blockedRecord, ["kind"])
      : !hasExactKeys(blockedRecord, ["causeSequence", "kind", "reason"])) ||
    (checkpoint.blockedState.kind !== "ready" &&
      checkpoint.blockedState.kind !== "blocked") ||
    checkpoint.platformKey.length > 128 ||
    !platformKeyPattern.test(checkpoint.platformKey) ||
    !configurationKeyPattern.test(
      checkpoint.sharedConfigurationEpoch.configurationKey,
    ) ||
    !Number.isSafeInteger(checkpoint.sharedConfigurationEpoch.revision) ||
    checkpoint.sharedConfigurationEpoch.revision <= 0 ||
    checkpoint.sharedConfigurationEpoch.publicChangeSequence <= 0n ||
    checkpoint.settledSequence < 0n ||
    checkpoint.sourceHeadSequence < checkpoint.settledSequence ||
    !finiteDate(checkpoint.sourceHeadAt) ||
    !finiteDate(checkpoint.lastSuccessfulObservationAt) ||
    !finiteDate(checkpoint.staleAt) ||
    checkpoint.staleAt <= checkpoint.lastSuccessfulObservationAt ||
    (checkpoint.freshness !== "fresh" && checkpoint.freshness !== "delayed") ||
    checkpoint.freshness !== (
      checkpoint.lastSuccessfulObservationAt >= checkpoint.sourceHeadAt
        ? "fresh" : "delayed"
    ) ||
    (checkpoint.settledSequence === 0n) !== (checkpoint.settledAt === null) ||
    (checkpoint.settledAt !== null && !finiteDate(checkpoint.settledAt)) ||
    checkpoint.sharedConfigurationEpoch.publicChangeSequence >
      checkpoint.sourceHeadSequence ||
    (checkpoint.blockedState.kind === "ready" &&
      checkpoint.settledSequence !== checkpoint.sourceHeadSequence) ||
    (checkpoint.blockedState.kind === "blocked" &&
      !(["pending_derivation", "technical_failure"] as const).includes(
        checkpoint.blockedState.reason,
      )) ||
    (checkpoint.blockedState.kind === "blocked" &&
      (checkpoint.blockedState.causeSequence <= checkpoint.settledSequence ||
        checkpoint.blockedState.causeSequence > checkpoint.sourceHeadSequence))
  ) throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
  assertPromotionV2Sha256(
    checkpoint.sharedConfigurationEpoch.configurationHash,
  );
  return promotionV2CanonicalJson({
    platformKey: checkpoint.platformKey,
    sharedConfigurationEpoch: {
      ...checkpoint.sharedConfigurationEpoch,
      publicChangeSequence: String(
        checkpoint.sharedConfigurationEpoch.publicChangeSequence,
      ),
    },
    settledSequence: String(checkpoint.settledSequence),
    sourceHeadSequence: String(checkpoint.sourceHeadSequence),
    settledAt: checkpoint.settledAt?.toISOString() ?? null,
    sourceHeadAt: checkpoint.sourceHeadAt.toISOString(),
    lastSuccessfulObservationAt:
      checkpoint.lastSuccessfulObservationAt.toISOString(),
    staleAt: checkpoint.staleAt.toISOString(),
    freshness: checkpoint.freshness,
    blockedState: checkpoint.blockedState.kind === "ready"
      ? { kind: "ready" }
      : {
          ...checkpoint.blockedState,
          causeSequence: String(checkpoint.blockedState.causeSequence),
        },
  });
}

export function parseProviderCheckpointIdentityBody(
  body: string,
): ProviderPromotionCheckpointIdentity {
  try {
    const value = JSON.parse(body) as unknown;
    if (!isPlainRecord(value) || !hasExactKeys(value, [
      "blockedState", "freshness", "lastSuccessfulObservationAt",
      "platformKey", "settledAt", "settledSequence", "sharedConfigurationEpoch",
      "sourceHeadAt", "sourceHeadSequence", "staleAt",
    ])) throw new Error("shape");
    const epoch = value.sharedConfigurationEpoch;
    const blocked = value.blockedState;
    if (!isPlainRecord(epoch) || !hasExactKeys(epoch, [
      "configurationHash", "configurationKey", "publicChangeSequence",
      "revision",
    ]) || !isPlainRecord(blocked)) throw new Error("shape");
    const blockedKind = blocked.kind;
    if (
      (blockedKind === "ready" && !hasExactKeys(blocked, ["kind"])) ||
      (blockedKind === "blocked" && !hasExactKeys(blocked, [
        "causeSequence", "kind", "reason",
      ])) ||
      (blockedKind !== "ready" && blockedKind !== "blocked")
    ) throw new Error("shape");
    if (
      typeof value.platformKey !== "string" ||
      typeof epoch.configurationKey !== "string" ||
      typeof epoch.revision !== "number" ||
      typeof epoch.publicChangeSequence !== "string" ||
      typeof epoch.configurationHash !== "string" ||
      typeof value.settledSequence !== "string" ||
      typeof value.sourceHeadSequence !== "string" ||
      (value.settledAt !== null && typeof value.settledAt !== "string") ||
      typeof value.sourceHeadAt !== "string" ||
      typeof value.lastSuccessfulObservationAt !== "string" ||
      typeof value.staleAt !== "string" ||
      (value.freshness !== "fresh" && value.freshness !== "delayed")
    ) throw new Error("shape");
    const parsed: ProviderPromotionCheckpointIdentity = {
      platformKey: value.platformKey,
      sharedConfigurationEpoch: {
        configurationKey: epoch.configurationKey,
        revision: epoch.revision,
        publicChangeSequence: BigInt(epoch.publicChangeSequence),
        configurationHash: epoch.configurationHash,
      },
      settledSequence: BigInt(value.settledSequence),
      sourceHeadSequence: BigInt(value.sourceHeadSequence),
      settledAt: value.settledAt === null ? null : new Date(value.settledAt),
      sourceHeadAt: new Date(value.sourceHeadAt),
      lastSuccessfulObservationAt: new Date(
        value.lastSuccessfulObservationAt,
      ),
      staleAt: new Date(value.staleAt),
      freshness: value.freshness,
      blockedState: blockedKind === "ready"
        ? { kind: "ready" }
        : {
            kind: "blocked",
            reason: blocked.reason as
              "pending_derivation" | "technical_failure",
            causeSequence: BigInt(String(blocked.causeSequence)),
          },
    };
    if (providerCheckpointIdentityBody(parsed) !== body) throw new Error("body");
    return parsed;
  } catch {
    throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length &&
    actual.every((key, index) => key === keys[index]);
}

export type ProviderMutationRequest = ProviderReleaseMutationRequest;
export type ManifestMutationRequest = CatalogManifestMutationRequest;
