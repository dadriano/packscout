import { createHash } from "node:crypto";
import {
  PRODUCTION_DATA_RELEASE_PATHS,
  type ProductionDataReleasePath,
  type ProductionReceipt,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";

export type PromotionAttemptState =
  | "assembling"
  | "ready"
  | "in_progress"
  | "retry_wait"
  | "published"
  | "unchanged"
  | "failed"
  | "rolled_back";

export type PromotionTerminalState = Extract<
  PromotionAttemptState,
  "published" | "unchanged" | "failed" | "rolled_back"
>;

export type PromotionFailureClass =
  | "technical"
  | "deterministic"
  | "reconciliation"
  | "bootstrap";

export type PromotionBootstrapState =
  | "unverified"
  | "verified_empty"
  | "verified_local";

export type PromotionLedgerErrorCode =
  | "PROMOTION_INPUT_INVALID"
  | "PROMOTION_BOOTSTRAP_UNVERIFIED"
  | "PROMOTION_BOOTSTRAP_UNPROVEN"
  | "PROMOTION_BOOTSTRAP_CONFLICT"
  | "PROMOTION_ATTEMPT_CONFLICT"
  | "PROMOTION_OPERATION_CONFLICT"
  | "PROMOTION_OPERATION_ORDER_INVALID"
  | "PROMOTION_WATERMARK_REGRESSED";

export class PromotionLedgerError extends Error {
  constructor(readonly code: PromotionLedgerErrorCode) {
    super("Promotion ledger state is invalid for the requested operation.");
    this.name = "PromotionLedgerError";
  }
}

export interface PromotionAttemptClaim {
  readonly attemptId: string;
  readonly laneKey: string;
  readonly targetWatermark: bigint;
  readonly state: PromotionAttemptState;
  readonly contentIdentity: string | null;
  readonly publicationIdentity: string | null;
  readonly expectedPredecessorIdentity: string | null;
  readonly manifestSourceProofBody: string | null;
  readonly manifestSourceProofSha256: string | null;
  readonly claimToken: string;
  readonly claimExpiresAt: Date;
  readonly claimCount: number;
  readonly retryCount: number;
  readonly recovered: boolean;
}

export interface PromotionOperationInput {
  readonly operationIndex: number;
  readonly operationId: string;
  readonly operationKind: string;
  readonly requestPath: string;
  readonly canonicalRequestBody: string;
}

export interface PromotionOperationRecord extends PromotionOperationInput {
  readonly id: string;
  readonly requestSha256: string;
  readonly state: "pending" | "sent" | "acknowledged";
  readonly sendCount: number;
  readonly lastSentAt: Date | null;
  readonly acknowledgedAt: Date | null;
  readonly receiptBody: string | null;
  readonly receiptSha256: string | null;
}

export interface PromotionHealthSnapshot {
  readonly laneKey: string;
  readonly bootstrapState: PromotionBootstrapState;
  readonly settledWatermark: bigint;
  readonly settledAt: Date | null;
  readonly requestedWatermark: bigint;
  readonly requestedAt: Date | null;
  readonly confirmedWatermark: bigint;
  readonly confirmedPublicationIdentity: string | null;
  readonly activeAttemptId: string | null;
  readonly activeAttemptState: PromotionAttemptState | null;
  readonly activeAttemptWatermark: bigint | null;
  readonly activeAttemptStartedAt: Date | null;
  readonly activeAttemptAgeMilliseconds: number | null;
  readonly lastActivatedWatermark: bigint;
  readonly lastActivatedAt: Date | null;
  readonly lastUnchangedWatermark: bigint | null;
  readonly lastUnchangedObservedAt: Date | null;
  readonly retryAt: Date | null;
  readonly delayedVendorCount: number;
}

export interface CatalogPromotionScope {
  readonly organizationId: string;
  readonly deploymentKey: string;
  readonly lane: "catalog";
}

export interface CatalogPromotionPreparedSummary {
  readonly classification: "publish" | "refresh_unchanged";
  readonly publicReleaseId: string;
  readonly requestedWatermark: bigint;
  readonly observationSequence: number;
  readonly contentHash: string;
  readonly publicConfigHash: string;
  readonly repackSearchIndexHash: string;
  readonly publicVendorKeys: readonly string[];
  readonly delayedVendorCount: number;
  readonly expectedPredecessorPublicReleaseId: string | null;
}

export interface CatalogPromotionOperation {
  readonly ordinal: number;
  readonly kind: "start" | "applyBatch" | "finalize" | "refreshObservation";
  readonly operationId: string;
  readonly publicationId: string;
  readonly path: ProductionDataReleasePath;
  readonly bodyJson: string;
  readonly bodyDigest: string;
  readonly dispatchCount: number;
  readonly lastDispatchedAt: Date | null;
  readonly acknowledgedAt: Date | null;
  readonly receipt: ProductionReceipt | null;
}

export interface CatalogPromotionClaim {
  readonly attemptId: string;
  readonly requestedWatermark: bigint;
  readonly claimToken: string;
  readonly claimExpiresAt: Date;
  readonly retryCount: number;
  readonly nextRetryAt: Date | null;
  readonly createdAt: Date;
  readonly startedAt: Date;
  readonly prepared: CatalogPromotionPreparedSummary | null;
  readonly operations: readonly CatalogPromotionOperation[];
}

export interface CatalogReleaseBaseline {
  readonly activePublicReleaseId: string;
  readonly observationSequence: number;
  readonly contentHash: string;
  readonly publicConfigHash: string;
  readonly repackSearchIndexHash: string;
  readonly publicVendorKeys: readonly string[];
}

export interface CatalogPromotionHealth {
  readonly settledWatermark: bigint;
  readonly requestedWatermark: bigint | null;
  readonly activeAttempt: Readonly<{
    attemptId: string;
    requestedWatermark: bigint;
    state: "pending" | "claimed" | "retry_wait";
    createdAt: Date;
    claimExpiresAt: Date | null;
  }> | null;
  readonly lastActivatedWatermark: bigint | null;
  readonly lastActivatedAt: Date | null;
  readonly lastUnchangedWatermark: bigint | null;
  readonly lastUnchangedAt: Date | null;
  readonly retryAt: Date | null;
  readonly delayedVendorCount: number | null;
}

export interface PromotionLaneRow {
  laneKey: string;
  bootstrapState: PromotionHealthSnapshot["bootstrapState"];
  settledWatermark: bigint;
  settledAt: Date | null;
  requestedWatermark: bigint;
  requestedAt: Date | null;
  confirmedWatermark: bigint;
  confirmedPublicationIdentity: string | null;
  confirmedReceiptSha256: string | null;
  lastActivatedWatermark: bigint;
  lastActivatedAt: Date | null;
  lastUnchangedWatermark: bigint | null;
  lastUnchangedObservedAt: Date | null;
  nextRetryAt: Date | null;
  delayedVendorCount: number;
}

export interface PromotionAttemptRow {
  id: string;
  laneKey: string;
  targetWatermark: bigint;
  state: PromotionAttemptState;
  contentIdentity: string | null;
  publicationIdentity: string | null;
  expectedPredecessorIdentity: string | null;
  preparedClassification: CatalogPromotionPreparedSummary["classification"] | null;
  observationSequence: number | null;
  publicConfigHash: string | null;
  repackSearchIndexHash: string | null;
  publicVendorKeys: string[];
  preparedAt: Date | null;
  manifestSourceProofBody: string | null;
  manifestSourceProofSha256: string | null;
  claimToken: string | null;
  claimExpiresAt: Date | null;
  lastHeartbeatAt: Date | null;
  claimCount: number;
  retryCount: number;
  retryAt: Date | null;
  delayedVendorCount: number;
  createdAt: Date;
}

export interface PromotionOperationRow {
  id: string;
  operationIndex: number;
  operationId: string;
  operationKind: string;
  requestPath: string;
  canonicalRequestBody: string;
  requestSha256: string;
  state: PromotionOperationRecord["state"];
  sendCount: number;
  lastSentAt: Date | null;
  acknowledgedAt: Date | null;
  receiptBody: string | null;
  receiptSha256: string | null;
}

export const laneKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const workerKeyPattern = /^\S(?:.{0,126}\S)?$/su;
export const operationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const operationKindPattern = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/u;
export const requestPathPattern = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,511}$/u;
export const sha256Pattern = /^[0-9a-f]{64}$/u;
export const failureCodePattern = /^[A-Z0-9_]{1,128}$/u;
export const maximumOperationCount = 4_098;
export const maximumRequestBytes = 131_072;
export const maximumReceiptBytes = 262_144;
export const maximumManifestSourceProofBytes = 4 * 1_024 * 1_024;
export const pathByKind = Object.freeze({
  start: PRODUCTION_DATA_RELEASE_PATHS.start,
  applyBatch: PRODUCTION_DATA_RELEASE_PATHS.applyBatch,
  finalize: PRODUCTION_DATA_RELEASE_PATHS.finalize,
  refreshObservation: PRODUCTION_DATA_RELEASE_PATHS.refreshObservation,
});
export const activeStates: readonly PromotionAttemptState[] = [
  "assembling", "ready", "in_progress", "retry_wait",
];

