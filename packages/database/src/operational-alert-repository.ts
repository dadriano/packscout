import {
  operationalNotificationSchema,
  type AdminAlertDetail,
  type AdminAlertOccurrence,
  type AdminAlertState,
  type AdminAlertSummary,
  type NotificationPublishResult,
  type OperationalNotification,
} from "@packscout/contracts";
import { and, desc, eq, ne, or, sql } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import type { PackscoutDatabase } from "./database.ts";
import { auditEvents } from "./schema/core.ts";
import {
  adminAlerts,
  operationalEvents,
} from "./schema/operations.ts";

const recoveryKinds = new Set<OperationalNotification["kind"]>([
  "provider_recovered",
  "quarantine_resolved",
  "retention_recovered",
]);

type AlertRow = typeof adminAlerts.$inferSelect;

function toSummary(row: AlertRow): AdminAlertSummary {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    state: row.state,
    title: row.title,
    summary: row.summary,
    providerId: row.providerId,
    runId: row.runId,
    quarantineId: row.quarantineId,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    occurrenceCount: row.occurrenceCount,
    reopenedCount: row.reopenedCount,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

export class DrizzleAdminNotificationPublisher<
  TQueryResult extends PgQueryResultHKT,
> {
  constructor(private readonly database: PackscoutDatabase<TQueryResult>) {}

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
    return this.database.transaction(async (transaction) => {
      const [insertedEvent] = await transaction
        .insert(operationalEvents)
        .values({
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
          evidenceJson: event.evidence,
          occurredAt: new Date(event.occurredAt),
        })
        .onConflictDoNothing()
        .returning({ id: operationalEvents.id });
      if (!insertedEvent) {
        const [existingEvent] = await transaction
          .select({ id: operationalEvents.id })
          .from(operationalEvents)
          .where(
            and(
              eq(operationalEvents.id, event.id),
              eq(operationalEvents.organizationId, event.organizationId),
            ),
          )
          .limit(1);
        if (!existingEvent) {
          return {
            status: "failed",
            alertId: null,
            failureCode: "OPERATIONAL_EVENT_ID_CONFLICT",
          };
        }
        const [alert] = await transaction
          .select({ id: adminAlerts.id })
          .from(adminAlerts)
          .where(
            and(
              eq(adminAlerts.organizationId, event.organizationId),
              or(
                eq(adminAlerts.latestEventId, event.id),
                eq(adminAlerts.dedupeKey, event.dedupeKey),
              ),
            ),
          )
          .limit(1);
        return {
          status: recoveryKinds.has(event.kind) ? "resolved" : "deduplicated",
          alertId: alert?.id ?? null,
          failureCode: null,
        };
      }

      if (recoveryKinds.has(event.kind)) {
        const active = await transaction
          .select({ id: adminAlerts.id })
          .from(adminAlerts)
          .where(
            and(
              eq(adminAlerts.organizationId, event.organizationId),
              eq(adminAlerts.recoveryKey, event.recoveryKey),
              ne(adminAlerts.state, "resolved"),
            ),
          )
          .for("update");
        if (active.length > 0) {
          await transaction
            .update(adminAlerts)
            .set({
              latestEventId: event.id,
              kind: event.kind,
              severity: event.severity,
              state: "resolved",
              title: event.title,
              summary: event.summary,
              providerId: event.providerId,
              runId: event.runId,
              quarantineId: event.quarantineId,
              lastSeenAt: new Date(event.occurredAt),
              occurrenceCount: sql`${adminAlerts.occurrenceCount} + 1`,
              resolvedByActorKey: "system:recovery",
              resolvedAt: new Date(event.occurredAt),
            })
            .where(
              and(
                eq(adminAlerts.organizationId, event.organizationId),
                eq(adminAlerts.recoveryKey, event.recoveryKey),
                ne(adminAlerts.state, "resolved"),
              ),
            );
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

      const [current] = await transaction
        .select()
        .from(adminAlerts)
        .where(
          and(
            eq(adminAlerts.organizationId, event.organizationId),
            eq(adminAlerts.dedupeKey, event.dedupeKey),
          ),
        )
        .limit(1)
        .for("update");
      if (!current) {
        const [created] = await transaction
          .insert(adminAlerts)
          .values(this.alertValues(event, false))
          .onConflictDoNothing()
          .returning({ id: adminAlerts.id });
        if (created) {
          return { status: "accepted", alertId: created.id, failureCode: null };
        }
      }
      const alertId = await this.createOrUpdateAlert(transaction, event, false);
      return {
        status: current?.state === "resolved" ? "accepted" : "deduplicated",
        alertId,
        failureCode: null,
      };
    });
  }

  async listAlerts(input: {
    organizationId: string;
    state?: AdminAlertState;
    limit: number;
  }): Promise<readonly AdminAlertSummary[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new RangeError("Alert list limit must be between 1 and 100.");
    }
    const filters = [eq(adminAlerts.organizationId, input.organizationId)];
    if (input.state) filters.push(eq(adminAlerts.state, input.state));
    const rows = await this.database
      .select()
      .from(adminAlerts)
      .where(and(...filters))
      .orderBy(desc(adminAlerts.lastSeenAt), desc(adminAlerts.id))
      .limit(input.limit);
    return rows.map(toSummary);
  }

  async getAlert(
    organizationId: string,
    alertId: string,
  ): Promise<AdminAlertDetail | null> {
    const [alert] = await this.database
      .select()
      .from(adminAlerts)
      .where(
        and(
          eq(adminAlerts.organizationId, organizationId),
          eq(adminAlerts.id, alertId),
        ),
      )
      .limit(1);
    if (!alert) return null;
    const events = await this.database
      .select({
        id: operationalEvents.id,
        kind: operationalEvents.kind,
        severity: operationalEvents.severity,
        occurredAt: operationalEvents.occurredAt,
        evidence: operationalEvents.evidenceJson,
      })
      .from(operationalEvents)
      .where(
        and(
          eq(operationalEvents.organizationId, organizationId),
          eq(operationalEvents.recoveryKey, alert.recoveryKey),
        ),
      )
      .orderBy(desc(operationalEvents.occurredAt), desc(operationalEvents.id))
      .limit(100);
    const occurrences: AdminAlertOccurrence[] = events.map((event) => ({
      ...event,
      occurredAt: event.occurredAt.toISOString(),
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
    database: PackscoutDatabase<TQueryResult>,
    event: OperationalNotification,
    resolved: boolean,
  ): Promise<string | null> {
    const [existing] = await database
      .select()
      .from(adminAlerts)
      .where(
        and(
          eq(adminAlerts.organizationId, event.organizationId),
          eq(adminAlerts.dedupeKey, event.dedupeKey),
        ),
      )
      .limit(1)
      .for("update");
    if (!existing) {
      const [created] = await database
        .insert(adminAlerts)
        .values(this.alertValues(event, resolved))
        .returning({ id: adminAlerts.id });
      return created?.id ?? null;
    }
    const reopening = !resolved && existing.state === "resolved";
    const [updated] = await database
      .update(adminAlerts)
      .set({
        latestEventId: event.id,
        kind: event.kind,
        severity: event.severity,
        state: resolved ? "resolved" : reopening ? "active" : existing.state,
        recoveryKey: event.recoveryKey,
        title: event.title,
        summary: event.summary,
        providerId: event.providerId,
        runId: event.runId,
        quarantineId: event.quarantineId,
        lastSeenAt: new Date(event.occurredAt),
        occurrenceCount: sql`${adminAlerts.occurrenceCount} + 1`,
        reopenedCount: reopening
          ? sql`${adminAlerts.reopenedCount} + 1`
          : adminAlerts.reopenedCount,
        acknowledgedByActorKey: reopening ? null : existing.acknowledgedByActorKey,
        acknowledgedAt: reopening ? null : existing.acknowledgedAt,
        resolvedByActorKey: resolved ? "system:recovery" : null,
        resolvedAt: resolved ? new Date(event.occurredAt) : null,
      })
      .where(
        and(
          eq(adminAlerts.organizationId, event.organizationId),
          eq(adminAlerts.id, existing.id),
        ),
      )
      .returning({ id: adminAlerts.id });
    return updated?.id ?? null;
  }

  private alertValues(event: OperationalNotification, resolved: boolean) {
    return {
      organizationId: event.organizationId,
      latestEventId: event.id,
      kind: event.kind,
      severity: event.severity,
      state: resolved ? "resolved" as const : "active" as const,
      dedupeKey: event.dedupeKey,
      recoveryKey: event.recoveryKey,
      title: event.title,
      summary: event.summary,
      providerId: event.providerId,
      runId: event.runId,
      quarantineId: event.quarantineId,
      firstSeenAt: new Date(event.occurredAt),
      lastSeenAt: new Date(event.occurredAt),
      resolvedByActorKey: resolved ? "system:recovery" : null,
      resolvedAt: resolved ? new Date(event.occurredAt) : null,
    };
  }

  private async mutateAlert(input: {
    organizationId: string;
    alertId: string;
    actorKey: string;
    acknowledgedAt: Date;
    target: "acknowledged" | "resolved";
  }): Promise<AdminAlertSummary | null> {
    return this.database.transaction(async (transaction) => {
      const [current] = await transaction
        .select()
        .from(adminAlerts)
        .where(
          and(
            eq(adminAlerts.organizationId, input.organizationId),
            eq(adminAlerts.id, input.alertId),
          ),
        )
        .limit(1)
        .for("update");
      if (!current) return null;
      const resolved = input.target === "resolved";
      const [updated] = await transaction
        .update(adminAlerts)
        .set({
          state: input.target,
          acknowledgedByActorKey: resolved
            ? current.acknowledgedByActorKey
            : input.actorKey,
          acknowledgedAt: resolved
            ? current.acknowledgedAt
            : input.acknowledgedAt,
          resolvedByActorKey: resolved ? input.actorKey : null,
          resolvedAt: resolved ? input.acknowledgedAt : null,
        })
        .where(
          and(
            eq(adminAlerts.organizationId, input.organizationId),
            eq(adminAlerts.id, input.alertId),
          ),
        )
        .returning();
      await transaction.insert(auditEvents).values({
        organizationId: input.organizationId,
        actorKey: input.actorKey,
        action: `provider.alert.${input.target}`,
        subjectType: "admin_alert",
        subjectId: input.alertId,
        outcome: "success",
        metadataJson: { state: input.target },
        occurredAt: input.acknowledgedAt,
      });
      return updated ? toSummary(updated) : null;
    });
  }
}
