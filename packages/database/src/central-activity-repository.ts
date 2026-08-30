import { createHash } from "node:crypto";
import {
  operationalNotificationSchema,
  type AdminAlertDetail,
  type AdminAlertOccurrence,
  type AdminAlertState,
  type AdminAlertSummary,
  type NotificationPublishResult,
  type OperationalNotification,
} from "@packscout/contracts";
import {
  Prisma as CentralPrisma,
  type admin_alerts as CentralAlertRow,
} from "../prisma/generated/central/index.js";
import {
  CENTRAL_TRANSACTION_OPTIONS,
  type CentralPrismaClient,
  type CentralTransactionClient,
} from "./central-database.ts";

const recoveryKinds = new Set<OperationalNotification["kind"]>([
  "provider_recovered",
  "quarantine_resolved",
  "retention_recovered",
  "promotion_recovered",
  "machinery_recovered",
]);

interface LockedAlertRow {
  readonly id: string;
  readonly state: AdminAlertState;
  readonly acknowledged_by_actor_key: string | null;
  readonly acknowledged_at: Date | null;
}

function toSummary(row: CentralAlertRow): AdminAlertSummary {
  return {
    id: row.id,
    kind: row.kind as OperationalNotification["kind"],
    severity: row.severity,
    state: row.state,
    title: row.title,
    summary: row.summary,
    providerId: row.provider_id,
    runId: row.run_id,
    quarantineId: row.quarantine_id,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    occurrenceCount: row.occurrence_count,
    reopenedCount: row.reopened_count,
    acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
  };
}