export function promotionUuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function requireJsonText(value: string, maximumBytes: number): void {
  const byteCount = Buffer.byteLength(value, "utf8");
  if (byteCount < 2 || byteCount > maximumBytes) {
    throw new PromotionLedgerError("PROMOTION_INPUT_INVALID");
  }
  try {
    JSON.parse(value);
  } catch {
    throw new PromotionLedgerError("PROMOTION_INPUT_INVALID");
  }
}

export function requireBoundRepositoryKey(value: string): void {
  if (!laneKeyPattern.test(value)) {
    throw new PromotionLedgerError("PROMOTION_INPUT_INVALID");
  }
}

export function requireClaimWindow(now: Date, claimExpiresAt: Date): void {
  if (
    !Number.isFinite(now.getTime())
    || !Number.isFinite(claimExpiresAt.getTime())
    || claimExpiresAt <= now
  ) {
    throw new PromotionLedgerError("PROMOTION_INPUT_INVALID");
  }
}

export function mapPromotionOperation(
  row: PromotionOperationRow,
): PromotionOperationRecord {
  return {
    id: row.id,
    operationIndex: row.operationIndex,
    operationId: row.operationId,
    operationKind: row.operationKind,
    requestPath: row.requestPath,
    canonicalRequestBody: row.canonicalRequestBody,
    requestSha256: row.requestSha256,
    state: row.state,
    sendCount: row.sendCount,
    lastSentAt: row.lastSentAt,
    acknowledgedAt: row.acknowledgedAt,
    receiptBody: row.receiptBody,
    receiptSha256: row.receiptSha256,
  };
}

