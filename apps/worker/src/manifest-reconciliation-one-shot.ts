import { randomUUID } from "node:crypto";
import type {
  BeginPromotionJobInvocationInput,
  ManifestGateClaim,
  ManifestGateIntent,
  PromotionInvocationAttemptEvidence,
  PromotionInvocationOperationSummary,
  PromotionJobAdmission,
  PromotionJobDeliveryEnvelope,
  PromotionJobInvocation,
  PromotionInvocationTriggerRequest,
  PromotionWakeIntent,
  ReconcileInterruptedPromotionJobInvocationInput,
  RecordPromotionJobProgressInput,
  TerminalizePromotionJobInvocationInput,
} from "@packscout/database";
import { promotionJobSha256 } from "@packscout/database";
import type {
  IndependentManifestReconciliationResult,
} from "@packscout/services";

export const MANIFEST_RECONCILIATION_ONE_SHOT_MAXIMUM_MILLISECONDS = 50_000;
export const MANIFEST_RECONCILIATION_ONE_SHOT_MAXIMUM_ATTEMPTS = 25;

const SAFE_CODE_PATTERN = /^[A-Z0-9_]{1,128}$/u;

export interface ManifestReconciliationJobLedgerPort {
  beginOrRecoverInvocation(
    input: BeginPromotionJobInvocationInput,
  ): Promise<PromotionJobAdmission>;
  loadWakeIntent(): Promise<PromotionWakeIntent>;
  recordProgress(
    input: RecordPromotionJobProgressInput,
  ): Promise<PromotionJobInvocation>;
  terminalize(
    input: TerminalizePromotionJobInvocationInput,
  ): Promise<PromotionJobInvocation>;
  reconcileInterrupted(
    input: ReconcileInterruptedPromotionJobInvocationInput,
  ): Promise<PromotionJobInvocation>;
}

export interface ManifestGateQueuePort {
  claimNext(input: Readonly<{
    owner: string;
    now: Date;
    claimMilliseconds: number;
  }>): Promise<ManifestGateClaim | null>;
  acknowledgeClaim(input: Readonly<{
    providerId: string;
    claimToken: string;
    observedGeneration: bigint;
    acknowledgedAt: Date;
  }>): Promise<ManifestGateIntent>;
  deferClaim(input: Readonly<{
    providerId: string;
    claimToken: string;
    observedGeneration: bigint;
    failureCode: string;
    observedAt: Date;
    retryAt: Date;
  }>): Promise<ManifestGateIntent>;
  hasPending(): Promise<boolean>;
}

export interface IndependentManifestReconciliationWorkPort {
  reconcile(input: Readonly<{
    claim: ManifestGateClaim;
    attemptId: string;
    signal?: AbortSignal;
  }>): Promise<IndependentManifestReconciliationResult>;
}

export type ManifestReconciliationOneShotResult =
  | Readonly<{ state: "terminal"; invocation: PromotionJobInvocation }>
  | Readonly<{
      state: "existing" | "existing_pruned";
      invocation: PromotionJobInvocation | null;
    }>
  | Readonly<{
      state: "reconciled_interruption";
      invocation: PromotionJobInvocation;
    }>;

export interface ManifestReconciliationOneShotRequest {
  readonly delivery: PromotionJobDeliveryEnvelope;
  readonly trigger: PromotionInvocationTriggerRequest;
  readonly requestedAt: Date;
  readonly signal?: AbortSignal;
}

interface DeadlineResources {
  readonly signal: AbortSignal;
  readonly deadlineExpired: () => boolean;
  readonly dispose: () => void;
}

function safeFailureCode(error: unknown, fallback: string): string {
  if (
    error !== null && typeof error === "object" && "code" in error &&
    typeof error.code === "string" && SAFE_CODE_PATTERN.test(error.code)
  ) return error.code;
  return fallback;
}

function deadlineResources(input: Readonly<{
  durationMilliseconds: number;
  externalSignal?: AbortSignal;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
}>): DeadlineResources {
  const controller = new AbortController();
  let expired = false;
  const expire = () => {
    expired = true;
    controller.abort(new Error("manifest reconciliation deadline reached"));
  };
  const cancel = () => controller.abort(input.externalSignal?.reason);
  const timer = input.setTimer(expire, input.durationMilliseconds);
  if (input.externalSignal?.aborted === true) cancel();
  else input.externalSignal?.addEventListener("abort", cancel, { once: true });
  return {
    signal: controller.signal,
    deadlineExpired: () => expired,
    dispose() {
      input.clearTimer(timer);
      input.externalSignal?.removeEventListener("abort", cancel);
    },
  };
}

