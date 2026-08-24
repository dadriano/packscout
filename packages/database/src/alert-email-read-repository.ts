import type { OperationalSeverity } from "@packscout/contracts";
import type { PackscoutPrismaClient } from "./database.ts";

/**
 * Read-only durable alert state for routing operational alerts to operator
 * email. The email publisher runs after the durable admin publisher inside
 * the composite, so these reads observe the alert row exactly as the
 * occurrence that triggered them left it — the occurrence count, first-seen
 * time, and alert identity here are the admin's own, never a parallel
 * notification state.
 *
 * Nothing is written here, and the alert lifecycle owned by the admin
 * notification publisher is untouched.
 */

const RESOLVED_ALERT_READ_MAXIMUM = 50;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const boundedKeyPattern = /^[a-z0-9][a-z0-9:._-]{0,255}$/;

export interface AlertEmailAlertStateRecord {
  readonly alertId: string;
  readonly occurrenceCount: number;
  readonly firstSeenAt: Date;
}

export interface AlertEmailResolvedAlertStateRecord
  extends AlertEmailAlertStateRecord {
  /** The severity of the alert's latest raising occurrence, or null when no
   * raising event is on record. */
  readonly raisedSeverity: OperationalSeverity | null;
}

function assertUuid(value: string, description: string): void {
  if (!uuidPattern.test(value)) {
    throw new RangeError(`${description} is not a valid identifier.`);
  }
}

function assertBoundedKey(value: string, description: string): void {
  if (!boundedKeyPattern.test(value)) {
    throw new RangeError(`${description} is not a valid bounded key.`);
  }
}

export class PrismaAlertEmailReadRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  /** The alert row a raising occurrence deduplicated onto, if any. The pair
   * (organization, dedupe key) is unique, so at most one row matches. */
  async findAlertByDedupeKey(input: {
    readonly organizationId: string;
    readonly dedupeKey: string;
  }): Promise<AlertEmailAlertStateRecord | null> {
    assertUuid(input.organizationId, "Alert email organization ID");
    assertBoundedKey(input.dedupeKey, "Alert email dedupe key");
    const row = await this.database.admin_alerts.findFirst({
      where: {
        organization_id: input.organizationId,
        dedupe_key: input.dedupeKey,
      },
      select: { id: true, occurrence_count: true, first_seen_at: true },
    });
    if (!row) return null;
    return {
      alertId: row.id,
      occurrenceCount: row.occurrence_count,
      firstSeenAt: row.first_seen_at,
    };
  }

  /**
   * The alerts one specific recovery event resolved: rows sharing the event's
   * recovery key whose latest event is that event and whose state is
   * resolved. A redundant recovery — arriving while nothing was active —
   * matches nothing, so it can never re-notify.
   *
   * The raised severity comes from the newest event carrying the alert's own
   * dedupe key. Recovery events carry dedupe keys of their own and never an
   * alert's, so every event under an alert's dedupe key is a raising
   * occurrence.
   */
  async listAlertsResolvedByEvent(input: {
    readonly organizationId: string;
    readonly recoveryKey: string;
    readonly eventId: string;
    readonly limit: number;
  }): Promise<readonly AlertEmailResolvedAlertStateRecord[]> {
    assertUuid(input.organizationId, "Alert email organization ID");
    assertUuid(input.eventId, "Alert email recovery event ID");
    assertBoundedKey(input.recoveryKey, "Alert email recovery key");
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > RESOLVED_ALERT_READ_MAXIMUM
    ) {
      throw new RangeError("Alert email resolved-alert limit is invalid.");
    }
    const rows = await this.database.admin_alerts.findMany({
      where: {
        organization_id: input.organizationId,
        recovery_key: input.recoveryKey,
        latest_event_id: input.eventId,
        state: "resolved",
      },
      orderBy: [{ last_seen_at: "desc" }, { id: "desc" }],
      take: input.limit,
      select: {
        id: true,
        dedupe_key: true,
        occurrence_count: true,
        first_seen_at: true,
      },
    });
    const resolved: AlertEmailResolvedAlertStateRecord[] = [];
    for (const row of rows) {
      const raised = await this.database.operational_events.findFirst({
        where: {
          organization_id: input.organizationId,
          dedupe_key: row.dedupe_key,
        },
        orderBy: [{ occurred_at: "desc" }, { id: "desc" }],
        select: { severity: true },
      });
      resolved.push({
        alertId: row.id,
        occurrenceCount: row.occurrence_count,
        firstSeenAt: row.first_seen_at,
        raisedSeverity: raised?.severity ?? null,
      });
    }
    return resolved;
  }
}
