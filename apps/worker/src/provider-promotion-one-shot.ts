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
export const PROVIDER_PROMOTION_OWNERSHIP_GRACE_MILLISECONDS = 10_000;
const PROVIDER_PROMOTION_COMPLETION_RESERVE_MILLISECONDS = 10_000;

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
  readBoundary(
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<ProviderPromotionBoundary>;
  attempt(input: Readonly<{
    runId: string;
    attemptId: string;
    targetPosition: bigint;
    retryCount: number;
    /** Absolute wall-clock boundary for all database work in this attempt. */
    deadlineAt: number;
    /** Later boundary reserved only for best-effort lease cleanup. */
    cleanupDeadlineAt: number;
    signal: AbortSignal;
  }>): Promise<ProviderPromotionAttemptObservation>;
}

export interface ProviderPromotionJobLedgerPort {
  beginOrRecoverInvocation(
    input: BeginPromotionJobInvocationInput,
    deadline?: Readonly<{ deadlineAt: number }>,
  ): Promise<PromotionJobAdmission>;
  loadWakeIntent(): Promise<PromotionWakeIntent>;
  recordProgress(
    input: RecordPromotionJobProgressInput,
    deadline?: Readonly<{ deadlineAt: number }>,
  ): Promise<PromotionJobInvocation>;
  terminalize(
    input: TerminalizePromotionJobInvocationInput,
    deadline?: Readonly<{ deadlineAt: number }>,
  ): Promise<PromotionJobInvocation>;
  reconcileInterrupted(
    input: ReconcileInterruptedPromotionJobInvocationInput,
    deadline?: Readonly<{ deadlineAt: number }>,
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
  /** Optional earlier absolute wall-clock deadline inherited from bootstrap. */
  readonly deadlineAt?: number;
}

interface DeadlineResources {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly deadlineExpired: () => boolean;
  readonly remainingMilliseconds: () => number;
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
  completionReserveMilliseconds: number;
  externalSignal?: AbortSignal;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
  nowMilliseconds: () => number;
  absoluteDeadlineAt?: number;
}>): DeadlineResources {
  const controller = new AbortController();
  const startedAt = input.nowMilliseconds();
  if (
    input.absoluteDeadlineAt !== undefined
    && (!Number.isSafeInteger(input.absoluteDeadlineAt)
      || input.absoluteDeadlineAt < 1)
  ) throw new TypeError("Provider promotion deadline is invalid.");
  const deadlineAt = input.absoluteDeadlineAt === undefined
    ? startedAt + input.durationMilliseconds
    : Math.min(
        input.absoluteDeadlineAt,
        startedAt + input.durationMilliseconds,
      );
  let expired = false;
  const expire = () => {
    if (controller.signal.aborted) return;
    expired = true;
    controller.abort(new Error("provider promotion deadline reached"));
  };
  const cancel = () => {
    controller.abort(input.externalSignal?.reason);
  };
  const timer = input.setTimer(
    expire,
    Math.max(
      0,
      deadlineAt - startedAt - input.completionReserveMilliseconds,
    ),
  );
  if (input.externalSignal?.aborted === true) cancel();
  else input.externalSignal?.addEventListener("abort", cancel, { once: true });
  return {
    signal: controller.signal,
    deadlineAt,
    deadlineExpired: () => expired,
    remainingMilliseconds: () => controller.signal.aborted
      ? 0
      : Math.max(0, deadlineAt - input.nowMilliseconds()),
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
  readonly #nowMilliseconds: () => number;
  readonly #completionReserveMilliseconds: number;

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
    nowMilliseconds?: () => number;
  }>) {
    this.#maximumMilliseconds = dependencies.maximumMilliseconds
      ?? PROVIDER_PROMOTION_ONE_SHOT_MAXIMUM_MILLISECONDS;
    this.#maximumAttempts = dependencies.maximumAttempts
      ?? PROVIDER_PROMOTION_ONE_SHOT_MAXIMUM_ATTEMPTS;
    this.#now = dependencies.now ?? (() => new Date());
    this.#randomUuid = dependencies.randomUuid ?? randomUUID;
    this.#setTimer = dependencies.setTimer ?? setTimeout;
    this.#clearTimer = dependencies.clearTimer ?? clearTimeout;
    this.#nowMilliseconds = dependencies.nowMilliseconds ?? Date.now;
    this.#completionReserveMilliseconds = Math.min(
      PROVIDER_PROMOTION_COMPLETION_RESERVE_MILLISECONDS,
      Math.max(1, Math.floor(this.#maximumMilliseconds / 5)),
    );
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
      completionReserveMilliseconds: this.#completionReserveMilliseconds,
      externalSignal: request.signal,
      setTimer: this.#setTimer,
      clearTimer: this.#clearTimer,
      nowMilliseconds: this.#nowMilliseconds,
      ...(request.deadlineAt === undefined
        ? {}
        : { absoluteDeadlineAt: request.deadlineAt }),
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
            startedAt.getTime()
              + deadline.remainingMilliseconds()
              + PROVIDER_PROMOTION_OWNERSHIP_GRACE_MILLISECONDS,
          ),
        }, {
          deadlineAt: deadline.deadlineAt - this.#completionReserveMilliseconds,
        });
      if (admission.disposition !== "started") {
        return await this.handleExisting(admission, startedAt, deadline);
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
    deadline: DeadlineResources,
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
      }, { deadlineAt: deadline.deadlineAt });
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
        input.deadline.deadlineAt - this.#completionReserveMilliseconds,
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
    const initialProgressFailure = await this.recordProgress(input, boundary, {
      attempts,
      initialLanePosition,
      initialSettledPosition,
      publicationCount,
      operationCount,
    });
    if (initialProgressFailure !== null) {
      return this.continueInvocation(input, initialProgressFailure);
    }

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
      if (
        input.deadline.remainingMilliseconds()
          <= this.#completionReserveMilliseconds
      ) {
        return this.continueInvocation(input, "PROVIDER_PROMOTION_DEADLINE");
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
          deadlineAt: input.deadline.deadlineAt
            - this.#completionReserveMilliseconds,
          cleanupDeadlineAt: input.deadline.deadlineAt
            - Math.floor(this.#completionReserveMilliseconds / 2),
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
          const progressFailure = await this.recordProgress(input, boundary, {
            attempts,
            initialLanePosition,
            initialSettledPosition,
            publicationCount,
            operationCount,
          });
          if (progressFailure !== null) {
            return this.continueInvocation(input, progressFailure);
          }
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
            input.deadline.deadlineAt - this.#completionReserveMilliseconds,
          );
          if (!validBoundary(observed, this.dependencies.providerId)
            || observed.settledPosition < confirmed) {
            throw Object.assign(new Error("Provider boundary regressed."), {
              code: "PROVIDER_PROMOTION_TARGET_READ_INVALID",
            });
          }
          boundary = observed;
        } catch (error) {
          const progressFailure = await this.recordProgress(input, boundary, {
            attempts,
            initialLanePosition,
            initialSettledPosition,
            publicationCount,
            operationCount,
          });
          if (progressFailure !== null) {
            return this.continueInvocation(input, progressFailure);
          }
          return this.continueInvocation(
            input,
            safeFailureCode(error, "PROVIDER_PROMOTION_TARGET_READ_FAILED"),
          );
        }
      }
      const progressFailure = await this.recordProgress(input, boundary, {
        attempts,
        initialLanePosition,
        initialSettledPosition,
        publicationCount,
        operationCount,
      });
      if (progressFailure !== null) {
        return this.continueInvocation(input, progressFailure);
      }
      if (
        input.deadline.remainingMilliseconds()
          <= this.#completionReserveMilliseconds
      ) {
        return this.continueInvocation(input, "PROVIDER_PROMOTION_DEADLINE");
      }
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
      deadline: DeadlineResources;
    }>,
    boundary: ProviderPromotionBoundary,
    state: Readonly<{
      attempts: readonly PromotionInvocationAttemptEvidence[];
      initialLanePosition: bigint;
      initialSettledPosition: bigint;
      publicationCount: number;
      operationCount: number;
    }>,
  ): Promise<string | null> {
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
    try {
      await this.dependencies.ledger.recordProgress({
        runId: input.invocation.runId,
        ownershipToken: input.ownershipToken,
        now: this.#now(),
        progress,
        attempts: state.attempts,
        retentionProtected: state.attempts.length > 0,
      }, {
        deadlineAt: input.deadline.deadlineAt -
          Math.floor(this.#completionReserveMilliseconds / 2),
      });
      return null;
    } catch (error) {
      return safeFailureCode(error, "PROVIDER_PROMOTION_PROGRESS_FAILED");
    }
  }

  private async continueInvocation(
    input: Readonly<{
      invocation: PromotionJobInvocation;
      ownershipToken: string;
      deadline: DeadlineResources;
    }>,
    failureCode: string,
  ): Promise<ProviderPromotionOneShotResult> {
    const finishedAt = this.#now();
    const requestedGeneration =
      (input.invocation.trigger.observedWakeGeneration ?? 0n) + 1n;
    const invocation = await this.dependencies.ledger.terminalize({
      runId: input.invocation.runId,
      ownershipToken: input.ownershipToken,
      finishedAt,
      outcome: "continuation_required",
      safeFailureCode: failureCode,
      acknowledgeObservedWake: false,
      continuation: { requestedGeneration, requestedAt: finishedAt },
      retentionProtected: true,
    }, { deadlineAt: input.deadline.deadlineAt });
    return { state: "terminal", invocation };
  }

  private async terminalize(
    input: Readonly<{
      invocation: PromotionJobInvocation;
      ownershipToken: string;
      deadline: DeadlineResources;
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
    }, { deadlineAt: input.deadline.deadlineAt });
    return { state: "terminal", invocation };
  }
}
