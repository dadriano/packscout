import {
  and,
  count,
  desc,
  eq,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import type { PackscoutDatabase } from "./database.ts";
import {
  providerConfigRevisions,
  providerSources,
} from "./schema/core.ts";
import { importRuns, quarantineRecords } from "./schema/ingestion.ts";
import {
  providerHealthStates,
  providerSchedules,
} from "./schema/scheduling.ts";

type ScheduleOutcome = "started" | "coalesced" | "not_enabled";

export interface ProviderRunHealthState {
  readonly consecutiveFailures: number;
  readonly latestFailureCode: string | null;
  readonly lastHeadReachedAt: Date | null;
  readonly recoveredAt: Date | null;
}

export function projectProviderRunHealth(
  current: ProviderRunHealthState,
  outcome: {
    reachedProviderHead: boolean;
    failureCode: string | null;
    finishedAt: Date;
  },
): ProviderRunHealthState {
  if (outcome.reachedProviderHead) {
    return {
      consecutiveFailures: 0,
      latestFailureCode: null,
      lastHeadReachedAt: outcome.finishedAt,
      recoveredAt:
        current.consecutiveFailures > 0
          ? outcome.finishedAt
          : current.recoveredAt,
    };
  }
  const failureCode = outcome.failureCode ?? "IMPORT_INCOMPLETE";
  if (!/^[A-Z0-9_]{1,128}$/.test(failureCode)) {
    throw new RangeError("Provider failure code is invalid.");
  }
  return {
    consecutiveFailures: current.consecutiveFailures + 1,
    latestFailureCode: failureCode,
    lastHeadReachedAt: current.lastHeadReachedAt,
    recoveredAt: current.recoveredAt,
  };
}

export class DrizzleProviderScheduleRepository<
  TQueryResult extends PgQueryResultHKT,
> {
  constructor(private readonly database: PackscoutDatabase<TQueryResult>) {}

  async claimDueProvider(input: {
    workerId: string;
    now: Date;
    leaseExpiresAt: Date;
  }) {
    return this.database.transaction(async (transaction) => {
      const [candidate] = await transaction
        .select({
          organizationId: providerSources.organizationId,
          providerId: providerSources.id,
          configRevisionId: providerSources.activeRevisionId,
          dueAt: providerSources.nextRunAt,
          scheduleSeconds: providerConfigRevisions.scheduleSeconds,
          staleAfterSeconds: providerConfigRevisions.staleAfterSeconds,
        })
        .from(providerSources)
        .innerJoin(
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
          providerSchedules,
          eq(providerSchedules.providerId, providerSources.id),
        )
        .where(
          and(
            eq(providerSources.state, "active"),
            isNotNull(providerSources.activeRevisionId),
            isNotNull(providerSources.nextRunAt),
            lte(providerSources.nextRunAt, input.now),
            isNotNull(providerConfigRevisions.testedAt),
            or(
              isNull(providerSchedules.providerId),
              ne(
                providerSchedules.configRevisionId,
                providerSources.activeRevisionId,
              ),
              isNull(providerSchedules.claimExpiresAt),
              lte(providerSchedules.claimExpiresAt, input.now),
            ),
          ),
        )
        .orderBy(providerSources.nextRunAt, providerSources.id)
        .limit(1)
        .for("update", { of: providerSources, skipLocked: true });
      if (!candidate?.configRevisionId || !candidate.dueAt) return null;

      await transaction
        .insert(providerSchedules)
        .values({
          organizationId: candidate.organizationId,
          providerId: candidate.providerId,
          configRevisionId: candidate.configRevisionId,
          nextDueAt: candidate.dueAt,
          claimOwner: input.workerId,
          claimExpiresAt: input.leaseExpiresAt,
          lastClaimedAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: providerSchedules.providerId,
          set: {
            organizationId: candidate.organizationId,
            configRevisionId: candidate.configRevisionId,
            nextDueAt: candidate.dueAt,
            claimOwner: input.workerId,
            claimExpiresAt: input.leaseExpiresAt,
            lastClaimedAt: input.now,
            updatedAt: input.now,
          },
        });
      return {
        organizationId: candidate.organizationId,
        providerId: candidate.providerId,
        configRevisionId: candidate.configRevisionId,
        scheduleSeconds: candidate.scheduleSeconds,
        staleAfterSeconds: candidate.staleAfterSeconds,
        dueAt: candidate.dueAt,
      };
    });
  }

  async completeClaim(input: {
    workerId: string;
    organizationId: string;
    providerId: string;
    configRevisionId: string;
    outcome: ScheduleOutcome;
    runId: string | null;
    completedAt: Date;
    nextDueAt: Date | null;
  }): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const completed = await transaction
        .update(providerSchedules)
        .set({
          nextDueAt: input.nextDueAt ?? input.completedAt,
          claimOwner: null,
          claimExpiresAt: null,
          lastOutcome: input.outcome,
          lastRunId: input.runId,
          updatedAt: input.completedAt,
        })
        .where(
          and(
            eq(providerSchedules.organizationId, input.organizationId),
            eq(providerSchedules.providerId, input.providerId),
            eq(providerSchedules.configRevisionId, input.configRevisionId),
            eq(providerSchedules.claimOwner, input.workerId),
          ),
        )
        .returning({ id: providerSchedules.providerId });
      if (completed.length !== 1) return false;
      await transaction
        .update(providerSources)
        .set({
          nextRunAt:
            input.outcome === "not_enabled" ? null : input.nextDueAt,
          updatedAt: input.completedAt,
        })
        .where(
          and(
            eq(providerSources.organizationId, input.organizationId),
            eq(providerSources.id, input.providerId),
            eq(providerSources.state, "active"),
            eq(providerSources.activeRevisionId, input.configRevisionId),
          ),
        );
      return true;
    });
  }

  async releaseClaim(input: {
    workerId: string;
    organizationId: string;
    providerId: string;
    configRevisionId: string;
    releasedAt: Date;
    retryAt: Date;
  }): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction
        .update(providerSchedules)
        .set({
          nextDueAt: input.retryAt,
          claimOwner: null,
          claimExpiresAt: null,
          updatedAt: input.releasedAt,
        })
        .where(
          and(
            eq(providerSchedules.organizationId, input.organizationId),
            eq(providerSchedules.providerId, input.providerId),
            eq(providerSchedules.configRevisionId, input.configRevisionId),
            eq(providerSchedules.claimOwner, input.workerId),
          ),
        );
      await transaction
        .update(providerSources)
        .set({ nextRunAt: input.retryAt, updatedAt: input.releasedAt })
        .where(
          and(
            eq(providerSources.organizationId, input.organizationId),
            eq(providerSources.id, input.providerId),
            eq(providerSources.state, "active"),
            eq(providerSources.activeRevisionId, input.configRevisionId),
          ),
        );
    });
  }
}

