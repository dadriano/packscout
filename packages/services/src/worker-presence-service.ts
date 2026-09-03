import {
  IDLE_WORKER_ACTIVITY,
  type WorkerActivity,
  type WorkerEffectiveSettings,
  type WorkerInstanceDescriptor,
  type WorkerInstanceState,
} from "@packscout/contracts";
import type { ProviderClock } from "./provider-configuration-service.ts";

/**
 * Reports one worker instance's liveness to the durable presence store, and
 * derives fleet status from what instances published.
 *
 * Presence reporting is strictly best-effort: an instance that cannot write a
 * heartbeat keeps importing and retries on its next beat. Every durable write
 * here therefore resolves rather than throws, and degradation is surfaced to
 * the observer for structured logging.
 */

export interface WorkerPresenceStore {
  register(input: {
    descriptor: WorkerInstanceDescriptor;
    startedAt: Date;
    effectiveSettings: WorkerEffectiveSettings;
  }): Promise<unknown>;
  heartbeat(input: {
    instanceId: string;
    observedAt: Date;
    activity: WorkerActivity;
  }): Promise<boolean>;
  markStopped(input: { instanceId: string; stoppedAt: Date }): Promise<boolean>;
}

export type WorkerPresenceReportKind = "register" | "heartbeat" | "stop";

export type WorkerPresenceFailureCode =
  | "WORKER_PRESENCE_RECORD_MISSING"
  | "WORKER_PRESENCE_WRITE_FAILED";

export interface WorkerPresenceObserver {
  reported(event: {
    readonly kind: WorkerPresenceReportKind;
    readonly instanceId: string;
    readonly activity: WorkerActivity;
    readonly recoveredAfter: number;
  }): void;
  degraded(event: {
    readonly kind: WorkerPresenceReportKind;
    readonly instanceId: string;
    readonly failureCode: WorkerPresenceFailureCode;
    readonly consecutiveFailures: number;
  }): void;
}

export interface WorkerPresenceServiceDependencies {
  readonly store: WorkerPresenceStore;
  readonly clock: ProviderClock;
  readonly descriptor: WorkerInstanceDescriptor;
  readonly effectiveSettings: WorkerEffectiveSettings;
  readonly observer?: WorkerPresenceObserver;
}

export class WorkerPresenceService {
  #consecutiveFailures = 0;
  #registered = false;
  #activity: WorkerActivity = IDLE_WORKER_ACTIVITY;

  constructor(
    private readonly dependencies: WorkerPresenceServiceDependencies,
  ) {}

  get instanceId(): string {
    return this.dependencies.descriptor.instanceId;
  }

  /** The settings this instance publishes and is actually running with. */
  get effectiveSettings(): WorkerEffectiveSettings {
    return this.dependencies.effectiveSettings;
  }

  get currentActivity(): WorkerActivity {
    return this.#activity;
  }

  get consecutiveFailures(): number {
    return this.#consecutiveFailures;
  }

  async register(): Promise<boolean> {
    return this.report("register", async () => {
      await this.dependencies.store.register({
        descriptor: this.dependencies.descriptor,
        startedAt: this.dependencies.clock.now(),
        effectiveSettings: this.dependencies.effectiveSettings,
      });
      this.#registered = true;
      this.#activity = IDLE_WORKER_ACTIVITY;
      return true;
    });
  }

  /**
   * Advances the heartbeat and publishes the current activity. A record that
   * has gone missing — pruned, or never registered because registration
   * failed — is re-registered on the next beat rather than lost for good.
   */
  async heartbeat(activity: WorkerActivity = this.#activity): Promise<boolean> {
    this.#activity = activity;
    if (!this.#registered) {
      const registered = await this.register();
      if (!registered) return false;
    }
    return this.report("heartbeat", async () => {
      const advanced = await this.dependencies.store.heartbeat({
        instanceId: this.instanceId,
        observedAt: this.dependencies.clock.now(),
        activity,
      });
      if (!advanced) this.#registered = false;
      return advanced;
    });
  }

