import { createHash } from "node:crypto";
import {
  EMPTY_PRODUCTION_HEAT_SIGNAL_SET_HASH,
  REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
  extendProductionHeatSignalSetHash,
  productionHeatApplyBatchRequestSchema,
  productionHeatBatchByteCount,
  productionHeatCoreByteCount,
  productionHeatFinalizeRequestSchema,
  productionHeatReceiptHash,
  productionHeatReceiptSchema,
  productionHeatRefreshFrameRequestSchema,
  productionHeatStartRequestSchema,
  type ProductionHeatReceipt,
} from "@packscout/contracts";
import { CatalogPublicationClientError } from "./convex-catalog-publication-client.ts";
import type {
  ActiveCatalogHeatManifest,
  HeatPromotionClaim,
  HeatPromotionHealth,
  HeatPromotionLedgerPort,
  HeatPromotionOperation,
  HeatPublicationStatusInput,
  HeatPublicationTransport,
} from "./heat-promotion-types.ts";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export class MutableHeatTestClock {
  constructor(private value = new Date("2026-08-15T12:00:01.000Z")) {}
  now(): Date { return new Date(this.value); }
  advance(milliseconds: number): void {
    this.value = new Date(this.value.getTime() + milliseconds);
  }
}

interface MutableHeatAttempt {
  attemptId: string;
  targetWatermark: bigint;
  state: HeatPromotionClaim["state"];
  contentIdentity: string | null;
  publicationIdentity: string | null;
  preparedClassification: "publish" | "refresh_unchanged" | null;
  expectedPredecessorIdentity: string | null;
  manifestSourceProof: ActiveCatalogHeatManifest | null;
  claimToken: string;
  claimExpiresAt: Date;
  claimCount: number;
  retryCount: number;
  retryAt: Date | null;
  operations: HeatPromotionOperation[];
  createdAt: Date;
}

export class MemoryHeatPromotionLedger implements HeatPromotionLedgerPort {
  attempt: MutableHeatAttempt | null = null;
  bootstrapState: "unverified" | "verified_empty" | "verified_local" =
    "verified_empty";
  confirmedPublicationIdentity: string | null = null;
  confirmedWatermark = 0n;
  expectedPredecessorIdentity: string | null = null;
  pendingWatermark: bigint | null = null;
  rejectAcknowledgement = false;
  rejectCompletionOnce = false;
  settledWatermark = 0n;
  readonly retryDelays: number[] = [];
  readonly terminal: Array<Readonly<{
    state: "published" | "unchanged" | "failed";
    failureCode: string | null;
    failureClass: "technical" | "deterministic" | "reconciliation" | null;
    targetWatermark: bigint;
    preparedClassification: "publish" | "refresh_unchanged" | null;
  }>> = [];
  private attemptNumber = 0;
  private claimNumber = 0;

  coalesceSettledWatermark(input: {
    settledWatermark: bigint;
    settledAt: Date;
  }): Promise<Readonly<{ settledWatermark: bigint; requestedWatermark: bigint }>> {
    this.settledWatermark = this.settledWatermark > input.settledWatermark
      ? this.settledWatermark : input.settledWatermark;
    if (
      this.attempt === null &&
      input.settledWatermark > this.confirmedWatermark
    ) {
      this.attempt = this.newAttempt(input.settledWatermark, input.settledAt);
    } else if (
      this.attempt !== null &&
      input.settledWatermark > this.attempt.targetWatermark
    ) {
      this.pendingWatermark = this.pendingWatermark === null ||
          input.settledWatermark > this.pendingWatermark
        ? input.settledWatermark : this.pendingWatermark;
    }
    return Promise.resolve({
      settledWatermark: this.settledWatermark,
      requestedWatermark: this.pendingWatermark ??
        this.attempt?.targetWatermark ?? this.confirmedWatermark,
    });
  }

  loadBootstrapState(): Promise<
    "unverified" | "verified_empty" | "verified_local"
  > {
    return Promise.resolve(this.bootstrapState);
  }

