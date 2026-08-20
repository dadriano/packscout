import {
  CATALOG_RETENTION_SCHEMA_VERSION,
  canonicalJson,
  catalogRetentionManifestRequestSchema,
  catalogRetentionProviderRequestSchema,
  catalogRetentionPublicationRequestDigest,
  catalogRetentionStatusNotFoundReceiptSchema,
  catalogRetentionStatusRequestSchema,
  type CatalogRetentionPostgresProofSnapshot,
  type CatalogRetentionReceipt,
  type CatalogRetentionStatusRequest,
} from "@packscout/contracts";
import {
  CatalogRetentionPublicationClientError,
  type ExactCatalogRetentionMutation,
  type SignedConvexCatalogRetentionClient,
} from "./convex-catalog-retention-client.ts";

export interface CatalogPromotionRetentionBarrier {
  readonly barrierGeneration: bigint;
  readonly barrierToken: string;
  readonly retentionGeneration: number;
  readonly postgresProof: CatalogRetentionPostgresProofSnapshot;
  readonly canonicalPostgresProofBody: string;
  readonly resumed: boolean;
}

export interface CatalogPromotionRetentionOperation {
  readonly operationIndex: number;
  readonly operationId: string;
  readonly operationKind: "retainManifests" | "retainProviderReleases";
  readonly phase: "manifests" | "provider_releases";
  readonly platformKey: string | null;
  readonly expectedRetentionGeneration: number;
  readonly canonicalRequestBody: string;
  readonly requestSha256: string;
  readonly state: "pending" | "sent" | "acknowledged";
  readonly sendCount: number;
  readonly lastSentAt: Date | null;
  readonly acknowledgedAt: Date | null;
  readonly canonicalReceiptBody: string | null;
  readonly receiptSha256: string | null;
  readonly exactResponseBody: string | null;
  readonly responseSha256: string | null;
  readonly postgresCleanupComplete: boolean;
}

export interface CatalogPromotionRetentionRepositoryPort {
  acquireBarrier(): Promise<CatalogPromotionRetentionBarrier>;
  loadPendingOperation(input: Readonly<{
    barrierToken: string;
  }>): Promise<CatalogPromotionRetentionOperation | null>;
  loadOperationRequiringCleanup(input: Readonly<{
    barrierToken: string;
  }>): Promise<CatalogPromotionRetentionOperation | null>;
  prepareOperation(input: Readonly<{
    barrierToken: string;
    phase: "manifests" | "provider_releases";
    platformKey?: string;
    maximumDocuments: number;
  }>): Promise<CatalogPromotionRetentionOperation | null>;
  markOperationSent(input: Readonly<{
    barrierToken: string;
    operationId: string;
    sentAt: Date;
  }>): Promise<boolean>;
  acknowledgeOperation(input: Readonly<{
    barrierToken: string;
    operationId: string;
    acknowledgedAt: Date;
    evidence: Readonly<{
      canonicalReceiptBody: string;
      exactResponseBody: string;
    }>;
  }>): Promise<Readonly<{
    receipt: CatalogRetentionReceipt;
    receiptSha256: string;
    postgresCleanupPending: boolean;
  }>>;
  deleteProviderArtifactChunk(input: Readonly<{
    barrierToken: string;
    operationId: string;
    maximumRows: number;
  }>): Promise<Readonly<{ deletedRowCount: number; complete: boolean }>>;
  releaseBarrier(input: Readonly<{ barrierToken: string }>): Promise<boolean>;
}

export type CatalogPromotionRetentionTransportPort = Pick<
  SignedConvexCatalogRetentionClient,
  "sendExact" | "status"
>;

export type CatalogPromotionRetentionCycleOutcome =
  | "bounded"
  | "released"
  | "retry_required"
  | "stopped";

export interface CatalogPromotionRetentionCycleResult {
  readonly outcome: CatalogPromotionRetentionCycleOutcome;
  readonly resumedBarrier: boolean;
  readonly steps: number;
  readonly networkRequests: number;
  readonly operationsAcknowledged: number;
  readonly postgresRowsDeleted: number;
}

export interface CatalogPromotionRetentionRunnerOptions {
  readonly repository: CatalogPromotionRetentionRepositoryPort;
  readonly transport: CatalogPromotionRetentionTransportPort;
  readonly maximumDocuments: number;
  readonly maximumPostgresRowsPerStep: number;
  readonly maximumStepsPerCycle: number;
  readonly clock?: Readonly<{ now(): Date }>;
}

