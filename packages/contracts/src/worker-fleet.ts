/**
 * Shared vocabulary and derivations for the pipeline's worker fleet: instance
 * liveness, stalled import runs, and provider schedule health.
 *
 * The condition evaluations below are the single server-side judgement of
 * whether the machinery is running. The admin renders them and alerting
 * consumes the same functions, so the browser never recomputes a threshold and
 * the two surfaces cannot disagree about a silent fleet, a stalled run, or a
 * wedged schedule.
 *
 * Per-instance liveness and the run-heartbeat threshold stay with
 * `classifyWorkerPresence`, `workerPresenceAgeMs`, and `isImportRunStalled` in
 * the worker-presence service — one threshold comparison each, shared by the
 * worker, this view, and alerting. The evaluations here compose those verdicts
 * into the fleet-level and schedule-level conditions, and add the measures both
 * consumers quote, so one observation is described identically wherever it
 * surfaces.
 */

import type {
  WorkerActivityKind,
  WorkerEffectiveSettings,
  WorkerInstanceState,
} from "./worker-presence.ts";

/** Largest page either growable worker-fleet listing may return at once. */
export const WORKER_FLEET_PAGE_LIMIT = 50;

/**
 * How many instances, running import runs, or provider schedules one condition
 * evaluation reads. The evaluations are exact inside this bound; beyond it the
 * fleet is far larger than the product supports and the page says so rather
 * than reporting a count it did not measure.
 */
export const WORKER_FLEET_SCAN_LIMIT = 200;

/**
 * Derived liveness of one instance: its durable state combined with heartbeat
 * age against the staleness window that same instance published. Distinct from
 * `WorkerInstanceState`, which is only what the instance last wrote.
 */
export const workerLivenessStatuses = ["running", "stale", "stopped"] as const;

export type WorkerLivenessStatus = (typeof workerLivenessStatuses)[number];

/**
 * Whether an instance's current activity belongs to the reading workspace.
 * Presence is fleet-wide while the admin is tenant-scoped, so an activity in
 * another workspace is named as such and carries no identifiers.
 */
export type WorkerActivityScope = "idle" | "workspace" | "other_workspace";

export interface WorkerActivityView {
  readonly kind: WorkerActivityKind;
  readonly scope: WorkerActivityScope;
  /** Present only when `scope` is `workspace`, so deep links never cross tenants. */
  readonly providerId: string | null;
  readonly providerName: string | null;
  readonly runId: string | null;
  readonly startedAt: string | null;
  readonly ageMs: number | null;
}

export interface WorkerInstanceView {
  readonly instanceId: string;
  readonly status: WorkerLivenessStatus;
  readonly state: WorkerInstanceState;
  readonly version: string;
  readonly host: string;
  readonly runtimeVersion: string;
  readonly startedAt: string;
  readonly upForMs: number;
  readonly lastHeartbeatAt: string;
  readonly heartbeatAgeMs: number;
  readonly stoppedAt: string | null;
  readonly activity: WorkerActivityView;
  readonly effectiveSettings: WorkerEffectiveSettings;
}

export type WorkerFleetState =
  /** No presence record exists at all — a fresh deployment, or every record
   * aged past the retention window. No silence duration can honestly be given. */
  | "never_reported"
  /** Presence records exist but none is live: the fleet has gone quiet. */
  | "silent"
  /** Something is alive, and something is wrong. */
  | "degraded"
  /** Something is alive and nothing is stale, stalled, or wedged. */
  | "healthy";

export interface WorkerFleetInstanceFact {
  /** `classifyWorkerPresence`'s verdict for this instance. */
  readonly status: WorkerLivenessStatus;
  /** `workerPresenceAgeMs` for this instance. */
  readonly heartbeatAgeMs: number;
}

export interface WorkerFleetFacts {
  readonly now: string;
  readonly instances: readonly WorkerFleetInstanceFact[];
  readonly stalledRuns: number;
  readonly wedgedSchedules: number;
}

export interface WorkerFleetEvaluation {
  readonly state: WorkerFleetState;
  readonly observed: number;
  readonly live: number;
  readonly stale: number;
  readonly stopped: number;
  /**
   * How long the whole fleet has been quiet, measured from the most recent
   * heartbeat any instance published. `null` whenever no duration can be
   * measured, which is exactly the `never_reported` case.
   */
  readonly silentForMs: number | null;
  readonly stalledRuns: number;
  readonly wedgedSchedules: number;
}

export interface RunStallFacts {
  readonly now: string;
  /** `isImportRunStalled`'s verdict — the one run-heartbeat comparison. */
  readonly stalled: boolean;
  /** The run's own heartbeat, or its start when it has never beaten. */
  readonly lastSignalAt: string | null;
  readonly staleAfterMs: number | null;
}

export interface RunStallEvaluation {
  readonly stalled: boolean;
  readonly heartbeatAgeMs: number | null;
  readonly staleAfterMs: number | null;
  readonly overdueByMs: number | null;
}

