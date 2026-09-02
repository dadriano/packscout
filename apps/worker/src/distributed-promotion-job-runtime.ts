import {
  PROMOTION_JOB_DELIVERY_RETENTION_MS,
  PROMOTION_JOB_SCHEDULE_CADENCE_SECONDS,
  promotionJobSha256,
  promotionJobTriggerEvidenceDigest,
  type PromotionInvocationTriggerRequest,
  type PromotionJobAuthority,
  type PromotionJobDeliveryEnvelope,
  type PromotionJobSchedule,
  type PromotionWakeIntent,
} from "@packscout/database";

const SAFE_FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;

export interface DistributedPromotionTriggerLedgerPort {
  loadWakeIntent(): Promise<PromotionWakeIntent>;
  loadSchedule(): Promise<PromotionJobSchedule>;
  recordWakeDelivery(input: Readonly<{
    generation: bigint;
    state: "accepted" | "delivered" | "retry_wait";
    attemptedAt: Date;
    safeFailureCode?: string | null;
  }>): Promise<PromotionWakeIntent>;
}

export interface DistributedPromotionOneShotPort {
  run(request: Readonly<{
    delivery: PromotionJobDeliveryEnvelope;
    trigger: PromotionInvocationTriggerRequest;
    requestedAt: Date;
    signal?: AbortSignal;
  }>): Promise<unknown>;
}

export interface DistributedPromotionManualCommandVerifier {
  verify(input: Readonly<{
    authority: PromotionJobAuthority;
    scopeIdentitySha256: string;
    protectedCommandIdentity: string;
    requestedAt: Date;
  }>): Promise<
    | Readonly<{ state: "verified"; deliveryIdentity: string }>
    | Readonly<{ state: "rejected"; failureCode: string }>
  >;
}

export class DistributedPromotionManualAuthorizationError extends Error {
  readonly code = "DISTRIBUTED_PROMOTION_MANUAL_UNAUTHORIZED";

  constructor() {
    super("Distributed promotion manual command is not authorized.");
    this.name = "DistributedPromotionManualAuthorizationError";
  }
}

export interface DistributedPromotionJobRuntimeLogger {
  log(record: Readonly<{
    level: "info" | "warning";
    event: "distributed_promotion_job_runtime";
    authority: PromotionJobAuthority;
    scopeIdentitySha256: string;
    phase: "started" | "stopped" | "invocation" | "state_read";
    triggerKind: PromotionInvocationTriggerRequest["kind"] | null;
    outcome: string;
    failureCode: string | null;
  }>): void;
}

export interface DistributedPromotionRuntimeInvocationResult {
  readonly triggerKind: PromotionInvocationTriggerRequest["kind"];
  readonly state: "completed" | "failed";
  readonly outcome: string;
  readonly failureCode: string | null;
}

export interface DistributedPromotionRuntimeCycleResult {
  readonly invocations: readonly DistributedPromotionRuntimeInvocationResult[];
  readonly stateReadFailures: number;
}

function safeFailure(error: unknown, fallback: string): string {
  if (
    error !== null && typeof error === "object" && "code" in error &&
    typeof error.code === "string" && SAFE_FAILURE_CODE.test(error.code)
  ) return error.code;
  return fallback;
}

