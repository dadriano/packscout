import type {
  PromotionJobLivenessConditionDelivery,
} from "@packscout/database";
import type {
  SuccessfulPromotionJobLivenessCycle,
} from "@packscout/services";

const SAFE_FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;
const MAXIMUM_RETRY_DELAY_MS = 15 * 60_000;
const DEFAULT_DELIVERY_BUDGET_MS = 10_000;
const MAXIMUM_DELIVERY_BUDGET_MS = 10_000;

export interface PromotionJobLivenessDeliveryDeadline {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}

type DeadlineSettlement<T> =
  | Readonly<{ state: "fulfilled"; value: T }>
  | Readonly<{ state: "rejected" }>
  | Readonly<{ state: "timed_out" }>;

function scheduleDeliveryDeadline(
  expire: () => void,
  timeoutMs: number,
): () => void {
  const timer = setTimeout(expire, timeoutMs);
  return () => clearTimeout(timer);
}

async function settleByDeadline<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<DeadlineSettlement<T>> {
  if (signal.aborted) return { state: "timed_out" };
  let pending: Promise<T>;
  try {
    pending = Promise.resolve(operation());
  } catch {
    return { state: "rejected" };
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: DeadlineSettlement<T>) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", timedOut);
      resolve(result);
    };
    const timedOut = () => finish({ state: "timed_out" });
    signal.addEventListener("abort", timedOut, { once: true });
    if (signal.aborted) timedOut();
    void pending.then(
      (value) => finish({ state: "fulfilled", value }),
      () => finish({ state: "rejected" }),
    );
  });
}

export interface PromotionJobLivenessEvaluatorPort {
  runCycle(): Promise<SuccessfulPromotionJobLivenessCycle>;
}

export interface PromotionJobLivenessConditionStorePort {
  listPendingConditionDeliveries(input: Readonly<{
    now: Date;
    limit: number;
  }> & PromotionJobLivenessDeliveryDeadline): Promise<
    readonly PromotionJobLivenessConditionDelivery[]
  >;
  recordConditionDeliveryAttempt(input: Readonly<{
    conditionId: string;
    eventId: string;
    attemptedAt: Date;
  }> & PromotionJobLivenessDeliveryDeadline): Promise<boolean>;
  recordConditionDeliveryResult(input: Readonly<{
    conditionId: string;
    eventId: string;
    attemptedAt: Date;
    result:
      | Readonly<{ state: "delivered" }>
      | Readonly<{
          state: "retry_wait";
          failureCode: string;
          retryAt: Date;
        }>;
  }> & PromotionJobLivenessDeliveryDeadline): Promise<boolean>;
}

export interface PromotionJobLivenessConditionPublisher {
  publish(
    delivery: PromotionJobLivenessConditionDelivery,
    input: PromotionJobLivenessDeliveryDeadline,
  ): Promise<Readonly<{
    state: "delivered";
  }> | Readonly<{
    state: "retryable_failure";
    failureCode: string;
  }>>;
}

export interface PromotionJobLivenessOneShotResult {
  readonly cycle: SuccessfulPromotionJobLivenessCycle;
  readonly delivery: Readonly<{
    state: "complete" | "store_unavailable";
    selectedCount: number;
    deliveredCount: number;
    retryScheduledCount: number;
    acknowledgementFailureCount: number;
  }>;
}

function failureCode(value: string): string {
  return SAFE_FAILURE_CODE_PATTERN.test(value)
    ? value
    : "PROMOTION_JOB_CONDITION_DELIVERY_FAILED";
}

function retryDelay(attemptCount: number): number {
  const exponent = Math.min(4, Math.max(0, attemptCount));
  return Math.min(MAXIMUM_RETRY_DELAY_MS, 60_000 * (2 ** exponent));
}

/**
 * Runs one evaluator pass, then best-effort drains a bounded notification page.
 * Durable liveness commits never depend on alert delivery, and a failed
 * evaluator still retries notifications persisted by an earlier pass.
 */
