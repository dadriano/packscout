import type { MachineryConditionKind } from "@packscout/contracts";
import type { CentralPrismaClient } from "./central-database.ts";
import {
  machineryAlertKinds,
  RETENTION_FAILURE_ALERT_KIND,
  type OpenMachineryAlertsSnapshot,
} from "./machinery-alert-read-repository.ts";

const MAXIMUM_LIMIT = 200;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface OrganizationRotation {
  readonly createdAt: Date;
  readonly id: string;
}

function assertLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAXIMUM_LIMIT) {
    throw new RangeError("Machinery alert page limit is invalid.");
  }
  return limit;
}

/** Central workspace rotation and open-alert evidence for machinery evaluation. */
export class CentralMachineryAlertReadRepository {
  #rotation: OrganizationRotation | null = null;

  constructor(private readonly central: CentralPrismaClient) {}

  async listOrganizations(input: Readonly<{
    limit: number;
  }>): Promise<readonly string[]> {
    const limit = assertLimit(input.limit);
    const tail = await this.pageOrganizations(limit, this.#rotation);
    const rows = tail.length < limit && this.#rotation !== null
      ? [...tail, ...(await this.pageOrganizations(limit - tail.length, null))]
      : tail;
    const identities: string[] = [];
    const seen = new Set<string>();
    let resume: OrganizationRotation | null = null;
    for (const row of rows) {
      resume = { createdAt: row.created_at, id: row.id };
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      identities.push(row.id);
    }
    this.#rotation = resume;
    return identities;
  }

  async readOpenAlerts(input: Readonly<{
    organizationId: string;
    limit: number;
  }>): Promise<OpenMachineryAlertsSnapshot> {
    if (!uuidPattern.test(input.organizationId)) {
      throw new RangeError("Machinery alert identity is invalid.");
    }
    const limit = assertLimit(input.limit);
    const kinds = [...machineryAlertKinds, RETENTION_FAILURE_ALERT_KIND];
    const rows = await this.central.admin_alerts.findMany({
      where: {
        organization_id: input.organizationId,
        state: { not: "resolved" },
        kind: { in: kinds },
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

  private pageOrganizations(
    limit: number,
    after: OrganizationRotation | null,
  ): Promise<readonly { id: string; created_at: Date }[]> {
    return this.central.organizations.findMany({
      ...(after === null
        ? {}
        : {
            where: {
              OR: [
                { created_at: { gt: after.createdAt } },
                { created_at: after.createdAt, id: { gt: after.id } },
              ],
            },
          }),
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true, created_at: true },
    });
  }
}