  verifyBootstrap(input: {
    observedPublicationIdentity: string | null;
    observedWatermark: bigint;
  }): Promise<void> {
    this.bootstrapState = input.observedPublicationIdentity === null
      ? "verified_empty" : "verified_local";
    this.confirmedPublicationIdentity = input.observedPublicationIdentity;
    this.confirmedWatermark = input.observedWatermark;
    this.expectedPredecessorIdentity = input.observedPublicationIdentity;
    return Promise.resolve();
  }

  claimAttempt(input: {
    now: Date;
    claimExpiresAt: Date;
  }): Promise<HeatPromotionClaim | null> {
    const attempt = this.attempt;
    if (
      attempt === null ||
      (attempt.retryAt !== null && attempt.retryAt > input.now)
    ) return Promise.resolve(null);
    attempt.claimToken = `claim-${++this.claimNumber}`;
    attempt.claimExpiresAt = input.claimExpiresAt;
    attempt.claimCount += 1;
    attempt.retryAt = null;
    attempt.state = attempt.contentIdentity === null ? "assembling" : "in_progress";
    return Promise.resolve(this.claim(attempt));
  }

  heartbeat(input: {
    attemptId: string;
    claimToken: string;
    claimExpiresAt: Date;
  }): Promise<boolean> {
    if (!this.validClaim(input.attemptId, input.claimToken)) {
      return Promise.resolve(false);
    }
    this.attempt!.claimExpiresAt = input.claimExpiresAt;
    return Promise.resolve(true);
  }

  persistAssembledOperations(input: {
    attemptId: string;
    claimToken: string;
    contentIdentity: string;
    publicationIdentity: string;
    preparedClassification: "publish" | "refresh_unchanged";
    manifestSourceProof: ActiveCatalogHeatManifest;
    operations: readonly Readonly<{
      operationIndex: number;
      operationId: string;
      operationKind: string;
      requestPath: string;
      canonicalRequestBody: string;
    }>[];
  }): Promise<readonly HeatPromotionOperation[] | null> {
    if (!this.validClaim(input.attemptId, input.claimToken)) {
      return Promise.resolve(null);
    }
    const attempt = this.attempt!;
    attempt.contentIdentity = input.contentIdentity;
    attempt.publicationIdentity = input.publicationIdentity;
    attempt.preparedClassification = input.preparedClassification;
    attempt.manifestSourceProof = structuredClone(input.manifestSourceProof);
    attempt.state = "ready";
    attempt.operations = input.operations.map((operation) => ({
      operationIndex: operation.operationIndex,
      operationId: operation.operationId,
      operationKind: operation.operationKind as HeatPromotionOperation["operationKind"],
      requestPath: operation.requestPath as HeatPromotionOperation["requestPath"],
      canonicalRequestBody: operation.canonicalRequestBody,
      requestSha256: sha256(operation.canonicalRequestBody),
      state: "pending",
      sendCount: 0,
      lastSentAt: null,
      acknowledgedAt: null,
      receiptBody: null,
      receiptSha256: null,
    }));
    return Promise.resolve(this.operations());
  }

  listAttemptOperations(input: {
    attemptId: string;
  }): Promise<readonly HeatPromotionOperation[]> {
    return Promise.resolve(
      this.attempt?.attemptId === input.attemptId ? this.operations() : [],
    );
  }

  firstUnacknowledgedOperation(input: {
    attemptId: string;
    claimToken: string;
  }): Promise<HeatPromotionOperation | null> {
    if (!this.validClaim(input.attemptId, input.claimToken)) {
      return Promise.resolve(null);
    }
    return Promise.resolve(
      this.attempt!.operations.find(({ state }) => state !== "acknowledged") ?? null,
    );
  }

  markOperationSent(input: {
    attemptId: string;
    operationId: string;
    claimToken: string;
    sentAt: Date;
  }): Promise<boolean> {
    const operation = this.operation(input);
    if (operation === null || operation.state === "acknowledged") {
      return Promise.resolve(false);
    }
    Object.assign(operation, {
      state: "sent" as const,
      sendCount: operation.sendCount + 1,
      lastSentAt: input.sentAt,
    });
    return Promise.resolve(true);
  }

