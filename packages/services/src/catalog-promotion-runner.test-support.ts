import {
  DATA_RELEASE_SCHEMA_VERSION,
  productionApplyBatchRequestSchema,
  productionBatchByteCount,
  productionFinalizeRequestSchema,
  productionReceiptHash,
  productionRefreshRequestSchema,
  productionStartRequestSchema,
  type ProductionReceipt,
} from "@packscout/contracts";
import { CatalogPublicationClientError } from "./convex-catalog-publication-client.ts";
import type { CatalogReleaseBaseline } from "./catalog-release-types.ts";
import type {
  CatalogPromotionClaim,
  CatalogPromotionCoalesceResult,
  CatalogPromotionHealth,
  CatalogPromotionLedgerPort,
  CatalogPromotionOperation,
  CatalogPromotionPreparedSummary,
  CatalogPromotionScope,
  CatalogPromotionTerminalOutcome,
  CatalogPublicationStatusInput,
  CatalogPublicationTransport,
} from "./catalog-promotion-types.ts";

export class MutableTestClock {
  constructor(private value = new Date("2026-08-15T12:00:00.000Z")) {}
  now(): Date { return new Date(this.value); }
  advance(milliseconds: number): void {
    this.value = new Date(this.value.getTime() + milliseconds);
  }
}

interface MutableAttempt {
  attemptId: string;
  requestedWatermark: bigint;
  claimToken: string;
  claimExpiresAt: Date;
  retryCount: number;
  nextRetryAt: Date | null;
  createdAt: Date;
  startedAt: Date;
  prepared: CatalogPromotionPreparedSummary | null;
  operations: CatalogPromotionOperation[];
}

export class MemoryCatalogPromotionLedger implements CatalogPromotionLedgerPort {
  attempt: MutableAttempt | null = null;
  baseline: CatalogReleaseBaseline | null = null;
  pendingWatermark: bigint | null = null;
  rejectOperationAcknowledgement = false;
  settledWatermark = 0n;
  readonly terminal: Array<{
    outcome: CatalogPromotionTerminalOutcome;
    failureCode: string | null;
    requestedWatermark: bigint;
  }> = [];
  readonly retryDelays: number[] = [];
  private claimNumber = 0;
  private attemptNumber = 0;
  private lastActivatedAt: Date | null = null;
  private lastActivatedWatermark: bigint | null = null;
  private lastUnchangedAt: Date | null = null;
  private lastUnchangedWatermark: bigint | null = null;

  coalesce(input: CatalogPromotionScope & {
    settledWatermark: bigint;
    requestedAt: Date;
  }): Promise<CatalogPromotionCoalesceResult> {
    this.settledWatermark = input.settledWatermark;
    if (this.baseline !== null &&
        input.settledWatermark <= BigInt(this.baseline.observationSequence)) {
      return Promise.resolve("already_covered");
    }
    if (this.attempt === null) {
      this.attempt = this.newAttempt(input.settledWatermark, input.requestedAt);
      return Promise.resolve("created");
    }
    if (input.settledWatermark > this.attempt.requestedWatermark) {
      this.pendingWatermark = this.pendingWatermark === null
        ? input.settledWatermark
        : input.settledWatermark > this.pendingWatermark
          ? input.settledWatermark : this.pendingWatermark;
      return Promise.resolve("coalesced");
    }
    return Promise.resolve("already_covered");
  }

