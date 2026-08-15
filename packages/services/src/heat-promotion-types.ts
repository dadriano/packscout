import type {
  ProductionHeatFrameEnvelope,
  ProductionHeatOperationKind,
  ProductionHeatReceipt,
  ProductionRepackHeatPath,
  PublicRepackHeatSignal,
} from "@packscout/contracts";
import type {
  NormalizedHeatFrameRead,
} from "./normalized-heat-observation-port.ts";

export type HeatPromotionOperationKind = Extract<
  ProductionHeatOperationKind,
  "start" | "applyBatch" | "finalize" | "refreshFrame"
>;

export interface HeatPromotionOperation {
  readonly operationIndex: number;
  readonly operationId: string;
  readonly operationKind: HeatPromotionOperationKind;
  readonly requestPath: ProductionRepackHeatPath;
  readonly canonicalRequestBody: string;
  readonly requestSha256: string;
  readonly state: "pending" | "sent" | "acknowledged";
  readonly sendCount: number;
  readonly lastSentAt: Date | null;
  readonly acknowledgedAt: Date | null;
  readonly receiptBody: string | null;
  readonly receiptSha256: string | null;
}

export interface HeatPromotionPreparedPlan {
  readonly classification: "publish" | "refresh_unchanged";
  readonly publicHeatFrameId: string;
  readonly targetFrameSequence: bigint;
  readonly catalogPublicReleaseId: string;
  readonly sourceWatermark: bigint;
  readonly signalSetHash: string;
  readonly contentIdentity: string;
  readonly frameHash: string;
  readonly signalCount: number;
  readonly frame: ProductionHeatFrameEnvelope;
  readonly signals: readonly PublicRepackHeatSignal[];
  readonly operations: readonly HeatPromotionOperation[];
}

export interface HeatPromotionClaim {
  readonly attemptId: string;
  readonly laneKey: string;
  readonly targetWatermark: bigint;
  readonly state:
    | "assembling" | "ready" | "in_progress" | "retry_wait"
    | "published" | "unchanged" | "failed" | "rolled_back";
  readonly contentIdentity: string | null;
  readonly publicationIdentity: string | null;
  readonly expectedPredecessorIdentity: string | null;
  readonly claimToken: string;
  readonly claimExpiresAt: Date;
  readonly claimCount: number;
  readonly retryCount: number;
  readonly recovered: boolean;
}

export interface HeatPromotionHealth {
  readonly settledWatermark: bigint;
  readonly requestedWatermark: bigint;
  readonly confirmedWatermark: bigint;
  readonly confirmedPublicationIdentity: string | null;
  readonly activeAttemptId: string | null;
  readonly activeAttemptState: string | null;
  readonly retryAt: Date | null;
  readonly lastActivatedAt: Date | null;
  readonly lastUnchangedObservedAt: Date | null;
}

export interface HeatPromotionLedgerPort {
  coalesceSettledWatermark(input: Readonly<{
    laneKey: "heat";
    settledWatermark: bigint;
    settledAt: Date;
    delayedVendorCount: 0;
  }>): Promise<Readonly<{
    settledWatermark: bigint;
    requestedWatermark: bigint;
  }>>;
  loadBootstrapState(laneKey: "heat"): Promise<
    "unverified" | "verified_empty" | "verified_local"
  >;
  verifyBootstrap(input: Readonly<{
    laneKey: "heat";
    observedPublicationIdentity: string | null;
    observedWatermark: bigint;
    observedReceiptSha256: string | null;
    verifiedAt: Date;
  }>): Promise<void>;
  claimAttempt(input: Readonly<{
    laneKey: "heat";
    claimOwner: string;
    now: Date;
    claimExpiresAt: Date;
  }>): Promise<HeatPromotionClaim | null>;
  heartbeat(input: Readonly<{
    attemptId: string;
    claimToken: string;
    heartbeatAt: Date;
    claimExpiresAt: Date;
  }>): Promise<boolean>;
  persistAssembledOperations(input: Readonly<{
    attemptId: string;
    claimToken: string;
    now: Date;
    contentIdentity: string;
    publicationIdentity: string;
    preparedClassification: "publish" | "refresh_unchanged";
    operations: readonly Readonly<{
      operationIndex: number;
      operationId: string;
      operationKind: string;
      requestPath: string;
      canonicalRequestBody: string;
    }>[];
  }>): Promise<readonly HeatPromotionOperation[] | null>;
  listAttemptOperations(input: Readonly<{
    attemptId: string;
  }>): Promise<readonly HeatPromotionOperation[]>;
  firstUnacknowledgedOperation(input: Readonly<{
    attemptId: string;
    claimToken: string;
    now: Date;
  }>): Promise<HeatPromotionOperation | null>;
  markOperationSent(input: Readonly<{
    attemptId: string;
    operationId: string;
    claimToken: string;
    sentAt: Date;
  }>): Promise<boolean>;
  acknowledgeOperation(input: Readonly<{
    attemptId: string;
    operationId: string;
    claimToken: string;
    acknowledgedAt: Date;
    receiptBody: string;
  }>): Promise<boolean>;
  scheduleRetry(input: Readonly<{
    attemptId: string;
    claimToken: string;
    failedAt: Date;
    retryAt: Date;
    failureClass: "technical" | "reconciliation";
    failureCode: string;
  }>): Promise<boolean>;
  completeAttempt(input: Readonly<{
    attemptId: string;
    claimToken: string;
    terminalState: "published" | "unchanged" | "failed";
    completedAt: Date;
    receiptBody: string | null;
    failureClass: "technical" | "deterministic" | "reconciliation" | null;
    failureCode: string | null;
  }>): Promise<boolean>;
  loadHealthSnapshot(input: Readonly<{
    laneKey: "heat";
    now: Date;
  }>): Promise<HeatPromotionHealth | null>;
}