  acknowledgeOperation(input: {
    attemptId: string;
    operationId: string;
    claimToken: string;
    acknowledgedAt: Date;
    receiptBody: string;
  }): Promise<boolean> {
    if (this.rejectAcknowledgement) return Promise.resolve(false);
    const operation = this.operation(input);
    if (operation === null || operation.state !== "sent") {
      return Promise.resolve(false);
    }
    Object.assign(operation, {
      state: "acknowledged" as const,
      acknowledgedAt: input.acknowledgedAt,
      receiptBody: input.receiptBody,
      receiptSha256: sha256(input.receiptBody),
    });
    return Promise.resolve(true);
  }

  scheduleRetry(input: {
    attemptId: string;
    claimToken: string;
    failedAt: Date;
    retryAt: Date;
  }): Promise<boolean> {
    if (!this.validClaim(input.attemptId, input.claimToken)) {
      return Promise.resolve(false);
    }
    this.retryDelays.push(input.retryAt.getTime() - input.failedAt.getTime());
    this.attempt!.retryCount += 1;
    this.attempt!.retryAt = input.retryAt;
    this.attempt!.state = "retry_wait";
    this.attempt!.claimToken = "released";
    return Promise.resolve(true);
  }

  completeAttempt(input: {
    attemptId: string;
    claimToken: string;
    terminalState: "published" | "unchanged" | "failed";
    completedAt: Date;
    failureClass: "technical" | "deterministic" | "reconciliation" | null;
    failureCode: string | null;
  }): Promise<boolean> {
    if (!this.validClaim(input.attemptId, input.claimToken)) {
      return Promise.resolve(false);
    }
    if (this.rejectCompletionOnce) {
      this.rejectCompletionOnce = false;
      return Promise.resolve(false);
    }
    const completed = this.attempt!;
    this.terminal.push({
      state: input.terminalState,
      failureCode: input.failureCode,
      failureClass: input.failureClass,
      targetWatermark: completed.targetWatermark,
      preparedClassification: completed.preparedClassification,
    });
    if (input.terminalState === "published") {
      this.confirmedWatermark = completed.targetWatermark;
      this.confirmedPublicationIdentity = completed.publicationIdentity;
      this.expectedPredecessorIdentity = completed.publicationIdentity;
      this.bootstrapState = "verified_local";
    }
    this.attempt = this.pendingWatermark === null
      ? null : this.newAttempt(this.pendingWatermark, input.completedAt);
    this.pendingWatermark = null;
    return Promise.resolve(true);
  }

  loadHealthSnapshot(): Promise<HeatPromotionHealth> {
    return Promise.resolve({
      settledWatermark: this.settledWatermark,
      requestedWatermark: this.pendingWatermark ??
        this.attempt?.targetWatermark ?? this.confirmedWatermark,
      confirmedWatermark: this.confirmedWatermark,
      confirmedPublicationIdentity: this.confirmedPublicationIdentity,
      activeAttemptId: this.attempt?.attemptId ?? null,
      activeAttemptState: this.attempt?.state ?? null,
      retryAt: this.attempt?.retryAt ?? null,
      lastActivatedAt: null,
      lastUnchangedObservedAt: null,
      manifestAlignment: this.attempt?.manifestSourceProof?.manifestAlignment ??
        null,
      alignmentMatchesActiveManifest: true,
      frameCalculatedAt: null,
      frameExpiresAt: null,
    });
  }

  private claim(attempt: MutableHeatAttempt): HeatPromotionClaim {
    return {
      attemptId: attempt.attemptId,
      laneKey: "heat",
      targetWatermark: attempt.targetWatermark,
      state: attempt.state,
      contentIdentity: attempt.contentIdentity,
      publicationIdentity: attempt.publicationIdentity,
      expectedPredecessorIdentity: attempt.expectedPredecessorIdentity,
      manifestSourceProof: attempt.manifestSourceProof === null
        ? null : structuredClone(attempt.manifestSourceProof),
      claimToken: attempt.claimToken,
      claimExpiresAt: new Date(attempt.claimExpiresAt),
      claimCount: attempt.claimCount,
      retryCount: attempt.retryCount,
      recovered: attempt.claimCount > 1,
    };
  }

