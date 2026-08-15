import {
  PRODUCTION_DATA_RELEASE_PATHS,
  type ProductionDataReleasePath,
  type ProductionOperationKind,
  type ProductionReceipt,
} from "@packscout/contracts";
import type {
  CatalogReleaseBaseline,
  CatalogReleasePlanV2,
} from "./catalog-release-types.ts";

export type CatalogPromotionOperationKind = Extract<
  ProductionOperationKind,
  "start" | "applyBatch" | "finalize" | "refreshObservation"
>;

export const CATALOG_PROMOTION_PATH_BY_KIND: Readonly<
  Record<CatalogPromotionOperationKind, ProductionDataReleasePath>
> = Object.freeze({
  start: PRODUCTION_DATA_RELEASE_PATHS.start,
  applyBatch: PRODUCTION_DATA_RELEASE_PATHS.applyBatch,
  finalize: PRODUCTION_DATA_RELEASE_PATHS.finalize,
  refreshObservation: PRODUCTION_DATA_RELEASE_PATHS.refreshObservation,
});

export type CatalogPromotionTerminalOutcome =
  | "published"
  | "unchanged"
  | "failed"
  | "rolled_back";

export interface CatalogPromotionScope {
  readonly organizationId: string;
  readonly deploymentKey: string;
  readonly lane: "catalog";
}

export interface CatalogPromotionOperation {
  readonly ordinal: number;
  readonly kind: CatalogPromotionOperationKind;
  readonly operationId: string;
  readonly publicationId: string;
  readonly path: ProductionDataReleasePath;
  /** Exact canonical UTF-8 request bytes, persisted before the first send. */
  readonly bodyJson: string;
  readonly bodyDigest: string;
  readonly dispatchCount: number;
  readonly lastDispatchedAt: Date | null;
  readonly acknowledgedAt: Date | null;
  readonly receipt: ProductionReceipt | null;
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

export type CatalogPromotionCoalesceResult =
  | "created"
  | "coalesced"
  | "already_covered";

/**
 * Structural persistence boundary. The PostgreSQL adapter owns tenant binding,
 * uniqueness, leasing, and stale-token rejection; the runner owns sequencing.
 */
export interface CatalogPromotionLedgerPort {
  coalesce(input: CatalogPromotionScope & Readonly<{
    settledWatermark: bigint;
    requestedAt: Date;
  }>): Promise<CatalogPromotionCoalesceResult>;

  claim(input: CatalogPromotionScope & Readonly<{
    workerId: string;
    now: Date;
    leaseExpiresAt: Date;
  }>): Promise<CatalogPromotionClaim | null>;

  heartbeat(input: Readonly<{
    attemptId: string;
    claimToken: string;
    now: Date;
    leaseExpiresAt: Date;
  }>): Promise<boolean>;

  loadBaseline(scope: CatalogPromotionScope): Promise<CatalogReleaseBaseline | null>;

  persistPreparedOperations(input: Readonly<{
    attemptId: string;
    claimToken: string;
    prepared: CatalogPromotionPreparedSummary;
    operations: readonly CatalogPromotionOperation[];
    preparedAt: Date;
  }>): Promise<boolean>;

  markOperationDispatched(input: Readonly<{
    attemptId: string;
    claimToken: string;
    ordinal: number;
    dispatchedAt: Date;
  }>): Promise<boolean>;

  acknowledgeOperation(input: Readonly<{
    attemptId: string;
    claimToken: string;
    ordinal: number;
    receipt: ProductionReceipt;
    acknowledgedAt: Date;
  }>): Promise<boolean>;

  scheduleRetry(input: Readonly<{
    attemptId: string;
    claimToken: string;
    failureCode: string;
    retryCount: number;
    retryAt: Date;
    acknowledgedAt: Date;
  }>): Promise<boolean>;

  acknowledgeTerminal(input: Readonly<{
    attemptId: string;
    claimToken: string;
    outcome: CatalogPromotionTerminalOutcome;
    failureCode: string | null;
    receipt: ProductionReceipt | null;
    completedAt: Date;
    prepared: CatalogPromotionPreparedSummary | null;
  }>): Promise<boolean>;

  loadHealth(scope: CatalogPromotionScope): Promise<CatalogPromotionHealth>;
}

export interface CatalogReleaseAssemblerPort {
  assemble(input: {
    requestedWatermark: bigint;
    baseline: CatalogReleaseBaseline | null;
    trigger: "full_rebuild" | "settled_change";
  }): Promise<CatalogReleasePlanV2>;
}

export interface CatalogPromotionSettlementPort {
  getCheckpoint(): Promise<Readonly<{
    settledSequence: bigint;
    settledAt: Date | null;
  }>>;
}

export interface CatalogPublicationStatusInput {
  readonly operationId: string;
  readonly publicationId: string;
  readonly expectedRequestDigest: string;
  readonly expectedKind: CatalogPromotionOperationKind;
}

export interface CatalogPublicationTransport {
  send(
    operation: CatalogPromotionOperation,
    signal?: AbortSignal,
  ): Promise<ProductionReceipt>;
  status(
    input: CatalogPublicationStatusInput,
    signal?: AbortSignal,
  ): Promise<ProductionReceipt | null>;
}

export interface CatalogPublicationActiveState {
  readonly activePublicReleaseId: string | null;
  readonly observationSequence: number;
  readonly terminalReceiptSha256: string | null;
}

export interface CatalogPublicationActiveStateTransport {
  activeState(signal?: AbortSignal): Promise<CatalogPublicationActiveState>;
}

export interface CatalogPromotionBootstrapPort {
  ensureVerified(input: CatalogPromotionScope & Readonly<{
    verifiedAt: Date;
    signal?: AbortSignal;
  }>): Promise<void>;
}

export interface CatalogPromotionClock {
  now(): Date;
}

export interface CatalogPromotionRandom {
  fraction(): number;
}

export interface CatalogPromotionAlertSink {
  notify(input: Readonly<{
    attemptId: string;
    requestedWatermark: bigint;
    failureCode: string;
    occurredAt: Date;
  }>): Promise<void>;
}

export interface CatalogPromotionHealthSink {
  report(health: CatalogPromotionHealth): void;
}
