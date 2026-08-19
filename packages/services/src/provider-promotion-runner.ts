import {
  MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT,
  canonicalJson,
  verifyProviderCatalogReleasePlanV1,
  type ProviderReleaseExpectedCompletedHeadV1,
} from "@packscout/contracts";
import { PublicationClientError } from "./convex-publication-http-client.ts";
import {
  ProviderPromotionPreparationError,
  parseProviderPromotionOperation,
  prepareProviderPromotion,
  providerPromotionStatusRequest,
  reconstructVerifiedProviderPromotionPlan,
  validateProviderPromotionReceipt,
} from "./provider-promotion-operations.ts";
import type {
  ProviderPromotionAssemblerPort,
  ProviderPromotionClaim,
  ProviderPromotionCompletedHead,
  ProviderPromotionHealth,
  ProviderPromotionLanePort,
  ProviderPromotionOperationRecord,
  ProviderPromotionCheckpointIdentity,
  ProviderPromotionPreparedSummary,
  ProviderPromotionTransport,
} from "./provider-promotion-types.ts";
import type {
  ProviderCatalogReleaseCheckpointPort,
} from "./provider-catalog-release-types.ts";
import type { ProviderCatalogCheckpoint } from "./provider-catalog-settlement-service.ts";
import { promotionRetryDelay } from "./promotion-retry-policy.ts";

export type ProviderPromotionCycleResult = Readonly<{
  outcome:
    | "idle"
    | "progressed"
    | "retry_scheduled"
    | "published"
    | "reused"
    | "superseded"
    | "reconciliation_lost"
    | "failed"
    | "lease_lost"
    | "stopped";
  platformKey: string;
  attemptId: string | null;
  evaluationSequence: bigint | null;
  targetCheckpoint: bigint | null;
  operationsAcknowledged: number;
  failureCode: string | null;
}>;

export interface ProviderPromotionAlertSink {
  notify(input: Readonly<{
    platformKey: string;
    attemptId: string;
    evaluationSequence: bigint;
    targetCheckpoint: bigint;
    failureCode: string;
    occurredAt: Date;
  }>): Promise<void>;
}

export interface ProviderPromotionHealthSink {
  report(health: ProviderPromotionHealth): void | Promise<void>;
}

export interface ProviderPromotionRunnerOptions {
  readonly platformKey: string;
  readonly workerId: string;
  readonly lane: ProviderPromotionLanePort;
  readonly checkpoints: ProviderCatalogReleaseCheckpointPort;
  readonly assembler: ProviderPromotionAssemblerPort;
  readonly transport: ProviderPromotionTransport;
  readonly clock: Readonly<{ now(): Date }>;
  readonly alerts: ProviderPromotionAlertSink;
  readonly health?: ProviderPromotionHealthSink;
  readonly random?: Readonly<{ fraction(): number }>;
  readonly leaseMilliseconds?: number;
  readonly maximumOperationsPerCycle?: number;
  readonly maximumRetries?: number;
  readonly initialRetryMilliseconds?: number;
  readonly maximumRetryMilliseconds?: number;
}

const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const MAX_PROVIDER_PROMOTION_OPERATIONS =
  MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT + 2;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError("Provider promotion runner limit is invalid.");
  }
  return resolved;
}

function wireCheckpoint(
  checkpoint: ProviderCatalogCheckpoint | ProviderPromotionCheckpointIdentity,
): unknown {
  return {
    platformKey: checkpoint.platformKey,
    sharedConfigurationEpoch: {
      configurationKey: checkpoint.sharedConfigurationEpoch.configurationKey,
      revision: checkpoint.sharedConfigurationEpoch.revision,
      publicChangeSequence: String(
        checkpoint.sharedConfigurationEpoch.publicChangeSequence,
      ),
      configurationHash: checkpoint.sharedConfigurationEpoch.configurationHash,
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
          kind: "blocked",
          reason: checkpoint.blockedState.reason,
          causeSequence: String(checkpoint.blockedState.causeSequence),
        },
  };
}

function sameCheckpoint(
  left: ProviderCatalogCheckpoint | ProviderPromotionCheckpointIdentity,
  right: ProviderCatalogCheckpoint | ProviderPromotionCheckpointIdentity,
): boolean {
  return canonicalJson(wireCheckpoint(left)) === canonicalJson(wireCheckpoint(right));
}