export interface StalledRunView {
  readonly runId: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly platformKey: string;
  readonly trigger: "scheduled" | "manual" | "recovery";
  readonly startedAt: string | null;
  readonly lastHeartbeatAt: string | null;
  readonly stall: RunStallEvaluation;
  /** The `import_runs.lease_owner` identity, matching a worker instance id. */
  readonly leaseOwner: string | null;
  /** Whether a retained presence record still exists for that identity. */
  readonly leaseOwnerPresent: boolean;
  readonly leaseExpiresAt: string | null;
  readonly leaseExpired: boolean;
}

export type ScheduleHealthState =
  /** Next run is still in the future. */
  | "scheduled"
  /** Past due, but inside the window a live fleet is allowed to take. */
  | "due"
  /** Past due for longer than a live worker's own liveness window. */
  | "overdue"
  /** A claim outlived its expiry: the worker holding the schedule is gone. */
  | "claim_expired";

export interface ScheduleHealthFacts {
  readonly now: string;
  readonly nextDueAt: string;
  readonly claimOwner: string | null;
  readonly claimExpiresAt: string | null;
  readonly lastClaimedAt: string | null;
  /**
   * How long past due a schedule may sit before it counts as overdue, taken
   * from the presence-staleness window the fleet published: a live worker that
   * has not claimed within its own liveness window is not keeping up. `null`
   * when nothing has published settings, in which case a past-due schedule
   * reads as `due` rather than being judged against a threshold that does not
   * exist.
   */
  readonly overdueAfterMs: number | null;
}

export interface ScheduleHealthEvaluation {
  readonly state: ScheduleHealthState;
  readonly overdueByMs: number | null;
  readonly overdueAfterMs: number | null;
  readonly claimHeldForMs: number | null;
  readonly claimExpired: boolean;
}

export interface ScheduleHealthView {
  readonly providerId: string;
  readonly providerName: string;
  readonly platformKey: string;
  readonly nextDueAt: string;
  readonly health: ScheduleHealthEvaluation;
  readonly claimOwner: string | null;
  /** Whether a retained presence record still exists for the claim holder. */
  readonly claimOwnerPresent: boolean;
  readonly claimExpiresAt: string | null;
  readonly lastClaimedAt: string | null;
  readonly lastOutcome: string | null;
  readonly lastRunId: string | null;
}

export type WorkerSettingsSource =
  /** Nothing has published settings inside the retained window. */
  | "none"
  /** Every publisher agrees. */
  | "uniform"
  /** Publishers disagree; the most permissive value governs. */
  | "mixed";

export interface WorkerFleetSettingsResolution {
  readonly settings: WorkerEffectiveSettings | null;
  readonly source: WorkerSettingsSource;
  readonly publishers: number;
}

function elapsedMs(from: string | null, now: string): number | null {
  if (from === null) return null;
  const started = Date.parse(from);
  const observed = Date.parse(now);
  if (!Number.isFinite(started) || !Number.isFinite(observed)) return null;
  return Math.max(0, observed - started);
}

function remainingMs(until: string | null, now: string): number | null {
  if (until === null) return null;
  const deadline = Date.parse(until);
  const observed = Date.parse(now);
  if (!Number.isFinite(deadline) || !Number.isFinite(observed)) return null;
  return deadline - observed;
}

