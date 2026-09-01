import { createHash } from "node:crypto";
import {
  PRODUCTION_PROVIDER_RELEASE_PATHS,
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  canonicalJson,
  providerReleaseBlockReceiptSchema,
  providerReleaseBlockRequestSchema,
  providerReleaseMutationRequestSchema,
  providerReleaseStatusNotFoundReceiptSchema,
  providerReleaseStatusRequestSchema,
  type ProviderReleaseBlockReasonV1,
  type ProviderReleaseExpectedCompletedHeadV1,
  type ProviderReleaseReceipt,
  type ProviderReleaseStatusNotFoundReceipt,
  type ProviderReleaseStatusRequest,
} from "@packscout/contracts";
import type {
  DistributedProviderPublicationIntent,
  DistributedProviderPublicationOperation,
  DistributedProviderPublicationOperationKind,
  DistributedProviderPublicationReceiptEvidence,
  DistributedProviderPublisherLease,
  ProviderReleaseAssemblyResult,
  ProviderReleasePublicationSource,
} from "@packscout/database";
import { PublicationClientError } from "./convex-publication-http-client.ts";
import {
  adaptDistributedProviderReleaseToCatalogV1,
} from "./distributed-provider-release-v1-adapter.ts";
import {
  prepareProviderPromotion,
  validateProviderPromotionReceipt,
} from "./provider-promotion-operations.ts";
import type {
  ProviderPromotionPreparedOperation,
  ProviderReleasePublicationResult,
} from "./provider-promotion-types.ts";

const DEFAULT_LEASE_MILLISECONDS = 60_000;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;

type ExecutableOperation = DistributedProviderPublicationOperation & Readonly<{
  operationIndex: number;
  requestPath: string;
}>;

export interface DistributedProviderReleasePublicationStore {
  claimLease(
    owner: string,
    leaseMilliseconds: number,
  ): Promise<DistributedProviderPublisherLease>;
  renewLease(
    lease: DistributedProviderPublisherLease,
    leaseMilliseconds: number,
  ): Promise<DistributedProviderPublisherLease>;
  releaseLease(lease: DistributedProviderPublisherLease): Promise<void>;
  loadExpectedCompletedHead(): Promise<ProviderReleaseExpectedCompletedHeadV1>;
  recordIntent(input: {
    readonly lease: DistributedProviderPublisherLease;
    readonly providerReleaseId: string;
    readonly operation: DistributedProviderPublicationOperation;
  }): Promise<DistributedProviderPublicationIntent>;
  recordAttempt(input: {
    readonly lease: DistributedProviderPublisherLease;
    readonly idempotencyKey: string;
  }): Promise<void>;
  markAmbiguous(input: {
    readonly lease: DistributedProviderPublisherLease;
    readonly idempotencyKey: string;
  }): Promise<void>;
  fail(input: {
    readonly lease: DistributedProviderPublisherLease;
    readonly idempotencyKey: string;
    readonly failureCode: string;
  }): Promise<void>;
  accept(input: {
    readonly lease: DistributedProviderPublisherLease;
    readonly providerReleaseId: string;
    readonly operation: DistributedProviderPublicationOperation;
    readonly evidence: DistributedProviderPublicationReceiptEvidence;
  }): Promise<Readonly<{ receipt: ProviderReleaseReceipt; completed: boolean }>>;
}

export interface DistributedProviderReleaseSourceStore {
  publicationSource(
    providerReleaseId: string,
  ): Promise<ProviderReleasePublicationSource>;
}

export interface DistributedProviderReleasePublicationTransport {
  sendExact(input: Readonly<{
    kind: DistributedProviderPublicationOperationKind;
    canonicalRequestBody: string;
  }>, signal?: AbortSignal): Promise<ProviderReleasePublicationResult>;
  status(
    request: ProviderReleaseStatusRequest,
    signal?: AbortSignal,
  ): Promise<ProviderReleasePublicationResult<
    ProviderReleaseReceipt | ProviderReleaseStatusNotFoundReceipt
  >>;
}

export type DistributedProviderPublicationMetricName =
  | "provider_publication_operation"
  | "provider_publication_retry"
  | "provider_publication_ambiguity"
  | "provider_publication_completion"
  | "provider_publication_block"
  | "provider_publication_checkpoint_lag";

