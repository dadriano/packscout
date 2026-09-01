import { randomUUID } from "node:crypto";
import type {
  BeginPromotionJobInvocationInput,
  PromotionInvocationAttemptEvidence,
  PromotionInvocationOperationSummary,
  PromotionJobAdmission,
  PromotionJobDeliveryEnvelope,
  PromotionJobInvocation,
  PromotionJobProgress,
  PromotionInvocationTriggerRequest,
  PromotionWakeIntent,
  ReconcileInterruptedPromotionJobInvocationInput,
  RecordPromotionJobProgressInput,
  TerminalizePromotionJobInvocationInput,
} from "@packscout/database";
import { promotionJobSha256 } from "@packscout/database";

export const PROVIDER_PROMOTION_ONE_SHOT_MAXIMUM_MILLISECONDS = 50_000;
export const PROVIDER_PROMOTION_ONE_SHOT_MAXIMUM_ATTEMPTS = 25;

const SAFE_CODE_PATTERN = /^[A-Z0-9_]{1,128}$/u;

export interface ProviderPromotionBoundary {
  readonly providerId: string;
  readonly providerKey: string;
  /** Latest provider-local canonical change position available to publish. */
  readonly lanePosition: bigint;
  /** Latest position confirmed by an exact terminal Convex receipt. */
  readonly settledPosition: bigint;
}

export interface ProviderPromotionAttemptObservation {
  readonly disposition:
    | "completed"
    | "retryable_failure"
    | "overlap"
    | "blocked";
  readonly observedState: string;
  readonly confirmedPosition: bigint | null;
  readonly safeFailureCode: string | null;
  readonly publicReleaseId: string | null;
  readonly releaseFingerprint: string | null;
  readonly totalOperationCount: number;
  readonly orderedOperationDigest: string;
  readonly recentOperations: readonly PromotionInvocationOperationSummary[];
}

export interface ProviderPromotionJobWorkPort {
  readBoundary(signal?: AbortSignal): Promise<ProviderPromotionBoundary>;
  attempt(input: Readonly<{
    runId: string;
    attemptId: string;
    targetPosition: bigint;
    retryCount: number;
    signal: AbortSignal;
  }>): Promise<ProviderPromotionAttemptObservation>;
}

export interface ProviderPromotionJobLedgerPort {
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

export type ProviderPromotionOneShotResult =
  | Readonly<{
      state: "terminal";
      invocation: PromotionJobInvocation;
    }>
  | Readonly<{
      state: "existing" | "existing_pruned";
      invocation: PromotionJobInvocation | null;
    }>
  | Readonly<{
      state: "reconciled_interruption";
      invocation: PromotionJobInvocation;
    }>;

export interface ProviderPromotionOneShotRequest {
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
    error !== null
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    && SAFE_CODE_PATTERN.test(error.code)
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
    controller.abort(new Error("provider promotion deadline reached"));
  };
  const cancel = () => {
    controller.abort(input.externalSignal?.reason);
  };
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

function validBoundary(
  value: ProviderPromotionBoundary,
  expectedProviderId: string,
): boolean {
  return value.providerId.toLowerCase() === expectedProviderId.toLowerCase()
    && value.providerKey.length > 0
    && value.lanePosition >= 0n
    && value.settledPosition >= 0n
    && value.settledPosition <= value.lanePosition;
}

function emptyAttempt(
  failureCode: string,
): ProviderPromotionAttemptObservation {
  return {
    disposition: "retryable_failure",
    observedState: "failed",
    confirmedPosition: null,
    safeFailureCode: failureCode,
    publicReleaseId: null,
    releaseFingerprint: null,
    totalOperationCount: 0,
    orderedOperationDigest: promotionJobSha256(""),
    recentOperations: [],
  };
}

function attemptEvidence(input: Readonly<{
  attemptId: string;
  targetPosition: bigint;
  retryCount: number;
  observation: ProviderPromotionAttemptObservation;
  observedAt: Date;
}>): PromotionInvocationAttemptEvidence {
  return {
    attemptKind: "provider",
    attemptId: input.attemptId,
    observedState: input.observation.observedState,
    targetPosition: input.targetPosition,
    retryCount: input.retryCount,
    safeFailureCode: input.observation.safeFailureCode,
    publicReleaseId: input.observation.publicReleaseId,
    releaseFingerprint: input.observation.releaseFingerprint,
    totalOperationCount: input.observation.totalOperationCount,
    orderedOperationDigest: input.observation.orderedOperationDigest,
    recentOperations: input.observation.recentOperations,
    observedAt: input.observedAt,
  };
}

/**
 * Runs exactly one provider authority through one durable admission path.
 * Trigger kind affects admission evidence only; all admitted work follows the
 * same receipt-gated publication loop.
 */
export class ProviderPromotionOneShot {
  readonly #maximumMilliseconds: number;
  readonly #maximumAttempts: number;
  readonly #now: () => Date;
  readonly #randomUuid: () => string;
  readonly #setTimer: typeof setTimeout;
  readonly #clearTimer: typeof clearTimeout;

