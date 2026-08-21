import type { MachineryConditionKind } from "@packscout/contracts";
import type { operational_event_kind as OperationalEventKindRow } from "@prisma/client";
import type { PackscoutPrismaClient } from "./database.ts";

/**
 * Read-only evidence the machinery alert cycle needs beyond the fleet and
 * background-work repositories: which workspaces to evaluate, and which
 * machinery alerts are already open.
 *
 * Open alerts serve two purposes. A condition that stopped holding is only
 * cleared when an alert actually exists for it, so a quiet pipeline publishes
 * nothing; and an open retention *failure* alert suppresses the overdue
 * condition, so a failing cleanup is reported once as a failure rather than
 * twice under two names.
 *
 * No threshold is expressed here. Every predicate is a durable fact — a
 * workspace, an alert kind, an unresolved lifecycle state.
 */

/** The alert kinds the machinery cycle owns and may therefore clear. */
export const machineryAlertKinds: readonly MachineryConditionKind[] = [
  "worker_fleet_silent",
  "import_run_stalled",
  "provider_schedule_overdue",
  "recomputation_backlogged",
  "retention_overdue",
];

/** The pre-existing failure alert the overdue condition must not duplicate. */
export const RETENTION_FAILURE_ALERT_KIND = "retention_failed";

export interface OpenMachineryAlertRecord {
  readonly kind: MachineryConditionKind;
  readonly recoveryKey: string;
  readonly providerId: string | null;
  readonly runId: string | null;
}

export interface OpenMachineryAlertsSnapshot {
  readonly alerts: readonly OpenMachineryAlertRecord[];
  readonly retentionFailureActive: boolean;
}

/** Bounds every read so one evaluation cycle stays a bounded unit of work. */
const MAXIMUM_LIMIT = 200;

function assertLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAXIMUM_LIMIT) {
    throw new RangeError("Machinery alert page limit is invalid.");
  }
  return limit;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PrismaMachineryAlertReadRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  /** Workspaces the cycle evaluates, oldest first so the set stays stable. */
  async listOrganizations(input: { limit: number }): Promise<readonly string[]> {
    const limit = assertLimit(input.limit);
    const rows = await this.database.organizations.findMany({
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  async readOpenAlerts(input: {
    organizationId: string;
    limit: number;
  }): Promise<OpenMachineryAlertsSnapshot> {
    if (!uuidPattern.test(input.organizationId)) {
      throw new RangeError("Machinery alert identity is invalid.");
    }
    const limit = assertLimit(input.limit);
    const kinds = [
      ...machineryAlertKinds,
      RETENTION_FAILURE_ALERT_KIND,
    ] as readonly OperationalEventKindRow[];
    const rows = await this.database.admin_alerts.findMany({
      where: {
        organization_id: input.organizationId,
        state: { not: "resolved" },
        kind: { in: [...kinds] },
      },
      orderBy: [{ last_seen_at: "desc" }, { id: "desc" }],
      take: limit,
      select: {
        kind: true,
        recovery_key: true,
        provider_id: true,
        run_id: true,
      },
    });
    const owned = new Set<string>(machineryAlertKinds);
    return {
      alerts: rows
        .filter((row) => owned.has(row.kind))
        .map((row) => ({
          kind: row.kind as MachineryConditionKind,
          recoveryKey: row.recovery_key,
          providerId: row.provider_id,
          runId: row.run_id,
        })),
      retentionFailureActive: rows.some(
        (row) => row.kind === RETENTION_FAILURE_ALERT_KIND,
      ),
    };
  }
}
