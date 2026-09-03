import {
  IDLE_WORKER_ACTIVITY,
  type WorkerActivity,
  type WorkerActivityKind,
} from "@packscout/contracts";
import type {
  ProviderImportExecutionPort,
  ProviderImportQueueExecutionPort,
  ProviderImportRunSummary,
  ProviderSchedulerResult,
  ProtectedPayloadRetentionCycleResult,
  EstimatedEvRecomputationCycleResult,
} from "@packscout/services";
import type { PromotionV2WorkerRuntimePort } from
  "./promotion-v2-worker-runtime.ts";
import type {
  HeatPromotionWorkerRuntimePort,
} from "./heat-promotion-worker-runtime.ts";
import type { CatalogRetentionWorkerRuntimePort } from
  "./catalog-retention-worker-runtime.ts";
import type {
  ProviderWorkerMessageOutboxCycleResult,
  ProviderWorkerMessageOutboxPort,
} from "./provider-worker-message-outbox.ts";
import type {
  ProviderWorkerWelcomeDispatchCycleResult,
  ProviderWorkerWelcomeDispatchPort,
} from "./provider-worker-welcome-dispatch.ts";

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

export interface ProviderWorkerStartupPrerequisitePort {
  run(signal: AbortSignal): Promise<void>;
}

/**
 * Durable liveness reporting. Every member is best-effort by contract: the
 * runtime never awaits `activity`, and a failed presence write must not
 * interrupt or fail import work.
 */
export interface ProviderWorkerPresencePort {
  start(): Promise<void>;
  activity(activity: WorkerActivity): void;
  stop(): Promise<void>;
}