export class CatalogPromotionRetentionRunnerError extends Error {
  readonly code = "CATALOG_PROMOTION_RETENTION_COORDINATOR_INVALID";

  constructor() {
    super("Catalog promotion retention coordinator refused invalid state.");
    this.name = "CatalogPromotionRetentionRunnerError";
  }
}

function refuse(): never {
  throw new CatalogPromotionRetentionRunnerError();
}

function retryableClientFailure(error: unknown): boolean {
  return error instanceof CatalogRetentionPublicationClientError &&
    error.disposition === "retryable";
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function statusRequestFor(
  operation: CatalogPromotionRetentionOperation,
): Promise<CatalogRetentionStatusRequest> {
  const parsed = operation.operationKind === "retainManifests"
    ? catalogRetentionManifestRequestSchema.safeParse(
        JSON.parse(operation.canonicalRequestBody) as unknown,
      )
    : catalogRetentionProviderRequestSchema.safeParse(
        JSON.parse(operation.canonicalRequestBody) as unknown,
      );
  if (!parsed.success || canonicalJson(parsed.data) !==
      operation.canonicalRequestBody) return refuse();
  const request = parsed.data;
  const platformKey = request.phase === "manifests" ? null : request.platformKey;
  const digest = await catalogRetentionPublicationRequestDigest(request);
  if (
    request.operationId !== operation.operationId ||
    request.idempotencyKey !== operation.operationId ||
    request.phase !== operation.phase ||
    platformKey !== operation.platformKey ||
    request.expectedRetentionGeneration !==
      operation.expectedRetentionGeneration ||
    digest !== operation.requestSha256
  ) return refuse();
  return catalogRetentionStatusRequestSchema.parse({
    schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
    target: {
      operationKind: operation.operationKind,
      operationId: operation.operationId,
      idempotencyKey: request.idempotencyKey,
      phase: operation.phase,
      platformKey: operation.platformKey,
      requestDigest: digest,
    },
  });
}

/**
 * Bounded crash-safe coordinator for the PostgreSQL proof barrier and Convex
 * retention protocol. Repository calls deliberately surround, but never span,
 * network requests.
 */
export class CatalogPromotionRetentionRunner {
  readonly #clock: Readonly<{ now(): Date }>;
  #running = false;

  constructor(private readonly options: CatalogPromotionRetentionRunnerOptions) {
    if (
      !Number.isSafeInteger(options.maximumDocuments) ||
      options.maximumDocuments < 9 || options.maximumDocuments > 90 ||
      !Number.isSafeInteger(options.maximumPostgresRowsPerStep) ||
      options.maximumPostgresRowsPerStep < 10 ||
      options.maximumPostgresRowsPerStep > 100 ||
      !Number.isSafeInteger(options.maximumStepsPerCycle) ||
      options.maximumStepsPerCycle < 1 || options.maximumStepsPerCycle > 100
    ) throw new RangeError("Catalog promotion retention limits are invalid.");
    this.#clock = options.clock ?? { now: () => new Date() };
  }

  async runCycle(signal?: AbortSignal): Promise<CatalogPromotionRetentionCycleResult> {
    if (this.#running) throw new Error("Catalog retention cycle is already running.");
    this.#running = true;
    let steps = 0;
    let networkRequests = 0;
    let operationsAcknowledged = 0;
    let postgresRowsDeleted = 0;
    let resumedBarrier = false;
    const result = (outcome: CatalogPromotionRetentionCycleOutcome) => ({
      outcome,
      resumedBarrier,
      steps,
      networkRequests,
      operationsAcknowledged,
      postgresRowsDeleted,
    });
    try {
      if (isAborted(signal)) return result("stopped");
      const barrier = await this.options.repository.acquireBarrier();
      resumedBarrier = barrier.resumed;
      while (steps < this.options.maximumStepsPerCycle) {
        if (isAborted(signal)) return result("stopped");
        steps += 1;

        const cleanup = await this.options.repository
          .loadOperationRequiringCleanup({ barrierToken: barrier.barrierToken });
        if (cleanup !== null) {
          if (cleanup.state !== "acknowledged" ||
              cleanup.postgresCleanupComplete ||
              cleanup.operationKind !== "retainProviderReleases" ||
              cleanup.phase !== "provider_releases" ||
              cleanup.platformKey === null) {
            return refuse();
          }
          const progress = await this.options.repository.deleteProviderArtifactChunk({
            barrierToken: barrier.barrierToken,
            operationId: cleanup.operationId,
            maximumRows: this.options.maximumPostgresRowsPerStep,
          });
          if (!Number.isSafeInteger(progress.deletedRowCount) ||
              progress.deletedRowCount < 0 ||
              progress.deletedRowCount > this.options.maximumPostgresRowsPerStep ||
              (progress.deletedRowCount === 0 && !progress.complete)) {
            return refuse();
          }
          postgresRowsDeleted += progress.deletedRowCount;
          continue;
        }

        let operation = await this.options.repository.loadPendingOperation({
          barrierToken: barrier.barrierToken,
        });
        if (operation === null) {
          operation = await this.options.repository.prepareOperation({
            barrierToken: barrier.barrierToken,
            phase: "manifests",
            maximumDocuments: this.options.maximumDocuments,
          });
        }
        if (operation === null) {
          for (const head of barrier.postgresProof.completedHeads) {
            operation = await this.options.repository.prepareOperation({
              barrierToken: barrier.barrierToken,
              phase: "provider_releases",
              platformKey: head.platformKey,
              maximumDocuments: this.options.maximumDocuments,
            });
            if (operation !== null) break;
          }
        }
        if (operation === null) {
          if (!await this.options.repository.releaseBarrier({
            barrierToken: barrier.barrierToken,
          })) return refuse();
          return result("released");
        }

        const reconciled = await this.reconcileOperation(
          barrier.barrierToken,
          operation,
          signal,
        );
        networkRequests += reconciled.networkRequests;
        if (reconciled.outcome === "stopped") return result("stopped");
        if (reconciled.outcome === "retry_required") {
          return result("retry_required");
        }
        operationsAcknowledged += 1;
      }
      return result("bounded");
    } finally {
      this.#running = false;
    }
  }

  private async reconcileOperation(
    barrierToken: string,
    operation: CatalogPromotionRetentionOperation,
    signal?: AbortSignal,
  ): Promise<Readonly<{
    outcome: "acknowledged" | "retry_required" | "stopped";
    networkRequests: number;
  }>> {
    let networkRequests = 0;
    try {
      if (operation.state === "acknowledged") return refuse();
      if (operation.state === "sent") {
        networkRequests += 1;
        const status = await this.options.transport.status(
          await statusRequestFor(operation),
          signal,
        );
        if (!catalogRetentionStatusNotFoundReceiptSchema.safeParse(
          status.receipt,
        ).success) {
          await this.acknowledge(barrierToken, operation, status);
          return { outcome: "acknowledged", networkRequests };
        }
      }
      if (isAborted(signal)) {
        return { outcome: "stopped", networkRequests };
      }
      const marked = await this.options.repository.markOperationSent({
        barrierToken,
        operationId: operation.operationId,
        sentAt: this.#clock.now(),
      });
      if (!marked) return { outcome: "retry_required", networkRequests };
      networkRequests += 1;
      const sent = await this.options.transport.sendExact({
        kind: operation.operationKind,
        canonicalRequestBody: operation.canonicalRequestBody,
      } as ExactCatalogRetentionMutation, signal);
      await this.acknowledge(barrierToken, operation, sent);
      return { outcome: "acknowledged", networkRequests };
    } catch (error) {
      if (isAborted(signal)) {
        return { outcome: "stopped", networkRequests };
      }
      if (retryableClientFailure(error)) {
        return { outcome: "retry_required", networkRequests };
      }
      throw error;
    }
  }

  private async acknowledge(
    barrierToken: string,
    operation: CatalogPromotionRetentionOperation,
    result: Readonly<{
      receipt: unknown;
      canonicalReceiptBody: string;
      exactResponseBody: string;
    }>,
  ): Promise<void> {
    if (typeof result.receipt !== "object" || result.receipt === null) {
      return refuse();
    }
    await this.options.repository.acknowledgeOperation({
      barrierToken,
      operationId: operation.operationId,
      acknowledgedAt: this.#clock.now(),
      evidence: {
        canonicalReceiptBody: result.canonicalReceiptBody,
        exactResponseBody: result.exactResponseBody,
      },
    });
  }
}
