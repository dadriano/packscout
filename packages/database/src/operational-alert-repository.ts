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
  Prisma,
  type admin_alerts as AlertRow,
  type operational_events as OperationalEventRow,
} from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutTransactionClient,
} from "./database.ts";

const recoveryKinds = new Set<OperationalNotification["kind"]>([
  "provider_recovered",
  "quarantine_resolved",
  "retention_recovered",
]);

interface LockedAlertRow {
  readonly id: string;
  readonly state: AdminAlertState;
  readonly acknowledged_by_actor_key: string | null;
  readonly acknowledged_at: Date | null;
}

function toSummary(row: AlertRow): AdminAlertSummary {
  return {
    id: row.id,
    kind: row.kind,
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

function evidenceMatches(
  stored: Prisma.JsonValue,
  expected: OperationalNotification["evidence"],
): boolean {
  if (stored === null || Array.isArray(stored) || typeof stored !== "object") {
    return false;
  }
  const storedKeys = Object.keys(stored).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (
    storedKeys.length !== expectedKeys.length ||
    storedKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    return false;
  }
  return expectedKeys.every((key) => stored[key] === expected[key as keyof typeof expected]);
}

function eventMatches(
  stored: OperationalEventRow,
  event: OperationalNotification,
): boolean {
  return (
    stored.organization_id === event.organizationId &&
    stored.kind === event.kind &&
    stored.severity === event.severity &&
    stored.provider_id === event.providerId &&
    stored.run_id === event.runId &&
    stored.quarantine_id === event.quarantineId &&
    stored.dedupe_key === event.dedupeKey &&
    stored.recovery_key === event.recoveryKey &&
    stored.title === event.title &&
    stored.summary === event.summary &&
    stored.occurred_at.getTime() === new Date(event.occurredAt).getTime() &&
    evidenceMatches(stored.evidence_json, event.evidence)
  );
}

export class PrismaAdminNotificationPublisher {
  constructor(private readonly database: PackscoutPrismaClient) {}

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
    return this.database.$transaction(async (transaction) => {
      const insertedEvents = await transaction.operational_events.createManyAndReturn({
        data: [this.eventValues(event)],
        skipDuplicates: true,
        select: { id: true },
      });
      if (insertedEvents.length === 0) {
        const existingEvent = await transaction.operational_events.findFirst({
          where: {
            id: event.id,
            organization_id: event.organizationId,
          },
        });
        if (!existingEvent || !eventMatches(existingEvent, event)) {
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
              { latest_event_id: event.id },
              { dedupe_key: event.dedupeKey },
            ],
          },
          select: { id: true },
        });
        return {
          status: recoveryKinds.has(event.kind) ? "resolved" : "deduplicated",
          alertId: alert?.id ?? null,
          failureCode: null,
        };
      }

      if (recoveryKinds.has(event.kind)) {
        const active = await transaction.$queryRaw<readonly { id: string }[]>(
          Prisma.sql`
            select id
            from admin_alerts
            where organization_id = ${event.organizationId}::uuid
              and recovery_key = ${event.recoveryKey}
              and state <> 'resolved'::admin_alert_state
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
              latest_event_id: event.id,
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
          return {
            status: "resolved",
            alertId: active[0]?.id ?? null,
            failureCode: null,
          };
        }
        // A recovery closes an existing condition; it must not create a
        // standalone resolved alert when no matching condition was active.
        return { status: "resolved", alertId: null, failureCode: null };
      }

      const [current] = await this.lockAlertByDedupeKey(
        transaction,
        event.organizationId,
        event.dedupeKey,
      );
      if (!current) {
        const created = await transaction.admin_alerts.createManyAndReturn({
          data: [this.alertValues(event, false)],
          skipDuplicates: true,
          select: { id: true },
        });
        if (created[0]) {
          return { status: "accepted", alertId: created[0].id, failureCode: null };
        }
      }
      const alertId = await this.createOrUpdateAlert(transaction, event, false);
      return {
        status: current?.state === "resolved" ? "accepted" : "deduplicated",
        alertId,
        failureCode: null,
      };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async listAlerts(input: {
    organizationId: string;
    state?: AdminAlertState;
    limit: number;
  }): Promise<readonly AdminAlertSummary[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new RangeError("Alert list limit must be between 1 and 100.");
    }
    const rows = await this.database.admin_alerts.findMany({
      where: {
        organization_id: input.organizationId,
        ...(input.state ? { state: input.state } : {}),
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
    const alert = await this.database.admin_alerts.findFirst({
      where: { organization_id: organizationId, id: alertId },
    });
    if (!alert) return null;
    const events = await this.database.operational_events.findMany({
      where: {
        organization_id: organizationId,
        recovery_key: alert.recovery_key,
      },
      orderBy: [{ occurred_at: "desc" }, { id: "desc" }],
      take: 100,
      select: {
        id: true,
        kind: true,
        severity: true,
        occurred_at: true,
        evidence_json: true,
      },
    });
    const occurrences: AdminAlertOccurrence[] = events.map((event) => ({
      id: event.id,
      kind: event.kind,
      severity: event.severity,
      occurredAt: event.occurred_at.toISOString(),
      evidence: event.evidence_json as OperationalNotification["evidence"],
    }));
    return { ...toSummary(alert), occurrences };
  }

  async acknowledge(input: {
    organizationId: string;
    alertId: string;
    actorKey: string;
    acknowledgedAt: Date;
  }): Promise<AdminAlertSummary | null> {
    return this.mutateAlert({ ...input, target: "acknowledged" });
  }

  async resolve(input: {
    organizationId: string;
    alertId: string;
    actorKey: string;
    resolvedAt: Date;
  }): Promise<AdminAlertSummary | null> {
    return this.mutateAlert({
      organizationId: input.organizationId,
      alertId: input.alertId,
      actorKey: input.actorKey,
      acknowledgedAt: input.resolvedAt,
      target: "resolved",
    });
  }

  private async createOrUpdateAlert(
    database: PackscoutTransactionClient,
    event: OperationalNotification,
    resolved: boolean,
  ): Promise<string | null> {
    const [existing] = await this.lockAlertByDedupeKey(
      database,
      event.organizationId,
      event.dedupeKey,
    );
    if (!existing) {
      const created = await database.admin_alerts.create({
        data: this.alertValues(event, resolved),
        select: { id: true },
      });
      return created.id;
    }
    const reopening = !resolved && existing.state === "resolved";
    const updated = await database.admin_alerts.updateManyAndReturn({
      where: {
        organization_id: event.organizationId,
        id: existing.id,
      },
      data: {
        latest_event_id: event.id,
        kind: event.kind,
        severity: event.severity,
        state: resolved ? "resolved" : reopening ? "active" : existing.state,
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
        resolved_by_actor_key: resolved ? "system:recovery" : null,
        resolved_at: resolved ? new Date(event.occurredAt) : null,
      },
      select: { id: true },
    });
    return updated[0]?.id ?? null;
  }

  private eventValues(
    event: OperationalNotification,
  ): Prisma.operational_eventsCreateManyInput {
    return {
      id: event.id,
      organization_id: event.organizationId,
      kind: event.kind,
      severity: event.severity,
      provider_id: event.providerId,
      run_id: event.runId,
      quarantine_id: event.quarantineId,
      dedupe_key: event.dedupeKey,
      recovery_key: event.recoveryKey,
      title: event.title,
      summary: event.summary,
      evidence_json: event.evidence,
      occurred_at: new Date(event.occurredAt),
    };
  }

  private alertValues(
    event: OperationalNotification,
    resolved: boolean,
  ): Prisma.admin_alertsCreateManyInput {
    return {
      organization_id: event.organizationId,
      latest_event_id: event.id,
      kind: event.kind,
      severity: event.severity,
      state: resolved ? "resolved" : "active",
      dedupe_key: event.dedupeKey,
      recovery_key: event.recoveryKey,
      title: event.title,
      summary: event.summary,
      provider_id: event.providerId,
      run_id: event.runId,
      quarantine_id: event.quarantineId,
      first_seen_at: new Date(event.occurredAt),
      last_seen_at: new Date(event.occurredAt),
      resolved_by_actor_key: resolved ? "system:recovery" : null,
      resolved_at: resolved ? new Date(event.occurredAt) : null,
    };
  }

  private async mutateAlert(input: {
    organizationId: string;
    alertId: string;
    actorKey: string;
    acknowledgedAt: Date;
    target: "acknowledged" | "resolved";
  }): Promise<AdminAlertSummary | null> {
    return this.database.$transaction(async (transaction) => {
      const [current] = await transaction.$queryRaw<readonly LockedAlertRow[]>(
        Prisma.sql`
          select id, state, acknowledged_by_actor_key, acknowledged_at
          from admin_alerts
          where organization_id = ${input.organizationId}::uuid
            and id = ${input.alertId}::uuid
          for update
        `,
      );
      if (!current) return null;
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
      return updated[0] ? toSummary(updated[0]) : null;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  private lockAlertByDedupeKey(
    transaction: PackscoutTransactionClient,
    organizationId: string,
    dedupeKey: string,
  ): Promise<readonly LockedAlertRow[]> {
    return transaction.$queryRaw<readonly LockedAlertRow[]>(Prisma.sql`
      select id, state, acknowledged_by_actor_key, acknowledged_at
      from admin_alerts
      where organization_id = ${organizationId}::uuid
        and dedupe_key = ${dedupeKey}
      for update
    `);
  }
}
