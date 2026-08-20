import {
  IDLE_WORKER_ACTIVITY,
  type WorkerActivity,
  type WorkerEffectiveSettings,
  type WorkerInstanceDescriptor,
} from "@packscout/contracts";
import { PROTECTED_PAYLOAD_RETENTION_DAYS } from "@packscout/database";
import type {
  WorkerPresenceObserver,
  WorkerPresenceService,
} from "@packscout/services";
import type { ProviderWorkerConfiguration } from "./runtime-config.ts";
import type {
  ProviderWorkerLogEvent,
  ProviderWorkerLogger,
  ProviderWorkerPresencePort,
} from "./provider-worker-runtime.ts";

type PresenceConfiguration = Pick<
  ProviderWorkerConfiguration,
  | "heartbeatIntervalMilliseconds"
  | "importRunLeaseMilliseconds"
  | "presenceRetentionDays"
  | "presenceStaleAfterMilliseconds"
  | "runHeartbeatStaleAfterMilliseconds"
  | "scheduleClaimLeaseMilliseconds"
>;

/**
 * The single place worker configuration becomes operating settings. The
 * composition hands this one object to the scheduler, the import service, the
 * retention cycle, and the presence reporter, so what an instance publishes
 * cannot drift from what it runs with.
 */
export function resolveWorkerEffectiveSettings(
  configuration: PresenceConfiguration,
): WorkerEffectiveSettings {
  return Object.freeze({
    heartbeatIntervalMs: configuration.heartbeatIntervalMilliseconds,
    presenceStaleAfterMs: configuration.presenceStaleAfterMilliseconds,
    runHeartbeatStaleAfterMs:
      configuration.runHeartbeatStaleAfterMilliseconds,
    scheduleClaimLeaseMs: configuration.scheduleClaimLeaseMilliseconds,
    importRunLeaseMs: configuration.importRunLeaseMilliseconds,
    // Sourced from the invariant the ingestion repository enforces, so the
    // published window cannot drift from the one evidence is written with.
    protectedPayloadRetentionDays: PROTECTED_PAYLOAD_RETENTION_DAYS,
    presenceRetentionDays: configuration.presenceRetentionDays,
  });
}

export function describeWorkerInstance(
  configuration: Pick<
    ProviderWorkerConfiguration,
    "workerHost" | "workerId" | "workerVersion"
  >,
  runtimeVersion: string = process.version,
): WorkerInstanceDescriptor {
  return Object.freeze({
    instanceId: configuration.workerId,
    version: configuration.workerVersion,
    host: configuration.workerHost,
    runtimeVersion,
  });
}

export interface ProviderWorkerHeartbeatTimer {
  schedule(intervalMilliseconds: number, tick: () => void): () => void;
}

const intervalTimer: ProviderWorkerHeartbeatTimer = {
  schedule(intervalMilliseconds, tick) {
    const timer = setInterval(tick, intervalMilliseconds);
    timer.unref?.();
    return () => clearInterval(timer);
  },
};

/**
 * Turns presence-reporting outcomes into the worker's structured log stream so
 * a degraded heartbeat is visible even though it never interrupts import work.
 */
export function createProviderWorkerPresenceObserver(
  logger: ProviderWorkerLogger,
): WorkerPresenceObserver {
  const write = (event: ProviderWorkerLogEvent) => {
    try {
      logger.write(event);
    } catch {
      // Presence reporting never depends on log delivery.
    }
  };
  return {
    reported({ kind, instanceId, activity, recoveredAfter }) {
      if (kind === "heartbeat" && recoveredAfter === 0) return;
      write({
        level: "info",
        event:
          kind === "stop"
            ? "provider_worker_presence_stopped"
            : recoveredAfter > 0
              ? "provider_worker_presence_recovered"
              : "provider_worker_presence_registered",
        workerId: instanceId,
        activityKind: activity.kind,
        ...(recoveredAfter > 0 ? { presenceFailures: recoveredAfter } : {}),
      });
    },
    degraded({ instanceId, failureCode, consecutiveFailures }) {
      write({
        level: "error",
        event: "provider_worker_presence_degraded",
        workerId: instanceId,
        failureCode,
        presenceFailures: consecutiveFailures,
      });
    },
  };
}

export interface ProviderWorkerPresenceDependencies {
  readonly service: WorkerPresenceService;
  readonly heartbeatIntervalMilliseconds: number;
  readonly timer?: ProviderWorkerHeartbeatTimer;
}

/**
 * Drives presence reporting on its own bounded cadence, independent of how long
 * an import cycle takes. Every report is serialized and best-effort: import work
 * never awaits a heartbeat and never fails because one could not be written.
 */
export class ProviderWorkerPresence implements ProviderWorkerPresencePort {
  readonly #timer: ProviderWorkerHeartbeatTimer;
  readonly #intervalMilliseconds: number;
  #cancel: (() => void) | null = null;
  #pending: Promise<void> = Promise.resolve();
  #activity: WorkerActivity = IDLE_WORKER_ACTIVITY;
  #running = false;

  constructor(
    private readonly dependencies: ProviderWorkerPresenceDependencies,
  ) {
    const interval = dependencies.heartbeatIntervalMilliseconds;
    if (!Number.isInteger(interval) || interval < 1_000 || interval > 300_000) {
      throw new RangeError("Worker heartbeat cadence is outside its bounds.");
    }
    this.#intervalMilliseconds = interval;
    this.#timer = dependencies.timer ?? intervalTimer;
  }

  get instanceId(): string {
    return this.dependencies.service.instanceId;
  }

  get effectiveSettings(): WorkerEffectiveSettings {
    return this.dependencies.service.effectiveSettings;
  }

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#activity = IDLE_WORKER_ACTIVITY;
    await this.dependencies.service.register();
    this.#cancel = this.#timer.schedule(this.#intervalMilliseconds, () => {
      this.enqueue();
    });
  }

  /**
   * Records what the instance is working on now. Fire-and-forget by contract:
   * callers in the import path must never await or fail on presence.
   */
  activity(activity: WorkerActivity): void {
    this.#activity = activity;
    if (!this.#running) return;
    this.enqueue();
  }

  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    this.#cancel?.();
    this.#cancel = null;
    this.#activity = IDLE_WORKER_ACTIVITY;
    await this.#pending;
    await this.dependencies.service.stop();
  }

  private enqueue(): void {
    // Whether a beat is owed is decided here, while the reporter is still
    // running, so a shutdown drains the beats it already accepted instead of
    // silently dropping the last activity it observed.
    if (!this.#running) return;
    const activity = this.#activity;
    const beat = async () => {
      await this.dependencies.service.heartbeat(activity);
    };
    this.#pending = this.#pending.then(beat, beat).then(
      () => undefined,
      () => undefined,
    );
  }
}