  private newAttempt(targetWatermark: bigint, createdAt: Date): MutableHeatAttempt {
    return {
      attemptId: `attempt-${++this.attemptNumber}`,
      targetWatermark,
      state: "assembling",
      contentIdentity: null,
      publicationIdentity: null,
      preparedClassification: null,
      expectedPredecessorIdentity: this.expectedPredecessorIdentity,
      manifestSourceProof: null,
      claimToken: "unclaimed",
      claimExpiresAt: createdAt,
      claimCount: 0,
      retryCount: 0,
      retryAt: null,
      operations: [],
      createdAt,
    };
  }

  private operations(): HeatPromotionOperation[] {
    return this.attempt?.operations.map((operation) => ({ ...operation })) ?? [];
  }

  private validClaim(attemptId: string, claimToken: string): boolean {
    return this.attempt?.attemptId === attemptId &&
      this.attempt.claimToken === claimToken;
  }

  private operation(input: {
    attemptId: string;
    operationId: string;
    claimToken: string;
  }): HeatPromotionOperation | null {
    if (!this.validClaim(input.attemptId, input.claimToken)) return null;
    return this.attempt!.operations.find(({ operationId }) =>
      operationId === input.operationId) ?? null;
  }
}

async function receipt(value: Readonly<Record<string, unknown>>): Promise<
  ProductionHeatReceipt
> {
  return productionHeatReceiptSchema.parse({
    ...value,
    receiptDigest: await productionHeatReceiptHash(value),
  });
}

export class FakeHeatPublicationTransport implements HeatPublicationTransport {
  readonly events: string[] = [];
  readonly sentBodies: string[] = [];
  readonly sentOperationIds: string[] = [];
  readonly statusOperationIds: string[] = [];
  corruptBatchProgress = false;
  failBeforeStore: HeatPromotionOperation["operationKind"] | null = null;
  failBeforeStoreCount = 1;
  loseAfterStore: HeatPromotionOperation["operationKind"] | null = null;
  terminalFailureCode:
    | "PUBLICATION_PREDECESSOR_CONFLICT"
    | "PUBLICATION_RECONCILIATION_FAILED"
    | "PUBLICATION_REQUEST_INVALID"
    | "PUBLICATION_STATE_CONFLICT"
    | null = null;
  private lost = false;
  private readonly frames = new Map<string, ReturnType<
    typeof productionHeatStartRequestSchema.parse
  >["frame"]>();
  private readonly progress = new Map<string, Readonly<{
    acceptedSignalCount: number;
    signalSetProgressHash: string;
  }>>();
  private readonly receipts = new Map<string, ProductionHeatReceipt>();

  async send(operation: HeatPromotionOperation): Promise<ProductionHeatReceipt> {
    this.events.push(`send:${operation.operationKind}`);
    this.sentBodies.push(operation.canonicalRequestBody);
    this.sentOperationIds.push(operation.operationId);
    if (this.terminalFailureCode !== null) {
      throw new CatalogPublicationClientError(
        this.terminalFailureCode,
        "terminal",
        false,
      );
    }
    if (
      this.failBeforeStore === operation.operationKind &&
      this.failBeforeStoreCount > 0
    ) {
      this.failBeforeStoreCount -= 1;
      throw new CatalogPublicationClientError(
        "PUBLICATION_NETWORK_ERROR", "retryable", true,
      );
    }
    const stored = await this.createReceipt(operation);
    this.receipts.set(operation.operationId, stored);
    if (this.loseAfterStore === operation.operationKind && !this.lost) {
      this.lost = true;
      throw new CatalogPublicationClientError(
        "PUBLICATION_NETWORK_ERROR", "retryable", true,
      );
    }
    return stored;
  }

  status(input: HeatPublicationStatusInput): Promise<ProductionHeatReceipt | null> {
    this.events.push(`status:${input.expectedKind}`);
    this.statusOperationIds.push(input.operationId);
    return Promise.resolve(this.receipts.get(input.operationId) ?? null);
  }