export function requireCatalogPrepared(
  prepared: CatalogPromotionPreparedSummary,
): void {
  const sortedVendorKeys = [...prepared.publicVendorKeys].sort();
  if (
    prepared.requestedWatermark <= 0n
    || !Number.isSafeInteger(prepared.observationSequence)
    || prepared.observationSequence <= 0
    || !sha256Pattern.test(prepared.contentHash)
    || !sha256Pattern.test(prepared.publicConfigHash)
    || !sha256Pattern.test(prepared.repackSearchIndexHash)
    || prepared.publicVendorKeys.length > 128
    || new Set(prepared.publicVendorKeys).size !== prepared.publicVendorKeys.length
    || sortedVendorKeys.some((key, index) => key !== prepared.publicVendorKeys[index])
    || prepared.publicVendorKeys.some((key) => !laneKeyPattern.test(key))
    || !Number.isSafeInteger(prepared.delayedVendorCount)
    || prepared.delayedVendorCount < 0
    || prepared.delayedVendorCount > 100_000
    || !workerKeyPattern.test(prepared.publicReleaseId)
    || (prepared.expectedPredecessorPublicReleaseId !== null
      && !workerKeyPattern.test(prepared.expectedPredecessorPublicReleaseId))
  ) throw new PromotionLedgerError("PROMOTION_INPUT_INVALID");
}

export function catalogPreparedMatches(
  attempt: PromotionAttemptRow,
  prepared: CatalogPromotionPreparedSummary,
): boolean {
  return attempt.preparedClassification === prepared.classification
    && attempt.publicationIdentity === prepared.publicReleaseId
    && attempt.targetWatermark === prepared.requestedWatermark
    && attempt.observationSequence === prepared.observationSequence
    && attempt.contentIdentity === prepared.contentHash
    && attempt.publicConfigHash === prepared.publicConfigHash
    && attempt.repackSearchIndexHash === prepared.repackSearchIndexHash
    && attempt.publicVendorKeys.length === prepared.publicVendorKeys.length
    && attempt.publicVendorKeys.every(
      (key, index) => key === prepared.publicVendorKeys[index],
    )
    && attempt.expectedPredecessorIdentity ===
      prepared.expectedPredecessorPublicReleaseId;
}
