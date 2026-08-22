import {
  isWorkerEffectiveSettingsValid,
  type WorkerActivity,
  type WorkerActivityKind,
  type WorkerEffectiveSettings,
  type WorkerInstanceDescriptor,
  type WorkerInstanceState,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import type { PackscoutPrismaClient } from "./database.ts";

/**
 * Durable worker presence. One row per running worker instance, keyed by the
 * identity the instance also stamps as `provider_schedules.claim_owner` and
 * `import_runs.lease_owner`, so a stalled run traces back to a named instance.
 *
 * Presence is observer-side only: workers write here, and the admin and
 * alerting read from here. Nothing connects to a worker process.
 */

export interface WorkerPresenceRecord {
  readonly instanceId: string;
  readonly state: WorkerInstanceState;
  readonly version: string;
  readonly host: string;
  readonly runtimeVersion: string;
  readonly startedAt: Date;
  readonly lastHeartbeatAt: Date;
  readonly stoppedAt: Date | null;
  readonly currentActivity: WorkerActivity;
  readonly activityStartedAt: Date | null;
  readonly effectiveSettings: WorkerEffectiveSettings;
}

const instanceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const activityKinds = new Set<WorkerActivityKind>([
  "idle",
  "scheduling",
  "importing",
  "estimated_ev",
  "retention",
  "message_outbox",
]);

interface WorkerInstanceRow {
  readonly instance_id: string;
  readonly state: WorkerInstanceState;
  readonly version: string;
  readonly host: string;
  readonly runtime_version: string;
  readonly started_at: Date;
  readonly last_heartbeat_at: Date;
  readonly stopped_at: Date | null;
  readonly activity_kind: WorkerActivityKind;
  readonly activity_organization_id: string | null;
  readonly activity_provider_id: string | null;
  readonly activity_run_id: string | null;
  readonly activity_started_at: Date | null;
  readonly heartbeat_interval_ms: number;
  readonly presence_stale_after_ms: number;
  readonly run_heartbeat_stale_after_ms: number;
  readonly schedule_claim_lease_ms: number;
  readonly import_run_lease_ms: number;
  readonly protected_payload_retention_days: number;
  readonly presence_retention_days: number;
}

function assertDescriptor(descriptor: WorkerInstanceDescriptor): void {
  const bounded = (value: string, maximum: number) =>
    value.length >= 1 && value.length <= maximum && !/[\r\n]/.test(value);
  if (
    !instanceIdPattern.test(descriptor.instanceId) ||
    !bounded(descriptor.version, 128) ||
    !bounded(descriptor.host, 128) ||
    !bounded(descriptor.runtimeVersion, 64)
  ) {
    throw new RangeError("Worker instance descriptor is invalid.");
  }
}

/**
 * Mirrors the table's CHECK constraints so an invalid presence report fails
 * before it reaches PostgreSQL, and so callers get one stable error shape.
 */
export function assertWorkerEffectiveSettings(
  settings: WorkerEffectiveSettings,
): void {
  if (!isWorkerEffectiveSettingsValid(settings)) {
    throw new RangeError("Worker effective settings are outside their bounds.");
  }
}

function assertActivity(activity: WorkerActivity): void {
  if (!activityKinds.has(activity.kind)) {
    throw new RangeError("Worker activity is invalid.");
  }
  const references = [
    activity.organizationId,
    activity.providerId,
    activity.runId,
  ];
  for (const reference of references) {
    if (reference !== null && !uuidPattern.test(reference)) {
      throw new RangeError("Worker activity is invalid.");
    }
  }
  if (activity.kind === "idle" && references.some((value) => value !== null)) {
    throw new RangeError("Worker activity is invalid.");
  }
  if (
    activity.kind === "importing" &&
    references.some((value) => value === null)
  ) {
    throw new RangeError("Worker activity is invalid.");
  }
}

function assertTimestamp(value: Date): void {
  if (!Number.isFinite(value.getTime())) {
    throw new RangeError("Worker presence timestamp is invalid.");
  }
}

function toRecord(row: WorkerInstanceRow): WorkerPresenceRecord {
  return {
    instanceId: row.instance_id,
    state: row.state,
    version: row.version,
    host: row.host,
    runtimeVersion: row.runtime_version,
    startedAt: row.started_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    stoppedAt: row.stopped_at,
    currentActivity: {
      kind: row.activity_kind,
      organizationId: row.activity_organization_id,
      providerId: row.activity_provider_id,
      runId: row.activity_run_id,
    },
    activityStartedAt: row.activity_started_at,
    effectiveSettings: {
      heartbeatIntervalMs: row.heartbeat_interval_ms,
      presenceStaleAfterMs: row.presence_stale_after_ms,
      runHeartbeatStaleAfterMs: row.run_heartbeat_stale_after_ms,
      scheduleClaimLeaseMs: row.schedule_claim_lease_ms,
      importRunLeaseMs: row.import_run_lease_ms,
      protectedPayloadRetentionDays: row.protected_payload_retention_days,
      presenceRetentionDays: row.presence_retention_days,
    },
  };
}

export class PrismaWorkerPresenceRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  /**
   * Registers a starting instance. A restart is a new instance record; reusing
   * an identity deliberately resets the record rather than resurrecting a
   * stopped one, so the fleet never shows two lives under one identity.
   */
  async register(input: {
    descriptor: WorkerInstanceDescriptor;
    startedAt: Date;
    effectiveSettings: WorkerEffectiveSettings;
  }): Promise<WorkerPresenceRecord> {
    assertDescriptor(input.descriptor);
    assertWorkerEffectiveSettings(input.effectiveSettings);
    assertTimestamp(input.startedAt);
    const settings = input.effectiveSettings;
    const row = await this.database.worker_instances.upsert({
      where: { instance_id: input.descriptor.instanceId },
      create: {
        instance_id: input.descriptor.instanceId,
        state: "running",
        version: input.descriptor.version,
        host: input.descriptor.host,
        runtime_version: input.descriptor.runtimeVersion,
        started_at: input.startedAt,
        last_heartbeat_at: input.startedAt,
        activity_kind: "idle",
        heartbeat_interval_ms: settings.heartbeatIntervalMs,
        presence_stale_after_ms: settings.presenceStaleAfterMs,
        run_heartbeat_stale_after_ms: settings.runHeartbeatStaleAfterMs,
        schedule_claim_lease_ms: settings.scheduleClaimLeaseMs,
        import_run_lease_ms: settings.importRunLeaseMs,
        protected_payload_retention_days: settings.protectedPayloadRetentionDays,
        presence_retention_days: settings.presenceRetentionDays,
      },
      update: {
        state: "running",
        version: input.descriptor.version,
        host: input.descriptor.host,
        runtime_version: input.descriptor.runtimeVersion,
        started_at: input.startedAt,
        last_heartbeat_at: input.startedAt,
        stopped_at: null,
        activity_kind: "idle",
        activity_organization_id: null,
        activity_provider_id: null,
        activity_run_id: null,
        activity_started_at: null,
        heartbeat_interval_ms: settings.heartbeatIntervalMs,
        presence_stale_after_ms: settings.presenceStaleAfterMs,
        run_heartbeat_stale_after_ms: settings.runHeartbeatStaleAfterMs,
        schedule_claim_lease_ms: settings.scheduleClaimLeaseMs,
        import_run_lease_ms: settings.importRunLeaseMs,
        protected_payload_retention_days: settings.protectedPayloadRetentionDays,
        presence_retention_days: settings.presenceRetentionDays,
      },
    });
    return toRecord(row as WorkerInstanceRow);
  }

  /**
   * Advances a running instance's heartbeat and current activity in one
   * statement. `activity_started_at` only moves when the activity itself
   * changes, so the admin can show how long a run has been worked.
   */
  async heartbeat(input: {
    instanceId: string;
    observedAt: Date;
    activity: WorkerActivity;
  }): Promise<boolean> {
    if (!instanceIdPattern.test(input.instanceId)) {
      throw new RangeError("Worker instance descriptor is invalid.");
    }
    assertActivity(input.activity);
    assertTimestamp(input.observedAt);
    const { kind, organizationId, providerId, runId } = input.activity;
    const updated = await this.database.$queryRaw<{ instance_id: string }[]>(
      Prisma.sql`
        update worker_instances
        set last_heartbeat_at = greatest(started_at, ${input.observedAt}),
            activity_kind = cast(${kind} as worker_activity_kind),
            activity_organization_id = cast(${organizationId} as uuid),
            activity_provider_id = cast(${providerId} as uuid),
            activity_run_id = cast(${runId} as uuid),
            activity_started_at = case
              when cast(${kind} as worker_activity_kind)
                = 'idle'::worker_activity_kind then null
              when activity_kind = cast(${kind} as worker_activity_kind)
                and activity_organization_id
                  is not distinct from cast(${organizationId} as uuid)
                and activity_provider_id
                  is not distinct from cast(${providerId} as uuid)
                and activity_run_id
                  is not distinct from cast(${runId} as uuid)
                and activity_started_at is not null
                then activity_started_at
              else greatest(started_at, ${input.observedAt})
            end
        where instance_id = ${input.instanceId}
          and state = 'running'::worker_instance_state
        returning instance_id
      `,
    );
    return updated.length === 1;
  }

  /** Clean shutdown. A vanished instance simply stops heartbeating instead. */
  async markStopped(input: {
    instanceId: string;
    stoppedAt: Date;
  }): Promise<boolean> {
    if (!instanceIdPattern.test(input.instanceId)) {
      throw new RangeError("Worker instance descriptor is invalid.");
    }
    assertTimestamp(input.stoppedAt);
    const stopped = await this.database.$queryRaw<{ instance_id: string }[]>(
      Prisma.sql`
        update worker_instances
        set state = 'stopped'::worker_instance_state,
            stopped_at = greatest(started_at, ${input.stoppedAt}),
            last_heartbeat_at = greatest(started_at, ${input.stoppedAt}),
            activity_kind = 'idle'::worker_activity_kind,
            activity_organization_id = null,
            activity_provider_id = null,
            activity_run_id = null,
            activity_started_at = null
        where instance_id = ${input.instanceId}
          and state = 'running'::worker_instance_state
        returning instance_id
      `,
    );
    return stopped.length === 1;
  }

  async getInstance(instanceId: string): Promise<WorkerPresenceRecord | null> {
    if (!instanceIdPattern.test(instanceId)) return null;
    const row = await this.database.worker_instances.findUnique({
      where: { instance_id: instanceId },
    });
    return row ? toRecord(row as WorkerInstanceRow) : null;
  }

  /** Fleet listing for the admin: most recently seen instances first. */
  async listInstances(
    input: { limit?: number } = {},
  ): Promise<readonly WorkerPresenceRecord[]> {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Worker presence listing limit is invalid.");
    }
    const rows = await this.database.worker_instances.findMany({
      orderBy: [{ last_heartbeat_at: "desc" }, { instance_id: "asc" }],
      take: limit,
    });
    return rows.map((row) => toRecord(row as WorkerInstanceRow));
  }

  /**
   * Bounded pruning of presence history, driven by the pipeline's existing
   * retention cycle. Instances that vanished stop heartbeating, so ageing out
   * by `last_heartbeat_at` retires crashed and stopped instances alike.
   */
  async prune(input: { cutoffAt: Date; limit: number }): Promise<number> {
    assertTimestamp(input.cutoffAt);
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 10_000
    ) {
      throw new RangeError("Worker presence prune request is invalid.");
    }
    const pruned = await this.database.$queryRaw<{ instance_id: string }[]>(
      Prisma.sql`
        delete from worker_instances
        where instance_id in (
          select instance_id
          from worker_instances
          where last_heartbeat_at <= ${input.cutoffAt}
          order by last_heartbeat_at asc, instance_id asc
          limit ${input.limit}
          for update skip locked
        )
        returning instance_id
      `,
    );
    return pruned.length;
  }
}
