import { createHash, timingSafeEqual } from "node:crypto";
import {
  canonicalJson,
  providerReleaseApplyBatchRequestSchema,
  providerReleaseBlockRequestSchema,
  providerReleaseCompletionReceiptSchema,
  providerReleaseConfirmReuseRequestSchema,
  providerReleaseExpectedCompletedHeadV1Schema,
  providerReleaseFinalizeRequestSchema,
  providerReleaseReceiptSchema,
  providerReleaseReuseReceiptSchema,
  providerReleaseStartRequestSchema,
  type ProviderReleaseExpectedCompletedHeadV1,
  type ProviderReleaseFinalizeRequest,
  type ProviderReleaseMutationRequest,
  type ProviderReleaseReceipt,
  type ProviderReleaseStartRequest,
} from "@packscout/contracts";
import { Prisma as ProviderPrisma } from
  "../prisma/generated/provider/index.js";
import type {
  ProviderPrismaClient,
  ProviderTransactionClient,
} from "./provider-database.ts";
import { appendProviderActivityOutbox } from "./provider-local-evidence.ts";
import {
  assertProviderActivityEvent,
  assertProviderReleaseCompletedActivity,
  sanitizeProviderActivityEvidence,
  type ProviderActivityEvent,
} from "./provider-activity-contract.ts";
import {
  hydrateProviderReleasePublicationSource,
  loadProviderReleasePublicationMetadata,
  type ProviderReleasePublicationSource,
} from "./provider-release-repository.ts";
import {
  PrismaProviderWorkerLeaseRepository,
  lockProviderWorkerLease,
  providerWorkerLeaseDatabaseNow,
  providerWorkerLeaseIsLive,
} from "./provider-worker-lease-repository.ts";
import {
  ProviderPublicationCompactProofError,
  buildProviderPublicationBatchEvidence,
  storedProviderPublicationBatchEvidenceMatches,
  type ProviderPublicationBatchEvidence,
} from "./provider-release-publication-proof.ts";
import {
  PUBLICATION_BATCH_EVIDENCE_SELECT,
  verifyProviderPublicationFinalizeTranscript,
} from "./provider-release-publication-transcript.ts";

const TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000,
  timeout: 20_000,
  isolationLevel: ProviderPrisma.TransactionIsolationLevel.Serializable,
});
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;

export type DistributedProviderPublicationOperationKind =
  | "start"
  | "applyBatch"
  | "finalize"
  | "confirmReuse"
  | "block";

export interface DistributedProviderPublicationOperation {
  readonly operationId: string;
  readonly operationKind: DistributedProviderPublicationOperationKind;
  readonly canonicalRequestBody: string;
  readonly requestSha256: string;
}

export interface DistributedProviderPublicationReceiptEvidence {
  readonly canonicalReceiptBody: string;
  readonly receiptSha256: string;
}

export interface DistributedProviderPublisherLease {
  readonly owner: string;
  readonly operationFence: bigint;
  readonly checkpointFence: bigint;
  readonly expiresAt: Date;
}

export interface DistributedProviderPublicationIntent {
  readonly id: string;
  readonly providerReleaseId: string;
  readonly operationKind: DistributedProviderPublicationOperationKind;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly canonicalRequestBody: string;
  readonly leaseFence: bigint;
  readonly state: "pending" | "accepted" | "ambiguous" | "failed";
  readonly attemptCount: number;
  readonly canonicalReceiptBody: string | null;
  readonly receiptSha256: string | null;
  readonly failureCode: string | null;
}

export type ProviderReleasePublicationRepositoryFailureCode =
  | "PROVIDER_PUBLICATION_DEADLINE"
  | "PROVIDER_PUBLICATION_LEASE_HELD"
  | "PROVIDER_PUBLICATION_LEASE_LOST"
  | "PROVIDER_PUBLICATION_SCOPE_INVALID"
  | "PROVIDER_PUBLICATION_IDEMPOTENCY_CONFLICT"
  | "PROVIDER_PUBLICATION_REQUEST_INVALID"
  | "PROVIDER_PUBLICATION_RECEIPT_INVALID"
  | "PROVIDER_PUBLICATION_COMPLETION_PROOF_INVALID"
  | "PROVIDER_PUBLICATION_SEQUENCE_CONFLICT";

type ProviderTerminalReceipt = Extract<ProviderReleaseReceipt, {
  readonly operationKind: "finalize" | "confirmReuse";
}>;

export interface ProviderCompletedPublishPlanSource {
  readonly providerId: string;
  readonly providerKey: string;
  readonly providerReleaseId: string;
  readonly publicProviderReleaseId: string;
  readonly providerReleaseFingerprint: string;
  readonly catalogVersionId: string;
  readonly catalogContentHash: string;
  readonly providerReleaseContentHash: string;
  readonly completedThroughChangeSequence: bigint;
  /** Provider-local durable terminal operation row. */
  readonly artifactAttemptId: string;
  readonly terminalOperationKind: "finalize" | "confirmReuse";
  readonly terminalOperationId: string;
  readonly terminalReceiptSha256: string;
  readonly receipt: ProviderTerminalReceipt;
  readonly publicationSource: ProviderReleasePublicationSource;
}

export class ProviderReleasePublicationRepositoryError extends Error {
  constructor(readonly code: ProviderReleasePublicationRepositoryFailureCode) {
    super(`Provider release publication persistence failed (${code}).`);
    this.name = "ProviderReleasePublicationRepositoryError";
  }
}

interface LockedCheckpoint {
  readonly last_confirmed_sequence: bigint;
  readonly lease_owner: string | null;
  readonly lease_fence: bigint;
  readonly lease_expires_at: Date | null;
  readonly row_version: bigint;
  readonly database_now: Date;
}

function repositoryFailure(
  code: ProviderReleasePublicationRepositoryFailureCode,
): never {
  throw new ProviderReleasePublicationRepositoryError(code);
}

export interface ProviderReleasePublicationTransactionDeadline {
  readonly deadlineAt: number;
}

