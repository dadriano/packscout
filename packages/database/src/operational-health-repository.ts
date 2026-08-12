import type { PackscoutPrismaClient } from "./database.ts";

export interface PersistedOperationalHealthSnapshot {
  readonly configuredProviderCount: number;
  readonly staleProviderCount: number;
  readonly degradedProviderCount: number;
  readonly failedProviderCount: number;
  readonly activeAlertCount: number;
  readonly latestRetentionState: "never_run" | "succeeded" | "failed";
  readonly latestRetentionAt: Date | null;
  readonly latestRetentionFailureCode: string | null;
}

export class DrizzleOperationalHealthRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async loadSnapshot(input: {
    organizationId: string;
    checkedAt: Date;
  }): Promise<PersistedOperationalHealthSnapshot> {
    const providers = await this.database.provider_sources.findMany({
      where: {
        organization_id: input.organizationId,
        state: { not: "archived" },
      },
      select: {
        id: true,
        state: true,
        active_revision_id: true,
      },
    });
    const providerIds = providers.map(({ id }) => id);
    const activeRevisionIds = [
      ...new Set(
        providers.flatMap(({ active_revision_id: id }) => (id ? [id] : [])),
      ),
    ];
    const revisions = activeRevisionIds.length === 0
      ? []
      : await this.database.provider_config_revisions.findMany({
          where: {
            organization_id: input.organizationId,
            id: { in: activeRevisionIds },
          },
          select: { id: true, stale_after_seconds: true },
        });
    const healthStates = providerIds.length === 0
      ? []
      : await this.database.provider_health_states.findMany({
          where: {
            organization_id: input.organizationId,
            provider_id: { in: providerIds },
          },
          select: {
            provider_id: true,
            last_head_reached_at: true,
            consecutive_failures: true,
            mapping_warning_active: true,
            calculation_warning_active: true,
          },
        });
    const openQuarantines = await this.database.quarantine_records.findMany({
      where: {
        organization_id: input.organizationId,
        state: "open",
      },
      distinct: ["provider_id"],
      select: { provider_id: true },
    });
    const quarantineProviders = new Set(
      openQuarantines.map(({ provider_id: providerId }) => providerId),
    );
    const revisionsById = new Map(
      revisions.map((revision) => [revision.id, revision] as const),
    );
    const healthByProviderId = new Map(
      healthStates.map((health) => [health.provider_id, health] as const),
    );
    let staleProviderCount = 0;
    let degradedProviderCount = 0;
    let failedProviderCount = 0;
    for (const provider of providers) {
      const health = healthByProviderId.get(provider.id);
      const revision = provider.active_revision_id
        ? revisionsById.get(provider.active_revision_id)
        : undefined;
      if (provider.state === "active") {
        const staleAfterMs = (revision?.stale_after_seconds ?? 900) * 1_000;
        if (
          !health?.last_head_reached_at ||
          input.checkedAt.getTime() - health.last_head_reached_at.getTime() >
            staleAfterMs
        ) {
          staleProviderCount += 1;
        }
      }
      if ((health?.consecutive_failures ?? 0) > 0) failedProviderCount += 1;
      if (
        health?.mapping_warning_active ||
        health?.calculation_warning_active ||
        quarantineProviders.has(provider.id)
      ) {
        degradedProviderCount += 1;
      }
    }
    const activeAlertCount = await this.database.admin_alerts.count({
      where: {
        organization_id: input.organizationId,
        state: { not: "resolved" },
      },
    });
    const latestRetention = await this.database.retention_executions.findFirst({
      where: {
        organization_id: input.organizationId,
        state: { not: "running" },
      },
      orderBy: [{ started_at: "desc" }, { id: "desc" }],
      select: {
        state: true,
        failure_code: true,
        finished_at: true,
      },
    });
    return {
      configuredProviderCount: providers.length,
      staleProviderCount,
      degradedProviderCount,
      failedProviderCount,
      activeAlertCount,
      latestRetentionState:
        latestRetention?.state === "succeeded"
          ? "succeeded"
          : latestRetention?.state === "failed"
            ? "failed"
            : "never_run",
      latestRetentionAt: latestRetention?.finished_at ?? null,
      latestRetentionFailureCode: latestRetention?.failure_code ?? null,
    };
  }
}