function operationSummary(
  observation: IndependentManifestReconciliationResult,
  observedAt: Date,
): PromotionInvocationOperationSummary | null {
  if (observation.operationId === null || observation.requestDigest === null) {
    return null;
  }
  const acknowledged = observation.disposition === "activated" ||
    observation.disposition === "recovered";
  return {
    operationIndex: 0,
    operationKind: observation.semanticOperation ?? "manifest_reconciliation",
    state: acknowledged
      ? "acknowledged"
      : observation.disposition === "deferred" ||
          observation.disposition === "cas_lost"
        ? "sent"
        : "pending",
    sendCount: acknowledged || observation.disposition === "deferred" ||
        observation.disposition === "cas_lost"
      ? 1
      : 0,
    sentAt: acknowledged || observation.disposition === "deferred" ||
        observation.disposition === "cas_lost"
      ? observedAt
      : null,
    acknowledgedAt: acknowledged ? observedAt : null,
    operationIdDigest: promotionJobSha256(observation.operationId),
    requestDigest: observation.requestDigest,
    receiptDigest: observation.receiptDigest,
  };
}

function attemptEvidence(input: Readonly<{
  claim: ManifestGateClaim;
  attemptId: string;
  retryCount: number;
  observation: IndependentManifestReconciliationResult;
  observedAt: Date;
}>): PromotionInvocationAttemptEvidence {
  const operation = operationSummary(input.observation, input.observedAt);
  const recentOperations = operation === null ? [] : [operation];
  return {
    attemptKind: "manifest",
    attemptId: input.attemptId,
    observedState: input.observation.disposition,
    targetPosition: input.claim.observedGeneration,
    retryCount: input.retryCount,
    safeFailureCode: input.observation.failureCode,
    publicReleaseId: input.observation.publicReleaseId,
    releaseFingerprint: input.observation.manifestFingerprint,
    totalOperationCount: input.observation.operationCount,
    orderedOperationDigest: promotionJobSha256(JSON.stringify(
      recentOperations.map((item) => ({
        operationKind: item.operationKind,
        operationIdDigest: item.operationIdDigest,
        requestDigest: item.requestDigest,
        receiptDigest: item.receiptDigest,
      })),
    )),
    recentOperations,
    observedAt: input.observedAt,
  };
}

/**
 * One bounded central invocation. Each loop iteration claims one provider gate;
 * deferral is written back before the next fair claim so one unavailable
 * provider cannot prevent an independent provider from advancing.
 */
export class ManifestReconciliationOneShot {
  readonly #maximumMilliseconds: number;
  readonly #maximumAttempts: number;
  readonly #now: () => Date;
  readonly #randomUuid: () => string;
  readonly #setTimer: typeof setTimeout;
  readonly #clearTimer: typeof clearTimeout;