export type ProviderWorkerLogEventName =
  | "provider_database_pool_failed"
  | "provider_promotion_v2_runtime_failed"
  | "provider_heat_promotion_runtime_failed"
  | "provider_catalog_retention_runtime_failed"
  | "provider_import_contended"
  | "provider_import_failed"
  | "provider_import_finished"
  | "provider_import_queue_failed"
  | "provider_message_outbox_cycle_failed"
  | "provider_message_outbox_cycle_finished"
  | "provider_welcome_dispatch_cycle_failed"
  | "provider_welcome_dispatch_cycle_finished"
  | "provider_estimated_ev_cycle_failed"
  | "provider_estimated_ev_cycle_finished"
  | "provider_retention_cycle_failed"
  | "provider_retention_cycle_finished"
  | "provider_source_supervisor_runtime_failed"
  | "provider_schedule_invalid"
  | "provider_schedule_processed"
  | "provider_scheduler_failed"
  | "provider_worker_presence_degraded"
  | "provider_worker_presence_recovered"
  | "provider_worker_presence_registered"
  | "provider_worker_presence_stopped"
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
  readonly retentionPruned?: number;
  readonly retentionPruneFailures?: number;
  readonly outboxClaimed?: number;
  readonly outboxSent?: number;
  readonly outboxSkipped?: number;
  readonly outboxRetrying?: number;
  readonly outboxFailed?: number;
  readonly outboxLost?: number;
  readonly outboxErrors?: number;
  readonly welcomeClaimed?: number;
  readonly welcomeEnqueued?: number;
  readonly welcomeDeduplicated?: number;
  readonly welcomeSkipped?: number;
  readonly welcomeErrors?: number;
  readonly welcomeCapReached?: boolean;
  readonly activityKind?: WorkerActivityKind;
  readonly presenceFailures?: number;
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
  readonly startupPrerequisite?: ProviderWorkerStartupPrerequisitePort;
  readonly scheduler: ProviderSchedulerPort;
  readonly imports: ProviderWorkerImportPort;
  readonly estimatedEv?: ProviderWorkerEstimatedEvPort;
  readonly promotion?: PromotionV2WorkerRuntimePort;
  readonly heatPromotion?: HeatPromotionWorkerRuntimePort;
  readonly catalogRetention?: CatalogRetentionWorkerRuntimePort;
  readonly sourceSupervisor?: Readonly<{
    start(): Promise<void>;
    stop(): Promise<void> | void;
  }>;
  readonly retention: ProviderWorkerRetentionPort;
  readonly messageOutbox?: ProviderWorkerMessageOutboxPort;
  readonly welcomeDispatch?: ProviderWorkerWelcomeDispatchPort;
  readonly presence?: ProviderWorkerPresencePort;
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
  #startupController: AbortController | null = null;
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

  /**
   * The identity this instance stamps on every schedule claim and import-run
   * lease. It is the same string the instance publishes as its presence record,
   * which is how the fleet view attributes a held run to a live worker.
   */
  get workerId(): string {
    return this.dependencies.workerId;
  }

  async start(): Promise<void> {
    if (this.#running) throw new Error("Provider worker is already running.");
    this.#running = true;
    this.#stopRequested = false;
    this.log({ level: "info", event: "provider_worker_started" });
    if (this.dependencies.startupPrerequisite !== undefined) {
      const controller = new AbortController();
      this.#startupController = controller;
      try {
        await this.dependencies.startupPrerequisite.run(controller.signal);
      } catch (error) {
        this.#startupController = null;
        this.#running = false;
        this.log({ level: "info", event: "provider_worker_stopped" });
        if (this.#stopRequested && controller.signal.aborted) return;
        throw error;
      }
      this.#startupController = null;
      if (this.#stopRequested) {
        this.#running = false;
        this.log({ level: "info", event: "provider_worker_stopped" });
        return;
      }
    }
    let promotionFailed = false;
    let promotionFailure: unknown;
    let signalPromotionFailure!: (error: unknown) => void;
    const promotionFailureSignal = new Promise<unknown>((resolve) => {
      signalPromotionFailure = resolve;
    });
    const promotionTask = this.dependencies.promotion === undefined
      ? null
      : (async () => await this.dependencies.promotion!.start())()
        .catch((error: unknown) => {
          promotionFailed = true;
          promotionFailure = error;
          signalPromotionFailure(error);
          this.log({
            level: "error",
            event: "provider_promotion_v2_runtime_failed",
            failureCode: "PROMOTION_V2_RUNTIME_ERROR",
          });
          // PromotionV2 absorbs transient failures internally. A rejected
          // runtime therefore represents a deterministic startup/proof refusal
          // and must fail the combined production worker closed.
          this.stop();
        });
    const heatTask = this.dependencies.heatPromotion === undefined
      ? null
      : (async () => await this.dependencies.heatPromotion!.start())()
        .catch(() => {
          this.log({
            level: "error",
            event: "provider_heat_promotion_runtime_failed",
            failureCode: "HEAT_PROMOTION_RUNTIME_ERROR",
          });
        });
    const catalogRetentionTask = this.dependencies.catalogRetention === undefined
      ? null
      : (async () => await this.dependencies.catalogRetention!.start())()
        .catch(() => {
          this.log({
            level: "error",
            event: "provider_catalog_retention_runtime_failed",
            failureCode: "CATALOG_RETENTION_RUNTIME_ERROR",
          });
        });
    let sourceSupervisorFailure: unknown;
    const sourceSupervisorTask = this.dependencies.sourceSupervisor === undefined
      ? null
      : (async () => await this.dependencies.sourceSupervisor!.start())()
        .catch((error: unknown) => {
          sourceSupervisorFailure = error;
          this.log({
            level: "error",
            event: "provider_source_supervisor_runtime_failed",
            failureCode: "PROVIDER_SOURCE_SUPERVISOR_RUNTIME_ERROR",
          });
          this.stop();
        });
    let sourceSupervisorStopFailure: unknown;
    // Registration is durable but best-effort: an instance that cannot publish
    // its presence still performs pipeline work.
    try {
      await this.dependencies.presence?.start();
    } catch {
      this.log({
        level: "error",
        event: "provider_worker_presence_degraded",
        failureCode: "WORKER_PRESENCE_START_FAILED",
      });
    }
    try {
      while (!this.#stopRequested) {
        const cycle = this.runCycle();
        const completion = await Promise.race([
          cycle.then(() => ({ kind: "cycle" as const })),
          promotionFailureSignal.then((error) => ({
            kind: "promotion_failure" as const,
            error,
          })),
        ]);
        if (completion.kind === "promotion_failure") {
          // A provider import port predates the abort-aware promotion lanes and
          // may never resolve. Do not let it mask a fail-closed promotion
          // startup refusal; retain a rejection handler for a late completion
          // and leave the stopped cycle to observe #stopRequested if it wakes.
          void cycle.catch(() => undefined);
          break;
        }
        if (this.#stopRequested) break;
        this.reportActivity(IDLE_WORKER_ACTIVITY);
        const controller = new AbortController();
        this.#sleepController = controller;
        await this.#sleeper.sleep(
          this.#pollIntervalMilliseconds,
          controller.signal,
        );
        this.#sleepController = null;
      }
    } finally {
      this.dependencies.promotion?.stop();
      this.dependencies.heatPromotion?.stop();
      this.dependencies.catalogRetention?.stop();
      try {
        await this.dependencies.sourceSupervisor?.stop();
      } catch (error) {
        // A failed supervisor stop must not replace start()'s outcome or skip
        // the cleanup below; it is logged here and rethrown after the stopped
        // log alongside the other captured lane failures.
        sourceSupervisorStopFailure = error;
        this.log({
          level: "error",
          event: "provider_source_supervisor_runtime_failed",
          failureCode: "PROVIDER_SOURCE_SUPERVISOR_STOP_ERROR",
        });
      }
      if (promotionFailed) {
        // A retained Heat adapter is expected to stop cooperatively, but it
        // cannot mask a fail-closed Task011 startup refusal. Keep a late
        // handler attached without joining an abort-ignoring sibling.
        if (heatTask !== null) void heatTask.then(() => undefined);
        if (catalogRetentionTask !== null) {
          void catalogRetentionTask.then(() => undefined);
        }
        await promotionTask;
      } else {
        await Promise.all([
          promotionTask,
          heatTask,
          catalogRetentionTask,
          sourceSupervisorTask,
        ]);
      }
      this.#sleepController = null;
      this.#running = false;
      try {
        await this.dependencies.presence?.stop();
      } catch {
        this.log({
          level: "error",
          event: "provider_worker_presence_degraded",
          failureCode: "WORKER_PRESENCE_STOP_FAILED",
        });
      }
      this.log({ level: "info", event: "provider_worker_stopped" });
    }
    if (promotionFailed) throw promotionFailure;
    if (sourceSupervisorFailure !== undefined) throw sourceSupervisorFailure;
    if (sourceSupervisorStopFailure !== undefined) {
      throw sourceSupervisorStopFailure;
    }
  }

  /**
   * Publishes coarse current activity. Presence is observational, so a throwing
   * reporter is swallowed rather than allowed to abort the cycle.
   */
  private reportActivity(activity: WorkerActivity): void {
    try {
      this.dependencies.presence?.activity(activity);
    } catch {
      this.log({
        level: "error",
        event: "provider_worker_presence_degraded",
        failureCode: "WORKER_PRESENCE_ACTIVITY_FAILED",
        activityKind: activity.kind,
      });
    }
  }

  stop(): void {
    this.#stopRequested = true;
    this.dependencies.promotion?.stop();
    this.dependencies.heatPromotion?.stop();
    this.dependencies.catalogRetention?.stop();
    this.#startupController?.abort();
    // start()'s finally awaits sourceSupervisor.stop() again and surfaces its
    // failure after cleanup; this detached copy only needs a rejection sink
    // so it can never become an unhandled rejection.
    void Promise.resolve(this.dependencies.sourceSupervisor?.stop())
      .catch(() => {});
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
        await this.processMessageOutbox();
        await this.processWelcomeDispatch();
      }
      return result;
    } finally {
      this.#cycleInProgress = false;
      this.reportActivity(IDLE_WORKER_ACTIVITY);
    }
  }

  private async processEstimatedEv(): Promise<void> {
    if (!this.dependencies.estimatedEv) return;
    this.reportActivity({
      kind: "estimated_ev",
      organizationId: null,
      providerId: null,
      runId: null,
    });
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

  private async processMessageOutbox(): Promise<void> {
    if (!this.dependencies.messageOutbox) return;
    this.reportActivity({
      kind: "message_outbox",
      organizationId: null,
      providerId: null,
      runId: null,
    });
    let result: ProviderWorkerMessageOutboxCycleResult;
    try {
      result = await this.dependencies.messageOutbox.runCycle();
    } catch {
      this.log({
        level: "error",
        event: "provider_message_outbox_cycle_failed",
        failureCode: "MESSAGE_OUTBOX_CYCLE_ERROR",
      });
      return;
    }
    // A gated pass between drain intervals is not an observable cycle.
    if (result.outcome === "waiting") return;
    const failures = result.outcome === "deferred"
      ? 0
      : safeCount(result.failed) + safeCount(result.errors);
    this.log({
      level: failures > 0 ? "error" : "info",
      event: "provider_message_outbox_cycle_finished",
      outcome:
        result.outcome === "deferred"
          ? "deferred"
          : failures > 0
            ? "degraded"
            : result.capReached
              ? "bounded"
              : "succeeded",
      outboxClaimed: safeCount(result.claimed),
      ...(result.outcome === "deferred"
        ? {}
        : {
            outboxSent: safeCount(result.sent),
            outboxSkipped: safeCount(result.skipped),
            outboxRetrying: safeCount(result.retrying),
            outboxFailed: safeCount(result.failed),
            outboxLost: safeCount(result.lost),
            outboxErrors: safeCount(result.errors),
          }),
      ...(failures > 0 ? { failureCode: "MESSAGE_OUTBOX_DELIVERY_FAILED" } : {}),
    });
  }

  private async processWelcomeDispatch(): Promise<void> {
    if (!this.dependencies.welcomeDispatch) return;
    // The dispatcher enqueues messages, so it reports under the same
    // activity kind as the outbox work it feeds.
    this.reportActivity({
      kind: "message_outbox",
      organizationId: null,
      providerId: null,
      runId: null,
    });
    let result: ProviderWorkerWelcomeDispatchCycleResult;
    try {
      result = await this.dependencies.welcomeDispatch.runCycle();
    } catch {
      this.log({
        level: "error",
        event: "provider_welcome_dispatch_cycle_failed",
        failureCode: "WELCOME_DISPATCH_CYCLE_ERROR",
      });
      return;
    }
    // A gated pass is not an observable cycle, and a deliberately disabled
    // or unconfigured dispatcher idles silently rather than filling the log
    // with a chosen state.
    if (
      result.outcome === "waiting" ||
      result.outcome === "disabled" ||
      result.outcome === "unconfigured"
    ) {
      return;
    }
    const failures = safeCount(result.errors);
    this.log({
      level: failures > 0 ? "error" : "info",
      event: "provider_welcome_dispatch_cycle_finished",
      outcome:
        failures > 0
          ? "degraded"
          : result.capReached
            ? "bounded"
            : "succeeded",
      welcomeClaimed: safeCount(result.claimed),
      welcomeEnqueued: safeCount(result.enqueued),
      welcomeDeduplicated: safeCount(result.deduplicated),
      welcomeSkipped: safeCount(result.skipped),
      welcomeErrors: failures,
      welcomeCapReached: result.capReached === true,
      ...(failures > 0 ? { failureCode: "WELCOME_DISPATCH_FAILED" } : {}),
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
    this.reportActivity({
      kind: "retention",
      organizationId: null,
      providerId: null,
      runId: null,
    });
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
    const failures = safeCount(result.failed) + safeCount(result.prunedFailures);
    this.log({
      level: failures > 0 ? "error" : "info",
      event: "provider_retention_cycle_finished",
      outcome: failures > 0 ? "degraded" : result.capReached ? "bounded" : "succeeded",
      retentionBatches: safeCount(result.batchesRun),
      retentionExpired: safeCount(result.expired),
      retentionFailures: failures,
      retentionDeferredOrganizations: safeCount(result.deferredOrganizations),
      retentionCapReached: result.capReached === true,
      retentionPruned: safeCount(result.prunedRecords),
      retentionPruneFailures: safeCount(result.prunedFailures),
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
    this.reportActivity({
      kind: "scheduling",
      organizationId: null,
      providerId: null,
      runId: null,
    });
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
    // The claimed run is stamped with this instance's lease owner identity, so
    // publishing the same identity's activity ties a stalled run to a name.
    this.reportActivity({
      kind: "importing",
      organizationId: scheduled.organizationId,
      providerId: scheduled.providerId,
      runId: scheduled.runId,
    });
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
    // The queue claim resolves its run inside the import service, so the
    // instance publishes the claim itself rather than a run it cannot name yet.
    this.reportActivity({
      kind: "scheduling",
      organizationId: null,
      providerId: null,
      runId: null,
    });
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
    try {
      this.dependencies.logger.write({
        ...event,
        workerId: this.dependencies.workerId,
      });
    } catch {
      // Best-effort logging never controls worker recovery or shutdown.
    }
  }
}