function canonicalObject(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

function eventDigest(event: OperationalNotification): string {
  return createHash("sha256")
    .update("packscout:central-activity:v1\0", "utf8")
    .update(canonicalObject({
      id: event.id,
      organizationId: event.organizationId,
      kind: event.kind,
      severity: event.severity,
      providerId: event.providerId,
      runId: event.runId,
      quarantineId: event.quarantineId,
      dedupeKey: event.dedupeKey,
      recoveryKey: event.recoveryKey,
      title: event.title,
      summary: event.summary,
      occurredAt: event.occurredAt,
      evidence: canonicalObject(event.evidence),
    }), "utf8")
    .digest("hex");
}

function activityPointer(event: OperationalNotification) {
  return event.providerId === null
    ? {
        latest_activity_event_id: null,
        latest_global_activity_event_id: event.id,
      }
    : {
        latest_activity_event_id: event.id,
        latest_global_activity_event_id: null,
      };
}

/**
 * Durable activity and alert projection in the central observer database.
 * Provider-independent events use the global ledger; provider observations
 * retain their provider identity without a cross-database foreign key.
 */
export class CentralAdminNotificationPublisher {
  constructor(private readonly central: CentralPrismaClient) {}

  async publish(
    input: OperationalNotification,
  ): Promise<NotificationPublishResult> {
    const parsed = operationalNotificationSchema.safeParse(input);
    if (!parsed.success) {
      return {
        status: "failed",
        alertId: null,
        failureCode: "INVALID_OPERATIONAL_EVENT",
      };
    }
    const event = parsed.data;
    const digest = eventDigest(event);
    return this.central.$transaction(async (transaction) => {
      const inserted = await this.insertActivity(
        transaction,
        event,
        digest,
      );
      if (!inserted) {
        const existingDigest = await this.readActivityDigest(
          transaction,
          event,
        );
        if (existingDigest !== digest) {
          return {
            status: "failed",
            alertId: null,
            failureCode: "OPERATIONAL_EVENT_ID_CONFLICT",
          };
        }
        const alert = await transaction.admin_alerts.findFirst({
          where: {
            organization_id: event.organizationId,
            OR: [
              event.providerId === null
                ? { latest_global_activity_event_id: event.id }
                : {
                    provider_id: event.providerId,
                    latest_activity_event_id: event.id,
                  },
              { dedupe_key: event.dedupeKey },
            ],
          },
          select: { id: true },
        });
        return {
          status: recoveryKinds.has(event.kind)
            ? "resolved"
            : "deduplicated",
          alertId: alert?.id ?? null,
          failureCode: null,
        };
      }

      if (recoveryKinds.has(event.kind)) {
        const active = await transaction.$queryRaw<readonly { id: string }[]>(
          CentralPrisma.sql`
            select id
            from admin_alerts
            where organization_id = ${event.organizationId}::uuid
              and recovery_key = ${event.recoveryKey}
              and state <> 'resolved'::alert_state
            for update
          `,
        );
        if (active.length > 0) {
          await transaction.admin_alerts.updateMany({
            where: {
              organization_id: event.organizationId,
              recovery_key: event.recoveryKey,
              state: { not: "resolved" },
            },
            data: {
              ...activityPointer(event),
              kind: event.kind,
              severity: event.severity,
              state: "resolved",
              title: event.title,
              summary: event.summary,
              provider_id: event.providerId,
              run_id: event.runId,
              quarantine_id: event.quarantineId,
              last_seen_at: new Date(event.occurredAt),
              occurrence_count: { increment: 1 },
              resolved_by_actor_key: "system:recovery",
              resolved_at: new Date(event.occurredAt),
            },
          });
        }
        return {
          status: "resolved",
          alertId: active[0]?.id ?? null,
          failureCode: null,
        };
      }

      const [current] = await this.lockAlertByDedupeKey(
        transaction,
        event.organizationId,
        event.dedupeKey,
      );
      if (current === undefined) {
        const created = await transaction.admin_alerts.createManyAndReturn({
          data: [this.alertValues(event)],
          skipDuplicates: true,
          select: { id: true },
        });
        if (created[0] !== undefined) {
          return {
            status: "accepted",
            alertId: created[0].id,
            failureCode: null,
          };
        }
      }
      const alertId = await this.createOrUpdateAlert(transaction, event);
      return {
        status: current?.state === "resolved" ? "accepted" : "deduplicated",
        alertId,
        failureCode: null,
      };
    }, CENTRAL_TRANSACTION_OPTIONS);
  }

  async listAlerts(input: Readonly<{
    organizationId: string;
    state?: AdminAlertState;
    limit: number;
  }>): Promise<readonly AdminAlertSummary[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new RangeError("Alert list limit must be between 1 and 100.");
    }
    const rows = await this.central.admin_alerts.findMany({
      where: {
        organization_id: input.organizationId,
        ...(input.state === undefined ? {} : { state: input.state }),
      },
      orderBy: [{ last_seen_at: "desc" }, { id: "desc" }],
      take: input.limit,
    });
    return rows.map(toSummary);
  }

  async getAlert(
    organizationId: string,
    alertId: string,
  ): Promise<AdminAlertDetail | null> {
    const alert = await this.central.admin_alerts.findFirst({
      where: { organization_id: organizationId, id: alertId },
    });
    if (alert === null) return null;
    const eventSelection = {
      id: true,
      event_type: true,
      severity: true,
      event_at: true,
      evidence: true,
    } as const;
    const events = alert.provider_id === null
      ? await this.central.global_activity_events.findMany({
          where: {
            organization_id: organizationId,
            recovery_key: alert.recovery_key,
          },
          orderBy: [{ event_at: "desc" }, { id: "desc" }],
          take: 100,
          select: eventSelection,
        })
      : await this.central.provider_activity_events.findMany({
          where: {
            organization_id: organizationId,
            provider_id: alert.provider_id,
            recovery_key: alert.recovery_key,
          },
          orderBy: [{ event_at: "desc" }, { id: "desc" }],
          take: 100,
          select: eventSelection,
        });
    const occurrences: AdminAlertOccurrence[] = events.map((event) => ({
      id: event.id,
      kind: event.event_type as OperationalNotification["kind"],
      severity: event.severity,
      occurredAt: event.event_at.toISOString(),
      evidence: event.evidence as OperationalNotification["evidence"],
    }));
    return { ...toSummary(alert), occurrences };
  }

  async acknowledge(input: Readonly<{
    organizationId: string;
    alertId: string;
    actorKey: string;
    acknowledgedAt: Date;
  }>): Promise<AdminAlertSummary | null> {
    return this.mutateAlert({ ...input, target: "acknowledged" });
  }

  async resolve(input: Readonly<{
    organizationId: string;
    alertId: string;
    actorKey: string;
    resolvedAt: Date;
  }>): Promise<AdminAlertSummary | null> {
    return this.mutateAlert({
      organizationId: input.organizationId,
      alertId: input.alertId,
      actorKey: input.actorKey,
      acknowledgedAt: input.resolvedAt,
      target: "resolved",
    });
  }

  private async insertActivity(
    transaction: CentralTransactionClient,
    event: OperationalNotification,
    digest: string,
  ): Promise<boolean> {
    const eventAt = new Date(event.occurredAt);
    if (event.providerId === null) {
      const inserted = await transaction.global_activity_events.createManyAndReturn({
        data: [{
          id: event.id,
          organization_id: event.organizationId,
          event_digest: digest,
          event_type: event.kind,
          severity: event.severity,
          dedupe_key: event.dedupeKey,
          recovery_key: event.recoveryKey,
          title: event.title,
          summary: event.summary,
          evidence: event.evidence,
          event_at: eventAt,
          received_at: eventAt,
        }],
        skipDuplicates: true,
        select: { id: true },
      });
      return inserted.length === 1;
    }
    const inserted = await transaction.provider_activity_events.createManyAndReturn({
      data: [{
        id: event.id,
        organization_id: event.organizationId,
        provider_id: event.providerId,
        origin: "central",
        event_digest: digest,
        event_type: event.kind,
        severity: event.severity,
        dedupe_key: event.dedupeKey,
        recovery_key: event.recoveryKey,
        local_run_id: null,
        local_quarantine_id: null,
        title: event.title,
        summary: event.summary,
        evidence: event.evidence,
        event_at: eventAt,
        received_at: eventAt,
      }],
      skipDuplicates: true,
      select: { id: true },
    });
    return inserted.length === 1;
  }

  private async readActivityDigest(
    transaction: CentralTransactionClient,
    event: OperationalNotification,
  ): Promise<string | null> {
    if (event.providerId === null) {
      const existing = await transaction.global_activity_events.findFirst({
        where: { id: event.id, organization_id: event.organizationId },
        select: { event_digest: true },
      });
      return existing?.event_digest ?? null;
    }
    const existing = await transaction.provider_activity_events.findFirst({
      where: {
        id: event.id,
        organization_id: event.organizationId,
        provider_id: event.providerId,
      },
      select: { event_digest: true },
    });
    return existing?.event_digest ?? null;
  }

  private async createOrUpdateAlert(
    transaction: CentralTransactionClient,
    event: OperationalNotification,
  ): Promise<string | null> {
    const [existing] = await this.lockAlertByDedupeKey(
      transaction,
      event.organizationId,
      event.dedupeKey,
    );
    if (existing === undefined) {
      const created = await transaction.admin_alerts.create({
        data: this.alertValues(event),
        select: { id: true },
      });
      return created.id;
    }
    const reopening = existing.state === "resolved";
    const updated = await transaction.admin_alerts.updateManyAndReturn({
      where: {
        organization_id: event.organizationId,
        id: existing.id,
      },
      data: {
        ...activityPointer(event),
        kind: event.kind,
        severity: event.severity,
        state: reopening ? "active" : existing.state,
        recovery_key: event.recoveryKey,
        title: event.title,
        summary: event.summary,
        provider_id: event.providerId,
        run_id: event.runId,
        quarantine_id: event.quarantineId,
        last_seen_at: new Date(event.occurredAt),
        occurrence_count: { increment: 1 },
        ...(reopening ? { reopened_count: { increment: 1 } } : {}),
        acknowledged_by_actor_key: reopening
          ? null
          : existing.acknowledged_by_actor_key,
        acknowledged_at: reopening ? null : existing.acknowledged_at,
        resolved_by_actor_key: null,
        resolved_at: null,
      },
      select: { id: true },
    });
    return updated[0]?.id ?? null;
  }

  private alertValues(
    event: OperationalNotification,
  ): CentralPrisma.admin_alertsCreateManyInput {
    return {
      organization_id: event.organizationId,
      ...activityPointer(event),
      kind: event.kind,
      severity: event.severity,
      state: "active",
      dedupe_key: event.dedupeKey,
      recovery_key: event.recoveryKey,
      title: event.title,
      summary: event.summary,
      provider_id: event.providerId,
      run_id: event.runId,
      quarantine_id: event.quarantineId,
      first_seen_at: new Date(event.occurredAt),
      last_seen_at: new Date(event.occurredAt),
    };
  }

  private async mutateAlert(input: Readonly<{
    organizationId: string;
    alertId: string;
    actorKey: string;
    acknowledgedAt: Date;
    target: "acknowledged" | "resolved";
  }>): Promise<AdminAlertSummary | null> {
    return this.central.$transaction(async (transaction) => {
      const [current] = await transaction.$queryRaw<readonly LockedAlertRow[]>(
        CentralPrisma.sql`
          select id, state, acknowledged_by_actor_key, acknowledged_at
          from admin_alerts
          where organization_id = ${input.organizationId}::uuid
            and id = ${input.alertId}::uuid
          for update
        `,
      );
      if (current === undefined) return null;
      const resolved = input.target === "resolved";
      const updated = await transaction.admin_alerts.updateManyAndReturn({
        where: {
          organization_id: input.organizationId,
          id: input.alertId,
        },
        data: {
          state: input.target,
          acknowledged_by_actor_key: resolved
            ? current.acknowledged_by_actor_key
            : input.actorKey,
          acknowledged_at: resolved
            ? current.acknowledged_at
            : input.acknowledgedAt,
          resolved_by_actor_key: resolved ? input.actorKey : null,
          resolved_at: resolved ? input.acknowledgedAt : null,
        },
      });
      await transaction.audit_events.create({
        data: {
          organization_id: input.organizationId,
          actor_key: input.actorKey,
          action: `provider.alert.${input.target}`,
          subject_type: "admin_alert",
          subject_id: input.alertId,
          outcome: "success",
          metadata_json: { state: input.target },
          occurred_at: input.acknowledgedAt,
        },
      });
      return updated[0] === undefined ? null : toSummary(updated[0]);
    }, CENTRAL_TRANSACTION_OPTIONS);
  }

  private lockAlertByDedupeKey(
    transaction: CentralTransactionClient,
    organizationId: string,
    dedupeKey: string,
  ): Promise<readonly LockedAlertRow[]> {
    return transaction.$queryRaw<readonly LockedAlertRow[]>(CentralPrisma.sql`
      select id, state, acknowledged_by_actor_key, acknowledged_at
      from admin_alerts
      where organization_id = ${organizationId}::uuid
        and dedupe_key = ${dedupeKey}
      for update
    `);
  }
}
