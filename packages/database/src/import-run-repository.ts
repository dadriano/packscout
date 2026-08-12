import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutQueryClient,
  type PackscoutTransactionClient,
} from "./database.ts";
import type { RunCounters } from "./pipeline-types.ts";

export type PersistedImportTrigger = "scheduled" | "manual";
export type PersistedImportRunState =
  | "queued"
  | "running"
  | "succeeded"
  | "incomplete"
  | "failed";

export interface PersistedImportRun {
  readonly id: string;
  readonly organizationId: string;
  readonly providerId: string;
  readonly configRevisionId: string;
  readonly trigger: PersistedImportTrigger | "recovery";
  readonly state: PersistedImportRunState;
  readonly requestedCursor: string | null;
  readonly finalCursor: string | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly heartbeatAt: Date | null;
  readonly counters: RunCounters;
  readonly reachedProviderHead: boolean;
  readonly failureCode: string | null;
  readonly failureSummary: string | null;
}

export interface ClaimedImportRun extends PersistedImportRun {
  readonly state: "running";
  readonly workerId: string;
  readonly leaseExpiresAt: Date;
  readonly currentCursor: string | null;
  readonly nextPageNumber: number;
}

export type RequestImportPersistenceResult =
  | { readonly kind: "created"; readonly run: PersistedImportRun }
  | { readonly kind: "active"; readonly run: PersistedImportRun }
  | { readonly kind: "not_found" }
  | { readonly kind: "provider_unavailable" }
  | {
      readonly kind: "revision_conflict";
      readonly activeConfigurationRevisionId: string;
    };

export type ClaimImportPersistenceResult =
  | { readonly kind: "claimed"; readonly run: ClaimedImportRun }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_claimable"; readonly run: PersistedImportRun };

export type ClaimNextImportPersistenceResult =
  | { readonly kind: "claimed"; readonly run: ClaimedImportRun }
  | { readonly kind: "idle" };

export type FinishImportPersistenceResult =
  | { readonly kind: "finished"; readonly run: PersistedImportRun }
  | { readonly kind: "not_found" }
  | { readonly kind: "ownership_lost" }
  | { readonly kind: "already_terminal"; readonly run: PersistedImportRun };

interface ImportRunRow {
  readonly id: string;
  readonly organization_id: string;
  readonly provider_id: string;
  readonly config_revision_id: string;
  readonly trigger: PersistedImportTrigger | "recovery";
  readonly state: PersistedImportRunState;
  readonly requested_cursor: string | null;
  readonly final_cursor: string | null;
  readonly started_at: Date | null;
  readonly finished_at: Date | null;
  readonly heartbeat_at: Date | null;
  readonly counters_json: Prisma.JsonValue;
  readonly reached_provider_head: boolean;
  readonly failure_code: string | null;
  readonly failure_summary: string | null;
  readonly lease_owner: string | null;
  readonly lease_expires_at: Date | null;
}

interface LockedImportRun {
  readonly run: PersistedImportRun;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: Date | null;
}

