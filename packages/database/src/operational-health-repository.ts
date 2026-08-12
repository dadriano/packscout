import { and, count, desc, eq, ne } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import type { PackscoutDatabase } from "./database.ts";
import { providerConfigRevisions, providerSources } from "./schema/core.ts";
import { quarantineRecords } from "./schema/ingestion.ts";
import {
  adminAlerts,
  retentionExecutions,
} from "./schema/operations.ts";
import { providerHealthStates } from "./schema/scheduling.ts";

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

export class DrizzleOperationalHealthRepository<
  TQueryResult extends PgQueryResultHKT,
> {
  constructor(private readonly database: PackscoutDatabase<TQueryResult>) {}

  async loadSnapshot(input: {
    organizationId: string;
    checkedAt: Date;
  }): Promise<PersistedOperationalHealthSnapshot> {
    const providers = await this.database
      .select({
        id: providerSources.id,
        state: providerSources.state,
        staleAfterSeconds: providerConfigRevisions.staleAfterSeconds,
        lastHeadReachedAt: providerHealthStates.lastHeadReachedAt,
        consecutiveFailures: providerHealthStates.consecutiveFailures,
        mappingWarning: providerHealthStates.mappingWarningActive,
        calculationWarning: providerHealthStates.calculationWarningActive,
      })
      .from(providerSources)
      .leftJoin(
        providerConfigRevisions,
        and(
          eq(providerConfigRevisions.id, providerSources.activeRevisionId),
          eq(
            providerConfigRevisions.organizationId,
            providerSources.organizationId,
          ),
        ),
      )
      .leftJoin(
        providerHealthStates,
        and(
          eq(providerHealthStates.providerId, providerSources.id),
          eq(
            providerHealthStates.organizationId,
            providerSources.organizationId,
          ),
        ),
      )
      .where(
        and(
          eq(providerSources.organizationId, input.organizationId),
          ne(providerSources.state, "archived"),
        ),
      );
    const openQuarantines = await this.database
      .select({ providerId: quarantineRecords.providerId, value: count() })
      .from(quarantineRecords)
      .where(
        and(
          eq(quarantineRecords.organizationId, input.organizationId),
          eq(quarantineRecords.state, "open"),
        ),
      )
      .groupBy(quarantineRecords.providerId);
    const quarantineProviders = new Set(
      openQuarantines
        .filter(({ value }) => Number(value) > 0)
        .map(({ providerId }) => providerId),
    );
    let staleProviderCount = 0;
    let degradedProviderCount = 0;
    let failedProviderCount = 0;
    for (const provider of providers) {
      if (provider.state === "active") {
        const staleAfterMs = (provider.staleAfterSeconds ?? 900) * 1_000;
        if (
          !provider.lastHeadReachedAt ||
          input.checkedAt.getTime() - provider.lastHeadReachedAt.getTime() >
            staleAfterMs
        ) {
          staleProviderCount += 1;
        }
      }
      if ((provider.consecutiveFailures ?? 0) > 0) failedProviderCount += 1;
      if (
        provider.mappingWarning ||
        provider.calculationWarning ||
        quarantineProviders.has(provider.id)
      ) {
        degradedProviderCount += 1;
      }
    }
    const [activeAlerts] = await this.database
      .select({ value: count() })
      .from(adminAlerts)
      .where(
        and(
          eq(adminAlerts.organizationId, input.organizationId),
          ne(adminAlerts.state, "resolved"),
        ),
      );
    const [latestRetention] = await this.database
      .select({
        state: retentionExecutions.state,
        failureCode: retentionExecutions.failureCode,
        finishedAt: retentionExecutions.finishedAt,
      })
      .from(retentionExecutions)
      .where(
        and(
          eq(retentionExecutions.organizationId, input.organizationId),
          ne(retentionExecutions.state, "running"),
        ),
      )
      .orderBy(desc(retentionExecutions.startedAt), desc(retentionExecutions.id))
      .limit(1);
    return {
      configuredProviderCount: providers.length,
      staleProviderCount,
      degradedProviderCount,
      failedProviderCount,
      activeAlertCount: Number(activeAlerts?.value ?? 0),
      latestRetentionState:
        latestRetention?.state === "succeeded"
          ? "succeeded"
          : latestRetention?.state === "failed"
            ? "failed"
            : "never_run",
      latestRetentionAt: latestRetention?.finishedAt ?? null,
      latestRetentionFailureCode: latestRetention?.failureCode ?? null,
    };
  }
}