  private async createReceipt(
    operation: HeatPromotionOperation,
  ): Promise<ProductionHeatReceipt> {
    const common = {
      schemaVersion: REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
      operationId: operation.operationId,
      publicationId: JSON.parse(operation.canonicalRequestBody).publicationId,
      serverTime: "2026-08-15T12:00:01.000Z",
      requestDigest: operation.requestSha256,
    } as const;
    if (operation.operationKind === "start") {
      const request = productionHeatStartRequestSchema.parse(
        JSON.parse(operation.canonicalRequestBody) as unknown,
      );
      this.frames.set(request.publicationId, request.frame);
      this.progress.set(request.publicationId, {
        acceptedSignalCount: 0,
        signalSetProgressHash: EMPTY_PRODUCTION_HEAT_SIGNAL_SET_HASH,
      });
      return receipt({
        ...common,
        operationKind: "start",
        terminalState: "staging",
        result: "created",
        details: {
          manifestAlignment: request.frame.manifestAlignment,
          frameHash: request.frame.frameHash,
          signalSetHash: request.frame.signalSetHash,
          sourceWatermark: request.frame.sourceWatermark,
          frameSequence: request.frame.frameSequence,
          expectedSignalCount: request.frame.signalCount,
          expectedBatchCount: request.expectedBatchCount,
        },
      });
    }
    if (operation.operationKind === "applyBatch") {
      const request = productionHeatApplyBatchRequestSchema.parse(
        JSON.parse(operation.canonicalRequestBody) as unknown,
      );
      const previous = this.progress.get(request.publicationId)!;
      const coreByteCount = productionHeatCoreByteCount(request.records);
      const next = {
        acceptedSignalCount:
          previous.acceptedSignalCount + request.records.length,
        signalSetProgressHash: await extendProductionHeatSignalSetHash({
          previousHash: previous.signalSetProgressHash,
          batchIndex: request.batchIndex,
          batchHash: request.batchHash,
          recordCount: request.records.length,
          coreByteCount,
        }),
      };
      this.progress.set(request.publicationId, next);
      return receipt({
        ...common,
        operationKind: "applyBatch",
        terminalState: "staging",
        result: "accepted",
        details: {
          batchIndex: request.batchIndex,
          batchHash: request.batchHash,
          recordCount: request.records.length,
          byteCount: productionHeatBatchByteCount(request.records),
          coreByteCount,
          acceptedSignalCount: this.corruptBatchProgress
            ? next.acceptedSignalCount + 1 : next.acceptedSignalCount,
          signalSetProgressHash: next.signalSetProgressHash,
        },
      });
    }
    if (operation.operationKind === "finalize") {
      const request = productionHeatFinalizeRequestSchema.parse(
        JSON.parse(operation.canonicalRequestBody) as unknown,
      );
      return this.activatedReceipt(common, request.publicationId, {
        operationKind: "finalize",
        result: "activated",
        previousPublicHeatFrameId: request.expectedActivePublicHeatFrameId,
      });
    }
    const request = productionHeatRefreshFrameRequestSchema.parse(
      JSON.parse(operation.canonicalRequestBody) as unknown,
    );
    this.frames.set(request.publicationId, request.frame);
    return this.activatedReceipt(common, request.publicationId, {
      operationKind: "refreshFrame",
      result: "refreshed",
      previousPublicHeatFrameId: request.expectedActivePublicHeatFrameId,
    });
  }

  private activatedReceipt(
    common: Readonly<Record<string, unknown>>,
    publicationId: string,
    activation: Readonly<{
      operationKind: "finalize" | "refreshFrame";
      result: "activated" | "refreshed";
      previousPublicHeatFrameId: string | null;
    }>,
  ): Promise<ProductionHeatReceipt> {
    const frame = this.frames.get(publicationId)!;
    return receipt({
      ...common,
      operationKind: activation.operationKind,
      terminalState: "complete",
      result: activation.result,
      details: {
        manifestAlignment: frame.manifestAlignment,
        activePublicHeatFrameId: frame.publicHeatFrameId,
        previousPublicHeatFrameId: activation.previousPublicHeatFrameId,
        frameHash: frame.frameHash,
        signalSetHash: frame.signalSetHash,
        sourceWatermark: frame.sourceWatermark,
        frameSequence: frame.frameSequence,
        signalCount: frame.signalCount,
        calculatedAt: frame.calculatedAt,
        expiresAt: frame.expiresAt,
      },
    });
  }
}
