import type { OperationalSeverity } from "@packscout/contracts";
import type { CentralPrismaClient } from "./central-database.ts";
import type {
  AlertEmailAlertStateRecord,
  AlertEmailResolvedAlertStateRecord,
} from "./alert-email-read-repository.ts";

const RESOLVED_ALERT_READ_MAXIMUM = 50;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const boundedKeyPattern = /^[a-z0-9][a-z0-9:._-]{0,255}$/;

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

/** Read-only central alert state used by the existing email notification publisher. */
export class CentralAlertEmailReadRepository {
  constructor(private readonly central: CentralPrismaClient) {}

  async findAlertByDedupeKey(input: Readonly<{
    organizationId: string;
    dedupeKey: string;
  }>): Promise<AlertEmailAlertStateRecord | null> {
    assertUuid(input.organizationId, "Alert email organization ID");
    assertBoundedKey(input.dedupeKey, "Alert email dedupe key");
    const row = await this.central.admin_alerts.findFirst({
      where: {
        organization_id: input.organizationId,
        dedupe_key: input.dedupeKey,
      },
      select: { id: true, occurrence_count: true, first_seen_at: true },
    });
    return row === null ? null : {
      alertId: row.id,
      occurrenceCount: row.occurrence_count,
      firstSeenAt: row.first_seen_at,
    };
  }

  async listAlertsResolvedByEvent(input: Readonly<{
    organizationId: string;
    recoveryKey: string;
    eventId: string;
    limit: number;
  }>): Promise<readonly AlertEmailResolvedAlertStateRecord[]> {
    assertUuid(input.organizationId, "Alert email organization ID");
    assertUuid(input.eventId, "Alert email recovery event ID");
    assertBoundedKey(input.recoveryKey, "Alert email recovery key");
    if (
      !Number.isInteger(input.limit)
      || input.limit < 1
      || input.limit > RESOLVED_ALERT_READ_MAXIMUM
    ) {
      throw new RangeError("Alert email resolved-alert limit is invalid.");
    }
    const rows = await this.central.admin_alerts.findMany({
      where: {
        organization_id: input.organizationId,
        recovery_key: input.recoveryKey,
        state: "resolved",
        OR: [
          { latest_activity_event_id: input.eventId },
          { latest_global_activity_event_id: input.eventId },
        ],
      },
      orderBy: [{ last_seen_at: "desc" }, { id: "desc" }],
      take: input.limit,
      select: {
        id: true,
        provider_id: true,
        dedupe_key: true,
        occurrence_count: true,
        first_seen_at: true,
      },
    });
    const resolved: AlertEmailResolvedAlertStateRecord[] = [];
    for (const row of rows) {
      let raisedSeverity: OperationalSeverity | null = null;
      if (row.provider_id === null) {
        const raised = await this.central.global_activity_events.findFirst({
          where: {
            organization_id: input.organizationId,
            dedupe_key: row.dedupe_key,
          },
          orderBy: [{ event_at: "desc" }, { id: "desc" }],
          select: { severity: true },
        });
        raisedSeverity = raised?.severity ?? null;
      } else {
        const raised = await this.central.provider_activity_events.findFirst({
          where: {
            organization_id: input.organizationId,
            provider_id: row.provider_id,
            dedupe_key: row.dedupe_key,
          },
          orderBy: [{ event_at: "desc" }, { id: "desc" }],
          select: { severity: true },
        });
        raisedSeverity = raised?.severity ?? null;
      }
      resolved.push({
        alertId: row.id,
        occurrenceCount: row.occurrence_count,
        firstSeenAt: row.first_seen_at,
        raisedSeverity,
      });
    }
    return resolved;
  }
}