  /** Clean shutdown: the record is marked stopped rather than left to age out. */
  async stop(): Promise<boolean> {
    this.#activity = IDLE_WORKER_ACTIVITY;
    return this.report("stop", async () => {
      const stopped = await this.dependencies.store.markStopped({
        instanceId: this.instanceId,
        stoppedAt: this.dependencies.clock.now(),
      });
      this.#registered = false;
      return stopped;
    });
  }

  private async report(
    kind: WorkerPresenceReportKind,
    write: () => Promise<boolean>,
  ): Promise<boolean> {
    let succeeded: boolean;
    try {
      succeeded = await write();
    } catch {
      this.notifyDegraded(kind, "WORKER_PRESENCE_WRITE_FAILED");
      return false;
    }
    if (!succeeded) {
      this.notifyDegraded(kind, "WORKER_PRESENCE_RECORD_MISSING");
      return false;
    }
    const recoveredAfter = this.#consecutiveFailures;
    this.#consecutiveFailures = 0;
    try {
      this.dependencies.observer?.reported({
        kind,
        instanceId: this.instanceId,
        activity: this.#activity,
        recoveredAfter,
      });
    } catch {
      // Presence reporting never depends on observability delivery.
    }
    return true;
  }

  private notifyDegraded(
    kind: WorkerPresenceReportKind,
    failureCode: WorkerPresenceFailureCode,
  ): void {
    this.#consecutiveFailures += 1;
    try {
      this.dependencies.observer?.degraded({
        kind,
        instanceId: this.instanceId,
        failureCode,
        consecutiveFailures: this.#consecutiveFailures,
      });
    } catch {
      // A failed presence write is already the degradation being reported.
    }
  }
}

export type WorkerPresenceStatus = "running" | "stale" | "stopped";

export interface WorkerPresenceSnapshot {
  readonly state: WorkerInstanceState;
  readonly lastHeartbeatAt: Date;
  readonly effectiveSettings: Pick<
    WorkerEffectiveSettings,
    "presenceStaleAfterMs"
  >;
}

/** Age of an instance's most recent heartbeat, floored at zero. */
export function workerPresenceAgeMs(
  record: Pick<WorkerPresenceSnapshot, "lastHeartbeatAt">,
  now: Date,
): number {
  return Math.max(0, now.getTime() - record.lastHeartbeatAt.getTime());
}

/**
 * Stale/presumed-dead is derived by consumers from heartbeat age against the
 * threshold the instance itself published, never from a hard-coded copy.
 */
export function classifyWorkerPresence(
  record: WorkerPresenceSnapshot,
  now: Date,
): WorkerPresenceStatus {
  if (record.state === "stopped") return "stopped";
  return workerPresenceAgeMs(record, now) >
    record.effectiveSettings.presenceStaleAfterMs
    ? "stale"
    : "running";
}

export interface ImportRunHeartbeatSnapshot {
  readonly state: "queued" | "running" | "succeeded" | "incomplete" | "failed";
  readonly heartbeatAt: Date | null;
  readonly startedAt: Date | null;
}

/**
 * A running import run counts as stalled once its own heartbeat is older than
 * the published run-heartbeat threshold. Stalled runs are detected from durable
 * run data, not from presence records, and attributed to an instance through
 * the shared lease-owner identity.
 */
export function isImportRunStalled(
  run: ImportRunHeartbeatSnapshot,
  settings: Pick<WorkerEffectiveSettings, "runHeartbeatStaleAfterMs">,
  now: Date,
): boolean {
  if (run.state !== "running") return false;
  const lastSignal = run.heartbeatAt ?? run.startedAt;
  if (lastSignal === null) return false;
  return (
    now.getTime() - lastSignal.getTime() > settings.runHeartbeatStaleAfterMs
  );
}