export class DrizzleProviderHealthRepository<
  TQueryResult extends PgQueryResultHKT,
> {
  constructor(private readonly database: PackscoutDatabase<TQueryResult>) {}

  async recordRunOutcome(input: {
    organizationId: string;
    providerId: string;
    reachedProviderHead: boolean;
    failureCode: string | null;
    finishedAt: Date;
  }): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction
        .insert(providerHealthStates)
        .values({
          organizationId: input.organizationId,
          providerId: input.providerId,
          updatedAt: input.finishedAt,
        })
        .onConflictDoNothing();
      const [current] = await transaction
        .select()
        .from(providerHealthStates)
        .where(
          and(
            eq(providerHealthStates.organizationId, input.organizationId),
            eq(providerHealthStates.providerId, input.providerId),
          ),
        )
        .limit(1)
        .for("update");
      if (!current) throw new Error("Provider health state could not be loaded.");
      const projected = projectProviderRunHealth(current, input);
      await transaction
        .update(providerHealthStates)
        .set({
          ...projected,
          lastAttemptedAt: input.finishedAt,
          updatedAt: input.finishedAt,
        })
        .where(eq(providerHealthStates.providerId, input.providerId));
    });
  }

  async recordQualitySignal(input: {
    organizationId: string;
    providerId: string;
    kind: "mapping" | "calculation";
    severity: "warning" | "degraded";
    occurredAt: Date;
  }): Promise<void> {
    const mapping = input.kind === "mapping";
    await this.database
      .insert(providerHealthStates)
      .values({
        organizationId: input.organizationId,
        providerId: input.providerId,
        latestMappingWarningAt: mapping ? input.occurredAt : null,
        mappingWarningSeverity: mapping ? input.severity : null,
        mappingWarningActive: mapping,
        latestCalculationWarningAt: mapping ? null : input.occurredAt,
        calculationWarningSeverity: mapping ? null : input.severity,
        calculationWarningActive: !mapping,
        updatedAt: input.occurredAt,
      })
      .onConflictDoUpdate({
        target: providerHealthStates.providerId,
        set: mapping
          ? {
              latestMappingWarningAt: input.occurredAt,
              mappingWarningSeverity: input.severity,
              mappingWarningActive: true,
              updatedAt: input.occurredAt,
            }
          : {
              latestCalculationWarningAt: input.occurredAt,
              calculationWarningSeverity: input.severity,
              calculationWarningActive: true,
              updatedAt: input.occurredAt,
            },
      });
  }

  async resolveQualitySignal(input: {
    organizationId: string;
    providerId: string;
    kind: "mapping" | "calculation";
    resolvedAt: Date;
  }): Promise<void> {
    await this.database
      .update(providerHealthStates)
      .set({
        ...(input.kind === "mapping"
          ? { mappingWarningActive: false }
          : { calculationWarningActive: false }),
        updatedAt: input.resolvedAt,
      })
      .where(
        and(
          eq(providerHealthStates.organizationId, input.organizationId),
          eq(providerHealthStates.providerId, input.providerId),
        ),
      );
  }

  async loadHealthEvidence(input: {
    organizationId: string;
    providerId: string;
  }) {
    const [provider] = await this.database
      .select()
      .from(providerSources)
      .where(
        and(
          eq(providerSources.organizationId, input.organizationId),
          eq(providerSources.id, input.providerId),
        ),
      )
      .limit(1);
    if (!provider) return null;
    const revisionQuery = this.database
      .select()
      .from(providerConfigRevisions)
      .where(
        and(
          eq(providerConfigRevisions.organizationId, input.organizationId),
          eq(providerConfigRevisions.providerId, input.providerId),
          ...(provider.activeRevisionId
            ? [eq(providerConfigRevisions.id, provider.activeRevisionId)]
            : []),
        ),
      )
      .orderBy(desc(providerConfigRevisions.version))
      .limit(1);
    const [revision] = await revisionQuery;
    if (!revision) return null;

    const [activeRun] = await this.database
      .select()
      .from(importRuns)
      .where(
        and(
          eq(importRuns.organizationId, input.organizationId),
          eq(importRuns.providerId, input.providerId),
          sql`${importRuns.state} in ('queued', 'running')`,
        ),
      )
      .orderBy(desc(importRuns.createdAt))
      .limit(1);
    const [latestRun] = await this.database
      .select()
      .from(importRuns)
      .where(
        and(
          eq(importRuns.organizationId, input.organizationId),
          eq(importRuns.providerId, input.providerId),
        ),
      )
      .orderBy(desc(importRuns.createdAt))
      .limit(1);
    const [latestIncomplete] = await this.database
      .select({ id: importRuns.id })
      .from(importRuns)
      .where(
        and(
          eq(importRuns.organizationId, input.organizationId),
          eq(importRuns.providerId, input.providerId),
          eq(importRuns.state, "incomplete"),
        ),
      )
      .orderBy(desc(importRuns.finishedAt))
      .limit(1);
    const [headRun] = await this.database
      .select({ finishedAt: importRuns.finishedAt })
      .from(importRuns)
      .where(
        and(
          eq(importRuns.organizationId, input.organizationId),
          eq(importRuns.providerId, input.providerId),
          eq(importRuns.reachedProviderHead, true),
          isNotNull(importRuns.finishedAt),
        ),
      )
      .orderBy(desc(importRuns.finishedAt))
      .limit(1);
    const [quarantine] = await this.database
      .select({ count: count() })
      .from(quarantineRecords)
      .where(
        and(
          eq(quarantineRecords.organizationId, input.organizationId),
          eq(quarantineRecords.providerId, input.providerId),
          eq(quarantineRecords.state, "open"),
        ),
      );
    const [state] = await this.database
      .select()
      .from(providerHealthStates)
      .where(
        and(
          eq(providerHealthStates.organizationId, input.organizationId),
          eq(providerHealthStates.providerId, input.providerId),
        ),
      )
      .limit(1);

    const runReference = (run: typeof importRuns.$inferSelect | undefined) =>
      run
        ? {
            id: run.id,
            state: run.state,
            attemptedAt: run.startedAt ?? run.createdAt,
          }
        : null;
    return {
      organizationId: provider.organizationId,
      providerId: provider.id,
      platformKey: provider.platformKey,
      displayName: provider.displayName,
      providerState: provider.state,
      configRevisionId: revision.id,
      scheduleSeconds: revision.scheduleSeconds,
      staleAfterSeconds: revision.staleAfterSeconds,
      nextDueAt: provider.nextRunAt,
      activeRun: runReference(activeRun),
      latestRun: runReference(latestRun),
      latestIncompleteRunId: latestIncomplete?.id ?? null,
      lastAttemptedAt:
        latestRun?.startedAt ?? latestRun?.createdAt ?? state?.lastAttemptedAt ?? null,
      lastHeadReachedAt: headRun?.finishedAt ?? state?.lastHeadReachedAt ?? null,
      openQuarantineCount: Number(quarantine?.count ?? 0),
      consecutiveFailures: state?.consecutiveFailures ?? 0,
      latestFailureCode: state?.latestFailureCode ?? null,
      recoveredAt: state?.recoveredAt ?? null,
      mappingWarning:
        state?.latestMappingWarningAt && state.mappingWarningSeverity
          ? {
              occurredAt: state.latestMappingWarningAt,
              severity: state.mappingWarningSeverity as "warning" | "degraded",
              active: state.mappingWarningActive,
            }
          : null,
      calculationWarning:
        state?.latestCalculationWarningAt && state.calculationWarningSeverity
          ? {
              occurredAt: state.latestCalculationWarningAt,
              severity: state.calculationWarningSeverity as "warning" | "degraded",
              active: state.calculationWarningActive,
            }
          : null,
    };
  }
}