export interface DistributedProviderPublicationMetric {
  readonly name: DistributedProviderPublicationMetricName;
  readonly providerId: string;
  readonly operationKind: DistributedProviderPublicationOperationKind | null;
  readonly outcome: "success" | "failure" | "ambiguous";
  readonly value: number;
}

export interface DistributedProviderPublicationResult {
  readonly providerId: string;
  readonly providerReleaseId: string;
  readonly catalogVersionId: string;
  readonly publicProviderReleaseId: string;
  readonly providerReleaseFingerprint: string;
  readonly providerReleaseContentHash: string;
  readonly catalogContentHash: string;
  readonly confirmedThroughChangeSequence: bigint;
  readonly reusedCompleteRelease: boolean;
  readonly terminalReceiptSha256: string;
}

export type DistributedProviderPublicationFailureCode =
  | "PROVIDER_PUBLICATION_SOURCE_INVALID"
  | "PROVIDER_PUBLICATION_INTENT_FAILED"
  | "PROVIDER_PUBLICATION_RECEIPT_INVALID"
  | "PROVIDER_PUBLICATION_AMBIGUOUS"
  | "PROVIDER_PUBLICATION_TRANSPORT_FAILED"
  | "PROVIDER_PUBLICATION_BLOCK_FAILED";

export class DistributedProviderPublicationError extends Error {
  constructor(
    readonly code: DistributedProviderPublicationFailureCode | string,
    readonly retryable: boolean,
  ) {
    super(`Distributed provider publication failed (${code}).`);
    this.name = "DistributedProviderPublicationError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactJson(value: unknown, canonicalBody: string, digest: string): boolean {
  return HASH_PATTERN.test(digest)
    && canonicalJson(value) === canonicalBody
    && sha256(canonicalBody) === digest;
}

function boundedFailureCode(error: unknown): string {
  if (
    error !== null
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    && FAILURE_CODE_PATTERN.test(error.code)
  ) return error.code;
  return "PROVIDER_PUBLICATION_TRANSPORT_FAILED";
}

function terminalBlockReason(code: string): ProviderReleaseBlockReasonV1 {
  if (code.includes("PREDECESSOR")) return "PUBLICATION_PREDECESSOR_CONFLICT";
  if (code.includes("RECONCILIATION") || code.includes("STATE_CONFLICT")) {
    return "PUBLICATION_RECONCILIATION_FAILED";
  }
  if (code.includes("AUTH") || code.includes("SECURITY")) {
    return "PUBLICATION_SECURITY_INVALID";
  }
  if (code.includes("PLATFORM") || code.includes("OWNERSHIP")) {
    return "PUBLICATION_OWNERSHIP_INVALID";
  }
  return "PUBLICATION_INTEGRITY_INVALID";
}

function executable(
  operation: ProviderPromotionPreparedOperation,
): ExecutableOperation {
  return operation;
}

function parseOperationRequest(operation: ExecutableOperation) {
  let value: unknown;
  try {
    value = JSON.parse(operation.canonicalRequestBody) as unknown;
  } catch {
    throw new DistributedProviderPublicationError(
      "PROVIDER_PUBLICATION_SOURCE_INVALID",
      false,
    );
  }
  const parsed = providerReleaseMutationRequestSchema.safeParse(value);
  if (
    !parsed.success
    || !("release" in parsed.data)
    || parsed.data.operationId !== operation.operationId
    || parsed.data.idempotencyKey !== operation.operationId
    || canonicalJson(parsed.data) !== operation.canonicalRequestBody
    || sha256(operation.canonicalRequestBody) !== operation.requestSha256
  ) {
    throw new DistributedProviderPublicationError(
      "PROVIDER_PUBLICATION_SOURCE_INVALID",
      false,
    );
  }
  return parsed.data;
}

function statusRequest(operation: ExecutableOperation): ProviderReleaseStatusRequest {
  const request = parseOperationRequest(operation);
  return providerReleaseStatusRequestSchema.parse({
    schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
    target: {
      operationKind: operation.operationKind,
      operationId: operation.operationId,
      idempotencyKey: request.idempotencyKey,
      platformKey: request.release.platformKey,
      publicProviderReleaseId: request.release.publicProviderReleaseId,
      requestDigest: operation.requestSha256,
    },
  });
}

function blockOperation(
  target: ExecutableOperation,
  reason: ProviderReleaseBlockReasonV1,
): ExecutableOperation {
  const targetRequest = parseOperationRequest(target);
  const operationId = `block:${sha256(`${target.operationId}\0${reason}`)}`;
  const parsed = providerReleaseBlockRequestSchema.parse({
    schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
    operationId,
    idempotencyKey: operationId,
    release: targetRequest.release,
    providerCheckpoint: targetRequest.providerCheckpoint,
    sourceWatermark: targetRequest.sourceWatermark,
    observation: targetRequest.observation,
    expectedCompletedHead: targetRequest.expectedCompletedHead,
    blockSequence: targetRequest.providerCheckpoint.settledSequence,
    reason,
  });
  const canonicalRequestBody = canonicalJson(parsed);
  return {
    operationIndex: -1,
    operationId,
    operationKind: "block",
    requestPath: PRODUCTION_PROVIDER_RELEASE_PATHS.block,
    canonicalRequestBody,
    requestSha256: sha256(canonicalRequestBody),
  };
}

function validatePublication(
  operation: ExecutableOperation,
  publication: ProviderReleasePublicationResult<
    ProviderReleaseReceipt | ProviderReleaseStatusNotFoundReceipt
  >,
): ProviderReleaseReceipt {
  if (!exactJson(
    publication.receipt,
    publication.canonicalReceiptBody,
    publication.receiptSha256,
  )) {
    throw new DistributedProviderPublicationError(
      "PROVIDER_PUBLICATION_RECEIPT_INVALID",
      true,
    );
  }
  if (operation.operationKind !== "block") {
    return validateProviderPromotionReceipt({
      operation: operation as ProviderPromotionPreparedOperation,
      receipt: publication.receipt,
      canonicalReceiptBody: publication.canonicalReceiptBody,
      receiptSha256: publication.receiptSha256,
    });
  }
  const request = parseOperationRequest(operation);
  const receipt = providerReleaseBlockReceiptSchema.safeParse(
    publication.receipt,
  );
  if (
    !receipt.success
    || receipt.data.operationId !== operation.operationId
    || receipt.data.idempotencyKey !== operation.operationId
    || receipt.data.requestDigest !== operation.requestSha256
    || receipt.data.platformKey !== request.release.platformKey
    || receipt.data.publicProviderReleaseId !==
      request.release.publicProviderReleaseId
    || canonicalJson(receipt.data.details.release) !==
      canonicalJson(request.release)
    || canonicalJson(receipt.data.details.providerCheckpoint) !==
      canonicalJson(request.providerCheckpoint)
    || receipt.data.details.sourceWatermark !== request.sourceWatermark
    || canonicalJson(receipt.data.details.observation) !==
      canonicalJson(request.observation)
    || canonicalJson(receipt.data.details.expectedCompletedHead) !==
      canonicalJson(request.expectedCompletedHead)
  ) {
    throw new DistributedProviderPublicationError(
      "PROVIDER_PUBLICATION_RECEIPT_INVALID",
      true,
    );
  }
  return receipt.data;
}

function requireStoredPublication(
  operation: ExecutableOperation,
  intent: DistributedProviderPublicationIntent,
): ProviderReleasePublicationResult {
  if (
    intent.canonicalReceiptBody === null
    || intent.receiptSha256 === null
  ) {
    throw new DistributedProviderPublicationError(
      "PROVIDER_PUBLICATION_RECEIPT_INVALID",
      false,
    );
  }
  let receipt: unknown;
  try {
    receipt = JSON.parse(intent.canonicalReceiptBody) as unknown;
  } catch {
    throw new DistributedProviderPublicationError(
      "PROVIDER_PUBLICATION_RECEIPT_INVALID",
      false,
    );
  }
  const result: ProviderReleasePublicationResult = {
    receipt: receipt as ProviderReleaseReceipt,
    canonicalReceiptBody: intent.canonicalReceiptBody,
    receiptSha256: intent.receiptSha256,
  };
  validatePublication(operation, result);
  return result;
}

function sameSource(
  assembly: ProviderReleaseAssemblyResult,
  source: ProviderReleasePublicationSource,
): boolean {
  return source.release.id === assembly.release.id
    && source.release.contentHash === assembly.release.contentHash
    && source.release.throughChangeSequence ===
      assembly.release.throughChangeSequence
    && source.publicEquivalenceHash === assembly.publicEquivalenceHash
    && canonicalJson(source.descriptor) ===
      canonicalJson(assembly.release.descriptor);
}

export class DistributedProviderReleasePublicationService {
  readonly #leaseMilliseconds: number;

