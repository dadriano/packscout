import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutQueryClient,
  type PackscoutTransactionClient,
} from "./database.ts";
import type { RunCounters } from "./pipeline-types.ts";

export type PersistedImportTrigger = "scheduled" | "manual";
export type PersistedImportWorkerLane = "general" | "controlled";
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
  readonly trigger: PersistedImportTrigger | "recovery" | "archive";
  readonly workerLane: PersistedImportWorkerLane;
  readonly archiveSha256: string | null;
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
  readonly committedCursors: readonly string[];
  readonly committedArchiveUncompressedBytes: number;
  readonly archiveMaximumElapsedMs: number;
}

export type RequestImportPersistenceResult =
  | { readonly kind: "created"; readonly run: PersistedImportRun }
  | { readonly kind: "active"; readonly run: PersistedImportRun }
  | { readonly kind: "worker_lane_conflict"; readonly run: PersistedImportRun }
  | { readonly kind: "not_found" }
  | { readonly kind: "provider_unavailable" }
  | {
      readonly kind: "revision_conflict";
      readonly activeConfigurationRevisionId: string;
    };

export type RequestArchiveImportPersistenceResult =
  | { readonly kind: "created"; readonly run: PersistedImportRun }
  | { readonly kind: "existing"; readonly run: PersistedImportRun }
  | { readonly kind: "active"; readonly run: PersistedImportRun }
  | { readonly kind: "not_found" | "provider_unavailable" | "revision_conflict" };

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

export type YieldImportPersistenceResult =
  | { readonly kind: "yielded"; readonly run: PersistedImportRun }
  | { readonly kind: "not_found" }
  | { readonly kind: "ownership_lost" }
  | { readonly kind: "already_terminal"; readonly run: PersistedImportRun };

interface ImportRunRow {
  readonly id: string;
  readonly organization_id: string;
  readonly provider_id: string;
  readonly config_revision_id: string;
  readonly trigger: PersistedImportTrigger | "recovery" | "archive";
  readonly worker_lane: PersistedImportWorkerLane;
  readonly archive_sha256: string | null;
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

const maximumArchiveOperationElapsedMs = 4 * 60 * 60 * 1_000;

function archiveResourceCounters(counters: Prisma.JsonValue): {
  uncompressedBytes: number;
  maximumElapsedMs: number;
} {
  if (typeof counters !== "object" || counters === null || Array.isArray(counters)) {
    throw new Error("Archive run resource counters are invalid.");
  }
  const uncompressedBytes = counters.archiveUncompressedBytes;
  const maximumElapsedMs = counters.archiveMaximumElapsedMs;
  if (
    typeof uncompressedBytes !== "number" ||
    !Number.isSafeInteger(uncompressedBytes) ||
    uncompressedBytes < 0 ||
    typeof maximumElapsedMs !== "number" ||
    !Number.isSafeInteger(maximumElapsedMs) ||
    maximumElapsedMs < 1 ||
    maximumElapsedMs > maximumArchiveOperationElapsedMs
  ) {
    throw new Error("Archive run resource counters are invalid.");
  }
  return { uncompressedBytes, maximumElapsedMs };
}

export class PrismaImportRunRepository {
  constructor(protected readonly database: PackscoutPrismaClient) {}

  async requestRun(input: {
    organizationId: string;
    providerId: string;
    runId: string;
    trigger: PersistedImportTrigger;
    workerLane?: PersistedImportWorkerLane;
    requestedByActorKey: string | null;
    requestedAt: Date;
    expectedConfigurationRevisionId?: string;
  }): Promise<RequestImportPersistenceResult> {
    const workerLane = input.workerLane ?? "general";
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
        select: { tested_at: true, source_mode: true },
      });
      if (!activeRevision?.tested_at || activeRevision.source_mode !== "http") {
        return { kind: "provider_unavailable" };
      }