function expectedCompletedHead(
  platformKey: string,
  head: ProviderPromotionCompletedHead | null,
): ProviderReleaseExpectedCompletedHeadV1 {
  if (head === null) {
    return {
      platformKey,
      publicProviderReleaseId: null,
      sharedConfigurationEpoch: null,
      providerCheckpoint: { settledSequence: "0", settledAt: null },
      observation: null,
      terminalReceiptSha256: null,
    };
  }
  return {
    platformKey,
    publicProviderReleaseId: head.publicProviderReleaseId,
    sharedConfigurationEpoch: head.completedHead.release.sharedConfigurationEpoch,
    providerCheckpoint: head.completedHead.providerCheckpoint,
    observation: head.completedHead.observation,
    terminalReceiptSha256: head.terminalReceiptSha256,
  };
}

function cycleResult(
  platformKey: string,
  outcome: ProviderPromotionCycleResult["outcome"],
  claim: ProviderPromotionClaim | null,
  operationsAcknowledged = 0,
  failureCode: string | null = null,
): ProviderPromotionCycleResult {
  return {
    outcome,
    platformKey,
    attemptId: claim?.attemptId ?? null,
    evaluationSequence: claim?.evaluationSequence ?? null,
    targetCheckpoint: claim?.checkpoint.settledSequence ?? null,
    operationsAcknowledged,
    failureCode,
  };
}

function cancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

const RECONCILIATION_LOSS_CODES = new Set([
  "PROVIDER_RELEASE_PREDECESSOR_CONFLICT",
  "PROVIDER_RELEASE_STATE_CONFLICT",
  "PROVIDER_RELEASE_RECONCILIATION_FAILED",
] as const);

type ProviderReconciliationLossCode =
  | "PROVIDER_RELEASE_PREDECESSOR_CONFLICT"
  | "PROVIDER_RELEASE_STATE_CONFLICT"
  | "PROVIDER_RELEASE_RECONCILIATION_FAILED";

function isReconciliationLoss(
  error: PublicationClientError,
): error is PublicationClientError & Readonly<{
  code: ProviderReconciliationLossCode;
  canonicalErrorResponseBody: string;
}> {
  return error.disposition === "terminal" && !error.ambiguous &&
    error.canonicalErrorResponseBody !== null &&
    RECONCILIATION_LOSS_CODES.has(error.code as ProviderReconciliationLossCode);
}

export class ProviderPromotionRunner {
  readonly #initialRetryMilliseconds: number;
  readonly #leaseMilliseconds: number;
  readonly #maximumOperationsPerCycle: number;
  readonly #maximumRetries: number;
  readonly #maximumRetryMilliseconds: number;
  readonly #random: Readonly<{ fraction(): number }>;
  #cycleInProgress = false;