export class PromotionJobLivenessOneShot {
  readonly #limit: number;
  readonly #now: () => Date;
  readonly #deliveryBudgetMs: number;
  readonly #deadlineNow: () => number;
  readonly #scheduleDeliveryDeadline: (
    expire: () => void,
    timeoutMs: number,
  ) => () => void;

  constructor(private readonly dependencies: Readonly<{
    evaluator: PromotionJobLivenessEvaluatorPort;
    conditions: PromotionJobLivenessConditionStorePort;
    publisher: PromotionJobLivenessConditionPublisher;
    deliveryLimit?: number;
    deliveryBudgetMs?: number;
    now?: () => Date;
    deadlineNow?: () => number;
    scheduleDeliveryDeadline?: (
      expire: () => void,
      timeoutMs: number,
    ) => () => void;
  }>) {
    this.#limit = dependencies.deliveryLimit ?? 50;
    this.#deliveryBudgetMs = dependencies.deliveryBudgetMs
      ?? DEFAULT_DELIVERY_BUDGET_MS;
    this.#now = dependencies.now ?? (() => new Date());
    this.#deadlineNow = dependencies.deadlineNow ?? Date.now;
    this.#scheduleDeliveryDeadline = dependencies.scheduleDeliveryDeadline
      ?? scheduleDeliveryDeadline;
    if (
      !Number.isInteger(this.#limit)
      || this.#limit < 1
      || this.#limit > 100
    ) throw new TypeError("Promotion job condition delivery limit is invalid.");
    if (
      !Number.isInteger(this.#deliveryBudgetMs)
      || this.#deliveryBudgetMs < 1
      || this.#deliveryBudgetMs > MAXIMUM_DELIVERY_BUDGET_MS
    ) throw new TypeError("Promotion job condition delivery budget is invalid.");
  }

  async run(): Promise<PromotionJobLivenessOneShotResult> {
    let cycle: SuccessfulPromotionJobLivenessCycle | undefined;
    let evaluationError: unknown;
    try {
      cycle = await this.dependencies.evaluator.runCycle();
    } catch (error) {
      evaluationError = error;
    }
    const delivery = await this.deliverPending();
    if (evaluationError !== undefined) throw evaluationError;
    return { cycle: cycle!, delivery };
  }

  private async deliverPending(): Promise<PromotionJobLivenessOneShotResult["delivery"]> {
    const selectedAt = this.#now();
    const deliveryStartedAt = this.#deadlineNow();
    if (
      !Number.isFinite(selectedAt.getTime())
      || !Number.isSafeInteger(deliveryStartedAt)
    ) {
      return {
        state: "store_unavailable",
        selectedCount: 0,
        deliveredCount: 0,
        retryScheduledCount: 0,
        acknowledgementFailureCount: 0,
      };
    }
    const deadlineAt = deliveryStartedAt + this.#deliveryBudgetMs;
    if (!Number.isSafeInteger(deadlineAt)) {
      return {
        state: "store_unavailable",
        selectedCount: 0,
        deliveredCount: 0,
        retryScheduledCount: 0,
        acknowledgementFailureCount: 0,
      };
    }
    const controller = new AbortController();
    const cancelDeadline = this.#scheduleDeliveryDeadline(
      () => controller.abort(),
      this.#deliveryBudgetMs,
    );
    try {
      return await this.deliverPendingBeforeDeadline(selectedAt, {
        deadlineAt,
        signal: controller.signal,
      });
    } finally {
      cancelDeadline();
    }
  }

  private async deliverPendingBeforeDeadline(
    selectedAt: Date,
    deadline: PromotionJobLivenessDeliveryDeadline,
  ): Promise<PromotionJobLivenessOneShotResult["delivery"]> {
    const listed = await settleByDeadline(
      () => this.dependencies.conditions.listPendingConditionDeliveries({
        now: selectedAt,
        limit: this.#limit,
        ...deadline,
      }),
      deadline.signal,
    );
    if (listed.state !== "fulfilled") {
      return {
        state: "store_unavailable",
        selectedCount: 0,
        deliveredCount: 0,
        retryScheduledCount: 0,
        acknowledgementFailureCount: 0,
      };
    }
    const deliveries = listed.value;
    let deliveredCount = 0;
    let retryScheduledCount = 0;
    let acknowledgementFailureCount = 0;
    for (const delivery of deliveries) {
      if (deadline.signal.aborted) break;
      const attemptedAt = this.#now();
      const attempt = await settleByDeadline(
        () => this.dependencies.conditions.recordConditionDeliveryAttempt({
            conditionId: delivery.conditionId,
            eventId: delivery.eventId,
            attemptedAt,
            ...deadline,
          }),
        deadline.signal,
      );
      if (attempt.state === "timed_out") break;
      if (attempt.state === "rejected" || !attempt.value) {
        acknowledgementFailureCount += 1;
        continue;
      }
      const publication = await settleByDeadline(
        () => this.dependencies.publisher.publish(
          delivery,
          deadline,
        ),
        deadline.signal,
      );
      if (publication.state === "timed_out") break;
      const published = publication.state === "fulfilled"
        ? publication.value
        : {
          state: "retryable_failure",
          failureCode: "PROMOTION_JOB_CONDITION_DELIVERY_FAILED",
        } as const;
      const result = published.state === "delivered"
        ? { state: "delivered" as const }
        : {
            state: "retry_wait" as const,
            failureCode: failureCode(published.failureCode),
            retryAt: new Date(
              attemptedAt.getTime() + retryDelay(delivery.attemptCount),
            ),
          };
      const acknowledgement = await settleByDeadline(
        () => this.dependencies.conditions.recordConditionDeliveryResult({
            conditionId: delivery.conditionId,
            eventId: delivery.eventId,
            attemptedAt,
            result,
            ...deadline,
          }),
        deadline.signal,
      );
      if (acknowledgement.state === "timed_out") break;
      if (acknowledgement.state === "rejected" || !acknowledgement.value) {
        acknowledgementFailureCount += 1;
      } else if (result.state === "delivered") deliveredCount += 1;
      else retryScheduledCount += 1;
    }
    return {
      state: "complete",
      selectedCount: deliveries.length,
      deliveredCount,
      retryScheduledCount,
      acknowledgementFailureCount,
    };
  }
}
