import type { ManifestEligibilitySnapshot } from "@packscout/services";

export interface PromotionV2EligibilityPort {
  getSnapshot(): Promise<ManifestEligibilitySnapshot>;
}

export interface PromotionV2BootstrapPort {
  ensureVerified(input: Readonly<{
    verifiedAt: Date;
    signal?: AbortSignal;
  }>): Promise<void>;
}

export interface PromotionV2CyclePort {
  runCycle(signal?: AbortSignal): Promise<unknown>;
}

export interface PromotionV2ProviderLane extends PromotionV2CyclePort {
  readonly platformKey: string;
  runRecoveryCycle(signal?: AbortSignal): Promise<unknown>;
}

export interface PromotionV2WorkerSleeper {
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export type PromotionV2WorkerLogEvent = Readonly<{
  level: "error" | "info";
  event:
    | "promotion_v2_worker_started"
    | "promotion_v2_worker_stopped"
    | "promotion_v2_cycle_finished"
    | "promotion_v2_cycle_failed"
    | "promotion_v2_provider_terminal_alert"
    | "promotion_v2_manifest_terminal_alert"
    | "promotion_v2_provider_health"
    | "promotion_v2_manifest_health";
  workerId: string;
  platformKey?: string;
  attemptId?: string;
  enabledProviderCount?: number;
  failureCode?: string;
  settledCheckpoint?: string;
  sourceHeadCheckpoint?: string;
  completedCheckpoint?: string;
  activeCheckpoint?: string;
  checkpointLag?: string;
  requestedEvaluationSequence?: string;
  confirmedEvaluationSequence?: string;
  activeGeneration?: string;
  activePublicReleaseId?: string;
  activeManifestPublicReleaseId?: string;
  bootstrapState?: string;
  activeConfigurationEpochSequence?: string;
  delayedProviderCount?: number;
  activeAttemptState?: string;
  activeAttemptStartedAt?: string;
  activeAttemptAgeSeconds?: number;
  retryAt?: string;
  completedAt?: string;
  lastActivatedAt?: string;
  lastReconciledAt?: string;
}>;

export interface PromotionV2WorkerLogger {
  write(event: PromotionV2WorkerLogEvent): void;
}

export interface PromotionV2WorkerRuntimePort {
  start(): Promise<void>;
  stop(): void;
}

const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;

const HARD_STARTUP_REFUSAL_CODES = new Set([
  "CATALOG_MANIFEST_BOOTSTRAP_CONFIGURATION_INVALID",
  "CATALOG_MANIFEST_BOOTSTRAP_LOCAL_PROOF_MISSING",
  "CATALOG_MANIFEST_BOOTSTRAP_REMOTE_PROOF_INVALID",
  "MANIFEST_ELIGIBILITY_INVALID",
  "MANIFEST_ENABLED_PLATFORM_LIMIT_EXCEEDED",
  "PROMOTION_V2_BOOTSTRAP_UNVERIFIED",
  "PROMOTION_V2_BOOTSTRAP_UNPROVEN",
  "PROMOTION_V2_ACTIVE_STATE_UNPROVEN",
  "PROMOTION_V2_CHECKPOINT_REGRESSED",
  "PROMOTION_V2_CLAIM_STALE",
  "PROMOTION_V2_CREDENTIAL_ELIGIBILITY_MISMATCH",
  "PROMOTION_V2_INPUT_INVALID",
  "PROMOTION_V2_OPERATION_CONFLICT",
  "PROMOTION_V2_OPERATION_ORDER",
  "PROMOTION_V2_PREDECESSOR_CONFLICT",
  "PROMOTION_V2_RECEIPT_INVALID",
  "PROMOTION_V2_SCOPE_MISMATCH",
]);

function hardStartupRefusal(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Readonly<Record<string, unknown>>;
  if (typeof candidate.code === "string" &&
      HARD_STARTUP_REFUSAL_CODES.has(candidate.code)) return true;
  return candidate.disposition === "terminal" && candidate.ambiguous === false;
}

const defaultSleeper: PromotionV2WorkerSleeper = {
  sleep(milliseconds, signal) {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      signal.addEventListener("abort", finish, { once: true });
    });
  },
};

export class JsonConsolePromotionV2WorkerLogger
implements PromotionV2WorkerLogger {
  write(event: PromotionV2WorkerLogEvent): void {
    const body = JSON.stringify(event);
    if (event.level === "error") console.error(body);
    else console.info(body);
  }
}