function safeCount(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function positiveWindow(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

const settingNames = [
  "heartbeatIntervalMs",
  "presenceStaleAfterMs",
  "runHeartbeatStaleAfterMs",
  "scheduleClaimLeaseMs",
  "importRunLeaseMs",
  "protectedPayloadRetentionDays",
  "presenceRetentionDays",
] as const satisfies readonly (keyof WorkerEffectiveSettings)[];

/**
 * The operating settings the fleet actually published, never a copy kept here.
 * When instances disagree the most permissive value governs each field, so a
 * fleet mid-rollout raises the fewest false conditions, and the resolution says
 * the values are mixed rather than presenting one instance as authoritative.
 *
 * These are published facts used to interpret observations, so a fleet that has
 * just died still tells the admin what "stale" meant while it was alive.
 */
export function resolveWorkerFleetSettings(
  published: readonly WorkerEffectiveSettings[],
): WorkerFleetSettingsResolution {
  const resolved: Record<string, number> = {};
  let publishers = 0;
  let mixed = false;
  for (const candidate of published) {
    const values = settingNames.map((name) => positiveWindow(candidate[name]));
    if (values.some((value) => value === null)) continue;
    publishers += 1;
    settingNames.forEach((name, index) => {
      const value = values[index] as number;
      const current = resolved[name];
      if (current === undefined) {
        resolved[name] = value;
        return;
      }
      if (current !== value) mixed = true;
      if (value > current) resolved[name] = value;
    });
  }
  if (publishers === 0) {
    return { settings: null, source: "none", publishers: 0 };
  }
  return {
    settings: {
      heartbeatIntervalMs: resolved.heartbeatIntervalMs as number,
      presenceStaleAfterMs: resolved.presenceStaleAfterMs as number,
      runHeartbeatStaleAfterMs: resolved.runHeartbeatStaleAfterMs as number,
      scheduleClaimLeaseMs: resolved.scheduleClaimLeaseMs as number,
      importRunLeaseMs: resolved.importRunLeaseMs as number,
      protectedPayloadRetentionDays:
        resolved.protectedPayloadRetentionDays as number,
      presenceRetentionDays: resolved.presenceRetentionDays as number,
    },
    source: mixed ? "mixed" : "uniform",
    publishers,
  };
}

/**
 * The fleet-level condition. Silent fleet death is otherwise invisible, so the
 * absence of any live instance is a first-class state carrying the duration of
 * the silence — measured from the most recent heartbeat anyone published. When
 * no presence record exists at all there is nothing to measure from, and the
 * evaluation reports `never_reported` with no duration rather than inventing
 * one.
 */
export function evaluateWorkerFleet(
  facts: WorkerFleetFacts,
): WorkerFleetEvaluation {
  let live = 0;
  let stale = 0;
  let stopped = 0;
  let quietestMs: number | null = null;
  for (const instance of facts.instances) {
    if (instance.status === "running") live += 1;
    else if (instance.status === "stale") stale += 1;
    else stopped += 1;
    const age = Number.isFinite(instance.heartbeatAgeMs)
      ? Math.max(0, instance.heartbeatAgeMs)
      : null;
    if (age !== null && (quietestMs === null || age < quietestMs)) {
      quietestMs = age;
    }
  }
  const base = {
    observed: facts.instances.length,
    live,
    stale,
    stopped,
    stalledRuns: safeCount(facts.stalledRuns),
    wedgedSchedules: safeCount(facts.wedgedSchedules),
  };
  if (base.observed === 0) {
    return { state: "never_reported", silentForMs: null, ...base };
  }
  if (live === 0) {
    return { state: "silent", silentForMs: quietestMs, ...base };
  }
  const impaired =
    stale > 0 || base.stalledRuns > 0 || base.wedgedSchedules > 0;
  return {
    state: impaired ? "degraded" : "healthy",
    silentForMs: null,
    ...base,
  };
}

/**
 * The measures behind one stalled run. The stall decision itself is
 * `isImportRunStalled` against the published run-heartbeat window, passed in as
 * `stalled`, so this never becomes a second opinion about whether a run is
 * stuck — only a shared description of how far past the window it is.
 */
export function evaluateRunStall(facts: RunStallFacts): RunStallEvaluation {
  const heartbeatAgeMs = elapsedMs(facts.lastSignalAt, facts.now);
  const staleAfterMs = positiveWindow(facts.staleAfterMs);
  const overdueByMs =
    facts.stalled && heartbeatAgeMs !== null && staleAfterMs !== null
      ? Math.max(0, heartbeatAgeMs - staleAfterMs)
      : null;
  return {
    stalled: facts.stalled,
    heartbeatAgeMs,
    staleAfterMs,
    overdueByMs,
  };
}

/**
 * Per-provider schedule condition. A claim held past its expiry outranks being
 * past due: the schedule is wedged behind a worker that is not coming back, and
 * that is the actionable fact. Being briefly past due is normal between worker
 * polls, so only a lapse longer than the fleet's own liveness window counts as
 * overdue.
 */
export function evaluateScheduleHealth(
  facts: ScheduleHealthFacts,
): ScheduleHealthEvaluation {
  const dueInMs = remainingMs(facts.nextDueAt, facts.now);
  // A schedule becomes claimable at its due instant, matching the scheduler's
  // own `next_due_at <= now` predicate, so the admin never reports a schedule
  // as still waiting when a worker would already take it.
  const overdueByMs = dueInMs !== null && dueInMs <= 0 ? -dueInMs : null;
  const overdueAfterMs = positiveWindow(facts.overdueAfterMs);
  const claimRemainingMs = remainingMs(facts.claimExpiresAt, facts.now);
  const claimExpired =
    facts.claimOwner !== null &&
    claimRemainingMs !== null &&
    claimRemainingMs <= 0;
  const measures = {
    overdueByMs,
    overdueAfterMs,
    claimHeldForMs: elapsedMs(facts.lastClaimedAt, facts.now),
    claimExpired,
  };
  if (claimExpired) return { state: "claim_expired", ...measures };
  if (overdueByMs === null) return { state: "scheduled", ...measures };
  if (overdueAfterMs !== null && overdueByMs > overdueAfterMs) {
    return { state: "overdue", ...measures };
  }
  return { state: "due", ...measures };
}

/** Schedule states that mean an operator has something to act on. */
export function isScheduleWedged(
  evaluation: Pick<ScheduleHealthEvaluation, "state">,
): boolean {
  return evaluation.state === "overdue" || evaluation.state === "claim_expired";
}
