import type {
  CatalogPromotionRetentionCycleResult,
} from "@packscout/services";

export interface CatalogRetentionCyclePort {
  runCycle(signal?: AbortSignal): Promise<CatalogPromotionRetentionCycleResult>;
}

export interface CatalogRetentionWorkerSleeper {
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export type CatalogRetentionWorkerLogEvent = Readonly<{
  level: "error" | "info";
  event:
    | "catalog_retention_worker_started"
    | "catalog_retention_worker_stopped"
    | "catalog_retention_cycle_finished"
    | "catalog_retention_cycle_failed";
  workerId: string;
  outcome?: CatalogPromotionRetentionCycleResult["outcome"];
  resumedBarrier?: boolean;
  steps?: number;
  networkRequests?: number;
  operationsAcknowledged?: number;
  postgresRowsDeleted?: number;
  failureCode?: "CATALOG_RETENTION_CYCLE_ERROR";
}>;

export interface CatalogRetentionWorkerLogger {
  write(event: CatalogRetentionWorkerLogEvent): void;
}

export interface CatalogRetentionWorkerRuntimePort {
  start(): Promise<void>;
  stop(): void;
}

const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;

const defaultSleeper: CatalogRetentionWorkerSleeper = {
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

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export class JsonConsoleCatalogRetentionWorkerLogger
implements CatalogRetentionWorkerLogger {
  write(event: CatalogRetentionWorkerLogEvent): void {
    const body = JSON.stringify(event);
    if (event.level === "error") console.error(body);
    else console.info(body);
  }
}

/** Independent retention cadence with prompt abort-aware shutdown. */
export class CatalogRetentionWorkerRuntime
implements CatalogRetentionWorkerRuntimePort {
  readonly #sleeper: CatalogRetentionWorkerSleeper;
  #cycleController: AbortController | null = null;
  #running = false;
  #sleepController: AbortController | null = null;
  #stopRequested = false;

  constructor(private readonly input: Readonly<{
    runner: CatalogRetentionCyclePort;
    logger: CatalogRetentionWorkerLogger;
    workerId: string;
    intervalMilliseconds: number;
    continuationIntervalMilliseconds: number;
    sleeper?: CatalogRetentionWorkerSleeper;
  }>) {
    if (!safeIdPattern.test(input.workerId) ||
        !Number.isSafeInteger(input.intervalMilliseconds) ||
        input.intervalMilliseconds < 60_000 ||
        input.intervalMilliseconds > 86_400_000 ||
        !Number.isSafeInteger(input.continuationIntervalMilliseconds) ||
        input.continuationIntervalMilliseconds < 100 ||
        input.continuationIntervalMilliseconds > 60_000 ||
        input.continuationIntervalMilliseconds > input.intervalMilliseconds) {
      throw new RangeError("Catalog retention worker runtime is invalid.");
    }
    this.#sleeper = input.sleeper ?? defaultSleeper;
  }

  async start(): Promise<void> {
    if (this.#running) throw new Error("Catalog retention worker is already running.");
    this.#running = true;
    this.#stopRequested = false;
    this.log({ level: "info", event: "catalog_retention_worker_started" });
    try {
      while (!this.#stopRequested) {
        const controller = new AbortController();
        this.#cycleController = controller;
        const result = await this.runCycle(controller.signal);
        this.#cycleController = null;
        if (this.#stopRequested || result?.outcome === "stopped") break;
        const wait = result?.outcome === "released"
          ? this.input.intervalMilliseconds
          : this.input.continuationIntervalMilliseconds;
        const sleepController = new AbortController();
        this.#sleepController = sleepController;
        await this.#sleeper.sleep(wait, sleepController.signal);
        this.#sleepController = null;
      }
    } finally {
      this.#cycleController?.abort();
      this.#cycleController = null;
      this.#sleepController = null;
      this.#running = false;
      this.log({ level: "info", event: "catalog_retention_worker_stopped" });
    }
  }

  stop(): void {
    this.#stopRequested = true;
    this.#cycleController?.abort();
    this.#sleepController?.abort();
  }

  async runCycle(
    signal?: AbortSignal,
  ): Promise<CatalogPromotionRetentionCycleResult | null> {
    try {
      const result = await this.input.runner.runCycle(signal);
      this.log({
        level: "info",
        event: "catalog_retention_cycle_finished",
        outcome: result.outcome,
        resumedBarrier: result.resumedBarrier,
        steps: safeCount(result.steps),
        networkRequests: safeCount(result.networkRequests),
        operationsAcknowledged: safeCount(result.operationsAcknowledged),
        postgresRowsDeleted: safeCount(result.postgresRowsDeleted),
      });
      return result;
    } catch {
      if (signal?.aborted !== true) {
        this.log({
          level: "error",
          event: "catalog_retention_cycle_failed",
          failureCode: "CATALOG_RETENTION_CYCLE_ERROR",
        });
      }
      return null;
    }
  }

  private log(
    event: Omit<CatalogRetentionWorkerLogEvent, "workerId">,
  ): void {
    try {
      this.input.logger.write({ ...event, workerId: this.input.workerId });
    } catch {
      // Logging is best effort and never weakens the durable barrier protocol.
    }
  }
}