function resultOutcome(result: unknown): string {
  if (result === null || typeof result !== "object") return "completed";
  const value = result as {
    state?: unknown;
    invocation?: { outcome?: unknown } | null;
  };
  if (typeof value.invocation?.outcome === "string") {
    return value.invocation.outcome;
  }
  return typeof value.state === "string" ? value.state : "completed";
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function dueWindow(
  schedule: PromotionJobSchedule,
  now: Date,
): Extract<PromotionInvocationTriggerRequest,
  { kind: "reconciliation_cron" }> | null {
  if (
    schedule.lifecycle !== "active" || schedule.baselineAt === null ||
    schedule.cadenceSeconds !== PROMOTION_JOB_SCHEDULE_CADENCE_SECONDS
  ) return null;
  const scheduleWindowIndex = (schedule.lastAdmittedWindowIndex ?? 0n) + 1n;
  const offset = scheduleWindowIndex *
    BigInt(PROMOTION_JOB_SCHEDULE_CADENCE_SECONDS * 1_000);
  if (offset > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const dueMilliseconds = schedule.baselineAt.getTime() + Number(offset);
  if (!Number.isSafeInteger(dueMilliseconds) || dueMilliseconds > now.getTime()) {
    return null;
  }
  return {
    kind: "reconciliation_cron",
    scheduleEpoch: schedule.scheduleEpoch,
    scheduleWindowIndex,
    scheduledDueAt: new Date(dueMilliseconds),
  };
}

function delivery(
  authority: PromotionJobAuthority,
  scopeIdentitySha256: string,
  trigger: PromotionInvocationTriggerRequest,
  issuedAt: Date,
  stableIdentity?: string,
): PromotionJobDeliveryEnvelope {
  const identity = stableIdentity ?? [
    "packscout-distributed-promotion-trigger-delivery-v1",
    scopeIdentitySha256,
    promotionJobTriggerEvidenceDigest(authority, trigger),
  ].join(":");
  return {
    opaqueKey: [
      "distributed-promotion-v1",
      authority,
      trigger.kind,
      promotionJobSha256(identity),
    ].join(":"),
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() +
      PROMOTION_JOB_DELIVERY_RETENTION_MS),
  };
}

/**
 * Trigger-only host around one authority's one-shot. Durable wake/schedule
 * rows remain the source of truth; a hint merely asks this host to reread them.
 */
export class DistributedPromotionJobRuntime {
  readonly #pollMilliseconds: number;
  readonly #now: () => Date;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #controller = new AbortController();
  #activeCycle: Promise<DistributedPromotionRuntimeCycleResult> | null = null;
  #startPromise: Promise<void> | null = null;
  #wakeSleep: (() => void) | null = null;

  constructor(private readonly dependencies: Readonly<{
    authority: PromotionJobAuthority;
    scopeIdentitySha256: string;
    ledger: DistributedPromotionTriggerLedgerPort;
    oneShot: DistributedPromotionOneShotPort;
    manualCommands: DistributedPromotionManualCommandVerifier;
    logger: DistributedPromotionJobRuntimeLogger;
    pollMilliseconds?: number;
    now?: () => Date;
    sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  }>) {
    this.#pollMilliseconds = dependencies.pollMilliseconds ?? 1_000;
    this.#now = dependencies.now ?? (() => new Date());
    this.#sleep = dependencies.sleep ?? defaultSleep;
    if (
      !/^[0-9a-f]{64}$/u.test(dependencies.scopeIdentitySha256) ||
      !Number.isSafeInteger(this.#pollMilliseconds) ||
      this.#pollMilliseconds < 100 || this.#pollMilliseconds > 60_000
    ) throw new RangeError("Distributed promotion runtime bounds are invalid.");
  }

  start(): Promise<void> {
    if (this.#startPromise !== null) return this.#startPromise;
    if (this.#controller.signal.aborted) {
      return Promise.reject(new Error("Distributed promotion runtime is stopped."));
    }
    this.#startPromise = this.runLoop();
    return this.#startPromise;
  }

  stop(): void {
    this.#controller.abort(new Error("Distributed promotion runtime stopped."));
    this.#wakeSleep?.();
  }

  /** Best-effort latency hint; correctness comes from the reread below. */
  requestImmediateCheck(): Promise<DistributedPromotionRuntimeCycleResult> {
    this.#wakeSleep?.();
    return this.runCycle();
  }

  runCycle(): Promise<DistributedPromotionRuntimeCycleResult> {
    if (this.#activeCycle !== null) return this.#activeCycle;
    const cycle = this.executeCycle().finally(() => {
      if (this.#activeCycle === cycle) this.#activeCycle = null;
    });
    this.#activeCycle = cycle;
    return cycle;
  }

  async runManual(
    protectedCommandIdentity: string,
  ): Promise<DistributedPromotionRuntimeInvocationResult> {
    if (
      protectedCommandIdentity.length < 1 ||
      protectedCommandIdentity.length > 512 || /[\r\n\0]/u.test(
        protectedCommandIdentity,
      )
    ) throw new TypeError("Manual command identity is invalid.");
    const requestedAt = this.#now();
    const authorization = await this.dependencies.manualCommands.verify({
      authority: this.dependencies.authority,
      scopeIdentitySha256: this.dependencies.scopeIdentitySha256,
      protectedCommandIdentity,
      requestedAt,
    });
    if (
      authorization.state !== "verified" ||
      authorization.deliveryIdentity.length < 1 ||
      authorization.deliveryIdentity.length > 512 ||
      /[\r\n\0]/u.test(authorization.deliveryIdentity)
    ) throw new DistributedPromotionManualAuthorizationError();
    return this.invoke(
      { kind: "manual" },
      requestedAt,
      authorization.deliveryIdentity,
    );
  }

  runContinuation(
    observedWakeGeneration: bigint,
  ): Promise<DistributedPromotionRuntimeInvocationResult> {
    if (observedWakeGeneration < 1n) {
      return Promise.reject(new TypeError("Continuation generation is invalid."));
    }
    return this.invoke({
      kind: "continuation",
      observedWakeGeneration,
    }, this.#now());
  }

  private async runLoop(): Promise<void> {
    this.dependencies.logger.log({
      level: "info",
      event: "distributed_promotion_job_runtime",
      authority: this.dependencies.authority,
      scopeIdentitySha256: this.dependencies.scopeIdentitySha256,
      phase: "started",
      triggerKind: null,
      outcome: "running",
      failureCode: null,
    });
    try {
      while (!this.#controller.signal.aborted) {
        await this.runCycle();
        if (this.#controller.signal.aborted) break;
        await this.waitForNextCheck();
      }
    } finally {
      this.dependencies.logger.log({
        level: "info",
        event: "distributed_promotion_job_runtime",
        authority: this.dependencies.authority,
        scopeIdentitySha256: this.dependencies.scopeIdentitySha256,
        phase: "stopped",
        triggerKind: null,
        outcome: "stopped",
        failureCode: null,
      });
    }
  }

  private waitForNextCheck(): Promise<void> {
    const hinted = new AbortController();
    const stopHint = () => hinted.abort();
    this.#wakeSleep = stopHint;
    return this.#sleep(this.#pollMilliseconds, hinted.signal).finally(() => {
      if (this.#wakeSleep === stopHint) this.#wakeSleep = null;
    });
  }

  private async executeCycle(): Promise<DistributedPromotionRuntimeCycleResult> {
    const [wakeRead, scheduleRead] = await Promise.allSettled([
      this.dependencies.ledger.loadWakeIntent(),
      this.dependencies.ledger.loadSchedule(),
    ]);
    const invocations: DistributedPromotionRuntimeInvocationResult[] = [];
    let stateReadFailures = 0;
    if (wakeRead.status === "rejected") {
      stateReadFailures += 1;
      this.logStateFailure(wakeRead.reason);
    } else if (wakeRead.value.pending) {
      const trigger: PromotionInvocationTriggerRequest = {
        kind: wakeRead.value.latestCause === "continuation"
          ? "continuation"
          : "change_wake",
        observedWakeGeneration: wakeRead.value.requestedGeneration,
      };
      const attemptedAt = this.#now();
      await this.dependencies.ledger.recordWakeDelivery({
        generation: wakeRead.value.requestedGeneration,
        state: "accepted",
        attemptedAt,
      }).catch((error: unknown) => this.logStateFailure(error));
      const invoked = await this.invoke(trigger, attemptedAt);
      invocations.push(invoked);
      await this.dependencies.ledger.recordWakeDelivery({
        generation: wakeRead.value.requestedGeneration,
        state: invoked.state === "completed" ? "delivered" : "retry_wait",
        attemptedAt: this.#now(),
        safeFailureCode: invoked.failureCode,
      }).catch((error: unknown) => this.logStateFailure(error));
    }
    if (scheduleRead.status === "rejected") {
      stateReadFailures += 1;
      this.logStateFailure(scheduleRead.reason);
    } else {
      const trigger = dueWindow(scheduleRead.value, this.#now());
      if (trigger !== null) invocations.push(await this.invoke(
        trigger,
        this.#now(),
      ));
    }
    return { invocations, stateReadFailures };
  }

  private async invoke(
    trigger: PromotionInvocationTriggerRequest,
    requestedAt: Date,
    stableIdentity?: string,
  ): Promise<DistributedPromotionRuntimeInvocationResult> {
    try {
      const observed = await this.dependencies.oneShot.run({
        delivery: delivery(
          this.dependencies.authority,
          this.dependencies.scopeIdentitySha256,
          trigger,
          requestedAt,
          stableIdentity,
        ),
        trigger,
        requestedAt,
        signal: this.#controller.signal,
      });
      const outcome = resultOutcome(observed);
      const result = {
        triggerKind: trigger.kind,
        state: "completed" as const,
        outcome,
        failureCode: null,
      };
      this.logInvocation(result);
      return result;
    } catch (error) {
      const result = {
        triggerKind: trigger.kind,
        state: "failed" as const,
        outcome: "failed",
        failureCode: safeFailure(
          error,
          "DISTRIBUTED_PROMOTION_INVOCATION_FAILED",
        ),
      };
      this.logInvocation(result);
      return result;
    }
  }

  private logInvocation(result: DistributedPromotionRuntimeInvocationResult) {
    this.dependencies.logger.log({
      level: result.state === "completed" ? "info" : "warning",
      event: "distributed_promotion_job_runtime",
      authority: this.dependencies.authority,
      scopeIdentitySha256: this.dependencies.scopeIdentitySha256,
      phase: "invocation",
      triggerKind: result.triggerKind,
      outcome: result.outcome,
      failureCode: result.failureCode,
    });
  }

  private logStateFailure(error: unknown): void {
    this.dependencies.logger.log({
      level: "warning",
      event: "distributed_promotion_job_runtime",
      authority: this.dependencies.authority,
      scopeIdentitySha256: this.dependencies.scopeIdentitySha256,
      phase: "state_read",
      triggerKind: null,
      outcome: "unavailable",
      failureCode: safeFailure(
        error,
        "DISTRIBUTED_PROMOTION_STATE_UNAVAILABLE",
      ),
    });
  }
}

export class JsonConsoleDistributedPromotionJobRuntimeLogger
implements DistributedPromotionJobRuntimeLogger {
  log(record: Parameters<DistributedPromotionJobRuntimeLogger["log"]>[0]) {
    const output = JSON.stringify(record);
    if (record.level === "warning") console.warn(output);
    else console.info(output);
  }
}