export interface ActiveCatalogHeatRelease {
  readonly publicReleaseId: string;
  readonly publicRepackIds: readonly string[];
  readonly confirmedWatermark: bigint;
  readonly terminalReceiptSha256: string;
}

export interface ActiveHeatFrameBaseline {
  readonly publicHeatFrameId: string;
  readonly catalogPublicReleaseId: string;
  readonly frameSequence: number;
  readonly sourceWatermark: bigint;
  readonly signalSetHash: string;
  readonly frameHash: string;
  readonly signalCount: number;
  readonly terminalReceiptSha256: string;
}

export interface HeatPromotionReleaseProofPort {
  loadActiveCatalogRelease(): Promise<ActiveCatalogHeatRelease | null>;
  loadActiveHeatFrame(): Promise<ActiveHeatFrameBaseline | null>;
  hasReusableHeatSignalSet(input: Readonly<{
    catalogPublicReleaseId: string;
    signalSetHash: string;
    contentIdentity: string;
    signalCount: number;
    reusableAt: Date;
  }>): Promise<boolean>;
}

export interface HeatPromotionSettlementPort {
  getCheckpoint(): Promise<Readonly<{
    settledSequence: bigint;
    settledAt: Date | null;
  }>>;
}

export interface HeatPromotionObservationPort {
  readFrame(input: Readonly<{
    publicRepackIds: readonly string[];
    frameEndedAt: string;
    maximumSettledCausalSequence: bigint;
    limit?: number;
  }>): Promise<NormalizedHeatFrameRead>;
}

export interface HeatPublicationStatusInput {
  readonly operationId: string;
  readonly publicationId: string;
  readonly expectedRequestDigest: string;
  readonly expectedKind: HeatPromotionOperationKind;
}

export interface HeatPublicationTransport {
  send(
    operation: HeatPromotionOperation,
    signal?: AbortSignal,
  ): Promise<ProductionHeatReceipt>;
  status(
    input: HeatPublicationStatusInput,
    signal?: AbortSignal,
  ): Promise<ProductionHeatReceipt | null>;
}

export interface HeatPublicationActiveState {
  readonly activePublicHeatFrameId: string | null;
  readonly catalogPublicReleaseId: string | null;
  readonly sourceWatermark: bigint | null;
  readonly frameSequence: number;
  readonly terminalReceiptSha256: string | null;
}

export interface HeatPublicationActiveStateTransport {
  activeState(signal?: AbortSignal): Promise<HeatPublicationActiveState>;
}

export interface HeatPromotionBootstrapPort {
  ensureVerified(input: Readonly<{
    verifiedAt: Date;
    signal?: AbortSignal;
  }>): Promise<void>;
}

export interface HeatPromotionClock {
  now(): Date;
}

export interface HeatPromotionAlertSink {
  notify(input: Readonly<{
    attemptId: string;
    frameSequence: bigint;
    failureCode: string;
    occurredAt: Date;
  }>): Promise<void>;
}

export interface HeatPromotionHealthSink {
  report(health: HeatPromotionHealth): void | Promise<void>;
}