/** Runs independent enabled provider lanes and the one serialized manifest lane. */
export class PromotionV2WorkerRuntime implements PromotionV2WorkerRuntimePort {
  readonly #pollIntervalMilliseconds: number;
  readonly #providerLanes: ReadonlyMap<string, PromotionV2ProviderLane>;
  readonly #sleeper: PromotionV2WorkerSleeper;
  #bootstrapComplete = false;
  readonly #cycleControllers = new Set<AbortController>();
  #cycleInProgress = false;
  #running = false;
  readonly #sleepControllers = new Set<AbortController>();
  #stopRequested = false;

  constructor(private readonly input: Readonly<{
    workerId: string;
    eligibility: PromotionV2EligibilityPort;
    validateEligibility(snapshot: ManifestEligibilitySnapshot): void;
    bootstrap: PromotionV2BootstrapPort;
    providerLanes: readonly PromotionV2ProviderLane[];
    manifestLane: PromotionV2CyclePort;
    pollIntervalMilliseconds: number;
    clock: Readonly<{ now(): Date }>;
    logger: PromotionV2WorkerLogger;
    sleeper?: PromotionV2WorkerSleeper;
  }>) {
    if (!safeIdPattern.test(input.workerId) ||
        !Number.isSafeInteger(input.pollIntervalMilliseconds) ||
        input.pollIntervalMilliseconds < 100 ||
        input.pollIntervalMilliseconds > 5_000 ||
        input.providerLanes.length > 8) {
      throw new RangeError("Promotion worker runtime is invalid.");
    }
    const canonical = [...input.providerLanes].sort((left, right) =>
      left.platformKey < right.platformKey
        ? -1 : left.platformKey > right.platformKey ? 1 : 0);
    if (canonical.some((lane, index) =>
      !safeIdPattern.test(lane.platformKey) ||
      lane !== input.providerLanes[index] ||
      (index > 0 && canonical[index - 1]!.platformKey === lane.platformKey))) {
      throw new RangeError("Promotion provider lanes are invalid.");
    }
    this.#providerLanes = new Map(canonical.map((lane) => [
      lane.platformKey, lane,
    ]));
    this.#pollIntervalMilliseconds = input.pollIntervalMilliseconds;
    this.#sleeper = input.sleeper ?? defaultSleeper;
  }

  async start(): Promise<void> {
    if (this.#running) throw new Error("Promotion worker is already running.");
    this.#running = true;
    this.#stopRequested = false;
    this.log({
      level: "info", event: "promotion_v2_worker_started",
      workerId: this.input.workerId,
    });
    try {
      await this.bootstrapUntilVerified();
      if (this.#stopRequested) return;
      let signalFatalFailure!: (error: unknown) => void;
      const fatalFailure = new Promise<unknown>((resolve) => {
        signalFatalFailure = resolve;
      });
      const loops = [
        ...this.#providerLanes.values(),
      ].map((lane) => this.runProviderLoop(lane));
      loops.push(this.runManifestLoop());
      const observedLoops = loops.map((loop) => loop.catch((error: unknown) => {
        signalFatalFailure(error);
        throw error;
      }));
      const allLoops = Promise.allSettled(observedLoops);
      const completion = await Promise.race([
        allLoops.then((settled) => ({ kind: "settled" as const, settled })),
        fatalFailure.then((error) => ({ kind: "fatal" as const, error })),
      ]);
      if (completion.kind === "fatal") {
        // A bounded port is expected to honor AbortSignal, but a hard proof
        // refusal must still propagate if an unrelated provider ignores it.
        // allSettled remains attached to retain late rejection handlers.
        void allLoops.then(() => undefined);
        throw completion.error;
      }
      const settled = completion.settled;
      const rejected = settled.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );
      if (rejected !== undefined) throw rejected.reason;
    } finally {
      for (const controller of this.#cycleControllers) controller.abort();
      this.#cycleControllers.clear();
      for (const controller of this.#sleepControllers) controller.abort();
      this.#sleepControllers.clear();
      this.#running = false;
      this.log({
        level: "info", event: "promotion_v2_worker_stopped",
        workerId: this.input.workerId,
      });
    }
  }

  stop(): void {
    this.#stopRequested = true;
    for (const controller of this.#cycleControllers) controller.abort();
    for (const controller of this.#sleepControllers) controller.abort();
  }

  private async bootstrapUntilVerified(): Promise<void> {
    while (!this.#stopRequested && !this.#bootstrapComplete) {
      const controller = new AbortController();
      this.#cycleControllers.add(controller);
      try {
        const snapshot = await this.input.eligibility.getSnapshot();
        this.input.validateEligibility(snapshot);
        await this.input.bootstrap.ensureVerified({
          verifiedAt: this.input.clock.now(),
          signal: controller.signal,
        });
        this.#bootstrapComplete = true;
      } catch (error) {
        if (this.#stopRequested || controller.signal.aborted) return;
        this.logCycleFailure("PROMOTION_V2_BOOTSTRAP_RETRY");
        if (hardStartupRefusal(error)) throw error;
      } finally {
        this.#cycleControllers.delete(controller);
      }
      if (!this.#bootstrapComplete) await this.waitForNextPoll();
    }
  }

  private async runProviderLoop(lane: PromotionV2ProviderLane): Promise<void> {
    while (!this.#stopRequested) {
      const controller = new AbortController();
      this.#cycleControllers.add(controller);
      try {
        const snapshot = await this.input.eligibility.getSnapshot();
        this.input.validateEligibility(snapshot);
        if (snapshot.enabledPlatformKeys.includes(lane.platformKey)) {
          await lane.runCycle(controller.signal);
        } else {
          await lane.runRecoveryCycle(controller.signal);
        }
      } catch (error) {
        if (this.#stopRequested || controller.signal.aborted) return;
        this.logCycleFailure("PROMOTION_V2_PROVIDER_CYCLE_FAILED");
        if (hardStartupRefusal(error)) {
          this.stop();
          throw error;
        }
      } finally {
        this.#cycleControllers.delete(controller);
      }
      if (!this.#stopRequested) await this.waitForNextPoll();
    }
  }

  private async runManifestLoop(): Promise<void> {
    while (!this.#stopRequested) {
      const controller = new AbortController();
      this.#cycleControllers.add(controller);
      try {
        const snapshot = await this.input.eligibility.getSnapshot();
        this.input.validateEligibility(snapshot);
        await this.input.bootstrap.ensureVerified({
          verifiedAt: this.input.clock.now(),
          signal: controller.signal,
        });
        await this.input.manifestLane.runCycle(controller.signal);
      } catch (error) {
        if (this.#stopRequested || controller.signal.aborted) return;
        this.logCycleFailure("PROMOTION_V2_MANIFEST_CYCLE_FAILED");
        if (hardStartupRefusal(error)) {
          this.stop();
          throw error;
        }
      } finally {
        this.#cycleControllers.delete(controller);
      }
      if (!this.#stopRequested) await this.waitForNextPoll();
    }
  }

  private async waitForNextPoll(): Promise<void> {
    if (this.#stopRequested) return;
    const controller = new AbortController();
    this.#sleepControllers.add(controller);
    try {
      await this.#sleeper.sleep(
        this.#pollIntervalMilliseconds,
        controller.signal,
      );
    } finally {
      this.#sleepControllers.delete(controller);
    }
  }

  private logCycleFailure(failureCode: string): void {
    this.log({
      level: "error",
      event: "promotion_v2_cycle_failed",
      workerId: this.input.workerId,
      failureCode,
    });
  }

  private log(event: PromotionV2WorkerLogEvent): void {
    try {
      this.input.logger.write(event);
    } catch {
      // Best-effort logging never controls durable scheduling or shutdown.
    }
  }

  async runCycle(signal?: AbortSignal): Promise<void> {
    if (this.#cycleInProgress) {
      throw new Error("Promotion worker cycle is already running.");
    }
    this.#cycleInProgress = true;
    try {
      const snapshot = await this.input.eligibility.getSnapshot();
      this.input.validateEligibility(snapshot);
      await this.input.bootstrap.ensureVerified({
        verifiedAt: this.input.clock.now(),
        signal,
      });
      this.#bootstrapComplete = true;
      if (signal?.aborted === true) return;
      const enabled = new Set(snapshot.enabledPlatformKeys);
      const executions = [
        ...this.#providerLanes.values(),
      ].map(async (lane) => enabled.has(lane.platformKey)
        ? await lane.runCycle(signal)
        : await lane.runRecoveryCycle(signal));
      executions.push(this.input.manifestLane.runCycle(signal));
      const settled = await Promise.allSettled(executions);
      const failures = settled.filter(({ status }) => status === "rejected");
      this.log({
        level: failures.length === 0 ? "info" : "error",
        event: failures.length === 0
          ? "promotion_v2_cycle_finished"
          : "promotion_v2_cycle_failed",
        workerId: this.input.workerId,
        enabledProviderCount: enabled.size,
        ...(failures.length === 0 ? {} : {
          failureCode: "PROMOTION_V2_LANE_CYCLE_FAILED",
        }),
      });
    } catch (error) {
      if (signal?.aborted === true) return;
      this.log({
        level: "error", event: "promotion_v2_cycle_failed",
        workerId: this.input.workerId,
        failureCode: "PROMOTION_V2_CYCLE_FAILED",
      });
      throw error;
    } finally {
      this.#cycleInProgress = false;
    }
  }
}
