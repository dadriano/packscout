import type {
  HeatPromotionAlertSink,
  HeatPromotionCycleResult,
  HeatPromotionHealth,
  HeatPromotionHealthSink,
} from "@packscout/services";

export interface HeatPromotionCyclePort {
  runCycle(
    frameEndedAt: Date,
    signal?: AbortSignal,
  ): Promise<HeatPromotionCycleResult>;
}

export interface HeatPromotionRetentionPort {
  runCycle(now: Date): Promise<Readonly<{
    batches: number;
    deletedOutcomes: number;
    deletedObservations: number;
    capReached: boolean;
  }>>;
}

export interface HeatPromotionWorkerSleeper {
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export type HeatPromotionWorkerLogEvent = Readonly<{
  level: "error" | "info";
  event:
    | "heat_promotion_worker_started" | "heat_promotion_worker_stopped"
    | "heat_promotion_cycle_finished" | "heat_promotion_cycle_failed"
    | "heat_promotion_terminal_alert" | "heat_promotion_health"
    | "heat_retention_finished" | "heat_retention_failed";
  workerId: string;
  outcome?: HeatPromotionCycleResult["outcome"];
  attemptId?: string;
  frameSequence?: string;
  operationsAcknowledged?: number;
  reusedSignalSet?: boolean;
  failureCode?: string;
  activeAttemptState?: string;
  confirmedFrameSequence?: string;
  manifestPublicReleaseId?: string;
  providerReferenceSetHash?: string;
  heatAlignmentCurrent?: boolean;
  confirmedFrameCalculatedAt?: string;
  confirmedFrameAgeSeconds?: number;
  confirmedFrameExpiresAt?: string;
  confirmedFrameExpired?: boolean;
  retryAt?: string;
  retentionBatches?: number;
  retentionDeletedOutcomes?: number;
  retentionDeletedObservations?: number;
  retentionCapReached?: boolean;
  occurredAt?: string;
}>;

export interface HeatPromotionWorkerLogger {
  write(event: HeatPromotionWorkerLogEvent): void;
}

export interface HeatPromotionWorkerRuntimePort {
  start(): Promise<void>;
  stop(): void;
}

const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const safeFailurePattern = /^[A-Z][A-Z0-9_]{0,127}$/u;
const safeSha256Pattern = /^[0-9a-f]{64}$/u;

const defaultSleeper: HeatPromotionWorkerSleeper = {
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
  return safeIdPattern.test(value) ? value : "invalid";
}

function safeFailure(value: string | null): string | undefined {
  if (value === null) return undefined;
  return safeFailurePattern.test(value) ? value : "HEAT_FAILURE_INVALID";
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function latestClosedHeatFrameBoundary(now: Date): Date {
  const milliseconds = now.getTime();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new RangeError("Heat worker clock is invalid.");
  }
  return new Date(Math.floor(milliseconds / 60_000) * 60_000);
}

export class JsonConsoleHeatPromotionWorkerLogger
  implements HeatPromotionWorkerLogger
{
  write(event: HeatPromotionWorkerLogEvent): void {
    const serialized = JSON.stringify(event);
    if (event.level === "error") console.error(serialized);
    else console.info(serialized);
  }
}

export class HeatPromotionWorkerTerminalAlertLogger
  implements HeatPromotionAlertSink
{
  constructor(
    private readonly logger: HeatPromotionWorkerLogger,
    private readonly workerId: string,
  ) {}

  notify(input: {
    attemptId: string;
    frameSequence: bigint;
    failureCode: string;
    occurredAt: Date;
  }): Promise<void> {
    this.logger.write({
      level: "error",
      event: "heat_promotion_terminal_alert",
      workerId: safeId(this.workerId),
      attemptId: safeId(input.attemptId),
      frameSequence: String(input.frameSequence),
      failureCode: safeFailure(input.failureCode) ?? "HEAT_FAILURE_INVALID",
      occurredAt: input.occurredAt.toISOString(),
    });
    return Promise.resolve();
  }
}

export class HeatPromotionWorkerHealthLogger
  implements HeatPromotionHealthSink
{
  constructor(
    private readonly logger: HeatPromotionWorkerLogger,
    private readonly workerId: string,
    private readonly clock: Readonly<{ now(): Date }> = { now: () => new Date() },
  ) {}

  report(health: HeatPromotionHealth): void {
    const now = this.clock.now();
    const calculatedAt = health.frameCalculatedAt;
    const expiresAt = health.frameExpiresAt;
    const validNow = Number.isFinite(now.getTime());
    const validCalculatedAt = calculatedAt !== null &&
      Number.isFinite(calculatedAt.getTime()) && validNow;
    const validExpiresAt = expiresAt !== null &&
      Number.isFinite(expiresAt.getTime()) && validNow;
    this.logger.write({
      level: "info",
      event: "heat_promotion_health",
      workerId: safeId(this.workerId),
      ...(health.activeAttemptState === null
        ? {} : { activeAttemptState: health.activeAttemptState }),
      confirmedFrameSequence: String(health.confirmedWatermark),
      ...(health.manifestAlignment === null ? {} : {
        manifestPublicReleaseId: safeId(
          health.manifestAlignment.publicReleaseId,
        ),
        providerReferenceSetHash:
          safeSha256Pattern.test(
            health.manifestAlignment.providerReferenceSetHash,
          )
            ? health.manifestAlignment.providerReferenceSetHash
            : "0".repeat(64),
        heatAlignmentCurrent: health.alignmentMatchesActiveManifest,
      }),
      ...(!validCalculatedAt ? {} : {
        confirmedFrameCalculatedAt: calculatedAt.toISOString(),
        confirmedFrameAgeSeconds: Math.min(
          Math.max(
            0,
            Math.floor((now.getTime() - calculatedAt.getTime()) / 1_000),
          ),
          31_536_000,
        ),
      }),
      ...(!validExpiresAt ? {} : {
        confirmedFrameExpiresAt: expiresAt.toISOString(),
        confirmedFrameExpired: now.getTime() >= expiresAt.getTime(),
      }),
      ...(health.retryAt === null ? {} : { retryAt: health.retryAt.toISOString() }),
    });
  }
}

export class HeatPromotionWorkerRuntime
  implements HeatPromotionWorkerRuntimePort
{
  readonly #sleeper: HeatPromotionWorkerSleeper;
  #cycleController: AbortController | null = null;
  #running = false;
  #sleepController: AbortController | null = null;
  #stopRequested = false;

  constructor(private readonly input: {
    runner: HeatPromotionCyclePort;
    retention: HeatPromotionRetentionPort;
    logger: HeatPromotionWorkerLogger;
    workerId: string;
    clock?: { now(): Date };
    sleeper?: HeatPromotionWorkerSleeper;
  }) {
    if (!safeIdPattern.test(input.workerId)) {
      throw new RangeError("Heat promotion worker identity is invalid.");
    }
    this.#sleeper = input.sleeper ?? defaultSleeper;
  }

  async start(): Promise<void> {
    if (this.#running) throw new Error("Heat promotion worker is already running.");
    this.#running = true;
    this.#stopRequested = false;
    this.log({ level: "info", event: "heat_promotion_worker_started" });
    let boundary = latestClosedHeatFrameBoundary(this.now());
    try {
      while (!this.#stopRequested) {
        const wait = boundary.getTime() - this.now().getTime();
        if (wait > 0) {
          const controller = new AbortController();
          this.#sleepController = controller;
          await this.#sleeper.sleep(wait, controller.signal);
          this.#sleepController = null;
          if (this.#stopRequested) break;
        }
        const controller = new AbortController();
        this.#cycleController = controller;
        await this.runBoundary(boundary, controller.signal);
        this.#cycleController = null;
        const following = new Date(boundary.getTime() + 60_000);
        const current = latestClosedHeatFrameBoundary(this.now());
        boundary = current > following ? current : following;
      }
    } finally {
      this.#cycleController?.abort();
      this.#cycleController = null;
      this.#sleepController = null;
      this.#running = false;
      this.log({ level: "info", event: "heat_promotion_worker_stopped" });
    }
  }

  stop(): void {
    this.#stopRequested = true;
    this.#cycleController?.abort();
    this.#sleepController?.abort();
  }

  async runBoundary(
    boundary: Date,
    signal?: AbortSignal,
  ): Promise<HeatPromotionCycleResult | null> {
    let result: HeatPromotionCycleResult | null = null;
    try {
      result = await this.input.runner.runCycle(boundary, signal);
      this.log({
        level: result.outcome === "failed" ? "error" : "info",
        event: "heat_promotion_cycle_finished",
        outcome: result.outcome,
        ...(result.attemptId === null ? {} : { attemptId: safeId(result.attemptId) }),
        ...(result.frameSequence === null
          ? {} : { frameSequence: String(result.frameSequence) }),
        operationsAcknowledged: safeCount(result.operationsAcknowledged),
        reusedSignalSet: result.reusedSignalSet,
        ...(safeFailure(result.failureCode) === undefined
          ? {} : { failureCode: safeFailure(result.failureCode) }),
      });
    } catch {
      if (signal?.aborted !== true) {
        this.log({
          level: "error",
          event: "heat_promotion_cycle_failed",
          failureCode: "HEAT_PROMOTION_CYCLE_ERROR",
        });
      }
    }
    if (signal?.aborted !== true) await this.runRetention();
    return result;
  }

  private async runRetention(): Promise<void> {
    try {
      const retained = await this.input.retention.runCycle(this.now());
      this.log({
        level: "info",
        event: "heat_retention_finished",
        retentionBatches: safeCount(retained.batches),
        retentionDeletedOutcomes: safeCount(retained.deletedOutcomes),
        retentionDeletedObservations: safeCount(retained.deletedObservations),
        retentionCapReached: retained.capReached,
      });
    } catch {
      this.log({
        level: "error",
        event: "heat_retention_failed",
        failureCode: "HEAT_RETENTION_CYCLE_ERROR",
      });
    }
  }

  private now(): Date {
    return this.input.clock?.now() ?? new Date();
  }

  private log(event: Omit<HeatPromotionWorkerLogEvent, "workerId">): void {
    this.input.logger.write({ ...event, workerId: this.input.workerId });
  }
}
