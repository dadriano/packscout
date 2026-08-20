import type {
  CatalogPromotionAlertSink,
  CatalogPromotionCycleResult,
  CatalogPromotionHealth,
  CatalogPromotionHealthSink,
} from "@packscout/services";

export interface CatalogPromotionCyclePort {
  runCycle(signal?: AbortSignal): Promise<CatalogPromotionCycleResult>;
}

export interface CatalogPromotionWorkerSleeper {
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export type CatalogPromotionWorkerLogEvent = Readonly<{
  level: "error" | "info";
  event:
    | "catalog_promotion_worker_started"
    | "catalog_promotion_worker_stopped"
    | "catalog_promotion_cycle_finished"
    | "catalog_promotion_cycle_failed"
    | "catalog_promotion_terminal_alert"
    | "catalog_promotion_health";
  workerId: string;
  outcome?: CatalogPromotionCycleResult["outcome"];
  attemptId?: string;
  requestedWatermark?: string;
  operationsAcknowledged?: number;
  failureCode?: string;
  settledWatermark?: string;
  activeAttemptState?: string;
  activeAttemptAgeMilliseconds?: number;
  lastActivatedWatermark?: string;
  lastActivatedAt?: string;
  lastUnchangedWatermark?: string;
  lastUnchangedAt?: string;
  retryAt?: string;
  delayedVendorCount?: number;
  occurredAt?: string;
}>;

export interface CatalogPromotionWorkerLogger {
  write(event: CatalogPromotionWorkerLogEvent): void;
}

export interface CatalogPromotionWorkerRuntimePort {
  start(): Promise<void>;
  stop(): void;
}

const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const safeFailureCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/u;

const defaultSleeper: CatalogPromotionWorkerSleeper = {
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

function safeId(value: string): string {
  return safeIdentifierPattern.test(value) ? value : "invalid";
}

function safeFailure(value: string | null): string | undefined {
  if (value === null) return undefined;
  return safeFailureCodePattern.test(value) ? value : "CATALOG_FAILURE_INVALID";
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export class JsonConsoleCatalogPromotionWorkerLogger
  implements CatalogPromotionWorkerLogger
{
  write(event: CatalogPromotionWorkerLogEvent): void {
    const serialized = JSON.stringify(event);
    if (event.level === "error") console.error(serialized);
    else console.info(serialized);
  }
}

export class CatalogPromotionWorkerHealthLogger
  implements CatalogPromotionHealthSink
{
  constructor(
    private readonly logger: CatalogPromotionWorkerLogger,
    private readonly workerId: string,
    private readonly now: () => Date,
  ) {}

  report(health: CatalogPromotionHealth): void {
    const active = health.activeAttempt;
    this.logger.write({
      level: "info",
      event: "catalog_promotion_health",
      workerId: safeId(this.workerId),
      settledWatermark: String(health.settledWatermark),
      ...(active === null ? {} : {
        attemptId: safeId(active.attemptId),
        requestedWatermark: String(active.requestedWatermark),
        activeAttemptState: active.state,
        activeAttemptAgeMilliseconds: safeCount(Math.max(
          0,
          this.now().getTime() - active.createdAt.getTime(),
        )),
      }),
      ...(health.lastActivatedWatermark === null ? {} : {
        lastActivatedWatermark: String(health.lastActivatedWatermark),
      }),
      ...(health.lastActivatedAt === null ? {} : {
        lastActivatedAt: health.lastActivatedAt.toISOString(),
      }),
      ...(health.lastUnchangedWatermark === null ? {} : {
        lastUnchangedWatermark: String(health.lastUnchangedWatermark),
      }),
      ...(health.lastUnchangedAt === null ? {} : {
        lastUnchangedAt: health.lastUnchangedAt.toISOString(),
      }),
      ...(health.retryAt === null ? {} : {
        retryAt: health.retryAt.toISOString(),
      }),
      ...(health.delayedVendorCount === null ? {} : {
        delayedVendorCount: safeCount(health.delayedVendorCount),
      }),
    });
  }
}

export class CatalogPromotionWorkerTerminalAlertLogger
  implements CatalogPromotionAlertSink
{
  constructor(
    private readonly logger: CatalogPromotionWorkerLogger,
    private readonly workerId: string,
  ) {}

  notify(input: {
    attemptId: string;
    requestedWatermark: bigint;
    failureCode: string;
    occurredAt: Date;
  }): Promise<void> {
    this.logger.write({
      level: "error",
      event: "catalog_promotion_terminal_alert",
      workerId: safeId(this.workerId),
      attemptId: safeId(input.attemptId),
      requestedWatermark: String(input.requestedWatermark),
      failureCode: safeFailure(input.failureCode) ?? "CATALOG_FAILURE_INVALID",
      occurredAt: input.occurredAt.toISOString(),
    });
    return Promise.resolve();
  }
}

export class CatalogPromotionWorkerRuntime
  implements CatalogPromotionWorkerRuntimePort
{
  readonly #pollIntervalMilliseconds: number;
  readonly #sleeper: CatalogPromotionWorkerSleeper;
  #cycleController: AbortController | null = null;
  #running = false;
  #sleepController: AbortController | null = null;
  #stopRequested = false;

  constructor(private readonly input: {
    runner: CatalogPromotionCyclePort;
    logger: CatalogPromotionWorkerLogger;
    workerId: string;
    pollIntervalMilliseconds: number;
    sleeper?: CatalogPromotionWorkerSleeper;
  }) {
    if (!safeIdentifierPattern.test(input.workerId) ||
        !Number.isSafeInteger(input.pollIntervalMilliseconds) ||
        input.pollIntervalMilliseconds < 1_000 ||
        input.pollIntervalMilliseconds > 30_000) {
      throw new RangeError("Catalog promotion worker runtime is invalid.");
    }
    this.#pollIntervalMilliseconds = input.pollIntervalMilliseconds;
    this.#sleeper = input.sleeper ?? defaultSleeper;
  }

  async start(): Promise<void> {
    if (this.#running) throw new Error("Catalog promotion worker is already running.");
    this.#running = true;
    this.#stopRequested = false;
    this.log({ level: "info", event: "catalog_promotion_worker_started" });
    try {
      while (!this.#stopRequested) {
        const cycleController = new AbortController();
        this.#cycleController = cycleController;
        await this.runCycle(cycleController.signal);
        this.#cycleController = null;
        if (this.#stopRequested) break;
        const controller = new AbortController();
        this.#sleepController = controller;
        await this.#sleeper.sleep(
          this.#pollIntervalMilliseconds,
          controller.signal,
        );
        this.#sleepController = null;
      }
    } finally {
      this.#cycleController?.abort();
      this.#cycleController = null;
      this.#sleepController = null;
      this.#running = false;
      this.log({ level: "info", event: "catalog_promotion_worker_stopped" });
    }
  }

  stop(): void {
    this.#stopRequested = true;
    this.#cycleController?.abort();
    this.#sleepController?.abort();
  }

  async runCycle(
    signal?: AbortSignal,
  ): Promise<CatalogPromotionCycleResult | null> {
    try {
      const cycle = await this.input.runner.runCycle(signal);
      this.log({
        level: cycle.outcome === "failed" ? "error" : "info",
        event: "catalog_promotion_cycle_finished",
        outcome: cycle.outcome,
        ...(cycle.attemptId === null ? {} : {
          attemptId: safeId(cycle.attemptId),
        }),
        ...(cycle.requestedWatermark === null ? {} : {
          requestedWatermark: String(cycle.requestedWatermark),
        }),
        operationsAcknowledged: safeCount(cycle.operationsAcknowledged),
        ...(safeFailure(cycle.failureCode) === undefined ? {} : {
          failureCode: safeFailure(cycle.failureCode),
        }),
      });
      return cycle;
    } catch {
      if (signal?.aborted === true) return null;
      this.log({
        level: "error",
        event: "catalog_promotion_cycle_failed",
        failureCode: "CATALOG_PROMOTION_CYCLE_ERROR",
      });
      return null;
    }
  }

  private log(
    event: Omit<CatalogPromotionWorkerLogEvent, "workerId">,
  ): void {
    this.input.logger.write({ ...event, workerId: this.input.workerId });
  }
}