  constructor(private readonly dependencies: {
    readonly workerId: string;
    readonly releases: DistributedProviderReleaseSourceStore;
    readonly publications: DistributedProviderReleasePublicationStore;
    readonly transport: DistributedProviderReleasePublicationTransport;
    readonly leaseMilliseconds?: number;
    readonly now?: () => Date;
    readonly emitMetric?: (metric: DistributedProviderPublicationMetric) => void;
  }) {
    this.#leaseMilliseconds = dependencies.leaseMilliseconds
      ?? DEFAULT_LEASE_MILLISECONDS;
    if (
      !Number.isInteger(this.#leaseMilliseconds)
      || this.#leaseMilliseconds < 1_000
      || this.#leaseMilliseconds > 15 * 60_000
    ) throw new RangeError("Provider publication lease duration is invalid.");
  }

  async publish(
    assembly: ProviderReleaseAssemblyResult,
    signal?: AbortSignal,
  ): Promise<DistributedProviderPublicationResult> {
    const descriptor = assembly.release.descriptor;
    const startedAt = this.now().getTime();
    let lease = await this.dependencies.publications.claimLease(
      this.dependencies.workerId,
      this.#leaseMilliseconds,
    );
    try {
      const source = await this.dependencies.releases.publicationSource(
        assembly.release.id,
      );
      if (!sameSource(assembly, source)) {
        throw new DistributedProviderPublicationError(
          "PROVIDER_PUBLICATION_SOURCE_INVALID",
          false,
        );
      }
      const plan = await adaptDistributedProviderReleaseToCatalogV1({
        descriptor: source.descriptor,
        batches: source.batches,
        selectedThroughChangeSequence: assembly.selectedThroughChangeSequence,
        classification: assembly.reusedCompleteRelease ? "reuse" : "publish",
      });
      if (plan.classification === "blocked") {
        throw new DistributedProviderPublicationError(
          "PROVIDER_PUBLICATION_SOURCE_INVALID",
          false,
        );
      }
      const expectedHead = await this.dependencies.publications
        .loadExpectedCompletedHead();
      const lag = assembly.selectedThroughChangeSequence
        - BigInt(expectedHead.providerCheckpoint.settledSequence);
      this.emit({
        name: "provider_publication_checkpoint_lag",
        providerId: descriptor.providerId,
        operationKind: null,
        outcome: "success",
        value: Number(lag > BigInt(Number.MAX_SAFE_INTEGER)
          ? BigInt(Number.MAX_SAFE_INTEGER)
          : lag),
      });
      const prepared = prepareProviderPromotion({
        plan,
        expectedCompletedHead: expectedHead,
        checkpointSha256: source.publicEquivalenceHash,
      });
      let terminal: ProviderReleasePublicationResult | null = null;
      for (const [index, preparedOperation] of prepared.operations.entries()) {
        if (signal?.aborted === true) {
          throw new DistributedProviderPublicationError(
            "PROVIDER_PUBLICATION_AMBIGUOUS",
            true,
          );
        }
        if (index > 0) {
          lease = await this.dependencies.publications.renewLease(
            lease,
            this.#leaseMilliseconds,
          );
        }
        terminal = await this.execute(
          lease,
          descriptor.providerReleaseId,
          executable(preparedOperation),
          descriptor.providerId,
          signal,
        );
      }
      if (terminal === null) {
        throw new DistributedProviderPublicationError(
          "PROVIDER_PUBLICATION_SOURCE_INVALID",
          false,
        );
      }
      const terminalReceipt = validatePublication(
        executable(prepared.operations.at(-1)!),
        terminal,
      );
      if (
        terminalReceipt.operationKind !== "finalize"
        && terminalReceipt.operationKind !== "confirmReuse"
      ) {
        throw new DistributedProviderPublicationError(
          "PROVIDER_PUBLICATION_RECEIPT_INVALID",
          false,
        );
      }
      this.emit({
        name: "provider_publication_completion",
        providerId: descriptor.providerId,
        operationKind: terminalReceipt.operationKind,
        outcome: "success",
        value: this.now().getTime() - startedAt,
      });
      return {
        providerId: descriptor.providerId,
        providerReleaseId: descriptor.providerReleaseId,
        catalogVersionId: descriptor.catalogVersionId,
        publicProviderReleaseId: terminalReceipt.publicProviderReleaseId,
        providerReleaseFingerprint:
          terminalReceipt.details.release.providerReleaseFingerprint,
        providerReleaseContentHash: descriptor.contentHash,
        catalogContentHash: descriptor.catalogContentHash,
        confirmedThroughChangeSequence: BigInt(
          terminalReceipt.providerCheckpoint.settledSequence,
        ),
        reusedCompleteRelease: assembly.reusedCompleteRelease,
        terminalReceiptSha256: terminal.receiptSha256,
      };
    } catch (error) {
      this.emit({
        name: "provider_publication_completion",
        providerId: descriptor.providerId,
        operationKind: null,
        outcome: "failure",
        value: this.now().getTime() - startedAt,
      });
      throw error;
    } finally {
      await this.dependencies.publications.releaseLease(lease)
        .catch(() => undefined);
    }
  }

  private async execute(
    lease: DistributedProviderPublisherLease,
    providerReleaseId: string,
    operation: ExecutableOperation,
    providerId: string,
    signal: AbortSignal | undefined,
  ): Promise<ProviderReleasePublicationResult> {
    const intent = await this.dependencies.publications.recordIntent({
      lease,
      providerReleaseId,
      operation,
    });
    if (intent.state === "accepted") {
      return requireStoredPublication(operation, intent);
    }
    if (intent.state === "failed") {
      throw new DistributedProviderPublicationError(
        intent.failureCode ?? "PROVIDER_PUBLICATION_INTENT_FAILED",
        false,
      );
    }
    if (
      intent.state === "ambiguous"
      || intent.attemptCount > 0
      || intent.leaseFence !== lease.operationFence
    ) {
      return this.reconcile(
        lease,
        providerReleaseId,
        operation,
        providerId,
        true,
        signal,
      );
    }
    return this.send(
      lease,
      providerReleaseId,
      operation,
      providerId,
      true,
      signal,
    );
  }

  private async send(
    lease: DistributedProviderPublisherLease,
    providerReleaseId: string,
    operation: ExecutableOperation,
    providerId: string,
    reconcileAmbiguity: boolean,
    signal: AbortSignal | undefined,
  ): Promise<ProviderReleasePublicationResult> {
    await this.dependencies.publications.recordAttempt({
      lease,
      idempotencyKey: operation.operationId,
    });
    const startedAt = this.now().getTime();
    let publication: ProviderReleasePublicationResult;
    try {
      publication = await this.dependencies.transport.sendExact({
        kind: operation.operationKind,
        canonicalRequestBody: operation.canonicalRequestBody,
      }, signal);
    } catch (error) {
      if (error instanceof PublicationClientError && !error.ambiguous) {
        if (error.disposition === "terminal") {
          return this.failAndBlock(
            lease,
            providerReleaseId,
            operation,
            providerId,
            error.code,
            signal,
          );
        }
        throw new DistributedProviderPublicationError(error.code, true);
      }
      await this.dependencies.publications.markAmbiguous({
        lease,
        idempotencyKey: operation.operationId,
      });
      this.emit({
        name: "provider_publication_ambiguity",
        providerId,
        operationKind: operation.operationKind,
        outcome: "ambiguous",
        value: 1,
      });
      if (reconcileAmbiguity) {
        return this.reconcile(
          lease,
          providerReleaseId,
          operation,
          providerId,
          true,
          signal,
        );
      }
      throw new DistributedProviderPublicationError(
        boundedFailureCode(error),
        true,
      );
    }
    const receipt = validatePublication(operation, publication);
    await this.dependencies.publications.accept({
      lease,
      providerReleaseId,
      operation,
      evidence: {
        canonicalReceiptBody: publication.canonicalReceiptBody,
        receiptSha256: publication.receiptSha256,
      },
    });
    void receipt;
    this.emit({
      name: "provider_publication_operation",
      providerId,
      operationKind: operation.operationKind,
      outcome: "success",
      value: this.now().getTime() - startedAt,
    });
    return publication;
  }

  private async reconcile(
    lease: DistributedProviderPublisherLease,
    providerReleaseId: string,
    operation: ExecutableOperation,
    providerId: string,
    allowResend: boolean,
    signal: AbortSignal | undefined,
  ): Promise<ProviderReleasePublicationResult> {
    let observed: ProviderReleasePublicationResult<
      ProviderReleaseReceipt | ProviderReleaseStatusNotFoundReceipt
    >;
    const request = statusRequest(operation);
    try {
      observed = await this.dependencies.transport.status(request, signal);
    } catch (error) {
      throw new DistributedProviderPublicationError(
        boundedFailureCode(error),
        true,
      );
    }
    if (!exactJson(
      observed.receipt,
      observed.canonicalReceiptBody,
      observed.receiptSha256,
    )) {
      throw new DistributedProviderPublicationError(
        "PROVIDER_PUBLICATION_RECEIPT_INVALID",
        true,
      );
    }
    const notFound = providerReleaseStatusNotFoundReceiptSchema.safeParse(
      observed.receipt,
    );
    if (notFound.success) {
      if (
        canonicalJson(notFound.data.target) !== canonicalJson(request.target)
        || !allowResend
      ) {
        throw new DistributedProviderPublicationError(
          "PROVIDER_PUBLICATION_AMBIGUOUS",
          true,
        );
      }
      this.emit({
        name: "provider_publication_retry",
        providerId,
        operationKind: operation.operationKind,
        outcome: "ambiguous",
        value: 1,
      });
      return this.send(
        lease,
        providerReleaseId,
        operation,
        providerId,
        false,
        signal,
      );
    }
    const receipt = validatePublication(operation, observed);
    const publication: ProviderReleasePublicationResult = {
      ...observed,
      receipt,
    };
    await this.dependencies.publications.accept({
      lease,
      providerReleaseId,
      operation,
      evidence: {
        canonicalReceiptBody: publication.canonicalReceiptBody,
        receiptSha256: publication.receiptSha256,
      },
    });
    return publication;
  }

  private async failAndBlock(
    lease: DistributedProviderPublisherLease,
    providerReleaseId: string,
    operation: ExecutableOperation,
    providerId: string,
    failureCode: string,
    signal: AbortSignal | undefined,
  ): Promise<never> {
    await this.dependencies.publications.fail({
      lease,
      idempotencyKey: operation.operationId,
      failureCode: FAILURE_CODE_PATTERN.test(failureCode)
        ? failureCode
        : "PROVIDER_PUBLICATION_TRANSPORT_FAILED",
    });
    if (operation.operationKind !== "block") {
      try {
        const blocked = blockOperation(
          operation,
          terminalBlockReason(failureCode),
        );
        await this.execute(
          lease,
          providerReleaseId,
          blocked,
          providerId,
          signal,
        );
        this.emit({
          name: "provider_publication_block",
          providerId,
          operationKind: "block",
          outcome: "failure",
          value: 1,
        });
      } catch (error) {
        throw new DistributedProviderPublicationError(
          error instanceof DistributedProviderPublicationError
            ? error.code
            : "PROVIDER_PUBLICATION_BLOCK_FAILED",
          true,
        );
      }
    }
    throw new DistributedProviderPublicationError(failureCode, false);
  }

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  private emit(metric: DistributedProviderPublicationMetric): void {
    try {
      this.dependencies.emitMetric?.(metric);
    } catch {
      // Metrics never invalidate exact durable publication evidence.
    }
  }
}