  claim(input: CatalogPromotionScope & {
    workerId: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<CatalogPromotionClaim | null> {
    const attempt = this.attempt;
    if (attempt === null ||
        (attempt.nextRetryAt !== null && attempt.nextRetryAt > input.now)) {
      return Promise.resolve(null);
    }
    attempt.claimToken = `claim-${++this.claimNumber}`;
    attempt.claimExpiresAt = input.leaseExpiresAt;
    attempt.nextRetryAt = null;
    return Promise.resolve(this.snapshot(attempt));
  }

  heartbeat(input: {
    attemptId: string;
    claimToken: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<boolean> {
    const valid = this.validClaim(input.attemptId, input.claimToken);
    if (valid) this.attempt!.claimExpiresAt = input.leaseExpiresAt;
    return Promise.resolve(valid);
  }

  loadBaseline(): Promise<CatalogReleaseBaseline | null> {
    return Promise.resolve(this.baseline);
  }

  persistPreparedOperations(input: {
    attemptId: string;
    claimToken: string;
    prepared: CatalogPromotionPreparedSummary;
    operations: readonly CatalogPromotionOperation[];
    preparedAt: Date;
  }): Promise<boolean> {
    if (!this.validClaim(input.attemptId, input.claimToken) ||
        this.attempt!.prepared !== null) return Promise.resolve(false);
    this.attempt!.prepared = input.prepared;
    this.attempt!.operations = input.operations.map((operation) => ({ ...operation }));
    return Promise.resolve(true);
  }

  markOperationDispatched(input: {
    attemptId: string;
    claimToken: string;
    ordinal: number;
    dispatchedAt: Date;
  }): Promise<boolean> {
    const operation = this.operation(input);
    if (operation === null || operation.receipt !== null) return Promise.resolve(false);
    this.attempt!.operations[input.ordinal] = {
      ...operation,
      dispatchCount: operation.dispatchCount + 1,
      lastDispatchedAt: input.dispatchedAt,
    };
    return Promise.resolve(true);
  }

  acknowledgeOperation(input: {
    attemptId: string;
    claimToken: string;
    ordinal: number;
    receipt: ProductionReceipt;
    acknowledgedAt: Date;
  }): Promise<boolean> {
    if (this.rejectOperationAcknowledgement) return Promise.resolve(false);
    const operation = this.operation(input);
    if (operation === null || operation.receipt !== null) return Promise.resolve(false);
    this.attempt!.operations[input.ordinal] = {
      ...operation,
      receipt: input.receipt,
      acknowledgedAt: input.acknowledgedAt,
    };
    return Promise.resolve(true);
  }

  scheduleRetry(input: {
    attemptId: string;
    claimToken: string;
    failureCode: string;
    retryCount: number;
    retryAt: Date;
    acknowledgedAt: Date;
  }): Promise<boolean> {
    if (!this.validClaim(input.attemptId, input.claimToken)) return Promise.resolve(false);
    this.retryDelays.push(input.retryAt.getTime() - input.acknowledgedAt.getTime());
    this.attempt!.retryCount = input.retryCount;
    this.attempt!.nextRetryAt = input.retryAt;
    return Promise.resolve(true);
  }

  acknowledgeTerminal(input: {
    attemptId: string;
    claimToken: string;
    outcome: CatalogPromotionTerminalOutcome;
    failureCode: string | null;
    receipt: ProductionReceipt | null;
    completedAt: Date;
    prepared: CatalogPromotionPreparedSummary | null;
  }): Promise<boolean> {
    if (!this.validClaim(input.attemptId, input.claimToken)) return Promise.resolve(false);
    const attempt = this.attempt!;
    const prepared = input.prepared ?? attempt.prepared;
    this.terminal.push({
      outcome: input.outcome,
      failureCode: input.failureCode,
      requestedWatermark: attempt.requestedWatermark,
    });
    if ((input.outcome === "published" || input.outcome === "unchanged") &&
        prepared !== null) {
      this.baseline = {
        activePublicReleaseId: prepared.publicReleaseId,
        observationSequence: prepared.observationSequence,
        contentHash: prepared.contentHash,
        publicConfigHash: prepared.publicConfigHash,
        repackSearchIndexHash: prepared.repackSearchIndexHash,
        publicVendorKeys: prepared.publicVendorKeys,
      };
      if (input.outcome === "published") {
        this.lastActivatedWatermark = attempt.requestedWatermark;
        this.lastActivatedAt = input.completedAt;
      } else {
        this.lastUnchangedWatermark = attempt.requestedWatermark;
        this.lastUnchangedAt = input.completedAt;
      }
    }
    this.attempt = this.pendingWatermark === null
      ? null : this.newAttempt(this.pendingWatermark, input.completedAt);
    this.pendingWatermark = null;
    return Promise.resolve(true);
  }

  loadHealth(): Promise<CatalogPromotionHealth> {
    return Promise.resolve({
      settledWatermark: this.settledWatermark,
      requestedWatermark:
        this.pendingWatermark ?? this.attempt?.requestedWatermark ?? null,
      activeAttempt: this.attempt === null ? null : {
        attemptId: this.attempt.attemptId,
        requestedWatermark: this.attempt.requestedWatermark,
        state: this.attempt.nextRetryAt === null ? "claimed" : "retry_wait",
        createdAt: this.attempt.createdAt,
        claimExpiresAt: this.attempt.claimExpiresAt,
      },
      lastActivatedWatermark: this.lastActivatedWatermark,
      lastActivatedAt: this.lastActivatedAt,
      lastUnchangedWatermark: this.lastUnchangedWatermark,
      lastUnchangedAt: this.lastUnchangedAt,
      retryAt: this.attempt?.nextRetryAt ?? null,
      delayedVendorCount: this.attempt?.prepared?.delayedVendorCount ?? null,
    });
  }

  seedAttempt(watermark: bigint, at: Date): void {
    this.attempt = this.newAttempt(watermark, at);
  }

  private validClaim(attemptId: string, claimToken: string): boolean {
    return this.attempt?.attemptId === attemptId &&
      this.attempt.claimToken === claimToken;
  }

  private operation(input: {
    attemptId: string;
    claimToken: string;
    ordinal: number;
  }): CatalogPromotionOperation | null {
    if (!this.validClaim(input.attemptId, input.claimToken)) return null;
    return this.attempt!.operations[input.ordinal] ?? null;
  }

  private newAttempt(watermark: bigint, at: Date): MutableAttempt {
    return {
      attemptId: `attempt-${++this.attemptNumber}`,
      requestedWatermark: watermark,
      claimToken: "unclaimed",
      claimExpiresAt: at,
      retryCount: 0,
      nextRetryAt: null,
      createdAt: at,
      startedAt: at,
      prepared: null,
      operations: [],
    };
  }

  private snapshot(attempt: MutableAttempt): CatalogPromotionClaim {
    return {
      ...attempt,
      operations: attempt.operations.map((operation) => ({ ...operation })),
    };
  }
}

async function receiptWithDigest(
  receipt: Omit<ProductionReceipt, "receiptDigest">,
): Promise<ProductionReceipt> {
  return {
    ...receipt,
    receiptDigest: await productionReceiptHash(receipt),
  } as ProductionReceipt;
}

export class FakeCatalogPublicationTransport implements CatalogPublicationTransport {
  readonly events: string[] = [];
  readonly sentBodies: string[] = [];
  readonly sentOperationIds: string[] = [];
  readonly statusOperations: string[] = [];
  loseAfterStore: CatalogPromotionOperation["kind"] | null = null;
  failResponseAfterStore: Readonly<{
    kind: CatalogPromotionOperation["kind"];
    code: "PUBLICATION_RESPONSE_INVALID" | "PUBLICATION_RESPONSE_AUTH_INVALID";
  }> | null = null;
  failBeforeStore: CatalogPromotionOperation["kind"] | null = null;
  failBeforeStoreCount = 1;
  private lost = false;
  private responseFailed = false;
  private readonly receipts = new Map<string, ProductionReceipt>();
  private readonly starts = new Map<string, ReturnType<typeof productionStartRequestSchema.parse>>();

  async send(operation: CatalogPromotionOperation): Promise<ProductionReceipt> {
    this.events.push(`send:${operation.kind}`);
    this.sentBodies.push(operation.bodyJson);
    this.sentOperationIds.push(operation.operationId);
    if (this.failBeforeStore === operation.kind && this.failBeforeStoreCount > 0) {
      this.failBeforeStoreCount -= 1;
      throw new CatalogPublicationClientError(
        "PUBLICATION_NETWORK_ERROR", "retryable", true,
      );
    }
    const receipt = await this.createReceipt(operation);
    this.receipts.set(operation.operationId, receipt);
    if (this.failResponseAfterStore?.kind === operation.kind &&
        !this.responseFailed) {
      this.responseFailed = true;
      throw new CatalogPublicationClientError(
        this.failResponseAfterStore.code,
        "retryable",
        true,
      );
    }
    if (this.loseAfterStore === operation.kind && !this.lost) {
      this.lost = true;
      throw new CatalogPublicationClientError(
        "PUBLICATION_NETWORK_ERROR", "retryable", true,
      );
    }
    return receipt;
  }

  status(input: CatalogPublicationStatusInput): Promise<ProductionReceipt | null> {
    this.events.push(`status:${input.expectedKind}`);
    this.statusOperations.push(input.operationId);
    return Promise.resolve(this.receipts.get(input.operationId) ?? null);
  }

  private async createReceipt(operation: CatalogPromotionOperation) {
    const common = {
      schemaVersion: DATA_RELEASE_SCHEMA_VERSION,
      operationId: operation.operationId,
      publicationId: operation.publicationId,
      serverTime: "2026-08-15T12:00:00.000Z",
      requestDigest: operation.bodyDigest,
    } as const;
    if (operation.kind === "start") {
      const request = productionStartRequestSchema.parse(JSON.parse(operation.bodyJson));
      this.starts.set(operation.publicationId, request);
      return receiptWithDigest({
        ...common,
        operationKind: "start",
        terminalState: "staging",
        result: "created",
        details: {
          sourceWatermark: request.manifest.sourceWatermark,
          manifestFingerprint: request.manifest.manifestFingerprint,
          contentHash: request.manifest.contentHash,
          expectedBatchCount: request.manifest.batchCount,
          expectedBatchChainHash: request.manifest.batchChainHash,
          expectedCounts: request.manifest.counts,
        },
      });
    }
    if (operation.kind === "applyBatch") {
      const request = productionApplyBatchRequestSchema.parse(JSON.parse(operation.bodyJson));
      return receiptWithDigest({
        ...common,
        operationKind: "applyBatch",
        terminalState: "staging",
        result: "accepted",
        details: {
          batchIndex: request.batchIndex,
          kind: request.kind,
          batchHash: request.batchHash,
          recordCount: request.records.length,
          byteCount: productionBatchByteCount(request.records),
          chainHash: "b".repeat(64),
          acceptedCounts: {
            vendors: 0, categories: 0, collectibles: 0,
            repacks: 0, repackChases: 0, searchShards: 0,
          },
        },
      });
    }
    if (operation.kind === "finalize") {
      const request = productionFinalizeRequestSchema.parse(JSON.parse(operation.bodyJson));
      const start = this.starts.get(operation.publicationId)!;
      return receiptWithDigest({
        ...common,
        operationKind: "finalize",
        terminalState: "complete",
        result: "activated",
        details: {
          manifestFingerprint: start.manifest.manifestFingerprint,
          contentHash: start.manifest.contentHash,
          sourceWatermark: start.manifest.sourceWatermark,
          activePublicReleaseId: operation.publicationId,
          previousPublicReleaseId: request.expectedPredecessorPublicReleaseId,
          counts: request.expectedCounts,
          batchCount: request.expectedBatchCount,
          batchChainHash: request.expectedBatchChainHash,
        },
      });
    }
    const request = productionRefreshRequestSchema.parse(JSON.parse(operation.bodyJson));
    return receiptWithDigest({
      ...common,
      operationKind: "refreshObservation",
      terminalState: "complete",
      result: "refreshed",
      details: {
        contentHash: request.contentHash,
        observationSequence: request.observationSequence,
        dataAsOf: request.dataAsOf,
        lastSuccessfulObservationAt: request.lastSuccessfulObservationAt,
        staleAt: request.staleAt,
        freshness: request.freshness,
        delayedVendorCount: request.delayedVendorCount,
      },
    });
  }
}
