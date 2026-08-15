import type {
  ProviderImportExecutionPort,
  ProviderImportQueueExecutionPort,
  ProviderImportRunSummary,
  ProviderSchedulerResult,
  ProtectedPayloadRetentionCycleResult,
  EstimatedEvRecomputationCycleResult,
} from "@packscout/services";
import type {
  CatalogPromotionWorkerRuntimePort,
} from "./catalog-promotion-worker-runtime.ts";

const safeLogValuePattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const safeFailureCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/;
const contentionCodes = new Set([
  "IMPORT_RUN_NOT_CLAIMABLE",
  "RUN_OWNERSHIP_LOST",
]);

export interface ProviderSchedulerPort {
  runOnce(workerId: string): Promise<ProviderSchedulerResult>;
}

export interface ProviderWorkerSleeper {
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface ProviderWorkerImportPort
  extends ProviderImportExecutionPort,
    ProviderImportQueueExecutionPort {}

export interface ProviderWorkerRetentionPort {
  runCycle(): Promise<ProtectedPayloadRetentionCycleResult>;
}

export interface ProviderWorkerEstimatedEvPort {
  runCycle(): Promise<EstimatedEvRecomputationCycleResult>;
}

export type ProviderWorkerLogEventName =
  | "provider_database_pool_failed"
  | "provider_catalog_promotion_runtime_failed"
  | "provider_import_contended"
  | "provider_import_failed"
  | "provider_import_finished"
  | "provider_import_queue_failed"
  | "provider_estimated_ev_cycle_failed"
  | "provider_estimated_ev_cycle_finished"
  | "provider_retention_cycle_failed"
  | "provider_retention_cycle_finished"
  | "provider_schedule_invalid"
  | "provider_schedule_processed"
  | "provider_scheduler_failed"
  | "provider_worker_started"
  | "provider_worker_stopped";

export interface ProviderWorkerLogEvent {
  readonly level: "error" | "info";
  readonly event: ProviderWorkerLogEventName;
  readonly workerId: string;
  readonly organizationId?: string;
  readonly providerId?: string;
  readonly runId?: string;
  readonly outcome?: string;
  readonly runState?: ProviderImportRunSummary["state"];
  readonly failureCode?: string;
  readonly retentionBatches?: number;
  readonly retentionExpired?: number;
  readonly retentionFailures?: number;
  readonly retentionDeferredOrganizations?: number;
  readonly retentionCapReached?: boolean;
  readonly evClaimed?: number;
  readonly evCompleted?: number;
  readonly evUnavailable?: number;
  readonly evFailures?: number;
  readonly evCapReached?: boolean;
}

export interface ProviderWorkerLogger {
  write(event: ProviderWorkerLogEvent): void;
}

export type ProviderWorkerCycleStopReason =
  | "claim_limit"
  | "idle"
  | "queue_failed"
  | "scheduler_failed"
  | "stopped";

export interface ProviderWorkerCycleResult {
  readonly claims: number;
  readonly executions: number;
  readonly contentions: number;
  readonly failures: number;
  readonly reason: ProviderWorkerCycleStopReason;
}

export interface ProviderWorkerRuntimeDependencies {
  readonly scheduler: ProviderSchedulerPort;
  readonly imports: ProviderWorkerImportPort;
  readonly estimatedEv?: ProviderWorkerEstimatedEvPort;
  readonly catalogPromotion?: CatalogPromotionWorkerRuntimePort;
  readonly retention: ProviderWorkerRetentionPort;
  readonly logger: ProviderWorkerLogger;
  readonly workerId: string;
  readonly pollIntervalMilliseconds?: number;
  readonly maximumClaimsPerCycle?: number;
  readonly sleeper?: ProviderWorkerSleeper;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${label} is outside its safe bounds.`);
  }
  return resolved;
}

function safeLogValue(value: string): string {
  return safeLogValuePattern.test(value) ? value : "invalid";
}

function safeCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return value;
}

function terminalFailureCode(value: string | null): string | undefined {
  if (value === null) return undefined;
  return safeFailureCodePattern.test(value)
    ? value
    : "IMPORT_FAILURE_CODE_INVALID";
}

function contentionCode(error: unknown): string | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    typeof error.code !== "string"
  ) {
    return null;
  }
  return contentionCodes.has(error.code) ? error.code : null;
}

const defaultSleeper: ProviderWorkerSleeper = {
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

export class JsonConsoleProviderWorkerLogger implements ProviderWorkerLogger {
  write(event: ProviderWorkerLogEvent): void {
    const serialized = JSON.stringify(event);
    if (event.level === "error") console.error(serialized);
    else console.info(serialized);
  }
}

export class ProviderWorkerRuntime {
  readonly #maximumClaimsPerCycle: number;
  readonly #pollIntervalMilliseconds: number;
  readonly #sleeper: ProviderWorkerSleeper;
  #cycleInProgress = false;
  #running = false;
  #sleepController: AbortController | null = null;
  #stopRequested = false;

  constructor(private readonly dependencies: ProviderWorkerRuntimeDependencies) {
    if (!safeLogValuePattern.test(dependencies.workerId)) {
      throw new RangeError("Provider worker ID is invalid.");
    }
    this.#pollIntervalMilliseconds = boundedInteger(
      dependencies.pollIntervalMilliseconds,
      1_000,
      100,
      60_000,
      "Provider worker poll interval",
    );
    this.#maximumClaimsPerCycle = boundedInteger(
      dependencies.maximumClaimsPerCycle,
      25,
      1,
      100,
      "Provider worker claim limit",
    );
    this.#sleeper = dependencies.sleeper ?? defaultSleeper;
  }

  async start(): Promise<void> {
    if (this.#running) throw new Error("Provider worker is already running.");
    this.#running = true;
    this.#stopRequested = false;
    this.log({ level: "info", event: "provider_worker_started" });
    const catalogTask = this.dependencies.catalogPromotion === undefined
      ? null
      : (async () => await this.dependencies.catalogPromotion!.start())()
        .catch(() => {
          this.log({
            level: "error",
            event: "provider_catalog_promotion_runtime_failed",
            failureCode: "CATALOG_PROMOTION_RUNTIME_ERROR",
          });
        });
    try {
      while (!this.#stopRequested) {
        await this.runCycle();
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
      this.dependencies.catalogPromotion?.stop();
      await catalogTask;
      this.#sleepController = null;
      this.#running = false;
      this.log({ level: "info", event: "provider_worker_stopped" });
    }
  }

  stop(): void {
    this.#stopRequested = true;
    this.dependencies.catalogPromotion?.stop();
    this.#sleepController?.abort();
  }

  async runCycle(): Promise<ProviderWorkerCycleResult> {
    if (this.#cycleInProgress) {
      throw new Error("Provider worker cycle is already running.");
    }
    this.#cycleInProgress = true;
    const counts = { claims: 0, executions: 0, contentions: 0, failures: 0 };
    try {
      const result = await this.runImportCycle(counts);
      if (result.reason !== "stopped") {
        await this.processEstimatedEv();
        await this.processRetention();
      }
      return result;
    } finally {
      this.#cycleInProgress = false;
    }
  }

  private async processEstimatedEv(): Promise<void> {
    if (!this.dependencies.estimatedEv) return;
    let result: EstimatedEvRecomputationCycleResult;
    try {
      result = await this.dependencies.estimatedEv.runCycle();
    } catch {
      this.log({
        level: "error",
        event: "provider_estimated_ev_cycle_failed",
        failureCode: "ESTIMATED_EV_CYCLE_ERROR",
      });
      return;
    }
    const failures = safeCount(result.failed + result.retrying + result.lost);
    this.log({
      level: failures > 0 ? "error" : "info",
      event: "provider_estimated_ev_cycle_finished",
      outcome: failures > 0 ? "degraded" : result.capReached ? "bounded" : "succeeded",
      evClaimed: safeCount(result.claimed),
      evCompleted: safeCount(result.completed),
      evUnavailable: safeCount(result.unavailable),
      evFailures: failures,
      evCapReached: result.capReached === true,
      ...(failures > 0
        ? { failureCode: "ESTIMATED_EV_REQUEST_FAILED" }
        : {}),
    });
  }

  private async runImportCycle(counts: {
    claims: number;
    executions: number;
    contentions: number;
    failures: number;
  }): Promise<ProviderWorkerCycleResult> {
    while (counts.claims < this.#maximumClaimsPerCycle) {
      if (this.#stopRequested) return { ...counts, reason: "stopped" };
      const schedule = await this.processSchedule(counts);
      if (schedule === "failed") {
        return { ...counts, reason: "scheduler_failed" };
      }
      if (this.#stopRequested) return { ...counts, reason: "stopped" };
      if (counts.claims === this.#maximumClaimsPerCycle) {
        return { ...counts, reason: "claim_limit" };
      }
      const queue = await this.processQueue(counts);
      if (queue === "failed") return { ...counts, reason: "queue_failed" };
      if (schedule === "idle" && queue === "idle") {
        return { ...counts, reason: "idle" };
      }
    }
    return { ...counts, reason: "claim_limit" };
  }

  private async processRetention(): Promise<void> {
    let result: ProtectedPayloadRetentionCycleResult;
    try {
      result = await this.dependencies.retention.runCycle();
    } catch {
      this.log({
        level: "error",
        event: "provider_retention_cycle_failed",
        failureCode: "RETENTION_CYCLE_ERROR",
      });
      return;
    }
    const failures = safeCount(result.failed);
    this.log({
      level: failures > 0 ? "error" : "info",
      event: "provider_retention_cycle_finished",
      outcome: failures > 0 ? "degraded" : result.capReached ? "bounded" : "succeeded",
      retentionBatches: safeCount(result.batchesRun),
      retentionExpired: safeCount(result.expired),
      retentionFailures: failures,
      retentionDeferredOrganizations: safeCount(result.deferredOrganizations),
      retentionCapReached: result.capReached === true,
      ...(failures > 0 ? { failureCode: "RETENTION_BATCH_FAILED" } : {}),
    });
  }

  private async processSchedule(
    counts: {
      claims: number;
      executions: number;
      contentions: number;
      failures: number;
    },
  ): Promise<"failed" | "idle" | "processed"> {
    let scheduled: ProviderSchedulerResult;
    try {
      scheduled = await this.dependencies.scheduler.runOnce(
        this.dependencies.workerId,
      );
    } catch {
      counts.failures += 1;
      this.log({ level: "error", event: "provider_scheduler_failed" });
      return "failed";
    }
    if (scheduled.kind === "idle") return "idle";
    counts.claims += 1;
    this.log({
      level: "info",
      event: "provider_schedule_processed",
      organizationId: safeLogValue(scheduled.organizationId),
      providerId: safeLogValue(scheduled.providerId),
      ...(scheduled.runId === null
        ? {}
        : { runId: safeLogValue(scheduled.runId) }),
      outcome: scheduled.kind,
    });
    if (scheduled.kind === "not_enabled") return "processed";
    if (scheduled.runId === null) {
      counts.failures += 1;
      this.log({
        level: "error",
        event: "provider_schedule_invalid",
        organizationId: safeLogValue(scheduled.organizationId),
        providerId: safeLogValue(scheduled.providerId),
        outcome: scheduled.kind,
      });
      return "processed";
    }
    try {
      const run = await this.dependencies.imports.executeImport({
        organizationId: scheduled.organizationId,
        runId: scheduled.runId,
        workerId: this.dependencies.workerId,
      });
      counts.executions += 1;
      this.logFinishedRun(run);
    } catch (error) {
      const code = contentionCode(error);
      if (code !== null) {
        counts.contentions += 1;
        this.log({
          level: "info",
          event: "provider_import_contended",
          organizationId: safeLogValue(scheduled.organizationId),
          providerId: safeLogValue(scheduled.providerId),
          runId: safeLogValue(scheduled.runId),
          failureCode: code,
        });
        return "processed";
      }
      counts.failures += 1;
      this.log({
        level: "error",
        event: "provider_import_failed",
        organizationId: safeLogValue(scheduled.organizationId),
        providerId: safeLogValue(scheduled.providerId),
        runId: safeLogValue(scheduled.runId),
        failureCode: "IMPORT_EXECUTION_ERROR",
      });
    }
    return "processed";
  }

  private async processQueue(counts: {
    claims: number;
    executions: number;
    contentions: number;
    failures: number;
  }): Promise<"failed" | "idle" | "processed"> {
    try {
      const result = await this.dependencies.imports.executeNextImport({
        workerId: this.dependencies.workerId,
      });
      if (result.kind === "idle") return "idle";
      counts.claims += 1;
      counts.executions += 1;
      this.logFinishedRun(result.run);
      return "processed";
    } catch (error) {
      const code = contentionCode(error);
      if (code !== null) {
        counts.claims += 1;
        counts.contentions += 1;
        this.log({
          level: "info",
          event: "provider_import_contended",
          failureCode: code,
        });
        return "processed";
      }
      counts.failures += 1;
      this.log({
        level: "error",
        event: "provider_import_queue_failed",
        failureCode: "IMPORT_QUEUE_EXECUTION_ERROR",
      });
      return "failed";
    }
  }

  private logFinishedRun(run: ProviderImportRunSummary): void {
    const failureCode = terminalFailureCode(run.failureCode);
    this.log({
      level: "info",
      event: "provider_import_finished",
      organizationId: safeLogValue(run.organizationId),
      providerId: safeLogValue(run.providerId),
      runId: safeLogValue(run.id),
      runState: run.state,
      ...(failureCode === undefined ? {} : { failureCode }),
    });
  }

  private log(
    event: Omit<ProviderWorkerLogEvent, "workerId">,
  ): void {
    this.dependencies.logger.write({
      ...event,
      workerId: this.dependencies.workerId,
    });
  }
}
