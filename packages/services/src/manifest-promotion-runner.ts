import { canonicalJson } from "@packscout/contracts";
import { PublicationClientError } from "./convex-publication-http-client.ts";
import {
  MANIFEST_PROMOTION_ACTIVE_STATE_REQUEST_BODY,
  ManifestPromotionPreparationError,
  manifestPromotionStatusRequest,
  parseManifestPromotionOperation,
  validateManifestPromotionReceipt,
} from "./manifest-promotion-operations.ts";
import {
  ManifestPromotionPlanningError,
  prepareManifestPromotion,
} from "./manifest-promotion-planner.ts";
import type {
  ManifestPromotionClaim,
  ManifestPromotionHealth,
  ManifestPromotionLanePort,
  ManifestPromotionOperationRecord,
  ManifestPromotionPreparedSummary,
  ManifestPromotionTransport,
  ManifestProviderPlanResolver,
} from "./manifest-promotion-types.ts";
import { promotionRetryDelay } from "./promotion-retry-policy.ts";

export type ManifestPromotionCycleResult = Readonly<{
  outcome:
    | "idle"
    | "activated"
    | "refreshed"
    | "cleared"
    | "no_change"
    | "cas_lost"
    | "retry_scheduled"
    | "failed"
    | "lease_lost"
    | "stopped";
  attemptId: string | null;
  evaluationSequence: bigint | null;
  operationKind: ManifestPromotionPreparedSummary["operationKind"] | null;
  failureCode: string | null;
}>;

export interface ManifestPromotionTriggerPort {
  loadEvaluationTrigger(): Promise<Readonly<{
    cause:
      | "lifecycle_settled"
      | "configuration_settled"
      | "observation_succeeded";
    causeIdentity: string;
  }> | null>;
}

export interface ManifestPromotionAlertSink {
  notify(input: Readonly<{
    attemptId: string;
    evaluationSequence: bigint;
    failureCode: string;
    occurredAt: Date;
  }>): Promise<void>;
}

export interface ManifestPromotionHealthSink {
  report(health: ManifestPromotionHealth): void | Promise<void>;
}

export interface ManifestPromotionRunnerOptions {
  readonly workerId: string;
  readonly lane: ManifestPromotionLanePort;
  readonly triggers: ManifestPromotionTriggerPort;
  readonly providerPlans: ManifestProviderPlanResolver;
  /** Publish-role credential: activate, refresh, active-state, and status. */
  readonly transport: ManifestPromotionTransport;
  /** Separately authorized clear-role credential. */
  readonly clearTransport?: Pick<ManifestPromotionTransport, "sendExact">;
  readonly clock: Readonly<{ now(): Date }>;
  readonly alerts: ManifestPromotionAlertSink;
  readonly health?: ManifestPromotionHealthSink;
  readonly random?: Readonly<{ fraction(): number }>;
  readonly leaseMilliseconds?: number;
  readonly maximumRetries?: number;
  readonly initialRetryMilliseconds?: number;
  readonly maximumRetryMilliseconds?: number;
}

const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError("Manifest promotion runner limit is invalid.");
  }
  return resolved;
}

function result(
  outcome: ManifestPromotionCycleResult["outcome"],
  claim: ManifestPromotionClaim | null,
  operationKind: ManifestPromotionPreparedSummary["operationKind"] | null =
    claim?.preparedSummary?.operationKind ?? null,
  failureCode: string | null = null,
): ManifestPromotionCycleResult {
  return {
    outcome,
    attemptId: claim?.attemptId ?? null,
    evaluationSequence: claim?.evaluationSequence ?? null,
    operationKind,
    failureCode,
  };
}

function cancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isCasLoss(error: PublicationClientError): boolean {
  return !error.ambiguous && error.disposition === "terminal" &&
    (error.code === "CATALOG_MANIFEST_PREDECESSOR_CONFLICT" ||
      error.code === "CATALOG_MANIFEST_STATE_CONFLICT");
}

export class ManifestPromotionRunner {
  readonly #initialRetryMilliseconds: number;
  readonly #leaseMilliseconds: number;
  readonly #maximumRetries: number;
  readonly #maximumRetryMilliseconds: number;
  readonly #random: Readonly<{ fraction(): number }>;
  #cycleInProgress = false;