function normalizeCounters(counters: Prisma.JsonValue): RunCounters {
  const values =
    typeof counters === "object" && counters !== null && !Array.isArray(counters)
      ? counters
      : {};
  const count = (key: keyof RunCounters): number => {
    const value = values[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : 0;
  };
  return {
    accepted: count("accepted"),
    duplicate: count("duplicate"),
    quarantined: count("quarantined"),
    pages: count("pages"),
    records: count("records"),
    requestAttempts: count("requestAttempts"),
    transientRetries: count("transientRetries"),
  };
}

export class DrizzleImportRunRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async requestRun(input: {
    organizationId: string;
    providerId: string;
    runId: string;
    trigger: PersistedImportTrigger;
    requestedByActorKey: string | null;
    requestedAt: Date;
    expectedConfigurationRevisionId?: string;
  }): Promise<RequestImportPersistenceResult> {
    return this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`
        select id
        from provider_sources
        where id = cast(${input.providerId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
        for update
      `);
      const provider = await transaction.provider_sources.findFirst({
        where: {
          organization_id: input.organizationId,
          id: input.providerId,
        },
        select: {
          id: true,
          state: true,
          active_revision_id: true,
        },
      });
      if (!provider) return { kind: "not_found" };
      if (provider.state !== "active" || !provider.active_revision_id) {
        return { kind: "provider_unavailable" };
      }
      if (
        input.expectedConfigurationRevisionId !== undefined &&
        provider.active_revision_id !== input.expectedConfigurationRevisionId
      ) {
        return {
          kind: "revision_conflict",
          activeConfigurationRevisionId: provider.active_revision_id,
        };
      }
      const activeRevision = await transaction.provider_config_revisions.findFirst({
        where: {
          organization_id: input.organizationId,
          provider_id: input.providerId,
          id: provider.active_revision_id,
        },
        select: { tested_at: true },
      });
      if (!activeRevision?.tested_at) return { kind: "provider_unavailable" };

      const activeRun = await this.loadActiveRun(
        transaction,
        input.organizationId,
        input.providerId,
      );
      if (activeRun) return { kind: "active", run: activeRun };
      const checkpoint = await transaction.provider_cursor_checkpoints.findFirst({
        where: {
          organization_id: input.organizationId,
          provider_id: input.providerId,
          config_revision_id: provider.active_revision_id,
        },
        select: { cursor: true },
      });
      await transaction.import_runs.create({
        data: {
          id: input.runId,
          organization_id: input.organizationId,
          provider_id: input.providerId,
          config_revision_id: provider.active_revision_id,
          trigger: input.trigger,
          requested_by_actor_key: input.requestedByActorKey,
          state: "queued",
          requested_cursor: checkpoint?.cursor ?? null,
          counters_json: {
            accepted: 0,
            duplicate: 0,
            quarantined: 0,
            pages: 0,
            records: 0,
            requestAttempts: 0,
            transientRetries: 0,
          },
          created_at: input.requestedAt,
        },
      });
      await transaction.audit_events.create({
        data: {
          organization_id: input.organizationId,
          actor_key: input.requestedByActorKey ?? "system:scheduler",
          action: "provider.import.request",
          subject_type: "import_run",
          subject_id: input.runId,
          outcome: "success",
          metadata_json: {
            providerId: input.providerId,
            configRevisionId: provider.active_revision_id,
            trigger: input.trigger,
          },
          occurred_at: input.requestedAt,
        },
      });
      const run = await this.loadRun(transaction, input.organizationId, input.runId);
      if (!run) throw new Error("Created import run could not be loaded.");
      return { kind: "created", run };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async claimRun(input: {
    organizationId: string;
    runId: string;
    workerId: string;
    claimedAt: Date;
    leaseExpiresAt: Date;
  }): Promise<ClaimImportPersistenceResult> {
    this.assertLease(input.workerId, input.claimedAt, input.leaseExpiresAt);
    return this.database.$transaction(async (transaction) => {
      const locked = await this.lockRun(
        transaction,
        input.organizationId,
        input.runId,
      );
      if (!locked) return { kind: "not_found" };
      const { run } = locked;
      const canClaim =
        run.state === "queued" ||
        (run.state === "running" &&
          locked.leaseExpiresAt !== null &&
          locked.leaseExpiresAt <= input.claimedAt);
      if (!canClaim) return { kind: "not_claimable", run };
      return {
        kind: "claimed",
        run: await this.persistClaim(transaction, run, input),
      };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async claimNextRun(input: {
    workerId: string;
    claimedAt: Date;
    leaseExpiresAt: Date;
  }): Promise<ClaimNextImportPersistenceResult> {
    this.assertLease(input.workerId, input.claimedAt, input.leaseExpiresAt);
    return this.database.$transaction(async (transaction) => {
      const [candidate] = await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`
        select id
        from import_runs
        where state = 'queued'::import_run_state
           or (
             state = 'running'::import_run_state
             and lease_expires_at is not null
             and lease_expires_at <= ${input.claimedAt}
           )
        order by created_at asc, id asc
        for update skip locked
        limit 1
      `);
      if (!candidate) return { kind: "idle" };
      const row = await transaction.import_runs.findUnique({
        where: { id: candidate.id },
      });
      if (!row) throw new Error("Claimable import run could not be loaded.");
      return {
        kind: "claimed",
        run: await this.persistClaim(transaction, this.toRun(row), input),
      };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async renewLease(input: {
    organizationId: string;
    runId: string;
    workerId: string;
    renewedAt: Date;
    leaseExpiresAt: Date;
  }): Promise<boolean> {
    this.assertLease(input.workerId, input.renewedAt, input.leaseExpiresAt);
    const renewed = await this.database.import_runs.updateMany({
      where: {
        organization_id: input.organizationId,
        id: input.runId,
        state: "running",
        lease_owner: input.workerId,
        lease_expires_at: { gte: input.renewedAt },
      },
      data: {
        heartbeat_at: input.renewedAt,
        lease_expires_at: input.leaseExpiresAt,
      },
    });
    return renewed.count === 1;
  }

  async recordRequestAttempt(input: {
    organizationId: string;
    runId: string;
    workerId: string;
    transientRetry: boolean;
  }): Promise<boolean> {
    const updated = await this.database.$queryRaw<{ id: string }[]>(Prisma.sql`
      update import_runs
      set counters_json = counters_json || jsonb_build_object(
        'requestAttempts',
        coalesce((counters_json ->> 'requestAttempts')::integer, 0) + 1,
        'transientRetries',
        coalesce((counters_json ->> 'transientRetries')::integer, 0) +
          ${input.transientRetry ? 1 : 0}
      )
      where organization_id = cast(${input.organizationId} as uuid)
        and id = cast(${input.runId} as uuid)
        and state = 'running'::import_run_state
        and lease_owner = ${input.workerId}
      returning id
    `);
    return updated.length === 1;
  }

  async finishRun(input: {
    organizationId: string;
    runId: string;
    workerId: string;
    state: "succeeded" | "incomplete" | "failed";
    reachedProviderHead: boolean;
    failureCode: string | null;
    failureSummary: string | null;
    finishedAt: Date;
  }): Promise<FinishImportPersistenceResult> {
    return this.database.$transaction(async (transaction) => {
      const locked = await this.lockRun(
        transaction,
        input.organizationId,
        input.runId,
      );
      if (!locked) return { kind: "not_found" };
      const { run } = locked;
      if (run.state !== "running") {
        return { kind: "already_terminal", run };
      }
      if (locked.leaseOwner !== input.workerId) return { kind: "ownership_lost" };
      await transaction.import_runs.updateMany({
        where: {
          organization_id: input.organizationId,
          id: input.runId,
        },
        data: {
          state: input.state,
          reached_provider_head: input.reachedProviderHead,
          failure_code: input.failureCode,
          failure_summary: input.failureSummary,
          finished_at: input.finishedAt,
          heartbeat_at: input.finishedAt,
          lease_owner: null,
          lease_expires_at: null,
        },
      });
      await transaction.audit_events.create({
        data: {
          organization_id: input.organizationId,
          actor_key: "system:import-worker",
          action: "provider.import.finish",
          subject_type: "import_run",
          subject_id: input.runId,
          outcome: input.state === "failed" ? "failure" : "success",
          metadata_json: {
            providerId: run.providerId,
            configRevisionId: run.configRevisionId,
            state: input.state,
            failureCode: input.failureCode,
            reachedProviderHead: input.reachedProviderHead,
          },
          occurred_at: input.finishedAt,
        },
      });
      const finished = await this.loadRun(transaction, input.organizationId, input.runId);
      if (!finished) throw new Error("Finished import run could not be loaded.");
      return { kind: "finished", run: finished };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async getRun(
    organizationId: string,
    runId: string,
  ): Promise<PersistedImportRun | null> {
    return this.loadRun(this.database, organizationId, runId);
  }

  private assertLease(workerId: string, startsAt: Date, expiresAt: Date): void {
    if (
      workerId.length < 1 ||
      workerId.length > 256 ||
      expiresAt.getTime() <= startsAt.getTime()
    ) {
      throw new RangeError("Import run lease is invalid.");
    }
  }

  private async persistClaim(
    database: PackscoutTransactionClient,
    run: PersistedImportRun,
    input: {
      workerId: string;
      claimedAt: Date;
      leaseExpiresAt: Date;
    },
  ): Promise<ClaimedImportRun> {
    await database.import_runs.updateMany({
      where: {
        organization_id: run.organizationId,
        id: run.id,
      },
      data: {
        state: "running",
        started_at: run.startedAt ?? input.claimedAt,
        heartbeat_at: input.claimedAt,
        lease_owner: input.workerId,
        lease_expires_at: input.leaseExpiresAt,
        attempt: { increment: 1 },
      },
    });
    const checkpoint = await database.provider_cursor_checkpoints.findFirst({
      where: {
        organization_id: run.organizationId,
        provider_id: run.providerId,
        config_revision_id: run.configRevisionId,
      },
      select: { cursor: true },
    });
    const claimed = await this.loadRun(database, run.organizationId, run.id);
    if (!claimed) throw new Error("Claimed import run could not be loaded.");
    return {
      ...claimed,
      state: "running",
      workerId: input.workerId,
      leaseExpiresAt: input.leaseExpiresAt,
      currentCursor: checkpoint?.cursor ?? null,
      nextPageNumber: claimed.counters.pages + 1,
    };
  }

  private async loadActiveRun(
    database: PackscoutQueryClient,
    organizationId: string,
    providerId: string,
  ): Promise<PersistedImportRun | null> {
    const row = await database.import_runs.findFirst({
      where: {
        organization_id: organizationId,
        provider_id: providerId,
        state: { in: ["queued", "running"] },
      },
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
    });
    return row ? this.toRun(row) : null;
  }

  private async loadRun(
    database: PackscoutQueryClient,
    organizationId: string,
    runId: string,
  ): Promise<PersistedImportRun | null> {
    const row = await database.import_runs.findFirst({
      where: {
        organization_id: organizationId,
        id: runId,
      },
    });
    return row ? this.toRun(row) : null;
  }

  private async lockRun(
    database: PackscoutTransactionClient,
    organizationId: string,
    runId: string,
  ): Promise<LockedImportRun | null> {
    const [locked] = await database.$queryRaw<{ id: string }[]>(Prisma.sql`
      select id
      from import_runs
      where organization_id = cast(${organizationId} as uuid)
        and id = cast(${runId} as uuid)
      for update
    `);
    if (!locked) return null;
    const row = await database.import_runs.findUnique({ where: { id: locked.id } });
    return row
      ? {
          run: this.toRun(row),
          leaseOwner: row.lease_owner,
          leaseExpiresAt: row.lease_expires_at,
        }
      : null;
  }

  private toRun(row: ImportRunRow): PersistedImportRun {
    return {
      id: row.id,
      organizationId: row.organization_id,
      providerId: row.provider_id,
      configRevisionId: row.config_revision_id,
      trigger: row.trigger,
      state: row.state,
      requestedCursor: row.requested_cursor,
      finalCursor: row.final_cursor,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      heartbeatAt: row.heartbeat_at,
      counters: normalizeCounters(row.counters_json),
      reachedProviderHead: row.reached_provider_head,
      failureCode: row.failure_code,
      failureSummary: row.failure_summary,
    };
  }
}