  constructor(private readonly options: ProviderPromotionRunnerOptions) {
    if (!safeIdPattern.test(options.platformKey) ||
        !safeIdPattern.test(options.workerId)) {
      throw new RangeError("Provider promotion runner identity is invalid.");
    }
    this.#leaseMilliseconds = boundedInteger(
      options.leaseMilliseconds, 30_000, 5_000, 300_000,
    );
    this.#maximumOperationsPerCycle = boundedInteger(
      options.maximumOperationsPerCycle,
      MAX_PROVIDER_PROMOTION_OPERATIONS,
      1,
      MAX_PROVIDER_PROMOTION_OPERATIONS,
    );
    this.#maximumRetries = boundedInteger(options.maximumRetries, 8, 1, 20);
    this.#initialRetryMilliseconds = boundedInteger(
      options.initialRetryMilliseconds, 500, 100, 60_000,
    );
    this.#maximumRetryMilliseconds = boundedInteger(
      options.maximumRetryMilliseconds,
      30_000,
      this.#initialRetryMilliseconds,
      300_000,
    );
    this.#random = options.random ?? { fraction: () => Math.random() };
  }

  get platformKey(): string {
    return this.options.platformKey;
  }

  async runCycle(signal?: AbortSignal): Promise<ProviderPromotionCycleResult> {
    if (this.#cycleInProgress) {
      throw new Error("Provider promotion cycle is already running.");
    }
    this.#cycleInProgress = true;
    try {
      return await this.executeCycle(signal);
    } finally {
      try {
        if (!cancelled(signal)) await this.reportHealth();
      } finally {
        this.#cycleInProgress = false;
      }
    }
  }

  /** Reconciles already-dispatched exact work without enqueueing disabled lanes. */
  async runRecoveryCycle(
    signal?: AbortSignal,
  ): Promise<ProviderPromotionCycleResult> {
    if (this.#cycleInProgress) {
      throw new Error("Provider promotion cycle is already running.");
    }
    this.#cycleInProgress = true;
    try {
      return await this.executeRecoveryCycle(signal);
    } finally {
      try {
        if (!cancelled(signal)) await this.reportHealth();
      } finally {
        this.#cycleInProgress = false;
      }
    }
  }

  private async executeRecoveryCycle(
    signal: AbortSignal | undefined,
  ): Promise<ProviderPromotionCycleResult> {
    if (cancelled(signal)) {
      return cycleResult(this.options.platformKey, "stopped", null);
    }
    const now = this.options.clock.now();
    const claim = await this.options.lane.claim({
      workerId: this.options.workerId,
      now,
      leaseExpiresAt: this.leaseExpiresAt(now),
    });
    if (claim === null) {
      return cycleResult(this.options.platformKey, "idle", null);
    }
    if (claim.platformKey !== this.options.platformKey) {
      return await this.failTerminal(claim, "PROVIDER_CLAIM_SCOPE_INVALID");
    }
    if (claim.preparedSummary === null) {
      return await this.completeSuperseded(claim);
    }
    const operations = await this.options.lane.listOperations({
      attemptId: claim.attemptId,
    });
    if (!operations.some(({ sendCount }) => sendCount > 0)) {
      return await this.completeSuperseded(claim);
    }
    if (!(await this.heartbeat(claim))) {
      return cycleResult(this.options.platformKey, "lease_lost", claim);
    }
    if (!(await this.validPrepared(
      claim,
      claim.preparedSummary,
      operations,
    ))) return await this.failTerminal(claim, "PROVIDER_LEDGER_INVALID");
    return await this.executeOperations(
      claim,
      claim.preparedSummary,
      operations,
      signal,
    );
  }

  private async executeCycle(
    signal: AbortSignal | undefined,
  ): Promise<ProviderPromotionCycleResult> {
    if (cancelled(signal)) {
      return cycleResult(this.options.platformKey, "stopped", null);
    }
    const checkpoint = await this.options.checkpoints.getCheckpoint();
    if (checkpoint.platformKey !== this.options.platformKey) {
      throw new Error("Provider promotion checkpoint scope is invalid.");
    }
    const now = this.options.clock.now();
    await this.options.lane.enqueueEvaluation({
      checkpoint: {
        platformKey: checkpoint.platformKey,
        sharedConfigurationEpoch: checkpoint.sharedConfigurationEpoch,
        settledSequence: checkpoint.settledSequence,
        sourceHeadSequence: checkpoint.sourceHeadSequence,
        settledAt: checkpoint.settledAt,
        sourceHeadAt: checkpoint.sourceHeadAt,
        lastSuccessfulObservationAt:
          checkpoint.lastSuccessfulObservationAt,
        staleAt: checkpoint.staleAt,
        freshness: checkpoint.freshness,
        blockedState: checkpoint.blockedState,
      },
      requestedAt: now,
    });
    if (cancelled(signal)) {
      return cycleResult(this.options.platformKey, "stopped", null);
    }
    const claim = await this.options.lane.claim({
      workerId: this.options.workerId,
      now,
      leaseExpiresAt: this.leaseExpiresAt(now),
    });
    if (claim === null) {
      return cycleResult(this.options.platformKey, "idle", null);
    }
    if (claim.platformKey !== this.options.platformKey) {
      return await this.failTerminal(claim, "PROVIDER_CLAIM_SCOPE_INVALID");
    }
    if (cancelled(signal)) {
      return cycleResult(this.options.platformKey, "stopped", claim);
    }

    const latestCheckpoint = await this.options.checkpoints.getCheckpoint();
    let recoveredOperations: readonly ProviderPromotionOperationRecord[] | null =
      null;
    let resumeDispatchedAttempt = false;
    if (!sameCheckpoint(claim.checkpoint, latestCheckpoint)) {
      if (claim.preparedSummary !== null) {
        recoveredOperations = await this.options.lane.listOperations({
          attemptId: claim.attemptId,
        });
        resumeDispatchedAttempt = recoveredOperations.some(
          ({ sendCount }) => sendCount > 0,
        );
      }
      if (!resumeDispatchedAttempt) {
        await this.enqueueCheckpoint(latestCheckpoint);
        return await this.completeSuperseded(claim);
      }
    }
    const completedHead = await this.options.lane.loadCompletedHead();
    if (!resumeDispatchedAttempt && completedHead !== null &&
        claim.checkpoint.settledSequence <= completedHead.targetCheckpoint) {
      return await this.completeSuperseded(claim);
    }
    if (!(await this.heartbeat(claim))) {
      return cycleResult(this.options.platformKey, "lease_lost", claim);
    }

    let summary = claim.preparedSummary;
    let operations: readonly ProviderPromotionOperationRecord[] | null;
    if (summary === null) {
      let candidate;
      try {
        candidate = await this.options.assembler.assemble({
          trigger: completedHead === null ? "full_rebuild" : "settled_change",
        });
        candidate = await verifyProviderCatalogReleasePlanV1(candidate);
      } catch {
        return await this.retry(claim, "PROVIDER_ASSEMBLY_UNAVAILABLE", null);
      }
      if (cancelled(signal)) {
        return cycleResult(this.options.platformKey, "stopped", claim);
      }
      if (candidate.classification === "blocked") {
        return await this.failTerminal(
          claim,
          `PROVIDER_ASSEMBLY_${candidate.reason}`,
        );
      }
      if (candidate.platformKey !== this.options.platformKey ||
          canonicalJson(candidate.sharedConfigurationEpoch) !==
            canonicalJson({
              configurationKey:
                claim.checkpoint.sharedConfigurationEpoch.configurationKey,
              revision: claim.checkpoint.sharedConfigurationEpoch.revision,
              publicChangeSequence: String(
                claim.checkpoint.sharedConfigurationEpoch.publicChangeSequence,
              ),
              configurationHash:
                claim.checkpoint.sharedConfigurationEpoch.configurationHash,
            }) ||
          candidate.providerCheckpoint.settledSequence !==
            String(claim.checkpoint.settledSequence) ||
          candidate.providerCheckpoint.settledAt !==
            claim.checkpoint.settledAt?.toISOString() ||
          candidate.observation.sourceHeadSequence !==
            String(claim.checkpoint.sourceHeadSequence) ||
          candidate.observation.lastSuccessfulObservationAt !==
            claim.checkpoint.lastSuccessfulObservationAt.toISOString() ||
          candidate.observation.staleAt !== claim.checkpoint.staleAt.toISOString() ||
          candidate.observation.freshness !== claim.checkpoint.freshness) {
        const racedCheckpoint = await this.options.checkpoints.getCheckpoint();
        if (!sameCheckpoint(claim.checkpoint, racedCheckpoint)) {
          await this.enqueueCheckpoint(racedCheckpoint);
          return await this.completeSuperseded(claim);
        }
        // A structurally valid but wrong-scope assembler result is not proof
        // that this evaluation was superseded. Retain the exact claim for a
        // bounded technical retry unless the authoritative checkpoint itself
        // demonstrably advanced.
        return await this.retry(
          claim,
          "PROVIDER_ASSEMBLY_SCOPE_INVALID",
          null,
        );
      }
      let prepared;
      try {
        prepared = prepareProviderPromotion({
          plan: candidate,
          expectedCompletedHead: expectedCompletedHead(
            this.options.platformKey,
            completedHead,
          ),
          checkpointSha256: claim.checkpointSha256,
        });
      } catch (error) {
        return await this.failTerminal(
          claim,
          error instanceof ProviderPromotionPreparationError
            ? error.code
            : "PROVIDER_OPERATION_INVALID",
        );
      }
      summary = prepared.summary;
      operations = await this.options.lane.persistPreparedOperations({
        attemptId: claim.attemptId,
        claimToken: claim.claimToken,
        preparedAt: this.options.clock.now(),
        summary,
        operations: prepared.operations,
      });
      if (operations === null) {
        return cycleResult(this.options.platformKey, "lease_lost", claim);
      }
    } else {
      operations = recoveredOperations ??
        await this.options.lane.listOperations({ attemptId: claim.attemptId });
    }
    if (operations === null ||
        !(await this.validPrepared(claim, summary, operations))) {
      return await this.failTerminal(claim, "PROVIDER_LEDGER_INVALID");
    }
    return await this.executeOperations(claim, summary, operations, signal);
  }

  private async validPrepared(
    claim: ProviderPromotionClaim,
    summary: ProviderPromotionPreparedSummary,
    operations: readonly ProviderPromotionOperationRecord[],
  ): Promise<boolean> {
    if (
      summary.platformKey !== this.options.platformKey ||
      summary.checkpointSha256 !== claim.checkpointSha256 ||
      !/^[0-9a-f]{64}$/u.test(summary.checkpointSha256) ||
      summary.targetCheckpoint !== claim.checkpoint.settledSequence ||
      summary.operationCount !== operations.length ||
      operations.length === 0 ||
      (summary.classification === "reuse" &&
        (operations.length !== 1 ||
          operations[0]?.operationKind !== "confirmReuse")) ||
      (summary.classification === "publish" &&
        (operations[0]?.operationKind !== "start" ||
          operations.at(-1)?.operationKind !== "finalize" ||
          operations.slice(1, -1).some(
            ({ operationKind }) => operationKind !== "applyBatch",
          )))
    ) return false;
    let pendingSeen = false;
    for (const [index, operation] of operations.entries()) {
      if (
        operation.operationIndex !== index ||
        operation.sendCount < 0 ||
        !Number.isSafeInteger(operation.sendCount) ||
        (operation.state === "pending" && operation.sendCount !== 0) ||
        (operation.state === "sent" && operation.sendCount === 0) ||
        (operation.state === "acknowledged") !==
          (operation.canonicalReceiptBody !== null &&
            operation.receiptSha256 !== null) ||
        (operation.state !== "acknowledged" &&
          (operation.canonicalReceiptBody !== null ||
            operation.receiptSha256 !== null))
      ) return false;
      if (operation.state !== "acknowledged") pendingSeen = true;
      else if (pendingSeen) return false;
      try {
        parseProviderPromotionOperation(operation);
        if (operation.state === "acknowledged") {
          validateProviderPromotionReceipt({
            operation,
            receipt: JSON.parse(operation.canonicalReceiptBody!),
            canonicalReceiptBody: operation.canonicalReceiptBody!,
            receiptSha256: operation.receiptSha256!,
          });
        }
      } catch {
        return false;
      }
    }
    try {
      await reconstructVerifiedProviderPromotionPlan({ summary, operations });
      return true;
    } catch {
      return false;
    }
  }

  private async executeOperations(
    claim: ProviderPromotionClaim,
    summary: ProviderPromotionPreparedSummary,
    operations: readonly ProviderPromotionOperationRecord[],
    signal: AbortSignal | undefined,
  ): Promise<ProviderPromotionCycleResult> {
    let acknowledged = 0;
    for (const operation of operations) {
      if (operation.state === "acknowledged") continue;
      if (cancelled(signal)) {
        return cycleResult(
          this.options.platformKey,
          "stopped",
          claim,
          acknowledged,
        );
      }
      if (acknowledged >= this.#maximumOperationsPerCycle) {
        const continued = await this.options.lane.scheduleRetry({
          attemptId: claim.attemptId,
          claimToken: claim.claimToken,
          failureClass: "technical",
          failureCode: "PROVIDER_CYCLE_BOUNDED",
          failedAt: this.options.clock.now(),
          retryAt: new Date(this.options.clock.now().getTime() + 1),
        });
        return cycleResult(
          this.options.platformKey,
          continued ? "progressed" : "lease_lost",
          claim,
          acknowledged,
        );
      }
      if (!(await this.heartbeat(claim))) {
        return cycleResult(
          this.options.platformKey,
          "lease_lost",
          claim,
          acknowledged,
        );
      }
      try {
        let publication = null;
        if (operation.sendCount > 0) {
          const observed = await this.options.transport.status(
            providerPromotionStatusRequest(operation),
            signal,
          );
          if (observed.receipt.result !== "not_found") publication = observed;
        }
        if (publication === null) {
          const sent = await this.options.lane.markOperationSent({
            attemptId: claim.attemptId,
            claimToken: claim.claimToken,
            operationId: operation.operationId,
            sentAt: this.options.clock.now(),
          });
          if (!sent) {
            return cycleResult(
              this.options.platformKey,
              "lease_lost",
              claim,
              acknowledged,
            );
          }
          publication = await this.options.transport.sendExact({
            kind: operation.operationKind,
            canonicalRequestBody: operation.canonicalRequestBody,
          }, signal);
        }
        const receipt = validateProviderPromotionReceipt({
          operation,
          receipt: publication.receipt,
          canonicalReceiptBody: publication.canonicalReceiptBody,
          receiptSha256: publication.receiptSha256,
        });
        if (cancelled(signal)) {
          return cycleResult(
            this.options.platformKey,
            "stopped",
            claim,
            acknowledged,
          );
        }
        const stored = await this.options.lane.acknowledgeOperation({
          attemptId: claim.attemptId,
          claimToken: claim.claimToken,
          operationId: operation.operationId,
          evidence: {
            canonicalReceiptBody: publication.canonicalReceiptBody,
            ...(publication.exactResponseBody === undefined ? {} : {
              exactResponseBody: publication.exactResponseBody,
            }),
          },
          acknowledgedAt: this.options.clock.now(),
        });
        if (!stored) {
          return cycleResult(
            this.options.platformKey,
            "lease_lost",
            claim,
            acknowledged,
          );
        }
        void receipt;
        acknowledged += 1;
      } catch (error) {
        if (cancelled(signal)) {
          return cycleResult(
            this.options.platformKey,
            "stopped",
            claim,
            acknowledged,
          );
        }
        if (error instanceof PublicationClientError &&
            isReconciliationLoss(error)) {
          const recovered = await this.options.lane.recordReconciliationLoss({
            attemptId: claim.attemptId,
            claimToken: claim.claimToken,
            failureCode: error.code,
            canonicalErrorBody: error.canonicalErrorResponseBody,
            observedAt: this.options.clock.now(),
          });
          return cycleResult(
            this.options.platformKey,
            recovered === null ? "lease_lost" : "reconciliation_lost",
            claim,
            acknowledged,
            error.code,
          );
        }
        if (error instanceof PublicationClientError &&
            error.disposition === "terminal" && !error.ambiguous) {
          return await this.failTerminal(claim, error.code);
        }
        const code = error instanceof PublicationClientError
          ? error.code
          : error instanceof ProviderPromotionPreparationError
            ? error.code
            : "PUBLICATION_NETWORK_ERROR";
        return await this.retry(
          claim,
          code,
          error instanceof PublicationClientError
            ? error.retryAfterMilliseconds
            : null,
        );
      }
    }
    const completed = await this.options.lane.complete({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      outcome: summary.classification === "publish" ? "published" : "reused",
      completedAt: this.options.clock.now(),
    });
    return cycleResult(
      this.options.platformKey,
      completed
        ? (summary.classification === "publish" ? "published" : "reused")
        : "lease_lost",
      claim,
      acknowledged,
    );
  }

  private async completeSuperseded(
    claim: ProviderPromotionClaim,
  ): Promise<ProviderPromotionCycleResult> {
    const completed = await this.options.lane.complete({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      outcome: "superseded",
      completedAt: this.options.clock.now(),
    });
    return cycleResult(
      this.options.platformKey,
      completed ? "superseded" : "lease_lost",
      claim,
    );
  }

  private async retry(
    claim: ProviderPromotionClaim,
    failureCode: string,
    retryAfterMilliseconds: number | null,
  ): Promise<ProviderPromotionCycleResult> {
    const retryCount = claim.retryCount + 1;
    if (retryCount > this.#maximumRetries) {
      return await this.exhaustRetry(claim);
    }
    const delay = promotionRetryDelay({
      currentRetryCount: claim.retryCount,
      initialRetryMilliseconds: this.#initialRetryMilliseconds,
      maximumRetryMilliseconds: this.#maximumRetryMilliseconds,
      retryAfterMilliseconds,
      randomFraction: this.#random.fraction(),
    });
    const now = this.options.clock.now();
    const scheduled = await this.options.lane.scheduleRetry({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      failureClass: "technical",
      failureCode,
      failedAt: now,
      retryAt: new Date(now.getTime() + delay),
    });
    return cycleResult(
      this.options.platformKey,
      scheduled ? "retry_scheduled" : "lease_lost",
      claim,
      0,
      failureCode,
    );
  }

  private async exhaustRetry(
    claim: ProviderPromotionClaim,
  ): Promise<ProviderPromotionCycleResult> {
    const failureCode = "PROVIDER_RETRY_EXHAUSTED";
    const now = this.options.clock.now();
    const delay = promotionRetryDelay({
      currentRetryCount: claim.retryCount,
      initialRetryMilliseconds: this.#initialRetryMilliseconds,
      maximumRetryMilliseconds: this.#maximumRetryMilliseconds,
      retryAfterMilliseconds: null,
      randomFraction: this.#random.fraction(),
    });
    const recovery = await this.options.lane.recordRetryExhaustion({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      failedAt: now,
      retryAt: new Date(now.getTime() + delay),
      failureClass: "technical",
      failureCode,
    });
    if (recovery === null) {
      return cycleResult(
        this.options.platformKey, "lease_lost", claim, 0, failureCode,
      );
    }
    try {
      await this.options.alerts.notify({
        platformKey: this.options.platformKey,
        attemptId: claim.attemptId,
        evaluationSequence: claim.evaluationSequence,
        targetCheckpoint: claim.checkpoint.settledSequence,
        failureCode,
        occurredAt: now,
      });
    } catch {
      // Exhaustion is already durable; alert fan-out cannot alter recovery.
    }
    return cycleResult(
      this.options.platformKey,
      recovery.result === "status_required" ? "retry_scheduled" : "failed",
      claim,
      0,
      failureCode,
    );
  }

  private async failTerminal(
    claim: ProviderPromotionClaim,
    failureCode: string,
    failureClass: "technical" | "deterministic" | "reconciliation" | "bootstrap" =
      "deterministic",
  ): Promise<ProviderPromotionCycleResult> {
    const now = this.options.clock.now();
    const completed = await this.options.lane.complete({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      outcome: "failed",
      completedAt: now,
      failureClass,
      failureCode,
    });
    if (!completed) {
      return cycleResult(
        this.options.platformKey,
        "lease_lost",
        claim,
        0,
        failureCode,
      );
    }
    try {
      await this.options.alerts.notify({
        platformKey: this.options.platformKey,
        attemptId: claim.attemptId,
        evaluationSequence: claim.evaluationSequence,
        targetCheckpoint: claim.checkpoint.settledSequence,
        failureCode,
        occurredAt: now,
      });
    } catch {
      // The durable terminal state remains authoritative if alerting fails.
    }
    return cycleResult(
      this.options.platformKey,
      "failed",
      claim,
      0,
      failureCode,
    );
  }

  private heartbeat(claim: ProviderPromotionClaim): Promise<boolean> {
    const now = this.options.clock.now();
    return this.options.lane.heartbeat({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      heartbeatAt: now,
      leaseExpiresAt: this.leaseExpiresAt(now),
    });
  }

  private async enqueueCheckpoint(
    checkpoint: ProviderCatalogCheckpoint,
  ): Promise<void> {
    await this.options.lane.enqueueEvaluation({
      checkpoint: {
        platformKey: checkpoint.platformKey,
        sharedConfigurationEpoch: checkpoint.sharedConfigurationEpoch,
        settledSequence: checkpoint.settledSequence,
        sourceHeadSequence: checkpoint.sourceHeadSequence,
        settledAt: checkpoint.settledAt,
        sourceHeadAt: checkpoint.sourceHeadAt,
        lastSuccessfulObservationAt:
          checkpoint.lastSuccessfulObservationAt,
        staleAt: checkpoint.staleAt,
        freshness: checkpoint.freshness,
        blockedState: checkpoint.blockedState,
      },
      requestedAt: this.options.clock.now(),
    });
  }

  private async reportHealth(): Promise<void> {
    try {
      await this.options.health?.report(
        await this.options.lane.loadHealth({ now: this.options.clock.now() }),
      );
    } catch {
      // Health fan-out is best effort and never changes the durable lane result.
    }
  }

  private leaseExpiresAt(now: Date): Date {
    return new Date(now.getTime() + this.#leaseMilliseconds);
  }
}
