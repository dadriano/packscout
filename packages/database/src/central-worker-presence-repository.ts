import {
  isWorkerEffectiveSettingsValid,
  type WorkerActivity,
  type WorkerActivityKind,
  type WorkerEffectiveSettings,
  type WorkerInstanceDescriptor,
  type WorkerInstanceState,
} from "@packscout/contracts";
import { Prisma as CentralPrisma } from
  "../prisma/generated/central/index.js";
import {
  CENTRAL_TRANSACTION_OPTIONS,
  type CentralPrismaClient,
  type CentralTransactionClient,
} from "./central-database.ts";
import type { WorkerPresenceRecord } from "./worker-presence-repository.ts";

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
  readonly row_version: bigint;
  readonly updated_at: Date;
}

function assertDescriptor(descriptor: WorkerInstanceDescriptor): void {
  const bounded = (value: string, maximum: number) =>
    value.length >= 1 && value.length <= maximum && !/[\r\n]/.test(value);
  if (
    !instanceIdPattern.test(descriptor.instanceId)
    || !bounded(descriptor.version, 128)
    || !bounded(descriptor.host, 128)
    || !bounded(descriptor.runtimeVersion, 64)
  ) {
    throw new RangeError("Worker instance descriptor is invalid.");
  }
}

export function assertCentralWorkerEffectiveSettings(
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
    activity.kind === "importing"
    && references.some((value) => value === null)
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

function nextTimestamp(current: Date, requested: Date): Date {
  return new Date(Math.max(requested.getTime(), current.getTime() + 1));
}

function sameActivity(row: WorkerInstanceRow, activity: WorkerActivity): boolean {
  return row.activity_kind === activity.kind
    && row.activity_organization_id === activity.organizationId
    && row.activity_provider_id === activity.providerId
    && row.activity_run_id === activity.runId;
}

function sameRegistration(
  row: WorkerInstanceRow,
  input: Readonly<{
    descriptor: WorkerInstanceDescriptor;
    startedAt: Date;
    effectiveSettings: WorkerEffectiveSettings;
  }>,
): boolean {
  const settings = input.effectiveSettings;
  return row.state === "running"
    && row.version === input.descriptor.version
    && row.host === input.descriptor.host
    && row.runtime_version === input.descriptor.runtimeVersion
    && row.started_at.getTime() === input.startedAt.getTime()
    && row.last_heartbeat_at.getTime() === input.startedAt.getTime()
    && row.stopped_at === null
    && row.activity_kind === "idle"
    && row.activity_organization_id === null
    && row.activity_provider_id === null
    && row.activity_run_id === null
    && row.activity_started_at === null
    && row.heartbeat_interval_ms === settings.heartbeatIntervalMs
    && row.presence_stale_after_ms === settings.presenceStaleAfterMs
    && row.run_heartbeat_stale_after_ms === settings.runHeartbeatStaleAfterMs
    && row.schedule_claim_lease_ms === settings.scheduleClaimLeaseMs
    && row.import_run_lease_ms === settings.importRunLeaseMs
    && row.protected_payload_retention_days ===
      settings.protectedPayloadRetentionDays
    && row.presence_retention_days === settings.presenceRetentionDays;
}

async function lockInstance(
  transaction: CentralTransactionClient,
  instanceId: string,
): Promise<WorkerInstanceRow | null> {
  const rows = await transaction.$queryRaw<readonly WorkerInstanceRow[]>(
    CentralPrisma.sql`
      select *
      from worker_instances
      where instance_id = ${instanceId}
      for update
    `,
  );
  return rows[0] ?? null;
}

/** Durable central runner presence; provider databases never own worker rows. */
export class CentralWorkerPresenceRepository {
  constructor(private readonly central: CentralPrismaClient) {}

  async register(input: Readonly<{
    descriptor: WorkerInstanceDescriptor;
    startedAt: Date;
    effectiveSettings: WorkerEffectiveSettings;
  }>): Promise<WorkerPresenceRecord> {
    assertDescriptor(input.descriptor);
    assertCentralWorkerEffectiveSettings(input.effectiveSettings);
    assertTimestamp(input.startedAt);
    return this.central.$transaction(async (transaction) => {
      await transaction.$executeRaw(CentralPrisma.sql`
        select pg_advisory_xact_lock(
          hashtextextended('worker_instances:' || ${input.descriptor.instanceId}, 0)
        )
      `);
      const current = await lockInstance(
        transaction,
        input.descriptor.instanceId,
      );
      const settings = input.effectiveSettings;
      if (current === null) {
        const created = await transaction.worker_instances.create({
          data: {
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
            protected_payload_retention_days:
              settings.protectedPayloadRetentionDays,
            presence_retention_days: settings.presenceRetentionDays,
          },
        });
        return toRecord(created as WorkerInstanceRow);
      }
      if (sameRegistration(current, input)) return toRecord(current);
      const updated = await transaction.worker_instances.updateMany({
        where: {
          instance_id: input.descriptor.instanceId,
          row_version: current.row_version,
        },
        data: {
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
          protected_payload_retention_days:
            settings.protectedPayloadRetentionDays,
          presence_retention_days: settings.presenceRetentionDays,
          row_version: { increment: 1 },
          updated_at: nextTimestamp(current.updated_at, input.startedAt),
        },
      });
      if (updated.count !== 1) {
        throw new Error("Central worker presence changed concurrently.");
      }
      const row = await lockInstance(transaction, input.descriptor.instanceId);
      if (row === null) throw new Error("Central worker presence disappeared.");
      return toRecord(row);
    }, CENTRAL_TRANSACTION_OPTIONS);
  }

  async heartbeat(input: Readonly<{
    instanceId: string;
    observedAt: Date;
    activity: WorkerActivity;
  }>): Promise<boolean> {
    if (!instanceIdPattern.test(input.instanceId)) {
      throw new RangeError("Worker instance descriptor is invalid.");
    }
    assertActivity(input.activity);
    assertTimestamp(input.observedAt);
    return this.central.$transaction(async (transaction) => {
      const current = await lockInstance(transaction, input.instanceId);
      if (current === null || current.state !== "running") return false;
      const heartbeatAt = new Date(Math.max(
        current.started_at.getTime(),
        input.observedAt.getTime(),
      ));
      const activityChanged = !sameActivity(current, input.activity);
      const activityStartedAt = input.activity.kind === "idle"
        ? null
        : activityChanged || current.activity_started_at === null
          ? heartbeatAt
          : current.activity_started_at;
      const material = heartbeatAt.getTime()
        !== current.last_heartbeat_at.getTime()
        || activityChanged
        || activityStartedAt?.getTime()
          !== current.activity_started_at?.getTime();
      if (!material) return true;
      const updated = await transaction.worker_instances.updateMany({
        where: {
          instance_id: input.instanceId,
          state: "running",
          row_version: current.row_version,
        },
        data: {
          last_heartbeat_at: heartbeatAt,
          activity_kind: input.activity.kind,
          activity_organization_id: input.activity.organizationId,
          activity_provider_id: input.activity.providerId,
          activity_run_id: input.activity.runId,
          activity_started_at: activityStartedAt,
          row_version: { increment: 1 },
          updated_at: nextTimestamp(current.updated_at, input.observedAt),
        },
      });
      return updated.count === 1;
    }, CENTRAL_TRANSACTION_OPTIONS);
  }

  async markStopped(input: Readonly<{
    instanceId: string;
    stoppedAt: Date;
  }>): Promise<boolean> {
    if (!instanceIdPattern.test(input.instanceId)) {
      throw new RangeError("Worker instance descriptor is invalid.");
    }
    assertTimestamp(input.stoppedAt);
    return this.central.$transaction(async (transaction) => {
      const current = await lockInstance(transaction, input.instanceId);
      if (current === null || current.state !== "running") return false;
      const stoppedAt = new Date(Math.max(
        current.started_at.getTime(),
        input.stoppedAt.getTime(),
      ));
      const updated = await transaction.worker_instances.updateMany({
        where: {
          instance_id: input.instanceId,
          state: "running",
          row_version: current.row_version,
        },
        data: {
          state: "stopped",
          stopped_at: stoppedAt,
          last_heartbeat_at: stoppedAt,
          activity_kind: "idle",
          activity_organization_id: null,
          activity_provider_id: null,
          activity_run_id: null,
          activity_started_at: null,
          row_version: { increment: 1 },
          updated_at: nextTimestamp(current.updated_at, input.stoppedAt),
        },
      });
      return updated.count === 1;
    }, CENTRAL_TRANSACTION_OPTIONS);
  }

  async getInstance(instanceId: string): Promise<WorkerPresenceRecord | null> {
    if (!instanceIdPattern.test(instanceId)) return null;
    const row = await this.central.worker_instances.findUnique({
      where: { instance_id: instanceId },
    });
    return row === null ? null : toRecord(row as WorkerInstanceRow);
  }

  async listInstances(
    input: Readonly<{ limit?: number }> = {},
  ): Promise<readonly WorkerPresenceRecord[]> {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Worker presence listing limit is invalid.");
    }
    const rows = await this.central.worker_instances.findMany({
      orderBy: [{ last_heartbeat_at: "desc" }, { instance_id: "asc" }],
      take: limit,
    });
    return rows.map((row) => toRecord(row as WorkerInstanceRow));
  }

  async prune(input: Readonly<{
    cutoffAt: Date;
    limit: number;
  }>): Promise<number> {
    assertTimestamp(input.cutoffAt);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 10_000) {
      throw new RangeError("Worker presence prune request is invalid.");
    }
    const rows = await this.central.$queryRaw<readonly { instance_id: string }[]>(
      CentralPrisma.sql`
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
    return rows.length;
  }
}
