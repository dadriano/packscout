import type {
  PromotionJobLivenessOneShotResult,
} from "./promotion-job-liveness-one-shot.ts";

export const PROMOTION_JOB_LIVENESS_EVALUATOR_CADENCE_MS = 60_000;

const SAFE_FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;

export interface PromotionJobLivenessRuntimeOneShot {
  run(): Promise<PromotionJobLivenessOneShotResult>;
}

export interface PromotionJobLivenessRuntimeLogger {
  log(record: Readonly<{
    level: "info" | "warning";
    event: "promotion_job_liveness_evaluator";
    phase: "started" | "cycle" | "stopped";
    outcome: "running" | "completed" | "failed" | "stopped";
    failureCode: string | null;
    expectedCount: number | null;
    reachableCount: number | null;
    unavailableCount: number | null;
    rosterDigest: string | null;
  }>): void;
}

export interface PromotionJobLivenessRuntimeCycleResult {
  readonly state: "completed" | "failed";
  readonly failureCode: string | null;
  readonly result: PromotionJobLivenessOneShotResult | null;
}

function safeFailure(error: unknown): string {
  if (
    error !== null && typeof error === "object" && "code" in error &&
    typeof error.code === "string"
  ) {
    const normalized = error.code.toUpperCase();
    if (SAFE_FAILURE_CODE.test(normalized)) return normalized;
  }
  return "PROMOTION_JOB_LIVENESS_EVALUATION_FAILED";
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || milliseconds <= 0) {
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

/** Fixed-cadence host for the already-bounded evaluator one-shot. */
export class PromotionJobLivenessRuntime {
  readonly #now: () => Date;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #controller = new AbortController();
  #activeCycle: Promise<PromotionJobLivenessRuntimeCycleResult> | null = null;
  #running: Promise<void> | null = null;

  constructor(private readonly dependencies: Readonly<{
    oneShot: PromotionJobLivenessRuntimeOneShot;
    logger: PromotionJobLivenessRuntimeLogger;
    now?: () => Date;
    sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  }>) {
    this.#now = dependencies.now ?? (() => new Date());
    this.#sleep = dependencies.sleep ?? defaultSleep;
  }

  start(): Promise<void> {
    if (this.#running !== null) return this.#running;
    if (this.#controller.signal.aborted) {
      return Promise.reject(new Error("Promotion job liveness runtime stopped."));
    }
    this.#running = this.runLoop();
    return this.#running;
  }

  stop(): void {
    this.#controller.abort();
  }

  runOnce(): Promise<PromotionJobLivenessRuntimeCycleResult> {
    if (this.#activeCycle !== null) return this.#activeCycle;
    const cycle = this.executeCycle().finally(() => {
      if (this.#activeCycle === cycle) this.#activeCycle = null;
    });
    this.#activeCycle = cycle;
    return cycle;
  }

  private async runLoop(): Promise<void> {
    this.dependencies.logger.log({
      level: "info",
      event: "promotion_job_liveness_evaluator",
      phase: "started",
      outcome: "running",
      failureCode: null,
      expectedCount: null,
      reachableCount: null,
      unavailableCount: null,
      rosterDigest: null,
    });
    try {
      while (!this.#controller.signal.aborted) {
        const startedAt = this.#now();
        await this.runOnce();
        if (this.#controller.signal.aborted) break;
        const elapsed = Math.max(0, this.#now().getTime() - startedAt.getTime());
        await this.#sleep(
          Math.max(0, PROMOTION_JOB_LIVENESS_EVALUATOR_CADENCE_MS - elapsed),
          this.#controller.signal,
        );
      }
    } finally {
      this.dependencies.logger.log({
        level: "info",
        event: "promotion_job_liveness_evaluator",
        phase: "stopped",
        outcome: "stopped",
        failureCode: null,
        expectedCount: null,
        reachableCount: null,
        unavailableCount: null,
        rosterDigest: null,
      });
    }
  }

  private async executeCycle(): Promise<PromotionJobLivenessRuntimeCycleResult> {
    try {
      const result = await this.dependencies.oneShot.run();
      this.dependencies.logger.log({
        level: "info",
        event: "promotion_job_liveness_evaluator",
        phase: "cycle",
        outcome: "completed",
        failureCode: null,
        expectedCount: result.cycle.summary.expectedCount,
        reachableCount: result.cycle.summary.reachableCount,
        unavailableCount: result.cycle.summary.unavailableCount,
        rosterDigest: result.cycle.roster.rosterDigest,
      });
      return { state: "completed", failureCode: null, result };
    } catch (error) {
      const failureCode = safeFailure(error);
      this.dependencies.logger.log({
        level: "warning",
        event: "promotion_job_liveness_evaluator",
        phase: "cycle",
        outcome: "failed",
        failureCode,
        expectedCount: null,
        reachableCount: null,
        unavailableCount: null,
        rosterDigest: null,
      });
      return { state: "failed", failureCode, result: null };
    }
  }
}

export class JsonConsolePromotionJobLivenessRuntimeLogger
implements PromotionJobLivenessRuntimeLogger {
  log(record: Parameters<PromotionJobLivenessRuntimeLogger["log"]>[0]): void {
    const serialized = JSON.stringify(record);
    if (record.level === "warning") console.warn(serialized);
    else console.info(serialized);
  }
}