      const activeRun = await this.loadActiveRun(
        transaction,
        input.organizationId,
        input.providerId,
      );
      if (activeRun) {
        return activeRun.workerLane === workerLane
          ? { kind: "active", run: activeRun }
          : { kind: "worker_lane_conflict", run: activeRun };
      }
      const checkpoint = await transaction.provider_cursor_checkpoints.findFirst({
        where: {
          organization_id: input.organizationId,
          provider_id: input.providerId,
          cursor: { not: null },
        },
        select: { cursor: true },
        orderBy: [{ updated_at: "desc" }, { config_revision_id: "desc" }],
      });
      await transaction.import_runs.create({
        data: {
          id: input.runId,
          organization_id: input.organizationId,
          provider_id: input.providerId,
          config_revision_id: provider.active_revision_id,
          trigger: input.trigger,
          worker_lane: workerLane,
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
            workerLane,
          },
          occurred_at: input.requestedAt,
        },
      });
      const run = await this.loadRun(transaction, input.organizationId, input.runId);
      if (!run) throw new Error("Created import run could not be loaded.");
      return { kind: "created", run };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async requestArchiveRun(input: {
    organizationId: string;
    providerId: string;
    configurationRevisionId: string;
    runId: string;
    archiveSha256: string;
    requestedByActorKey: string;
    requestedAt: Date;
    initialCursor: string;
    maximumElapsedMs: number;
  }): Promise<RequestArchiveImportPersistenceResult> {
    if (!/^[0-9a-f]{64}$/.test(input.archiveSha256)) {
      throw new RangeError("Archive SHA-256 must be a lowercase hexadecimal value.");
    }
    if (
      input.requestedByActorKey.length < 1 ||
      input.initialCursor.length < 1 ||
      !Number.isSafeInteger(input.maximumElapsedMs) ||
      input.maximumElapsedMs < 1 ||
      input.maximumElapsedMs > maximumArchiveOperationElapsedMs
    ) {
      throw new RangeError(
        "Archive imports require a valid actor, initial cursor, and elapsed-time limit.",
      );
    }
    return this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`
        select id
        from provider_sources
        where id = cast(${input.providerId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
        for update
      `);
      const existingRow = await transaction.import_runs.findFirst({
        where: {
          organization_id: input.organizationId,
          provider_id: input.providerId,
          archive_sha256: input.archiveSha256,
        },
      });
      if (existingRow) {
        return existingRow.config_revision_id === input.configurationRevisionId
          ? { kind: "existing", run: this.toRun(existingRow) }
          : { kind: "revision_conflict" };
      }

      const provider = await transaction.provider_sources.findFirst({
        where: { organization_id: input.organizationId, id: input.providerId },
        select: { state: true, active_revision_id: true },
      });
      if (!provider) return { kind: "not_found" };
      if (provider.state === "archived") {
        return { kind: "provider_unavailable" };
      }
      const revision = await transaction.provider_config_revisions.findFirst({
        where: {
          id: input.configurationRevisionId,
          organization_id: input.organizationId,
          provider_id: input.providerId,
        },
        select: { source_mode: true, endpoint_url: true },
      });
      if (
        !revision ||
        revision.source_mode !== "archive" ||
        revision.endpoint_url !== `archive://sha256/${input.archiveSha256}`
      ) {
        return { kind: "revision_conflict" };
      }
      const activeRun = await this.loadActiveRun(
        transaction,
        input.organizationId,
        input.providerId,
      );
      if (activeRun) return { kind: "active", run: activeRun };

      await transaction.import_runs.create({
        data: {
          id: input.runId,
          organization_id: input.organizationId,
          provider_id: input.providerId,
          config_revision_id: input.configurationRevisionId,
          trigger: "archive",
          archive_sha256: input.archiveSha256,
          requested_by_actor_key: input.requestedByActorKey,
          state: "queued",
          requested_cursor: input.initialCursor,
          counters_json: {
            accepted: 0,
            duplicate: 0,
            quarantined: 0,
            pages: 0,
            records: 0,
            requestAttempts: 0,
            transientRetries: 0,
            archiveUncompressedBytes: 0,
            archiveMaximumElapsedMs: input.maximumElapsedMs,
          },
          created_at: input.requestedAt,
        },
      });
      await transaction.audit_events.create({
        data: {
          organization_id: input.organizationId,
          actor_key: input.requestedByActorKey,
          action: "provider.archive_import.request",
          subject_type: "import_run",
          subject_id: input.runId,
          outcome: "success",
          metadata_json: {
            providerId: input.providerId,
            configRevisionId: input.configurationRevisionId,
            archiveSha256: input.archiveSha256,
          },
          occurred_at: input.requestedAt,
        },
      });
      const run = await this.loadRun(transaction, input.organizationId, input.runId);
      if (!run) throw new Error("Created archive import run could not be loaded.");
      return { kind: "created", run };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async claimArchiveRun(input: {
    organizationId: string;
    runId: string;
    workerId: string;
    claimedAt: Date;
    leaseExpiresAt: Date;
  }): Promise<ClaimImportPersistenceResult> {
    this.assertLease(input.workerId, input.claimedAt, input.leaseExpiresAt);
    return this.database.$transaction(async (transaction) => {
      const locked = await this.lockRun(transaction, input.organizationId, input.runId);
      if (!locked) return { kind: "not_found" };
      const { run } = locked;
      const canClaim =
        run.trigger === "archive" &&
        (run.state === "queued" ||
          (run.state === "running" &&
            locked.leaseExpiresAt !== null &&
            locked.leaseExpiresAt <= input.claimedAt));
      if (!canClaim) return { kind: "not_claimable", run };
      return {
        kind: "claimed",
        run: await this.persistClaim(transaction, run, input),
      };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async getArchiveRevision(input: {
    organizationId: string;
    providerId: string;
    configurationRevisionId: string;
  }): Promise<{ platformKey: string; mappingAdapterKey: string } | null> {
    const revision = await this.database.provider_config_revisions.findFirst({
      where: {
        id: input.configurationRevisionId,
        organization_id: input.organizationId,
        provider_id: input.providerId,
        source_mode: "archive",
      },
      select: {
        mapping_adapter_key: true,
        provider_sources_provider_config_revisions_provider_idToprovider_sources: {
          select: { platform_key: true },
        },
      },
    });
    if (!revision?.mapping_adapter_key) return null;
    return {
      platformKey:
        revision.provider_sources_provider_config_revisions_provider_idToprovider_sources.platform_key,
      mappingAdapterKey: revision.mapping_adapter_key,
    };
  }

  async hasCommittedTerminalPage(input: {
    organizationId: string;
    runId: string;
    pageNumber: number;
    finalCursor: string;
  }): Promise<boolean> {
    if (!Number.isSafeInteger(input.pageNumber) || input.pageNumber < 1) return false;
    const rows = await this.database.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
      select exists (
        select 1
        from public.import_pages as page
        join public.import_runs as run
          on run.id = page.run_id
         and run.organization_id = page.organization_id
        where run.id = cast(${input.runId} as uuid)
          and run.organization_id = cast(${input.organizationId} as uuid)
          and page.page_number = ${input.pageNumber}
          and page.next_cursor = ${input.finalCursor}
          and page.has_more = false
          and (
            run.trigger <> 'archive'::public.import_trigger
            or (
              run.started_at is not null
              and jsonb_typeof(run.counters_json -> 'archiveMaximumElapsedMs') = 'number'
              and (run.counters_json ->> 'archiveMaximumElapsedMs')::bigint
                between 1 and ${maximumArchiveOperationElapsedMs}
              and page.committed_at <= run.started_at +
                ((run.counters_json ->> 'archiveMaximumElapsedMs')::bigint *
                  interval '1 millisecond')
            )
          )
      ) as present
    `);
    return rows[0]?.present ?? false;
  }

  async claimRun(input: {
    organizationId: string;
    runId: string;
    workerId: string;
    workerLane?: PersistedImportWorkerLane;
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
      const workerLane = input.workerLane ?? "general";
      const canClaim =
        run.trigger !== "archive" && run.workerLane === workerLane && (run.state === "queued" ||
        (run.state === "running" &&
          locked.leaseExpiresAt !== null &&
          locked.leaseExpiresAt <= input.claimedAt));
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
        where trigger <> 'archive'::import_trigger
          and worker_lane = 'general'::import_worker_lane
          and (
            state = 'queued'::import_run_state
            or (
             state = 'running'::import_run_state
             and lease_expires_at is not null
             and lease_expires_at <= ${input.claimedAt}
            )
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

  async yieldRun(input: {
    organizationId: string;
    runId: string;
    workerId: string;
    yieldedAt: Date;
  }): Promise<YieldImportPersistenceResult> {
    return this.database.$transaction(async (transaction) => {
      const locked = await this.lockRun(
        transaction,
        input.organizationId,
        input.runId,
      );
      if (!locked) return { kind: "not_found" };
      if (locked.run.state !== "running") {
        return { kind: "already_terminal", run: locked.run };
      }
      if (locked.leaseOwner !== input.workerId) return { kind: "ownership_lost" };
      await transaction.import_runs.updateMany({
        where: {
          organization_id: input.organizationId,
          id: input.runId,
          state: "running",
          lease_owner: input.workerId,
        },
        data: {
          state: "queued",
          heartbeat_at: input.yieldedAt,
          lease_owner: null,
          lease_expires_at: null,
        },
      });
      const yielded = await this.loadRun(
        transaction,
        input.organizationId,
        input.runId,
      );
      if (!yielded) throw new Error("Yielded import run could not be loaded.");
      return { kind: "yielded", run: yielded };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
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
    if (run.trigger === "archive") {
      await database.$executeRaw(Prisma.sql`
        update public.import_runs
        set state = 'running'::public.import_run_state,
            started_at = coalesce(started_at, clock_timestamp()),
            heartbeat_at = ${input.claimedAt},
            lease_owner = ${input.workerId},
            lease_expires_at = ${input.leaseExpiresAt},
            attempt = attempt + 1
        where organization_id = cast(${run.organizationId} as uuid)
          and id = cast(${run.id} as uuid)
      `);
    } else {
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
    }
    const checkpoint = run.trigger === "archive"
      ? null
      : await database.provider_cursor_checkpoints.findFirst({
          where: {
            organization_id: run.organizationId,
            provider_id: run.providerId,
            cursor: { not: null },
          },
          select: { cursor: true },
          orderBy: [{ updated_at: "desc" }, { config_revision_id: "desc" }],
        });
    const claimed = await this.loadRun(database, run.organizationId, run.id);
    if (!claimed) throw new Error("Claimed import run could not be loaded.");
    const claimedResourceCounters = run.trigger === "archive"
      ? await database.import_runs.findFirst({
          where: { id: run.id, organization_id: run.organizationId },
          select: { counters_json: true },
        })
      : null;
    const committedPages = await database.import_pages.findMany({
      where: {
        organization_id: run.organizationId,
        run_id: run.id,
      },
      select: { requested_cursor: true, next_cursor: true },
      orderBy: [{ page_number: "asc" }, { id: "asc" }],
      take: 100_001,
    });
    const committedCursors = [...new Set(
      committedPages.flatMap(({ requested_cursor, next_cursor }) =>
        [requested_cursor, next_cursor].filter(
          (cursor): cursor is string => cursor !== null,
        ),
      ),
    )];
    const archiveResources = run.trigger === "archive"
      ? archiveResourceCounters(claimedResourceCounters?.counters_json ?? null)
      : null;
    return {
      ...claimed,
      state: "running",
      workerId: input.workerId,
      leaseExpiresAt: input.leaseExpiresAt,
      currentCursor:
        run.trigger === "archive"
          ? claimed.finalCursor ?? claimed.requestedCursor
          : checkpoint?.cursor ?? claimed.finalCursor ?? claimed.requestedCursor,
      nextPageNumber: claimed.counters.pages + 1,
      committedCursors,
      committedArchiveUncompressedBytes:
        archiveResources?.uncompressedBytes ?? 0,
      archiveMaximumElapsedMs:
        archiveResources?.maximumElapsedMs ?? maximumArchiveOperationElapsedMs,
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
      workerLane: row.worker_lane,
      archiveSha256: row.archive_sha256,
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