function transactionOptions(
  deadline?: ProviderReleasePublicationTransactionDeadline,
  isolationLevel: ProviderPrisma.TransactionIsolationLevel =
    ProviderPrisma.TransactionIsolationLevel.Serializable,
) {
  if (deadline === undefined) return { ...TRANSACTION_OPTIONS, isolationLevel };
  const available = Math.floor(deadline.deadlineAt - Date.now() - 50);
  const maxWait = Math.min(
    TRANSACTION_OPTIONS.maxWait,
    Math.max(1, Math.floor(available / 5)),
  );
  const timeout = Math.min(
    TRANSACTION_OPTIONS.timeout,
    available - maxWait,
  );
  if (timeout < 1) repositoryFailure("PROVIDER_PUBLICATION_DEADLINE");
  return { maxWait, timeout, isolationLevel };
}

function transactionExpired(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && (error.code === "P2024" || error.code === "P2028");
}

async function withPublicationDeadline<T>(
  deadline: ProviderReleasePublicationTransactionDeadline | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (deadline !== undefined && transactionExpired(error)) {
      repositoryFailure("PROVIDER_PUBLICATION_DEADLINE");
    }
    throw error;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactText(left: string, right: Uint8Array): boolean {
  const expected = Buffer.from(left, "utf8");
  return expected.byteLength === right.byteLength
    && timingSafeEqual(expected, Buffer.from(right));
}

function requireOwner(owner: string, leaseMilliseconds: number): void {
  if (
    !OWNER_PATTERN.test(owner)
    || !Number.isInteger(leaseMilliseconds)
    || leaseMilliseconds < 1_000
    || leaseMilliseconds > 15 * 60_000
  ) throw new TypeError("Provider publication lease input is invalid.");
}

async function lockCheckpoint(
  transaction: ProviderTransactionClient,
): Promise<LockedCheckpoint> {
  const [row] = await transaction.$queryRaw<LockedCheckpoint[]>(ProviderPrisma.sql`
    select last_confirmed_sequence, lease_owner, lease_fence,
           lease_expires_at, row_version, clock_timestamp() as database_now
    from provider_change_consumers
    where consumer_key = 'provider_release'
    for update
  `);
  if (!row) throw new Error("Provider release checkpoint is missing.");
  return row;
}

async function requireLease(
  transaction: ProviderTransactionClient,
  lease: DistributedProviderPublisherLease,
): Promise<Readonly<{
  checkpoint: LockedCheckpoint;
  databaseNow: Date;
}>> {
  const worker = await lockProviderWorkerLease(transaction, "promotion");
  const checkpoint = await lockCheckpoint(transaction);
  if (
    !providerWorkerLeaseIsLive(worker, {
      owner: lease.owner,
      fence: lease.operationFence,
    })
    || checkpoint.lease_owner !== lease.owner
    || checkpoint.lease_fence !== lease.checkpointFence
    || checkpoint.lease_expires_at === null
    || checkpoint.lease_expires_at <= checkpoint.database_now
  ) repositoryFailure("PROVIDER_PUBLICATION_LEASE_LOST");
  const workerNow = providerWorkerLeaseDatabaseNow(worker);
  return {
    checkpoint,
    databaseNow: workerNow > checkpoint.database_now
      ? workerNow
      : checkpoint.database_now,
  };
}

function parseRequest(
  operation: DistributedProviderPublicationOperation,
): ProviderReleaseMutationRequest {
  let value: unknown;
  try {
    value = JSON.parse(operation.canonicalRequestBody) as unknown;
  } catch {
    repositoryFailure("PROVIDER_PUBLICATION_REQUEST_INVALID");
  }
  const parsed = operation.operationKind === "start"
    ? providerReleaseStartRequestSchema.safeParse(value)
    : operation.operationKind === "applyBatch"
      ? providerReleaseApplyBatchRequestSchema.safeParse(value)
      : operation.operationKind === "finalize"
        ? providerReleaseFinalizeRequestSchema.safeParse(value)
        : operation.operationKind === "confirmReuse"
          ? providerReleaseConfirmReuseRequestSchema.safeParse(value)
          : providerReleaseBlockRequestSchema.safeParse(value);
  if (
    !parsed.success
    || parsed.data.operationId !== operation.operationId
    || parsed.data.idempotencyKey !== operation.operationId
    || canonicalJson(parsed.data) !== operation.canonicalRequestBody
    || sha256(operation.canonicalRequestBody) !== operation.requestSha256
  ) repositoryFailure("PROVIDER_PUBLICATION_REQUEST_INVALID");
  return parsed.data;
}

function requestBodyHash(request: ProviderReleaseMutationRequest): string {
  if (!("release" in request)) {
    repositoryFailure("PROVIDER_PUBLICATION_REQUEST_INVALID");
  }
  return "batch" in request ? request.batch.batchHash : request.release.contentHash;
}

function requestBatchIndex(request: ProviderReleaseMutationRequest): number | null {
  return "batch" in request ? request.batch.batchIndex : null;
}

function receiptFrom(
  operation: DistributedProviderPublicationOperation,
  evidence: DistributedProviderPublicationReceiptEvidence,
): ProviderReleaseReceipt {
  if (
    !HASH_PATTERN.test(evidence.receiptSha256)
    || sha256(evidence.canonicalReceiptBody) !== evidence.receiptSha256
  ) repositoryFailure("PROVIDER_PUBLICATION_RECEIPT_INVALID");
  let value: unknown;
  try {
    value = JSON.parse(evidence.canonicalReceiptBody) as unknown;
  } catch {
    repositoryFailure("PROVIDER_PUBLICATION_RECEIPT_INVALID");
  }
  const parsed = providerReleaseReceiptSchema.safeParse(value);
  const request = parseRequest(operation);
  if (!parsed.success || parsed.data.operationKind === "completedHead") {
    repositoryFailure("PROVIDER_PUBLICATION_RECEIPT_INVALID");
  }
  if (
    parsed.data.operationKind !== operation.operationKind
    || parsed.data.operationId !== operation.operationId
    || parsed.data.idempotencyKey !== operation.operationId
    || parsed.data.requestDigest !== operation.requestSha256
    || !("release" in request)
    || parsed.data.platformKey !== request.release.platformKey
    || parsed.data.publicProviderReleaseId !==
      request.release.publicProviderReleaseId
    || !("details" in parsed.data)
    || !("release" in parsed.data.details)
    || canonicalJson(parsed.data.details.release) !==
      canonicalJson(request.release)
    || canonicalJson(parsed.data.details.providerCheckpoint) !==
      canonicalJson(request.providerCheckpoint)
    || parsed.data.details.sourceWatermark !== request.sourceWatermark
    || canonicalJson(parsed.data.details.observation) !==
      canonicalJson(request.observation)
    || canonicalJson(parsed.data.details.expectedCompletedHead) !==
      canonicalJson(request.expectedCompletedHead)
    || canonicalJson(parsed.data) !== evidence.canonicalReceiptBody
  ) repositoryFailure("PROVIDER_PUBLICATION_RECEIPT_INVALID");
  if (
    parsed.data.operationKind === "applyBatch"
    && "batch" in request
    && (
      parsed.data.details.batchIndex !== request.batch.batchIndex
      || parsed.data.details.kind !== request.batch.kind
      || parsed.data.details.batchHash !== request.batch.batchHash
      || parsed.data.details.recordCount !== request.batch.records.length
      || parsed.data.details.byteCount !== request.batch.byteCount
    )
  ) repositoryFailure("PROVIDER_PUBLICATION_RECEIPT_INVALID");
  return parsed.data;
}

function intentFrom(row: {
  readonly id: string;
  readonly provider_release_id: string;
  readonly operation_kind: string;
  readonly idempotency_key: string;
  readonly request_digest: string;
  readonly request_bytes: Uint8Array;
  readonly lease_fence: bigint;
  readonly state: "pending" | "accepted" | "ambiguous" | "failed";
  readonly attempt_count: number;
  readonly failure_code: string | null;
  readonly receipt?: Readonly<{
    response_bytes: Uint8Array;
    response_digest: string;
  }> | null;
}): DistributedProviderPublicationIntent {
  return {
    id: row.id,
    providerReleaseId: row.provider_release_id,
    operationKind: row.operation_kind as
      DistributedProviderPublicationOperationKind,
    idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest,
    canonicalRequestBody: new TextDecoder().decode(row.request_bytes),
    leaseFence: row.lease_fence,
    state: row.state,
    attemptCount: row.attempt_count,
    canonicalReceiptBody: row.receipt === undefined || row.receipt === null
      ? null
      : new TextDecoder().decode(row.receipt.response_bytes),
    receiptSha256: row.receipt?.response_digest ?? null,
    failureCode: row.failure_code,
  };
}

function emptyExpectedHead(platformKey: string): ProviderReleaseExpectedCompletedHeadV1 {
  return providerReleaseExpectedCompletedHeadV1Schema.parse({
    platformKey,
    publicProviderReleaseId: null,
    sharedConfigurationEpoch: null,
    providerCheckpoint: { settledSequence: "0", settledAt: null },
    observation: null,
    terminalReceiptSha256: null,
  });
}

function immutableActivityBody(event: ProviderActivityEvent): string {
  return canonicalJson({
    id: event.id,
    eventDigest: event.eventDigest,
    eventType: event.eventType,
    severity: event.severity,
    dedupeKey: event.dedupeKey,
    recoveryKey: event.recoveryKey,
    localRunId: event.localRunId,
    localQuarantineId: event.localQuarantineId,
    title: event.title,
    summary: event.summary,
    evidence: event.evidence,
    eventAt: event.eventAt.toISOString(),
  });
}

async function setReconciliationContext(
  transaction: ProviderTransactionClient,
  lease: DistributedProviderPublisherLease,
  intentFence: bigint,
): Promise<void> {
  if (intentFence === lease.operationFence) return;
  await transaction.$queryRaw(ProviderPrisma.sql`
    select set_config(
             'packscout.provider_publication_reconciliation_owner',
             ${lease.owner}, true
           ),
           set_config(
             'packscout.provider_publication_reconciliation_fence',
             ${lease.operationFence.toString()}, true
           )
  `);
}

export class ProviderReleasePublicationRepository {
  readonly #workerLeases: PrismaProviderWorkerLeaseRepository;

  constructor(private readonly provider: ProviderPrismaClient) {
    this.#workerLeases = new PrismaProviderWorkerLeaseRepository(provider);
  }

  async claimLease(
    owner: string,
    leaseMilliseconds: number,
    deadline?: ProviderReleasePublicationTransactionDeadline,
    cleanupDeadline?: ProviderReleasePublicationTransactionDeadline,
  ): Promise<DistributedProviderPublisherLease> {
    requireOwner(owner, leaseMilliseconds);
    const worker = await this.#workerLeases.acquire({
      role: "promotion",
      owner,
      leaseMilliseconds,
    }, deadline);
    if (worker.kind === "held") {
      repositoryFailure("PROVIDER_PUBLICATION_LEASE_HELD");
    }
    try {
      const checkpoint = await withPublicationDeadline(deadline, () =>
        this.provider.$transaction(async (transaction) => {
        let row = await lockCheckpoint(transaction);
        const active = row.lease_owner !== null
          && row.lease_expires_at !== null
          && row.lease_expires_at > row.database_now;
        if (active && row.lease_owner !== owner) {
          repositoryFailure("PROVIDER_PUBLICATION_LEASE_HELD");
        }
        const takeover = !active || row.lease_owner === null;
        const expiresAt = new Date(
          row.database_now.getTime() + leaseMilliseconds,
        );
        const changed = await transaction.provider_change_consumers.updateMany({
          where: {
            consumer_key: "provider_release",
            row_version: row.row_version,
          },
          data: {
            lease_owner: owner,
            lease_fence: takeover ? row.lease_fence + 1n : row.lease_fence,
            lease_expires_at: expiresAt,
            row_version: { increment: 1n },
            updated_at: row.database_now,
          },
        });
        if (changed.count !== 1) {
          repositoryFailure("PROVIDER_PUBLICATION_LEASE_LOST");
        }
        row = await lockCheckpoint(transaction);
        return row;
        }, transactionOptions(deadline))
      );
      if (
        checkpoint.lease_owner !== owner
        || checkpoint.lease_expires_at === null
      ) repositoryFailure("PROVIDER_PUBLICATION_LEASE_LOST");
      return {
        owner,
        operationFence: worker.lease.fence,
        checkpointFence: checkpoint.lease_fence,
        expiresAt: worker.lease.expiresAt < checkpoint.lease_expires_at
          ? worker.lease.expiresAt
          : checkpoint.lease_expires_at,
      };
    } catch (error) {
      await this.#workerLeases.release({
        role: "promotion",
        owner,
        fence: worker.lease.fence,
      }, cleanupDeadline ?? deadline).catch(() => undefined);
      throw error;
    }
  }

  async renewLease(
    lease: DistributedProviderPublisherLease,
    leaseMilliseconds: number,
    deadline?: ProviderReleasePublicationTransactionDeadline,
  ): Promise<DistributedProviderPublisherLease> {
    requireOwner(lease.owner, leaseMilliseconds);
    const worker = await this.#workerLeases.renew({
      role: "promotion",
      owner: lease.owner,
      fence: lease.operationFence,
      leaseMilliseconds,
    }, deadline);
    if (worker === null) repositoryFailure("PROVIDER_PUBLICATION_LEASE_LOST");
    const checkpoint = await withPublicationDeadline(deadline, () =>
      this.provider.$transaction(async (transaction) => {
      let row = await lockCheckpoint(transaction);
      if (
        row.lease_owner !== lease.owner
        || row.lease_fence !== lease.checkpointFence
        || row.lease_expires_at === null
        || row.lease_expires_at <= row.database_now
      ) repositoryFailure("PROVIDER_PUBLICATION_LEASE_LOST");
      const expiresAt = new Date(row.database_now.getTime() + leaseMilliseconds);
      const changed = await transaction.provider_change_consumers.updateMany({
        where: {
          consumer_key: "provider_release",
          lease_owner: lease.owner,
          lease_fence: lease.checkpointFence,
          row_version: row.row_version,
        },
        data: {
          lease_expires_at: expiresAt,
          row_version: { increment: 1n },
          updated_at: row.database_now,
        },
      });
      if (changed.count !== 1) {
        repositoryFailure("PROVIDER_PUBLICATION_LEASE_LOST");
      }
      row = await lockCheckpoint(transaction);
      return row;
      }, transactionOptions(deadline))
    );
    if (checkpoint.lease_expires_at === null) {
      repositoryFailure("PROVIDER_PUBLICATION_LEASE_LOST");
    }
    return {
      ...lease,
      expiresAt: worker.expiresAt < checkpoint.lease_expires_at
        ? worker.expiresAt
        : checkpoint.lease_expires_at,
    };
  }

  async releaseLease(
    lease: DistributedProviderPublisherLease,
    deadline?: ProviderReleasePublicationTransactionDeadline,
  ): Promise<void> {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => this.#workerLeases.release({
        role: "promotion",
        owner: lease.owner,
        fence: lease.operationFence,
      }, deadline)),
      Promise.resolve().then(() => withPublicationDeadline(
        deadline,
        () => this.provider.$transaction(async (transaction) => {
          const row = await lockCheckpoint(transaction);
          if (row.lease_owner === null) return;
          if (
            row.lease_owner !== lease.owner
            || row.lease_fence !== lease.checkpointFence
          ) return;
          await transaction.provider_change_consumers.updateMany({
            where: {
              consumer_key: "provider_release",
              lease_owner: lease.owner,
              lease_fence: lease.checkpointFence,
              row_version: row.row_version,
            },
            data: {
              lease_owner: null,
              lease_expires_at: null,
              row_version: { increment: 1n },
              updated_at: row.database_now,
            },
          });
        }, transactionOptions(deadline)),
      )),
    ]);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure !== undefined) throw failure.reason;
  }

  async loadExpectedCompletedHead(
    deadline?: ProviderReleasePublicationTransactionDeadline,
  ): Promise<ProviderReleaseExpectedCompletedHeadV1> {
    return withPublicationDeadline(deadline, () =>
      this.provider.$transaction(async (transaction) => {
      const identity = await transaction.database_identity.findUniqueOrThrow({
        where: { singleton_key: true },
        select: { provider_key: true },
      });
      const state = await transaction.provider_publication_state.findUniqueOrThrow({
        where: { singleton_key: true },
        include: {
          completion_receipt: {
            include: { operation: true, provider_release: true },
          },
        },
      });
      if (
        state.completed_release_id === null
        || state.completion_receipt_id === null
        || state.completed_at === null
      ) {
        if (state.completed_through_change_sequence !== 0n) {
          repositoryFailure("PROVIDER_PUBLICATION_RECEIPT_INVALID");
        }
        return emptyExpectedHead(identity.provider_key);
      }
      const stored = state.completion_receipt;
      if (
        stored === null
        || stored.provider_release_id !== state.completed_release_id
        || stored.operation.provider_release_id !== state.completed_release_id
        || stored.provider_release.lifecycle !== "complete"
      ) repositoryFailure("PROVIDER_PUBLICATION_RECEIPT_INVALID");
      const canonicalReceiptBody = new TextDecoder().decode(stored.response_bytes);
      if (sha256(canonicalReceiptBody) !== stored.response_digest) {
        repositoryFailure("PROVIDER_PUBLICATION_RECEIPT_INVALID");
      }
      let value: unknown;
      try {
        value = JSON.parse(canonicalReceiptBody) as unknown;
      } catch {
        repositoryFailure("PROVIDER_PUBLICATION_RECEIPT_INVALID");
      }
      const parsed = stored.operation.operation_kind === "finalize"
        ? providerReleaseCompletionReceiptSchema.safeParse(value)
        : stored.operation.operation_kind === "confirmReuse"
          ? providerReleaseReuseReceiptSchema.safeParse(value)
          : null;
      if (
        parsed === null
        || !parsed.success
        || parsed.data.platformKey !== identity.provider_key
        || parsed.data.providerCheckpoint.settledSequence !==
          state.completed_through_change_sequence.toString()
        || parsed.data.receiptDigest !== stored.remote_receipt_id
        || canonicalJson(parsed.data) !== canonicalReceiptBody
      ) repositoryFailure("PROVIDER_PUBLICATION_RECEIPT_INVALID");
      return providerReleaseExpectedCompletedHeadV1Schema.parse({
        platformKey: parsed.data.platformKey,
        publicProviderReleaseId: parsed.data.publicProviderReleaseId,
        sharedConfigurationEpoch: parsed.data.sharedConfigurationEpoch,
        providerCheckpoint: parsed.data.providerCheckpoint,
        observation: parsed.data.details.observation,
        terminalReceiptSha256: stored.response_digest,
      });
      }, transactionOptions(
        deadline,
        ProviderPrisma.TransactionIsolationLevel.RepeatableRead,
      ))
    );
  }

  /** Verifies compact completion evidence before hydrating immutable batches. */
  async loadCompletedPublishPlanSource(input: Readonly<{
    event: ProviderActivityEvent;
  }>): Promise<ProviderCompletedPublishPlanSource> {
    const event = assertProviderActivityEvent(input.event);
    const completion = assertProviderReleaseCompletedActivity(event);
    const expectedKind = completion.state === "complete"
      ? "finalize"
      : "confirmReuse";
    const verified = await this.provider.$transaction(async (transaction) => {
      const storedEvent = await transaction.provider_activity_outbox.findUnique({
        where: { id: event.id },
      });
      if (storedEvent === null) {
        repositoryFailure("PROVIDER_PUBLICATION_COMPLETION_PROOF_INVALID");
      }
      let verifiedStoredEvent: ProviderActivityEvent;
      try {
        verifiedStoredEvent = assertProviderActivityEvent({
          id: storedEvent.id,
          eventDigest: storedEvent.event_digest,
          eventType: storedEvent.event_type,
          severity: storedEvent.severity,
          dedupeKey: storedEvent.dedupe_key,
          recoveryKey: storedEvent.recovery_key,
          localRunId: storedEvent.local_run_id,
          localQuarantineId: storedEvent.local_quarantine_id,
          title: storedEvent.title,
          summary: storedEvent.summary,
          evidence: sanitizeProviderActivityEvidence(storedEvent.evidence),
          eventAt: storedEvent.event_at,
          deliveryAttemptCount: storedEvent.delivery_attempt_count,
          lastFailureCode: storedEvent.last_failure_code,
        });
      } catch {
        repositoryFailure("PROVIDER_PUBLICATION_COMPLETION_PROOF_INVALID");
      }
      if (immutableActivityBody(verifiedStoredEvent) !== immutableActivityBody(event)) {
        repositoryFailure("PROVIDER_PUBLICATION_COMPLETION_PROOF_INVALID");
      }

      const metadata = await loadProviderReleasePublicationMetadata(
        transaction,
        completion.providerReleaseId,
      );
      const receiptRows = await transaction.provider_publication_receipts.findMany({
        where: {
          provider_release_id: completion.providerReleaseId,
          response_digest: completion.terminalReceiptSha256,
        },
        include: { operation: true },
        take: 3,
      });
      const matches = receiptRows.filter((row) =>
        row.operation.operation_kind === expectedKind &&
        row.operation.state === "accepted"
      );
      if (matches.length !== 1) {
        repositoryFailure("PROVIDER_PUBLICATION_COMPLETION_PROOF_INVALID");
      }
      const stored = matches[0]!;
      const operation: DistributedProviderPublicationOperation = {
        operationId: stored.operation.idempotency_key,
        operationKind: expectedKind,
        canonicalRequestBody: new TextDecoder().decode(
          stored.operation.request_bytes,
        ),
        requestSha256: stored.operation.request_digest,
      };
      const parsed = receiptFrom(operation, {
        canonicalReceiptBody: new TextDecoder().decode(stored.response_bytes),
        receiptSha256: stored.response_digest,
      });
      if (
        (parsed.operationKind !== "finalize" &&
          parsed.operationKind !== "confirmReuse") ||
        parsed.operationKind !== expectedKind
      ) repositoryFailure("PROVIDER_PUBLICATION_COMPLETION_PROOF_INVALID");
      const receipt = parsed as ProviderTerminalReceipt;
      if (expectedKind === "finalize") {
        try {
          await verifyProviderPublicationFinalizeTranscript({
            transaction,
            providerReleaseId: completion.providerReleaseId,
            terminalRequest: parseRequest(operation) as
              ProviderReleaseFinalizeRequest,
            parseStartRequest: (start) => parseRequest({
              ...start,
              operationKind: "start",
            }) as ProviderReleaseStartRequest,
          });
        } catch (error) {
          if (error instanceof ProviderPublicationCompactProofError) {
            repositoryFailure("PROVIDER_PUBLICATION_COMPLETION_PROOF_INVALID");
          }
          throw error;
        }
      }
      if (
        metadata.release.lifecycle !== "complete" ||
        metadata.descriptor.providerReleaseId !== completion.providerReleaseId ||
        metadata.descriptor.catalogVersionId !== completion.catalogVersionId ||
        metadata.descriptor.catalogContentHash !== completion.catalogContentHash ||
        metadata.descriptor.contentHash !== completion.providerReleaseContentHash ||
        receipt.publicProviderReleaseId !== completion.publicProviderReleaseId ||
        receipt.details.release.providerReleaseFingerprint !==
          completion.providerReleaseFingerprint ||
        receipt.providerCheckpoint.settledSequence !==
          completion.completedThroughChangeSequence ||
        stored.accepted_content_hash !== metadata.descriptor.contentHash ||
        stored.accepted_record_count !== metadata.batchRecordCount
      ) repositoryFailure("PROVIDER_PUBLICATION_COMPLETION_PROOF_INVALID");
      return {
        metadata,
        publicProviderReleaseId: receipt.publicProviderReleaseId,
        providerReleaseFingerprint:
          receipt.details.release.providerReleaseFingerprint,
        completedThroughChangeSequence:
          BigInt(completion.completedThroughChangeSequence),
        artifactAttemptId: stored.operation.id,
        terminalOperationKind: receipt.operationKind,
        terminalOperationId: receipt.operationId,
        terminalReceiptSha256: stored.response_digest,
        receipt,
      };
    }, {
      ...TRANSACTION_OPTIONS,
      isolationLevel: ProviderPrisma.TransactionIsolationLevel.RepeatableRead,
    });
    const source = await hydrateProviderReleasePublicationSource(
      this.provider,
      verified.metadata,
    );
    return {
      providerId: source.descriptor.providerId,
      providerKey: source.descriptor.providerKey,
      providerReleaseId: source.descriptor.providerReleaseId,
      publicProviderReleaseId: verified.publicProviderReleaseId,
      providerReleaseFingerprint: verified.providerReleaseFingerprint,
      catalogVersionId: source.descriptor.catalogVersionId,
      catalogContentHash: source.descriptor.catalogContentHash,
      providerReleaseContentHash: source.descriptor.contentHash,
      completedThroughChangeSequence: verified.completedThroughChangeSequence,
      artifactAttemptId: verified.artifactAttemptId,
      terminalOperationKind: verified.terminalOperationKind,
      terminalOperationId: verified.terminalOperationId,
      terminalReceiptSha256: verified.terminalReceiptSha256,
      receipt: verified.receipt,
      publicationSource: source,
    };
  }

  async recordIntent(input: {
    readonly lease: DistributedProviderPublisherLease;
    readonly providerReleaseId: string;
    readonly operation: DistributedProviderPublicationOperation;
  }, deadline?: ProviderReleasePublicationTransactionDeadline): Promise<
    DistributedProviderPublicationIntent
  > {
    const request = parseRequest(input.operation);
    if (!("release" in request)) {
      repositoryFailure("PROVIDER_PUBLICATION_REQUEST_INVALID");
    }
    return withPublicationDeadline(deadline, () =>
      this.provider.$transaction(async (transaction) => {
      const { databaseNow } = await requireLease(transaction, input.lease);
      const identity = await transaction.database_identity.findUniqueOrThrow({
        where: { singleton_key: true },
        select: { provider_id: true, provider_key: true },
      });
      const release = await transaction.provider_releases.findUnique({
        where: { id: input.providerReleaseId },
      });
      const existing = await transaction.provider_publication_operations.findUnique({
        where: { idempotency_key: request.idempotencyKey },
        include: { receipt: true },
      });
      if (
        release === null
        || release.provider_id !== identity.provider_id
        || release.provider_key !== identity.provider_key
        || request.release.platformKey !== identity.provider_key
      ) repositoryFailure("PROVIDER_PUBLICATION_SCOPE_INVALID");
      if (existing !== null) {
        if (
          existing.provider_release_id !== input.providerReleaseId
          || existing.operation_kind !== input.operation.operationKind
          || existing.request_digest !== input.operation.requestSha256
          || !exactText(
            input.operation.canonicalRequestBody,
            existing.request_bytes,
          )
        ) repositoryFailure("PROVIDER_PUBLICATION_IDEMPOTENCY_CONFLICT");
        return intentFrom(existing);
      }
      const reuse = input.operation.operationKind === "confirmReuse";
      const block = input.operation.operationKind === "block";
      if (
        (reuse && release.lifecycle !== "complete")
        || (block
          && release.lifecycle !== "assembled"
          && release.lifecycle !== "publishing"
          && release.lifecycle !== "blocked")
        || (!reuse && !block
          && release.lifecycle !== "assembled"
          && release.lifecycle !== "publishing")
      ) repositoryFailure("PROVIDER_PUBLICATION_SCOPE_INVALID");
      if (!reuse && !block && release.lifecycle === "assembled") {
        await transaction.provider_releases.update({
          where: { id: release.id },
          data: { lifecycle: "publishing" },
        });
      }
      const created = await transaction.provider_publication_operations.create({
        data: {
          provider_release_id: release.id,
          operation_kind: input.operation.operationKind,
          batch_index: requestBatchIndex(request),
          idempotency_key: request.idempotencyKey,
          request_digest: input.operation.requestSha256,
          request_bytes: Buffer.from(
            input.operation.canonicalRequestBody,
            "utf8",
          ),
          body_hash: requestBodyHash(request),
          lease_fence: input.lease.operationFence,
          requested_at: databaseNow,
        },
        include: { receipt: true },
      });
      return intentFrom(created);
      }, transactionOptions(deadline))
    );
  }

  async recordAttempt(input: {
    readonly lease: DistributedProviderPublisherLease;
    readonly idempotencyKey: string;
  }, deadline?: ProviderReleasePublicationTransactionDeadline): Promise<void> {
    await withPublicationDeadline(deadline, () =>
      this.provider.$transaction(async (transaction) => {
      const { databaseNow } = await requireLease(transaction, input.lease);
      const changed = await transaction.provider_publication_operations.updateMany({
        where: {
          idempotency_key: input.idempotencyKey,
          state: { in: ["pending", "ambiguous"] },
        },
        data: {
          attempt_count: { increment: 1 },
          last_attempted_at: databaseNow,
        },
      });
      if (changed.count !== 1) {
        repositoryFailure("PROVIDER_PUBLICATION_RECEIPT_INVALID");
      }
      }, transactionOptions(deadline))
    );
  }

  async markAmbiguous(input: {
    readonly lease: DistributedProviderPublisherLease;
    readonly idempotencyKey: string;
  }, deadline?: ProviderReleasePublicationTransactionDeadline): Promise<void> {
    await withPublicationDeadline(deadline, () =>
      this.provider.$transaction(async (transaction) => {
      await requireLease(transaction, input.lease);
      const operation = await transaction.provider_publication_operations.findUnique({
        where: { idempotency_key: input.idempotencyKey },
      });
      if (operation === null || operation.state === "accepted") return;
      if (operation.state === "failed") {
        repositoryFailure("PROVIDER_PUBLICATION_RECEIPT_INVALID");
      }
      if (operation.state === "pending") {
        await transaction.provider_publication_operations.update({
          where: { id: operation.id },
          data: { state: "ambiguous" },
        });
      }
      }, transactionOptions(deadline))
    );
  }

  async fail(input: {
    readonly lease: DistributedProviderPublisherLease;
    readonly idempotencyKey: string;
    readonly failureCode: string;
  }, deadline?: ProviderReleasePublicationTransactionDeadline): Promise<void> {
    if (!FAILURE_CODE_PATTERN.test(input.failureCode)) {
      throw new TypeError("Provider publication failure code is invalid.");
    }
    await withPublicationDeadline(deadline, () =>
      this.provider.$transaction(async (transaction) => {
      const { databaseNow } = await requireLease(transaction, input.lease);
      const row = await transaction.provider_publication_operations.findUnique({
        where: { idempotency_key: input.idempotencyKey },
        include: { provider_release: true },
      });
      if (row === null || row.state === "accepted") {
        repositoryFailure("PROVIDER_PUBLICATION_RECEIPT_INVALID");
      }
      if (row.state === "failed") return;
      await setReconciliationContext(
        transaction,
        input.lease,
        row.lease_fence,
      );
      await transaction.provider_publication_operations.update({
        where: { id: row.id },
        data: {
          state: "failed",
          failure_code: input.failureCode,
          completed_at: databaseNow,
        },
      });
      if (
        row.operation_kind !== "confirmReuse"
        && row.provider_release.lifecycle !== "complete"
        && row.provider_release.lifecycle !== "blocked"
        && row.provider_release.lifecycle !== "failed"
      ) {
        await transaction.provider_releases.update({
          where: { id: row.provider_release_id },
          data: { lifecycle: "blocked" },
        });
      }
      }, transactionOptions(deadline))
    );
  }

  async accept(input: {
    readonly lease: DistributedProviderPublisherLease;
    readonly providerReleaseId: string;
    readonly operation: DistributedProviderPublicationOperation;
    readonly evidence: DistributedProviderPublicationReceiptEvidence;
  }, deadline?: ProviderReleasePublicationTransactionDeadline): Promise<Readonly<{
    receipt: ProviderReleaseReceipt;
    completed: boolean;
  }>> {
    const receipt = receiptFrom(input.operation, input.evidence);
    const request = parseRequest(input.operation);
    if (!("release" in request)) {
      repositoryFailure("PROVIDER_PUBLICATION_REQUEST_INVALID");
    }
    let compactBatchEvidence: ProviderPublicationBatchEvidence | null = null;
    if ("batch" in request) {
      try {
        compactBatchEvidence =
          await buildProviderPublicationBatchEvidence(request);
      } catch (error) {
        if (error instanceof ProviderPublicationCompactProofError) {
          repositoryFailure("PROVIDER_PUBLICATION_REQUEST_INVALID");
        }
        throw error;
      }
    }
    return withPublicationDeadline(deadline, () =>
      this.provider.$transaction(async (transaction) => {
      const { checkpoint, databaseNow } = await requireLease(
        transaction,
        input.lease,
      );
      const row = await transaction.provider_publication_operations.findUnique({
        where: { idempotency_key: request.idempotencyKey },
        include: { receipt: true, provider_release: true },
      });
      if (
        row === null
        || row.provider_release_id !== input.providerReleaseId
        || row.operation_kind !== input.operation.operationKind
        || row.request_digest !== input.operation.requestSha256
        || !exactText(input.operation.canonicalRequestBody, row.request_bytes)
      ) repositoryFailure("PROVIDER_PUBLICATION_IDEMPOTENCY_CONFLICT");
      if (row.state === "accepted") {
        if (
          row.receipt === null
          || row.receipt.response_digest !== input.evidence.receiptSha256
          || !exactText(
            input.evidence.canonicalReceiptBody,
            row.receipt.response_bytes,
          )
        ) repositoryFailure("PROVIDER_PUBLICATION_RECEIPT_INVALID");
        if (compactBatchEvidence !== null) {
          const storedEvidence = await transaction
            .provider_publication_batch_evidence.findUnique({
              where: { operation_id: row.id },
              select: PUBLICATION_BATCH_EVIDENCE_SELECT,
            });
          if (
            storedEvidence === null
            || !storedProviderPublicationBatchEvidenceMatches(
              storedEvidence,
              compactBatchEvidence,
            )
          ) repositoryFailure("PROVIDER_PUBLICATION_RECEIPT_INVALID");
        }
        return {
          receipt,
          completed: input.operation.operationKind === "finalize"
            || input.operation.operationKind === "confirmReuse",
        };
      }
      if (row.state === "failed") {
        repositoryFailure("PROVIDER_PUBLICATION_RECEIPT_INVALID");
      }
      if (input.operation.operationKind === "finalize") {
        try {
          await verifyProviderPublicationFinalizeTranscript({
            transaction,
            providerReleaseId: row.provider_release_id,
            terminalRequest: request as ProviderReleaseFinalizeRequest,
            parseStartRequest: (operation) => parseRequest({
              ...operation,
              operationKind: "start",
            }) as ProviderReleaseStartRequest,
          });
        } catch (error) {
          if (error instanceof ProviderReleasePublicationRepositoryError) {
            throw error;
          }
          if (error instanceof ProviderPublicationCompactProofError) {
            repositoryFailure("PROVIDER_PUBLICATION_RECEIPT_INVALID");
          }
          throw error;
        }
      }
      await setReconciliationContext(
        transaction,
        input.lease,
        row.lease_fence,
      );
      await transaction.provider_publication_operations.update({
        where: { id: row.id },
        data: {
          state: "accepted",
          failure_code: null,
          completed_at: databaseNow,
        },
      });
      const terminal = input.operation.operationKind === "finalize"
        || input.operation.operationKind === "confirmReuse";
      const localRecordCount = terminal
        ? await transaction.provider_release_batches.aggregate({
            where: { provider_release_id: row.provider_release_id },
            _sum: { record_count: true },
          }).then(({ _sum }) => _sum.record_count ?? 0)
        : "batch" in request
          ? request.batch.records.length
          : 0;
      const acceptedContentHash = terminal
        ? row.provider_release.content_hash
        : requestBodyHash(request);
      const localReceipt = await transaction.provider_publication_receipts.create({
        data: {
          operation_id: row.id,
          provider_release_id: row.provider_release_id,
          remote_receipt_id: receipt.receiptDigest,
          outcome: "accepted",
          response_digest: input.evidence.receiptSha256,
          response_bytes: Buffer.from(
            input.evidence.canonicalReceiptBody,
            "utf8",
          ),
          accepted_content_hash: acceptedContentHash,
          accepted_record_count: localRecordCount,
          received_at: databaseNow,
        },
      });
      if (compactBatchEvidence !== null) {
        await transaction.provider_publication_batch_evidence.create({
          data: {
            operation_id: row.id,
            provider_release_id: row.provider_release_id,
            batch_index: compactBatchEvidence.batchIndex,
            batch_kind: compactBatchEvidence.batchKind,
            batch_hash: compactBatchEvidence.batchHash,
            record_count: compactBatchEvidence.recordCount,
            byte_count: compactBatchEvidence.byteCount,
            release_context_hash: compactBatchEvidence.releaseContextHash,
            search_shard_descriptors:
              compactBatchEvidence.searchShardDescriptors.map(
                (descriptor) => ({ ...descriptor }),
              ),
            created_at: databaseNow,
          },
        });
      }
      if (input.operation.operationKind === "block") {
        if (row.provider_release.lifecycle !== "blocked") {
          await transaction.provider_releases.update({
            where: { id: row.provider_release_id },
            data: { lifecycle: "blocked" },
          });
        }
        return { receipt, completed: false };
      }
      if (!terminal) return { receipt, completed: false };
      if (
        receipt.operationKind !== "finalize"
        && receipt.operationKind !== "confirmReuse"
      ) repositoryFailure("PROVIDER_PUBLICATION_RECEIPT_INVALID");
      const completedSequence = BigInt(
        receipt.providerCheckpoint.settledSequence,
      );
      if (
        completedSequence <= checkpoint.last_confirmed_sequence
        || (receipt.operationKind === "finalize"
          && completedSequence !== row.provider_release.through_change_sequence)
        || (receipt.operationKind === "confirmReuse"
          && completedSequence <= row.provider_release.through_change_sequence)
      ) repositoryFailure("PROVIDER_PUBLICATION_SEQUENCE_CONFLICT");
      const ledger = await transaction.promotion_ledger.findUniqueOrThrow({
        where: { singleton_key: true },
        select: { last_sequence: true },
      });
      if (completedSequence > ledger.last_sequence) {
        repositoryFailure("PROVIDER_PUBLICATION_SEQUENCE_CONFLICT");
      }
      if (receipt.operationKind === "finalize") {
        if (row.provider_release.lifecycle !== "publishing") {
          repositoryFailure("PROVIDER_PUBLICATION_SCOPE_INVALID");
        }
        await transaction.provider_releases.update({
          where: { id: row.provider_release_id },
          data: { lifecycle: "complete", completed_at: databaseNow },
        });
      } else if (row.provider_release.lifecycle !== "complete") {
        repositoryFailure("PROVIDER_PUBLICATION_SCOPE_INVALID");
      }
      await transaction.provider_publication_state.update({
        where: { singleton_key: true },
        data: {
          completed_release_id: row.provider_release_id,
          completed_through_change_sequence: completedSequence,
          completion_receipt_id: localReceipt.id,
          completed_at: databaseNow,
          row_version: { increment: 1n },
          updated_at: databaseNow,
        },
      });
      await transaction.provider_change_consumers.update({
        where: { consumer_key: "provider_release" },
        data: {
          last_confirmed_sequence: completedSequence,
          confirmation_kind: "provider_publication_receipt",
          confirmation_id: localReceipt.id,
          row_version: { increment: 1n },
          updated_at: databaseNow,
        },
      });
      await appendProviderActivityOutbox(transaction, {
        eventType: "provider_release_completed",
        severity: "info",
        dedupeKey:
          `provider-release-completed:${row.provider_release_id}:${completedSequence}`,
        recoveryKey: `provider-release:${row.provider_release_id}`,
        title: "Provider release publication completed",
        summary: receipt.operationKind === "finalize"
          ? "An immutable provider release completed publication."
          : "An unchanged immutable provider release confirmed a newer boundary.",
        evidence: {
          state: receipt.operationKind === "finalize" ? "complete" : "reused",
          providerReleaseId: row.provider_release_id,
          publicProviderReleaseId: receipt.publicProviderReleaseId,
          catalogVersionId: row.provider_release.catalog_version_id,
          catalogContentHash: row.provider_release.catalog_content_hash,
          providerReleaseContentHash: row.provider_release.content_hash,
          providerReleaseFingerprint:
            receipt.details.release.providerReleaseFingerprint,
          completedThroughChangeSequence: completedSequence.toString(),
          terminalReceiptSha256: input.evidence.receiptSha256,
        },
        eventAt: databaseNow,
      });
      return { receipt, completed: true };
      }, transactionOptions(deadline))
    );
  }
}