  constructor(private readonly dependencies: Readonly<{
    workerId: string;
    ledger: ManifestReconciliationJobLedgerPort;
    gates: ManifestGateQueuePort;
    work: IndependentManifestReconciliationWorkPort;
    maximumMilliseconds?: number;
    maximumAttempts?: number;
    now?: () => Date;
    randomUuid?: () => string;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
  }>) {
    this.#maximumMilliseconds = dependencies.maximumMilliseconds ??
      MANIFEST_RECONCILIATION_ONE_SHOT_MAXIMUM_MILLISECONDS;
    this.#maximumAttempts = dependencies.maximumAttempts ??
      MANIFEST_RECONCILIATION_ONE_SHOT_MAXIMUM_ATTEMPTS;
    this.#now = dependencies.now ?? (() => new Date());
    this.#randomUuid = dependencies.randomUuid ?? randomUUID;
    this.#setTimer = dependencies.setTimer ?? setTimeout;
    this.#clearTimer = dependencies.clearTimer ?? clearTimeout;
    if (
      dependencies.workerId.length === 0 ||
      !Number.isSafeInteger(this.#maximumMilliseconds) ||
      this.#maximumMilliseconds < 1 ||
      this.#maximumMilliseconds >
        MANIFEST_RECONCILIATION_ONE_SHOT_MAXIMUM_MILLISECONDS ||
      !Number.isSafeInteger(this.#maximumAttempts) ||
      this.#maximumAttempts < 1 ||
      this.#maximumAttempts > MANIFEST_RECONCILIATION_ONE_SHOT_MAXIMUM_ATTEMPTS
    ) throw new RangeError("Manifest reconciliation one-shot bounds are invalid.");
  }

  async run(
    request: ManifestReconciliationOneShotRequest,
  ): Promise<ManifestReconciliationOneShotResult> {
    const deadline = deadlineResources({
      durationMilliseconds: this.#maximumMilliseconds,
      externalSignal: request.signal,
      setTimer: this.#setTimer,
      clearTimer: this.#clearTimer,
    });
    const startedAt = this.#now();
    const ownershipToken = this.#randomUuid();
    try {
      const admission = await this.dependencies.ledger.beginOrRecoverInvocation({
        delivery: request.delivery,
        trigger: request.trigger,
        now: startedAt,
        requestedAt: request.requestedAt,
        startedAt,
        ownershipKey: this.dependencies.workerId,
        ownershipToken,
        ownershipExpiresAt: new Date(
          startedAt.getTime() + this.#maximumMilliseconds + 10_000,
        ),
      });
      if (admission.disposition !== "started") {
        return this.handleExisting(admission, startedAt);
      }
      if (admission.invocation === null) {
        throw new Error("Started manifest invocation is missing.");
      }
      return await this.executeAdmitted({
        invocation: admission.invocation,
        ownershipToken,
        deadline,
      });
    } finally {
      deadline.dispose();
    }
  }

  private async handleExisting(
    admission: PromotionJobAdmission,
    now: Date,
  ): Promise<ManifestReconciliationOneShotResult> {
    const invocation = admission.invocation;
    if (
      invocation?.lifecycleState === "running" &&
      invocation.ownershipExpiresAt !== null &&
      invocation.ownershipExpiresAt.getTime() <= now.getTime()
    ) {
      const reconciled = await this.dependencies.ledger.reconcileInterrupted({
        runId: invocation.runId,
        reconciledAt: now,
        resolution: "continuation_required",
        safeFailureCode: "MANIFEST_RECONCILIATION_INTERRUPTED",
        continuation: {
          requestedGeneration:
            (invocation.trigger.observedWakeGeneration ?? 0n) + 1n,
          requestedAt: now,
        },
        retentionProtected: true,
      });
      return { state: "reconciled_interruption", invocation: reconciled };
    }
    return {
      state: admission.disposition === "existing"
        ? "existing"
        : "existing_pruned",
      invocation,
    };
  }

  private async executeAdmitted(input: Readonly<{
    invocation: PromotionJobInvocation;
    ownershipToken: string;
    deadline: DeadlineResources;
  }>): Promise<ManifestReconciliationOneShotResult> {
    const attempts: PromotionInvocationAttemptEvidence[] = [];
    let publicationCount = 0;
    let operationCount = 0;
    let activeGeneration: bigint | null = null;
    let publicReleaseId: string | null = null;
    let manifestFingerprint: string | null = null;

    while (attempts.length < this.#maximumAttempts) {
      if (input.deadline.signal.aborted) {
        return this.continueInvocation(
          input,
          input.deadline.deadlineExpired()
            ? "MANIFEST_RECONCILIATION_DEADLINE"
            : "MANIFEST_RECONCILIATION_CANCELLED",
          { activeGeneration, publicReleaseId, manifestFingerprint },
        );
      }
      let claim: ManifestGateClaim | null;
      try {
        claim = await this.dependencies.gates.claimNext({
          owner: `${this.dependencies.workerId}:${input.invocation.runId}`,
          now: this.#now(),
          claimMilliseconds: this.#maximumMilliseconds + 10_000,
        });
      } catch (error) {
        return this.continueInvocation(
          input,
          safeFailureCode(error, "MANIFEST_GATE_CLAIM_FAILED"),
          { activeGeneration, publicReleaseId, manifestFingerprint },
        );
      }
      if (claim === null) {
        const pending = await this.dependencies.gates.hasPending().catch(
          () => true,
        );
        if (pending) {
          return this.continueInvocation(
            input,
            "MANIFEST_GATE_RETRY_PENDING",
            { activeGeneration, publicReleaseId, manifestFingerprint },
          );
        }
        return this.terminalize(input, {
          outcome: input.invocation.trigger.kind === "reconciliation_cron"
            ? "no_change"
            : "caught_up",
          failureCode: null,
          acknowledgeObservedWake: true,
          activeGeneration,
          publicReleaseId,
          manifestFingerprint,
        });
      }

      const attemptId = this.#randomUuid();
      let observation: IndependentManifestReconciliationResult;
      try {
        observation = await this.dependencies.work.reconcile({
          claim,
          attemptId,
          signal: input.deadline.signal,
        });
      } catch (error) {
        observation = {
          disposition: "deferred",
          semanticOperation: claim.requestedOperation,
          operationId: null,
          requestDigest: null,
          receiptDigest: null,
          activeGeneration: activeGeneration ?? 0n,
          publicReleaseId,
          manifestFingerprint,
          failureCode: safeFailureCode(
            error,
            "MANIFEST_RECONCILIATION_ATTEMPT_FAILED",
          ),
          publicationCount: 0,
          operationCount: 0,
        };
      }
      const observedAt = this.#now();
      activeGeneration = activeGeneration === null ||
          observation.activeGeneration > activeGeneration
        ? observation.activeGeneration
        : activeGeneration;
      if (
        observation.activeGeneration === activeGeneration &&
        observation.publicReleaseId !== null &&
        observation.manifestFingerprint !== null
      ) {
        publicReleaseId = observation.publicReleaseId;
        manifestFingerprint = observation.manifestFingerprint;
      }
      publicationCount += observation.publicationCount;
      operationCount += observation.operationCount;
      attempts.push(attemptEvidence({
        claim,
        attemptId,
        retryCount: attempts.length,
        observation,
        observedAt,
      }));

      let gateFailure: string | null = null;
      try {
        if (
          observation.disposition === "activated" ||
          observation.disposition === "recovered" ||
          observation.disposition === "no_change"
        ) {
          await this.dependencies.gates.acknowledgeClaim({
            providerId: claim.providerId,
            claimToken: claim.claimToken,
            observedGeneration: claim.observedGeneration,
            acknowledgedAt: observedAt,
          });
        } else {
          const failureCode = observation.failureCode ??
            (observation.disposition === "cas_lost"
              ? "MANIFEST_ACTIVATION_CAS_LOST"
              : observation.disposition === "blocked"
                ? "MANIFEST_RECONCILIATION_BLOCKED"
                : "MANIFEST_RECONCILIATION_DEFERRED");
          await this.dependencies.gates.deferClaim({
            providerId: claim.providerId,
            claimToken: claim.claimToken,
            observedGeneration: claim.observedGeneration,
            failureCode,
            observedAt,
            retryAt: new Date(observedAt.getTime() +
              (observation.disposition === "blocked" ? 60_000 : 1_000)),
          });
        }
      } catch (error) {
        gateFailure = safeFailureCode(error, "MANIFEST_GATE_CLAIM_STALE");
      }

      await this.dependencies.ledger.recordProgress({
        runId: input.invocation.runId,
        ownershipToken: input.ownershipToken,
        now: observedAt,
        progress: {
          beforeLanePosition: null,
          afterLanePosition: null,
          beforeSettledPosition: null,
          afterSettledPosition: null,
          cycleCount: attempts.length,
          promotionAttemptCount: attempts.length,
          publicationCount,
          operationCount,
        },
        attempts,
        retentionProtected: true,
      });
      if (gateFailure !== null) {
        return this.continueInvocation(input, gateFailure, {
          activeGeneration,
          publicReleaseId,
          manifestFingerprint,
        });
      }
    }
    return this.continueInvocation(input, "MANIFEST_RECONCILIATION_ATTEMPT_LIMIT", {
      activeGeneration,
      publicReleaseId,
      manifestFingerprint,
    });
  }

  private async continueInvocation(
    input: Readonly<{
      invocation: PromotionJobInvocation;
      ownershipToken: string;
    }>,
    failureCode: string,
    state: Readonly<{
      activeGeneration: bigint | null;
      publicReleaseId: string | null;
      manifestFingerprint: string | null;
    }>,
  ): Promise<ManifestReconciliationOneShotResult> {
    const finishedAt = this.#now();
    const wake = await this.dependencies.ledger.loadWakeIntent();
    const observed = input.invocation.trigger.observedWakeGeneration ?? 0n;
    const requestedGeneration =
      (wake.requestedGeneration > observed
        ? wake.requestedGeneration
        : observed) + 1n;
    const invocation = await this.dependencies.ledger.terminalize({
      runId: input.invocation.runId,
      ownershipToken: input.ownershipToken,
      finishedAt,
      outcome: "continuation_required",
      safeFailureCode: failureCode,
      acknowledgeObservedWake: false,
      continuation: { requestedGeneration, requestedAt: finishedAt },
      resultActiveGeneration: state.activeGeneration,
      resultPublicReleaseId: state.publicReleaseId,
      resultReleaseFingerprint: state.manifestFingerprint,
      retentionProtected: true,
    });
    return { state: "terminal", invocation };
  }

  private async terminalize(
    input: Readonly<{
      invocation: PromotionJobInvocation;
      ownershipToken: string;
    }>,
    options: Readonly<{
      outcome: "caught_up" | "no_change";
      failureCode: string | null;
      acknowledgeObservedWake: boolean;
      activeGeneration: bigint | null;
      publicReleaseId: string | null;
      manifestFingerprint: string | null;
    }>,
  ): Promise<ManifestReconciliationOneShotResult> {
    const invocation = await this.dependencies.ledger.terminalize({
      runId: input.invocation.runId,
      ownershipToken: input.ownershipToken,
      finishedAt: this.#now(),
      outcome: options.outcome,
      safeFailureCode: options.failureCode,
      acknowledgeObservedWake: options.acknowledgeObservedWake,
      resultActiveGeneration: options.activeGeneration,
      resultPublicReleaseId: options.publicReleaseId,
      resultReleaseFingerprint: options.manifestFingerprint,
      retentionProtected: options.activeGeneration !== null,
    });
    return { state: "terminal", invocation };
  }
}
