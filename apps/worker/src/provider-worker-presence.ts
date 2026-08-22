import { randomUUID } from "node:crypto";
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

/**
 * The identity one worker *process* answers to, for its whole lifetime and no
 * longer.
 *
 * `PACKSCOUT_WORKER_ID` is deployment configuration: replicas of the same
 * deployment share it, and a restarted process inherits the value its
 * predecessor used. Using it directly would let one replica mark another
 * stopped, overwrite the other's restart history, and stamp claims and leases
 * that cannot be traced back to the instance actually holding them. The
 * configured value is therefore a prefix — it still names the deployment in
 * logs and in the fleet view — and a per-process UUID makes the identity
 * distinct.
 */
export function resolveWorkerInstanceId(
  configuredWorkerId: string,
  processId: string = randomUUID(),
): string {
  return `${configuredWorkerId}:${processId}`;
}

/**
 * Describes this process to the presence store. Each call mints a new process
 * identity, so the composition resolves the descriptor once and reuses its
 * `instanceId` everywhere the same instance has to be recognised — presence,
 * schedule claims, and import-run leases all name one instance.
 */
export function describeWorkerInstance(
  configuration: Pick<
    ProviderWorkerConfiguration,
    "workerHost" | "workerId" | "workerVersion"
  >,
  runtimeVersion: string = process.version,
): WorkerInstanceDescriptor {
  return Object.freeze({
    instanceId: resolveWorkerInstanceId(configuration.workerId),
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
  #reporting = false;
  #owed = false;
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
    // A beat already owed still reports the last activity this instance
    // actually observed, and no further beat can be accepted behind it.
    await this.#pending;
    this.#activity = IDLE_WORKER_ACTIVITY;
    await this.dependencies.service.stop();
  }

  /**
   * Records that a beat is owed, while the reporter is still running, so a
   * shutdown reports the last activity it observed instead of silently dropping
   * it.
   *
   * Only the newest activity is worth reporting, so transitions that arrive
   * while a write is in flight collapse into a single owed beat rather than
   * queueing one write each. A worker moving through scheduling, estimated-EV,
   * retention, and idle every cycle therefore costs at most one extra write per
   * completed write, and a database that has stopped responding can hold at
   * most one in-flight beat and one owed beat — never a backlog that shutdown
   * has to drain.
   */
  private enqueue(): void {
    if (!this.#running) return;
    if (this.#reporting) {
      this.#owed = true;
      return;
    }
    this.#reporting = true;
    this.#pending = this.report();
  }

  private async report(): Promise<void> {
    try {
      for (;;) {
        this.#owed = false;
        try {
          await this.dependencies.service.heartbeat(this.#activity);
        } catch {
          // Presence is best-effort: the service already reported the failure,
          // and import work never depends on a heartbeat landing.
        }
        if (!this.#owed) return;
      }
    } finally {
      this.#reporting = false;
    }
  }
}
