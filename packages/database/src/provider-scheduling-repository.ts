import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutTransactionClient,
} from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";

type ScheduleOutcome = "started" | "coalesced" | "not_enabled";

export interface ProviderRunHealthState {
  readonly consecutiveFailures: number;
  readonly latestFailureCode: string | null;
  readonly lastHeadReachedAt: Date | null;
  readonly recoveredAt: Date | null;
}

interface DueProviderRow {
  readonly organization_id: string;
  readonly provider_id: string;
  readonly config_revision_id: string;
  readonly due_at: Date;
  readonly schedule_seconds: number;
  readonly stale_after_seconds: number;
}

interface ImportRunReferenceRow {
  readonly id: string;
  readonly state: "queued" | "running" | "succeeded" | "incomplete" | "failed";
  readonly started_at: Date | null;
  readonly created_at: Date;
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

export class DrizzleProviderScheduleRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async claimDueProvider(input: {
    workerId: string;
    now: Date;
    leaseExpiresAt: Date;
  }) {
    return this.database.$transaction(async (transaction) => {
      const [candidate] = await transaction.$queryRaw<DueProviderRow[]>(Prisma.sql`
        select sources.organization_id,
               sources.id as provider_id,
               sources.active_revision_id as config_revision_id,
               sources.next_run_at as due_at,
               revisions.schedule_seconds,
               revisions.stale_after_seconds
        from provider_sources as sources
        inner join provider_config_revisions as revisions
          on revisions.id = sources.active_revision_id
         and revisions.organization_id = sources.organization_id
         and revisions.provider_id = sources.id
        left join provider_schedules as schedules
          on schedules.provider_id = sources.id
         and schedules.organization_id = sources.organization_id
        where sources.state = 'active'::provider_state
          and sources.active_revision_id is not null
          and sources.next_run_at is not null
          and sources.next_run_at <= ${input.now}
          and revisions.tested_at is not null
          and (
            schedules.provider_id is null
            or schedules.config_revision_id <> sources.active_revision_id
            or schedules.claim_expires_at is null
            or schedules.claim_expires_at <= ${input.now}
          )
        order by sources.next_run_at asc, sources.id asc
        for update of sources skip locked
        limit 1
      `);
      if (!candidate) return null;

      await transaction.provider_schedules.upsert({
        where: { provider_id: candidate.provider_id },
        create: {
          organization_id: candidate.organization_id,
          provider_id: candidate.provider_id,
          config_revision_id: candidate.config_revision_id,
          next_due_at: candidate.due_at,
          claim_owner: input.workerId,
          claim_expires_at: input.leaseExpiresAt,
          last_claimed_at: input.now,
          updated_at: input.now,
        },
        update: {
          organization_id: candidate.organization_id,
          config_revision_id: candidate.config_revision_id,
          next_due_at: candidate.due_at,
          claim_owner: input.workerId,
          claim_expires_at: input.leaseExpiresAt,
          last_claimed_at: input.now,
          updated_at: input.now,
        },
      });
      return {
        organizationId: candidate.organization_id,
        providerId: candidate.provider_id,
        configRevisionId: candidate.config_revision_id,
        scheduleSeconds: candidate.schedule_seconds,
        staleAfterSeconds: candidate.stale_after_seconds,
        dueAt: candidate.due_at,
      };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
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
    return this.database.$transaction(async (transaction) => {
      const completed = await transaction.provider_schedules.updateMany({
        where: {
          organization_id: input.organizationId,
          provider_id: input.providerId,
          config_revision_id: input.configRevisionId,
          claim_owner: input.workerId,
        },
        data: {
          next_due_at: input.nextDueAt ?? input.completedAt,
          claim_owner: null,
          claim_expires_at: null,
          last_outcome: input.outcome,
          last_run_id: input.runId,
          updated_at: input.completedAt,
        },
      });
      if (completed.count !== 1) return false;
      await transaction.provider_sources.updateMany({
        where: {
          organization_id: input.organizationId,
          id: input.providerId,
          state: "active",
          active_revision_id: input.configRevisionId,
        },
        data: {
          next_run_at:
            input.outcome === "not_enabled" ? null : input.nextDueAt,
          updated_at: input.completedAt,
        },
      });
      return true;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async releaseClaim(input: {
    workerId: string;
    organizationId: string;
    providerId: string;
    configRevisionId: string;
    releasedAt: Date;
    retryAt: Date;
  }): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const released = await transaction.provider_schedules.updateMany({
        where: {
          organization_id: input.organizationId,
          provider_id: input.providerId,
          config_revision_id: input.configRevisionId,
          claim_owner: input.workerId,
        },
        data: {
          next_due_at: input.retryAt,
          claim_owner: null,
          claim_expires_at: null,
          updated_at: input.releasedAt,
        },
      });
      if (released.count !== 1) return;
      await transaction.provider_sources.updateMany({
        where: {
          organization_id: input.organizationId,
          id: input.providerId,
          state: "active",
          active_revision_id: input.configRevisionId,
        },
        data: { next_run_at: input.retryAt, updated_at: input.releasedAt },
      });
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }
}

export class DrizzleProviderHealthRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async recordRunOutcome(input: {
    organizationId: string;
    providerId: string;
    reachedProviderHead: boolean;
    failureCode: string | null;
    finishedAt: Date;
  }): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await this.lockTenantProvider(transaction, input.organizationId, input.providerId);
      const current = await transaction.provider_health_states.upsert({
        where: { provider_id: input.providerId },
        create: {
          organization_id: input.organizationId,
          provider_id: input.providerId,
          updated_at: input.finishedAt,
        },
        update: {},
      });
      const projected = projectProviderRunHealth(
        {
          consecutiveFailures: current.consecutive_failures,
          latestFailureCode: current.latest_failure_code,
          lastHeadReachedAt: current.last_head_reached_at,
          recoveredAt: current.recovered_at,
        },
        input,
      );
      await transaction.provider_health_states.updateMany({
        where: {
          organization_id: input.organizationId,
          provider_id: input.providerId,
        },
        data: {
          consecutive_failures: projected.consecutiveFailures,
          latest_failure_code: projected.latestFailureCode,
          last_head_reached_at: projected.lastHeadReachedAt,
          recovered_at: projected.recoveredAt,
          last_attempted_at: input.finishedAt,
          updated_at: input.finishedAt,
        },
      });
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async recordQualitySignal(input: {
    organizationId: string;
    providerId: string;
    kind: "mapping" | "calculation";
    severity: "warning" | "degraded";
    occurredAt: Date;
  }): Promise<void> {
    const mapping = input.kind === "mapping";
    await this.database.$transaction(async (transaction) => {
      await this.lockTenantProvider(transaction, input.organizationId, input.providerId);
      await transaction.provider_health_states.upsert({
        where: { provider_id: input.providerId },
        create: {
          organization_id: input.organizationId,
          provider_id: input.providerId,
          latest_mapping_warning_at: mapping ? input.occurredAt : null,
          mapping_warning_severity: mapping ? input.severity : null,
          mapping_warning_active: mapping,
          latest_calculation_warning_at: mapping ? null : input.occurredAt,
          calculation_warning_severity: mapping ? null : input.severity,
          calculation_warning_active: !mapping,
          updated_at: input.occurredAt,
        },
        update: mapping
          ? {
              latest_mapping_warning_at: input.occurredAt,
              mapping_warning_severity: input.severity,
              mapping_warning_active: true,
              updated_at: input.occurredAt,
            }
          : {
              latest_calculation_warning_at: input.occurredAt,
              calculation_warning_severity: input.severity,
              calculation_warning_active: true,
              updated_at: input.occurredAt,
            },
      });
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async resolveQualitySignal(input: {
    organizationId: string;
    providerId: string;
    kind: "mapping" | "calculation";
    resolvedAt: Date;
  }): Promise<void> {
    await this.database.provider_health_states.updateMany({
      where: {
        organization_id: input.organizationId,
        provider_id: input.providerId,
      },
      data: {
        ...(input.kind === "mapping"
          ? { mapping_warning_active: false }
          : { calculation_warning_active: false }),
        updated_at: input.resolvedAt,
      },
    });
  }

  async loadHealthEvidence(input: {
    organizationId: string;
    providerId: string;
  }) {
    const provider = await this.database.provider_sources.findFirst({
      where: {
        organization_id: input.organizationId,
        id: input.providerId,
      },
    });
    if (!provider) return null;
    const revision = await this.database.provider_config_revisions.findFirst({
      where: {
        organization_id: input.organizationId,
        provider_id: input.providerId,
        ...(provider.active_revision_id ? { id: provider.active_revision_id } : {}),
      },
      orderBy: [{ version: "desc" }, { id: "desc" }],
    });
    if (!revision) return null;

    const [activeRun, latestRun, latestIncomplete, headRun, openQuarantineCount, state] =
      await Promise.all([
        this.database.import_runs.findFirst({
          where: {
            organization_id: input.organizationId,
            provider_id: input.providerId,
            state: { in: ["queued", "running"] },
          },
          orderBy: [{ created_at: "desc" }, { id: "desc" }],
        }),
        this.database.import_runs.findFirst({
          where: {
            organization_id: input.organizationId,
            provider_id: input.providerId,
          },
          orderBy: [{ created_at: "desc" }, { id: "desc" }],
        }),
        this.database.import_runs.findFirst({
          where: {
            organization_id: input.organizationId,
            provider_id: input.providerId,
            state: "incomplete",
          },
          orderBy: [{ finished_at: "desc" }, { id: "desc" }],
          select: { id: true },
        }),
        this.database.import_runs.findFirst({
          where: {
            organization_id: input.organizationId,
            provider_id: input.providerId,
            reached_provider_head: true,
            finished_at: { not: null },
          },
          orderBy: [{ finished_at: "desc" }, { id: "desc" }],
          select: { finished_at: true },
        }),
        this.database.quarantine_records.count({
          where: {
            organization_id: input.organizationId,
            provider_id: input.providerId,
            state: "open",
          },
        }),
        this.database.provider_health_states.findFirst({
          where: {
            organization_id: input.organizationId,
            provider_id: input.providerId,
          },
        }),
      ]);

    const runReference = (run: ImportRunReferenceRow | null) =>
      run
        ? {
            id: run.id,
            state: run.state,
            attemptedAt: run.started_at ?? run.created_at,
          }
        : null;
    return {
      organizationId: provider.organization_id,
      providerId: provider.id,
      platformKey: provider.platform_key,
      displayName: provider.display_name,
      providerState: provider.state,
      configRevisionId: revision.id,
      scheduleSeconds: revision.schedule_seconds,
      staleAfterSeconds: revision.stale_after_seconds,
      nextDueAt: provider.next_run_at,
      activeRun: runReference(activeRun),
      latestRun: runReference(latestRun),
      latestIncompleteRunId: latestIncomplete?.id ?? null,
      lastAttemptedAt:
        latestRun?.started_at ??
        latestRun?.created_at ??
        state?.last_attempted_at ??
        null,
      lastHeadReachedAt: headRun?.finished_at ?? state?.last_head_reached_at ?? null,
      openQuarantineCount,
      consecutiveFailures: state?.consecutive_failures ?? 0,
      latestFailureCode: state?.latest_failure_code ?? null,
      recoveredAt: state?.recovered_at ?? null,
      mappingWarning:
        state?.latest_mapping_warning_at && state.mapping_warning_severity
          ? {
              occurredAt: state.latest_mapping_warning_at,
              severity: state.mapping_warning_severity as "warning" | "degraded",
              active: state.mapping_warning_active,
            }
          : null,
      calculationWarning:
        state?.latest_calculation_warning_at && state.calculation_warning_severity
          ? {
              occurredAt: state.latest_calculation_warning_at,
              severity: state.calculation_warning_severity as "warning" | "degraded",
              active: state.calculation_warning_active,
            }
          : null,
    };
  }

  private async lockTenantProvider(
    transaction: PackscoutTransactionClient,
    organizationId: string,
    providerId: string,
  ): Promise<void> {
    const [provider] = await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`
      select id
      from provider_sources
      where organization_id = cast(${organizationId} as uuid)
        and id = cast(${providerId} as uuid)
      for update
    `);
    if (!provider) {
      throw new PersistenceError(
        "TENANT_SCOPE_VIOLATION",
        "Provider is outside the organization scope.",
      );
    }
  }
}
