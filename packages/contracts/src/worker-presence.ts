/**
 * Shared worker-presence vocabulary.
 *
 * The pipeline's worker instances publish their liveness and the operating
 * settings they are actually running with. The persistence layer writes these
 * shapes and the service layer derives fleet status from them, so the
 * vocabulary lives here rather than being duplicated on either side.
 */

export type WorkerInstanceState = "running" | "stopped";

export type WorkerActivityKind =
  | "idle"
  | "scheduling"
  | "importing"
  | "estimated_ev"
  | "retention";

/** Coarse, bounded description of what an instance is doing right now. */
export interface WorkerActivity {
  readonly kind: WorkerActivityKind;
  readonly organizationId: string | null;
  readonly providerId: string | null;
  readonly runId: string | null;
}

export const IDLE_WORKER_ACTIVITY: WorkerActivity = Object.freeze({
  kind: "idle",
  organizationId: null,
  providerId: null,
  runId: null,
});

/**
 * Identity and build descriptor for one worker process lifetime. `instanceId`
 * is the same identity the instance stamps as `provider_schedules.claim_owner`
 * and `import_runs.lease_owner`, so claimed work traces to a named instance.
 */
export interface WorkerInstanceDescriptor {
  readonly instanceId: string;
  readonly version: string;
  readonly host: string;
  readonly runtimeVersion: string;
}

/**
 * The operating settings an instance is actually running with. Consumers read
 * these published values instead of keeping hard-coded copies of the worker's
 * cadence, staleness thresholds, lease durations, and retention windows.
 */
export interface WorkerEffectiveSettings {
  readonly heartbeatIntervalMs: number;
  readonly presenceStaleAfterMs: number;
  readonly runHeartbeatStaleAfterMs: number;
  readonly scheduleClaimLeaseMs: number;
  readonly importRunLeaseMs: number;
  readonly protectedPayloadRetentionDays: number;
  readonly presenceRetentionDays: number;
}

/**
 * Inclusive bounds for every published setting. The presence table carries the
 * same bounds as CHECK constraints; keeping one declaration here stops the
 * worker's configuration reader, the repository, and the database from drifting.
 */
export const WORKER_EFFECTIVE_SETTINGS_BOUNDS: Readonly<
  Record<keyof WorkerEffectiveSettings, readonly [number, number]>
> = Object.freeze({
  heartbeatIntervalMs: Object.freeze([1_000, 300_000] as const),
  presenceStaleAfterMs: Object.freeze([1_001, 86_400_000] as const),
  runHeartbeatStaleAfterMs: Object.freeze([1_000, 86_400_000] as const),
  scheduleClaimLeaseMs: Object.freeze([1_000, 3_600_000] as const),
  importRunLeaseMs: Object.freeze([1_000, 3_600_000] as const),
  protectedPayloadRetentionDays: Object.freeze([1, 3_650] as const),
  presenceRetentionDays: Object.freeze([1, 3_650] as const),
});

/**
 * True when every published setting is a whole number inside its bound and the
 * staleness threshold leaves room for at least one missed heartbeat.
 */
export function isWorkerEffectiveSettingsValid(
  settings: WorkerEffectiveSettings,
): boolean {
  for (const [name, bounds] of Object.entries(
    WORKER_EFFECTIVE_SETTINGS_BOUNDS,
  )) {
    const value = settings[name as keyof WorkerEffectiveSettings];
    const [minimum, maximum] = bounds;
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      return false;
    }
  }
  return settings.presenceStaleAfterMs > settings.heartbeatIntervalMs;
}