  constructor(private readonly dependencies: Readonly<{
    providerId: string;
    workerId: string;
    ledger: ProviderPromotionJobLedgerPort;
    work: ProviderPromotionJobWorkPort;
    maximumMilliseconds?: number;
    maximumAttempts?: number;
    now?: () => Date;
    randomUuid?: () => string;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
  }>) {
    this.#maximumMilliseconds = dependencies.maximumMilliseconds
      ?? PROVIDER_PROMOTION_ONE_SHOT_MAXIMUM_MILLISECONDS;
    this.#maximumAttempts = dependencies.maximumAttempts
      ?? PROVIDER_PROMOTION_ONE_SHOT_MAXIMUM_ATTEMPTS;
    this.#now = dependencies.now ?? (() => new Date());
    this.#randomUuid = dependencies.randomUuid ?? randomUUID;
    this.#setTimer = dependencies.setTimer ?? setTimeout;
    this.#clearTimer = dependencies.clearTimer ?? clearTimeout;
    if (
      !Number.isSafeInteger(this.#maximumMilliseconds)
      || this.#maximumMilliseconds < 1
      || this.#maximumMilliseconds >
        PROVIDER_PROMOTION_ONE_SHOT_MAXIMUM_MILLISECONDS
      || !Number.isSafeInteger(this.#maximumAttempts)
      || this.#maximumAttempts < 1
      || this.#maximumAttempts > PROVIDER_PROMOTION_ONE_SHOT_MAXIMUM_ATTEMPTS
      || dependencies.providerId.length === 0
      || dependencies.workerId.length === 0
    ) throw new RangeError("Provider promotion one-shot bounds are invalid.");
  }

  async run(
    request: ProviderPromotionOneShotRequest,
  ): Promise<ProviderPromotionOneShotResult> {
    const deadline = deadlineResources({
      durationMilliseconds: this.#maximumMilliseconds,
      externalSignal: request.signal,
      setTimer: this.#setTimer,
      clearTimer: this.#clearTimer,
    });
    const startedAt = this.#now();
    const ownershipToken = this.#randomUuid();
    try {
      const admission = await this.dependencies.ledger
        .beginOrRecoverInvocation({
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
        return await this.handleExisting(admission, startedAt);
      }
      const invocation = admission.invocation;
      if (invocation === null) {
        throw new Error("Started provider promotion invocation is missing.");
      }
      return await this.executeAdmitted({
        invocation,
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
  ): Promise<ProviderPromotionOneShotResult> {
    const invocation = admission.invocation;
    if (
      invocation?.lifecycleState === "running"
      && invocation.ownershipExpiresAt !== null
      && invocation.ownershipExpiresAt.getTime() <= now.getTime()
    ) {
      const reconciled = await this.dependencies.ledger.reconcileInterrupted({
        runId: invocation.runId,
        reconciledAt: now,
        resolution: "continuation_required",
        safeFailureCode: "PROVIDER_PROMOTION_INTERRUPTED",
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
  }>): Promise<ProviderPromotionOneShotResult> {
    if (input.deadline.signal.aborted) {
      return this.continueInvocation(
        input,
        input.deadline.deadlineExpired()
          ? "PROVIDER_PROMOTION_DEADLINE"
          : "PROVIDER_PROMOTION_CANCELLED",
      );
    }
    let boundary: ProviderPromotionBoundary;
    try {
      boundary = await this.dependencies.work.readBoundary(
        input.deadline.signal,
      );
    } catch (error) {
      return this.continueInvocation(
        input,
        safeFailureCode(error, "PROVIDER_PROMOTION_FIRST_READ_FAILED"),
      );
    }
    if (!validBoundary(boundary, this.dependencies.providerId)) {
      return this.terminalize(input, "blocked", {
        failureCode: "PROVIDER_PROMOTION_BOUNDARY_INVALID",
        acknowledgeObservedWake: false,
      });
    }

    const attempts: PromotionInvocationAttemptEvidence[] = [];
    const initialLanePosition = boundary.lanePosition;
    const initialSettledPosition = boundary.settledPosition;
    let publicationCount = 0;
    let operationCount = 0;
    await this.recordProgress(input, boundary, {
      attempts,
      initialLanePosition,
      initialSettledPosition,
      publicationCount,
      operationCount,
    });

    if (boundary.settledPosition === boundary.lanePosition) {
      return this.terminalize(
        input,
        input.invocation.trigger.kind === "reconciliation_cron"
          ? "no_change"
          : "caught_up",
        { failureCode: null, acknowledgeObservedWake: true },
      );
    }

    while (attempts.length < this.#maximumAttempts) {
      if (input.deadline.signal.aborted) {
        return this.continueInvocation(
          input,
          input.deadline.deadlineExpired()
            ? "PROVIDER_PROMOTION_DEADLINE"
            : "PROVIDER_PROMOTION_CANCELLED",
        );
      }
      const attemptId = this.#randomUuid();
      const targetPosition = boundary.lanePosition;
      let observation: ProviderPromotionAttemptObservation;
      try {
        observation = await this.dependencies.work.attempt({
          runId: input.invocation.runId,
          attemptId,
          targetPosition,
          retryCount: attempts.length,
          signal: input.deadline.signal,
        });
      } catch (error) {
        observation = emptyAttempt(safeFailureCode(
          error,
          "PROVIDER_PROMOTION_ATTEMPT_FAILED",
        ));
      }
      const retryCount = attempts.length;
      attempts.push(attemptEvidence({
        attemptId,
        targetPosition,
        retryCount,
        observation,
        observedAt: this.#now(),
      }));
      operationCount += observation.totalOperationCount;
      if (observation.disposition === "completed") {
        publicationCount += 1;
        const confirmed = observation.confirmedPosition;
        if (confirmed === null || confirmed < targetPosition) {
          await this.recordProgress(input, boundary, {
            attempts,
            initialLanePosition,
            initialSettledPosition,
            publicationCount,
            operationCount,
          });
          return this.terminalize(input, "blocked", {
            failureCode: "PROVIDER_PROMOTION_RECEIPT_POSITION_INVALID",
            acknowledgeObservedWake: false,
          });
        }
        boundary = {
          ...boundary,
          lanePosition: boundary.lanePosition > confirmed
            ? boundary.lanePosition
            : confirmed,
          settledPosition: confirmed,
        };
        try {
          const observed = await this.dependencies.work.readBoundary(
            input.deadline.signal,
          );
          if (!validBoundary(observed, this.dependencies.providerId)
            || observed.settledPosition < confirmed) {
            throw Object.assign(new Error("Provider boundary regressed."), {
              code: "PROVIDER_PROMOTION_TARGET_READ_INVALID",
            });
          }
          boundary = observed;
        } catch (error) {
          await this.recordProgress(input, boundary, {
            attempts,
            initialLanePosition,
            initialSettledPosition,
            publicationCount,
            operationCount,
          });
          return this.continueInvocation(
            input,
            safeFailureCode(error, "PROVIDER_PROMOTION_TARGET_READ_FAILED"),
          );
        }
      }
      await this.recordProgress(input, boundary, {
        attempts,
        initialLanePosition,
        initialSettledPosition,
        publicationCount,
        operationCount,
      });
      if (observation.disposition === "overlap") {
        return this.terminalize(input, "coalesced", {
          failureCode: observation.safeFailureCode
            ?? "PROVIDER_PROMOTION_LEASE_HELD",
          acknowledgeObservedWake: false,
        });
      }
      if (observation.disposition === "blocked") {
        return this.terminalize(input, "blocked", {
          failureCode: observation.safeFailureCode
            ?? "PROVIDER_PROMOTION_BLOCKED",
          acknowledgeObservedWake: false,
        });
      }
      if (
        observation.disposition === "completed"
        && boundary.settledPosition === boundary.lanePosition
      ) {
        return this.terminalize(input, "caught_up", {
          failureCode: null,
          acknowledgeObservedWake: true,
        });
      }
      if (input.deadline.signal.aborted) {
        return this.continueInvocation(
          input,
          input.deadline.deadlineExpired()
            ? "PROVIDER_PROMOTION_DEADLINE"
            : "PROVIDER_PROMOTION_CANCELLED",
        );
      }
    }
    return this.continueInvocation(
      input,
      "PROVIDER_PROMOTION_ATTEMPT_LIMIT",
    );
  }

  private async recordProgress(
    input: Readonly<{
      invocation: PromotionJobInvocation;
      ownershipToken: string;
    }>,
    boundary: ProviderPromotionBoundary,
    state: Readonly<{
      attempts: readonly PromotionInvocationAttemptEvidence[];
      initialLanePosition: bigint;
      initialSettledPosition: bigint;
      publicationCount: number;
      operationCount: number;
    }>,
  ): Promise<void> {
    const progress: PromotionJobProgress = {
      beforeLanePosition: state.initialLanePosition,
      afterLanePosition: boundary.lanePosition,
      beforeSettledPosition: state.initialSettledPosition,
      afterSettledPosition: boundary.settledPosition,
      cycleCount: state.attempts.length,
      promotionAttemptCount: state.attempts.length,
      publicationCount: state.publicationCount,
      operationCount: state.operationCount,
    };
    await this.dependencies.ledger.recordProgress({
      runId: input.invocation.runId,
      ownershipToken: input.ownershipToken,
      now: this.#now(),
      progress,
      attempts: state.attempts,
      retentionProtected: state.attempts.length > 0,
    });
  }

  private async continueInvocation(
    input: Readonly<{
      invocation: PromotionJobInvocation;
      ownershipToken: string;
    }>,
    failureCode: string,
  ): Promise<ProviderPromotionOneShotResult> {
    const finishedAt = this.#now();
    const wake = await this.dependencies.ledger.loadWakeIntent();
    const requestedGeneration = (
      wake.requestedGeneration >
          (input.invocation.trigger.observedWakeGeneration ?? 0n)
        ? wake.requestedGeneration
        : (input.invocation.trigger.observedWakeGeneration ?? 0n)
    ) + 1n;
    const invocation = await this.dependencies.ledger.terminalize({
      runId: input.invocation.runId,
      ownershipToken: input.ownershipToken,
      finishedAt,
      outcome: "continuation_required",
      safeFailureCode: failureCode,
      acknowledgeObservedWake: false,
      continuation: { requestedGeneration, requestedAt: finishedAt },
      retentionProtected: true,
    });
    return { state: "terminal", invocation };
  }

  private async terminalize(
    input: Readonly<{
      invocation: PromotionJobInvocation;
      ownershipToken: string;
    }>,
    outcome: "caught_up" | "no_change" | "coalesced" | "blocked",
    options: Readonly<{
      failureCode: string | null;
      acknowledgeObservedWake: boolean;
    }>,
  ): Promise<ProviderPromotionOneShotResult> {
    const invocation = await this.dependencies.ledger.terminalize({
      runId: input.invocation.runId,
      ownershipToken: input.ownershipToken,
      finishedAt: this.#now(),
      outcome,
      safeFailureCode: options.failureCode,
      acknowledgeObservedWake: options.acknowledgeObservedWake,
    });
    return { state: "terminal", invocation };
  }
}