  constructor(private readonly options: ManifestPromotionRunnerOptions) {
    if (!safeIdPattern.test(options.workerId)) {
      throw new RangeError("Manifest promotion runner identity is invalid.");
    }
    this.#leaseMilliseconds = boundedInteger(
      options.leaseMilliseconds, 30_000, 5_000, 300_000,
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

  async runCycle(signal?: AbortSignal): Promise<ManifestPromotionCycleResult> {
    if (this.#cycleInProgress) {
      throw new Error("Manifest promotion cycle is already running.");
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

  private async executeCycle(
    signal: AbortSignal | undefined,
  ): Promise<ManifestPromotionCycleResult> {
    if (cancelled(signal)) return result("stopped", null);
    const trigger = await this.options.triggers.loadEvaluationTrigger();
    const now = this.options.clock.now();
    if (trigger !== null) {
      if (!sha256Pattern.test(trigger.causeIdentity)) {
        throw new Error("Manifest promotion trigger proof is invalid.");
      }
      await this.options.lane.enqueueEvaluation({ ...trigger, requestedAt: now });
    }
    if (cancelled(signal)) return result("stopped", null);
    const claim = await this.options.lane.claim({
      workerId: this.options.workerId,
      now,
      leaseExpiresAt: this.leaseExpiresAt(now),
    });
    if (claim === null) return result("idle", null);
    if (cancelled(signal)) return result("stopped", claim);
    if (!(await this.heartbeat(claim))) return result("lease_lost", claim);
    if (claim.pendingCasLoss !== null) {
      return await this.reconcilePendingCasLoss(
        claim,
        claim.pendingCasLoss.canonicalErrorBody,
        claim.pendingCasLoss.failureCode,
        signal,
      );
    }

    let summary = claim.preparedSummary;
    let operation: ManifestPromotionOperationRecord | null;
    if (summary === null) {
      const snapshot = await this.options.lane.loadEvaluationSnapshot({
        attemptId: claim.attemptId,
        claimToken: claim.claimToken,
        now: this.options.clock.now(),
      });
      if (snapshot === null) return result("lease_lost", claim);
      if (snapshot.evaluationSequence !== claim.evaluationSequence) {
        return await this.failTerminal(
          claim,
          "MANIFEST_SNAPSHOT_SEQUENCE_INVALID",
          "reconciliation",
        );
      }
      let prepared;
      try {
        prepared = await prepareManifestPromotion({
          snapshot,
          providerPlans: this.options.providerPlans,
        });
      } catch (error) {
        if (error instanceof ManifestPromotionPlanningError) {
          return await this.failTerminal(claim, error.code);
        }
        // Artifact and database availability failures retain this exact
        // evaluation for retry. Only typed planning/content refusals confirm a
        // deterministic terminal outcome.
        return await this.retry(
          claim,
          "MANIFEST_ASSEMBLY_UNAVAILABLE",
          null,
        );
      }
      summary = prepared.summary;
      operation = await this.options.lane.persistPreparedOperation({
        attemptId: claim.attemptId,
        claimToken: claim.claimToken,
        preparedAt: this.options.clock.now(),
        summary,
        operation: prepared.operation,
      });
      if (prepared.operation !== null && operation === null) {
        return result("lease_lost", claim, summary.operationKind);
      }
      if (prepared.operation === null) {
        const completed = await this.options.lane.complete({
          attemptId: claim.attemptId,
          claimToken: claim.claimToken,
          outcome: "no_change",
          completedAt: this.options.clock.now(),
        });
        return result(
          completed ? "no_change" : "lease_lost",
          claim,
          "no_change",
        );
      }
    } else {
      const operations = await this.options.lane.listOperations({
        attemptId: claim.attemptId,
      });
      if (summary.operationKind === "no_change") {
        if (operations.length !== 0) {
          return await this.failTerminal(
            claim, "MANIFEST_LEDGER_INVALID", "reconciliation",
          );
        }
        const completed = await this.options.lane.complete({
          attemptId: claim.attemptId,
          claimToken: claim.claimToken,
          outcome: "no_change",
          completedAt: this.options.clock.now(),
        });
        return result(
          completed ? "no_change" : "lease_lost",
          claim,
          "no_change",
        );
      }
      operation = operations.length === 1 ? operations[0]! : null;
    }
    if (operation === null || !this.validPrepared(summary, operation)) {
      return await this.failTerminal(
        claim, "MANIFEST_LEDGER_INVALID", "reconciliation",
      );
    }
    if (operation.state === "acknowledged") {
      return await this.completeAcknowledged(claim, summary, operation);
    }
    return await this.executeOperation(claim, summary, operation, signal);
  }

  private validPrepared(
    summary: ManifestPromotionPreparedSummary,
    operation: ManifestPromotionOperationRecord,
  ): boolean {
    if (
      !sha256Pattern.test(summary.evaluationSnapshotSha256) ||
      operation.operationIndex !== 0 ||
      operation.operationKind !== summary.operationKind ||
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
    try {
      const request = parseManifestPromotionOperation(operation);
      if (
        canonicalJson(request.expectedActiveState) !==
          canonicalJson(summary.expectedActiveState)
      ) return false;
      if (operation.operationKind === "rollback") {
        if (!("rollbackKind" in request) || request.rollbackKind !== "clear" ||
            summary.manifestIdentity !== null ||
            summary.enabledPlatformKeys.length !== 0) return false;
      } else if (
        !("manifest" in request) || summary.manifestIdentity === null ||
        canonicalJson({
          publicReleaseId: request.manifest.publicReleaseId,
          manifestFingerprint: request.manifest.manifestFingerprint,
          sharedConfigurationEpoch: request.manifest.sharedConfigurationEpoch,
          providerReferenceSetHash: request.manifest.providerReferenceSetHash,
        }) !== canonicalJson(summary.manifestIdentity)
      ) return false;
      if (operation.state === "acknowledged") {
        validateManifestPromotionReceipt({
          operation,
          receipt: JSON.parse(operation.canonicalReceiptBody!),
          canonicalReceiptBody: operation.canonicalReceiptBody!,
          receiptSha256: operation.receiptSha256!,
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  private async executeOperation(
    claim: ManifestPromotionClaim,
    summary: ManifestPromotionPreparedSummary,
    operation: ManifestPromotionOperationRecord,
    signal: AbortSignal | undefined,
  ): Promise<ManifestPromotionCycleResult> {
    if (cancelled(signal)) return result("stopped", claim, summary.operationKind);
    if (!(await this.heartbeat(claim))) {
      return result("lease_lost", claim, summary.operationKind);
    }
    try {
      let publication = null;
      if (operation.sendCount > 0) {
        const observed = await this.options.transport.status(
          manifestPromotionStatusRequest(operation),
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
        if (!sent) return result("lease_lost", claim, summary.operationKind);
        const mutationTransport = operation.operationKind === "rollback"
          ? this.options.clearTransport
          : this.options.transport;
        if (mutationTransport === undefined) {
          return await this.failTerminal(
            claim, "MANIFEST_CLEAR_CREDENTIAL_MISSING", "bootstrap",
          );
        }
        publication = await mutationTransport.sendExact({
          kind: operation.operationKind,
          canonicalRequestBody: operation.canonicalRequestBody,
        }, signal);
      }
      validateManifestPromotionReceipt({
        operation,
        receipt: publication.receipt,
        canonicalReceiptBody: publication.canonicalReceiptBody,
        receiptSha256: publication.receiptSha256,
      });
      if (cancelled(signal)) return result("stopped", claim, summary.operationKind);
      const stored = await this.options.lane.acknowledgeOperation({
        attemptId: claim.attemptId,
        claimToken: claim.claimToken,
        operationId: operation.operationId,
        acknowledgedAt: this.options.clock.now(),
        evidence: {
          canonicalReceiptBody: publication.canonicalReceiptBody,
          exactResponseBody: publication.exactResponseBody,
        },
      });
      if (!stored) return result("lease_lost", claim, summary.operationKind);
      return await this.completeMutation(claim, summary.operationKind);
    } catch (error) {
      if (cancelled(signal)) return result("stopped", claim, summary.operationKind);
      if (error instanceof PublicationClientError && isCasLoss(error)) {
        if (error.canonicalErrorResponseBody === null) {
          return await this.failTerminal(
            claim, "MANIFEST_CAS_EVIDENCE_INVALID", "reconciliation",
          );
        }
        return await this.deferCasLoss(
          claim,
          error.canonicalErrorResponseBody,
          error.code,
          error.retryAfterMilliseconds,
        );
      }
      if (error instanceof PublicationClientError &&
          error.disposition === "terminal" && !error.ambiguous) {
        return await this.failTerminal(claim, error.code);
      }
      if (error instanceof ManifestPromotionPreparationError) {
        return await this.failTerminal(claim, error.code, "reconciliation");
      }
      return await this.retry(
        claim,
        error instanceof PublicationClientError
          ? error.code
          : "PUBLICATION_NETWORK_ERROR",
        error instanceof PublicationClientError
          ? error.retryAfterMilliseconds
          : null,
      );
    }
  }

  private async reconcilePendingCasLoss(
    claim: ManifestPromotionClaim,
    canonicalErrorBody: string,
    failureCode: string,
    signal: AbortSignal | undefined,
  ): Promise<ManifestPromotionCycleResult> {
    let active: Awaited<ReturnType<ManifestPromotionTransport["activeState"]>>;
    try {
      active = await this.options.transport.activeState(signal);
    } catch (activeError) {
      if (cancelled(signal)) {
        return result(
          "stopped",
          claim,
          claim.preparedSummary?.operationKind ?? null,
        );
      }
      return await this.deferCasLoss(
        claim,
        canonicalErrorBody,
        failureCode,
        activeError instanceof PublicationClientError
          ? activeError.retryAfterMilliseconds
          : null,
      );
    }
    // Persistence/proof conflicts are deterministic corruption, not probe
    // availability. Let them cross the worker's hard-refusal classifier rather
    // than repeatedly deferring a state that cannot reconcile.
    const recorded = await this.options.lane.recordCasLoss({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      canonicalErrorBody,
      observedAt: this.options.clock.now(),
      activeStateEvidence: {
        requestBody: MANIFEST_PROMOTION_ACTIVE_STATE_REQUEST_BODY,
        canonicalReceiptBody: active.canonicalReceiptBody,
        exactResponseBody: active.exactResponseBody,
      },
    });
    return result(
      recorded === null ? "lease_lost" : "cas_lost",
      claim,
      claim.preparedSummary?.operationKind ?? null,
    );
  }

  private async deferCasLoss(
    claim: ManifestPromotionClaim,
    canonicalErrorBody: string,
    failureCode: string,
    retryAfterMilliseconds: number | null,
  ): Promise<ManifestPromotionCycleResult> {
    const delay = promotionRetryDelay({
      currentRetryCount: claim.retryCount,
      initialRetryMilliseconds: this.#initialRetryMilliseconds,
      maximumRetryMilliseconds: this.#maximumRetryMilliseconds,
      retryAfterMilliseconds,
      randomFraction: this.#random.fraction(),
    });
    const now = this.options.clock.now();
    const deferred = await this.options.lane.deferCasLoss({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      canonicalErrorBody,
      observedAt: now,
      retryAt: new Date(now.getTime() + delay),
    });
    return result(
      deferred ? "retry_scheduled" : "lease_lost",
      claim,
      claim.preparedSummary?.operationKind ?? null,
      failureCode,
    );
  }

  private async completeAcknowledged(
    claim: ManifestPromotionClaim,
    summary: ManifestPromotionPreparedSummary,
    operation: ManifestPromotionOperationRecord,
  ): Promise<ManifestPromotionCycleResult> {
    try {
      validateManifestPromotionReceipt({
        operation,
        receipt: JSON.parse(operation.canonicalReceiptBody!),
        canonicalReceiptBody: operation.canonicalReceiptBody!,
        receiptSha256: operation.receiptSha256!,
      });
    } catch {
      return await this.failTerminal(
        claim, "MANIFEST_RECEIPT_INVALID", "reconciliation",
      );
    }
    return this.completeMutation(claim, summary.operationKind);
  }

  private async completeMutation(
    claim: ManifestPromotionClaim,
    operationKind: ManifestPromotionPreparedSummary["operationKind"],
  ): Promise<ManifestPromotionCycleResult> {
    const terminal = operationKind === "activateManifest"
      ? { outcome: "activated" as const, result: "activated" as const }
      : operationKind === "refreshActiveState"
        ? { outcome: "refreshed" as const, result: "refreshed" as const }
        : operationKind === "rollback"
          ? { outcome: "cleared" as const, result: "cleared" as const }
          : null;
    if (terminal === null) {
      return await this.failTerminal(
        claim, "MANIFEST_OPERATION_INVALID", "reconciliation",
      );
    }
    const completed = await this.options.lane.complete({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      outcome: terminal.outcome,
      completedAt: this.options.clock.now(),
    });
    return result(
      completed ? terminal.result : "lease_lost",
      claim,
      operationKind,
    );
  }

  private async retry(
    claim: ManifestPromotionClaim,
    failureCode: string,
    retryAfterMilliseconds: number | null,
    failureClass: "technical" | "reconciliation" = "technical",
  ): Promise<ManifestPromotionCycleResult> {
    if (claim.retryCount + 1 > this.#maximumRetries) {
      return await this.exhaustRetry(claim, failureClass);
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
      failureClass,
      failureCode,
      failedAt: now,
      retryAt: new Date(now.getTime() + delay),
    });
    return result(
      scheduled ? "retry_scheduled" : "lease_lost",
      claim,
      claim.preparedSummary?.operationKind ?? null,
      failureCode,
    );
  }

  private async exhaustRetry(
    claim: ManifestPromotionClaim,
    failureClass: "technical" | "reconciliation",
  ): Promise<ManifestPromotionCycleResult> {
    const failureCode = "MANIFEST_RETRY_EXHAUSTED";
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
      failureClass,
      failureCode,
    });
    if (recovery === null) {
      return result("lease_lost", claim, null, failureCode);
    }
    try {
      await this.options.alerts.notify({
        attemptId: claim.attemptId,
        evaluationSequence: claim.evaluationSequence,
        failureCode,
        occurredAt: now,
      });
    } catch {
      // Exhaustion is already durable; alert fan-out cannot alter recovery.
    }
    return result(
      recovery.result === "status_required" ? "retry_scheduled" : "failed",
      claim,
      claim.preparedSummary?.operationKind ?? null,
      failureCode,
    );
  }

  private async failTerminal(
    claim: ManifestPromotionClaim,
    failureCode: string,
    failureClass: "technical" | "deterministic" | "reconciliation" | "bootstrap" =
      "deterministic",
  ): Promise<ManifestPromotionCycleResult> {
    const now = this.options.clock.now();
    const completed = await this.options.lane.complete({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      outcome: "failed",
      completedAt: now,
      failureClass,
      failureCode,
    });
    if (!completed) return result("lease_lost", claim, null, failureCode);
    try {
      await this.options.alerts.notify({
        attemptId: claim.attemptId,
        evaluationSequence: claim.evaluationSequence,
        failureCode,
        occurredAt: now,
      });
    } catch {
      // Durable attempt state remains authoritative if alerting fails.
    }
    return result("failed", claim, claim.preparedSummary?.operationKind ?? null,
      failureCode);
  }

  private heartbeat(claim: ManifestPromotionClaim): Promise<boolean> {
    const now = this.options.clock.now();
    return this.options.lane.heartbeat({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      heartbeatAt: now,
      leaseExpiresAt: this.leaseExpiresAt(now),
    });
  }

  private async reportHealth(): Promise<void> {
    try {
      await this.options.health?.report(
        await this.options.lane.loadHealth({ now: this.options.clock.now() }),
      );
    } catch {
      // Health fan-out is best effort and cannot alter a durable cycle result.
    }
  }

  private leaseExpiresAt(now: Date): Date {
    return new Date(now.getTime() + this.#leaseMilliseconds);
  }
}
