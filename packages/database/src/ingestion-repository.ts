import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutQueryClient,
  type PackscoutTransactionClient,
} from "./database.ts";
import { estimatedEvRecomputationRequestKey } from "./estimated-ev-recomputation-repository.ts";
import {
  persistPageRecordsInBatches,
  writeCanonicalProjectionBatch,
} from "./ingestion-page-batch-writer.ts";
import type {
  CanonicalIdentity,
  CanonicalProjectionInput,
  CanonicalRevisionRecord,
  CommitPageInput,
  CommitPageResult,
  CurrentProjection,
  MaterializeAndProjectSourceRecordInput,
  ProjectDerivedSourceRecordInput,
  ProjectSourceRecordInput,
  RawEvidencePolicy,
  RunCounters,
  SourceRecordKind,
} from "./pipeline-types.ts";
import { PersistenceError } from "./persistence-error.ts";
import {
  providerStreamContentHashV2,
  providerStreamRecordIdentityHashV2,
  providerStreamSourceFactsHashV2,
} from "./provider-stream-write-policy.ts";
import { databaseSafeProtectedJsonEvidence } from "./protected-json-evidence.ts";
import { hashJson } from "./security.ts";
import {
  advanceSettledPublicWatermark,
  allocatePublicChangeCauses,
  canonicalCatalogPlatformKeys,
  createPublicDerivationObligationBatch,
  relationshipPublicEntityKey,
  type PublicCatalogImpact,
} from "./public-change-settlement-repository.ts";

const millisecondsPerDay = 24 * 60 * 60 * 1_000;
const maximumRowsPerWrite = 500;
const maximumArchiveOperationUncompressedBytes = 4 * 1024 * 1024 * 1024;
const maximumArchiveOperationElapsedMs = 4 * 60 * 60 * 1_000;
const catalogProjectionRecordKinds = new Set<CanonicalIdentity["recordKind"]>([
  "platform",
  "pack",
  "catalog_asset",
  "ev_input",
  "estimated_ev",
]);

function relationshipCatalogImpact(input: {
  sourceRecordKind: CanonicalIdentity["recordKind"];
  sourcePlatformKey: string;
  targetPlatformKey: string;
}): PublicCatalogImpact {
  return catalogProjectionRecordKinds.has(input.sourceRecordKind)
    ? {
        kind: "catalog",
        providerPlatformKeys: canonicalCatalogPlatformKeys([
          input.sourcePlatformKey,
          input.targetPlatformKey,
        ]),
      }
    : { kind: "none" };
}

interface ChangedPackInput {
  readonly platformKey: string;
  readonly packExternalId: string;
  readonly causeSequences: readonly bigint[];
}

interface ChangedEvInput extends ChangedPackInput {
  readonly evInputExternalId: string;
}

interface CanonicalRevisionRow {
  entityId: string;
  revisionId: string;
  revisionNumber: number;
  content: Record<string, unknown>;
  provenance: Record<string, unknown>;
  actorKey: string | null;
  sourceRecordId: string;
  sourceUpdatedAt: Date;
  sourceCollectedAt: Date;
  acceptedAt: Date;
}

function addRetentionPeriod(at: Date, retentionDays: number): Date {
  return new Date(at.getTime() + retentionDays * millisecondsPerDay);
}

function emptyCounters(): RunCounters {
  return {
    accepted: 0,
    duplicate: 0,
    quarantined: 0,
    pages: 0,
    records: 0,
    requestAttempts: 0,
    transientRetries: 0,
  };
}

function archiveResourceCounters(value: unknown): {
  uncompressedBytes: number;
  maximumElapsedMs: number;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Archive run resource counters are invalid.");
  }
  const bytes = (value as Record<string, unknown>).archiveUncompressedBytes;
  const maximumElapsedMs = (value as Record<string, unknown>).archiveMaximumElapsedMs;
  if (
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    typeof maximumElapsedMs !== "number" ||
    !Number.isSafeInteger(maximumElapsedMs) ||
    maximumElapsedMs < 1 ||
    maximumElapsedMs > maximumArchiveOperationElapsedMs
  ) {
    throw new Error("Archive run resource counters are invalid.");
  }
  return { uncompressedBytes: bytes, maximumElapsedMs };
}

function jsonValue(value: unknown): Prisma.Sql {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Persistence JSON values must be serializable.");
  }
  return Prisma.sql`cast(${serialized} as jsonb)`;
}

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

function batches<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += maximumRowsPerWrite) {
    result.push(values.slice(index, index + maximumRowsPerWrite));
  }
  return result;
}

export class IngestionPersistenceRepository {
  constructor(
    private readonly database: PackscoutPrismaClient,
    private readonly policy: RawEvidencePolicy,
  ) {
    if (policy.retentionDays !== 90) {
      throw new Error("Raw evidence retention must be exactly 90 days.");
    }
  }

  async commitPage(input: CommitPageInput): Promise<CommitPageResult> {
    return this.database.$transaction(async (transaction) => {
      const context = await this.loadRunContext(transaction, input);
      const nextArchiveUncompressedBytes = (() => {
        if (input.checkpointMode !== "archive") {
          if (input.archiveUncompressedBytes !== undefined) {
            throw new TypeError("Live provider pages cannot declare archive byte usage.");
          }
          return null;
        }
        if (
          !Number.isSafeInteger(input.archiveUncompressedBytes) ||
          input.archiveUncompressedBytes === undefined ||
          input.archiveUncompressedBytes < 1
        ) {
          throw new TypeError("Archive page byte usage must be a positive safe integer.");
        }
        const next =
          context.committedArchiveUncompressedBytes + input.archiveUncompressedBytes;
        if (next > maximumArchiveOperationUncompressedBytes) {
          throw new RangeError("Archive run exceeds the uncompressed byte limit.");
        }
        return next;
      })();
      const protectedPayload = databaseSafeProtectedJsonEvidence(input.payload);
      const payloadHash = input.payloadHash ?? hashJson(protectedPayload);
      if (!/^[0-9a-f]{64}$/.test(payloadHash)) {
        throw new TypeError("Page payload hash must be a lowercase SHA-256 value.");
      }
      const expiresAt = addRetentionPeriod(input.committedAt, this.policy.retentionDays);
      const recordKindCount = (recordKind: SourceRecordKind) =>
        input.records.filter((record) => record.recordKind === recordKind).length +
        (input.quarantines ?? []).filter(
          (quarantine) => quarantine.recordKind === recordKind,
        ).length;
      const recordCounts = {
        catalog: recordKindCount("catalog"),
        pulls: recordKindCount("pull"),
        trades: recordKindCount("trade"),
      };
      const pageCommittedAt =
        input.checkpointMode === "archive"
          ? Prisma.sql`clock_timestamp()`
          : Prisma.sql`${input.committedAt}`;
      const insertedPages = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        insert into public.import_pages (
          organization_id, provider_id, run_id, page_number, requested_cursor,
          next_cursor, has_more, payload_json, payload_hash, record_counts_json,
          committed_at, expires_at
        ) values (
          ${uuid(input.organizationId)}, ${uuid(input.providerId)}, ${uuid(input.runId)},
          ${input.pageNumber}, ${input.requestedCursor}, ${input.nextCursor}, ${input.hasMore},
          ${jsonValue(protectedPayload)},
          ${payloadHash}, ${jsonValue(recordCounts)},
          ${pageCommittedAt}, ${expiresAt}
        )
        on conflict do nothing
        returning id
      `);
      const insertedPage = insertedPages[0];
      if (!insertedPage) {
        const existingPages = await transaction.$queryRaw<Array<{
          id: string;
          payloadHash: string;
        }>>(Prisma.sql`
          select id, payload_hash as "payloadHash"
          from public.import_pages
          where organization_id = ${uuid(input.organizationId)}
            and run_id = ${uuid(input.runId)}
            and page_number = ${input.pageNumber}
          limit 1
        `);
        const existingPage = existingPages[0];
        if (!existingPage || existingPage.payloadHash !== payloadHash) {
          throw new PersistenceError(
            "IDEMPOTENCY_CONFLICT",
            "The run page identity is already committed with different content.",
          );
        }
        return {
          kind: "already_committed",
          pageId: existingPage.id,
          counters: context.counters,
          newCanonicalRevisions: 0,
          duplicateSourceRecords: 0,
        };
      }

      if (input.checkpointMode === "provider") {
        const stationaryEmptyTerminalPage =
          input.nextCursor !== null &&
          input.nextCursor === input.requestedCursor &&
          !input.hasMore &&
          input.records.length === 0 &&
          (input.quarantines?.length ?? 0) === 0;
        if (input.nextCursor === null) {
          throw new PersistenceError(
            "CURSOR_SAFETY_VIOLATION",
            "A live provider page must return a resumable cursor.",
          );
        }
        if (
          input.nextCursor === input.requestedCursor &&
          !stationaryEmptyTerminalPage
        ) {
          throw new PersistenceError(
            "CURSOR_SAFETY_VIOLATION",
            "A live provider page did not advance its continuing cursor.",
          );
        }
        if (!stationaryEmptyTerminalPage) {
          // Replaying a known pagination edge is valid recovery/idempotency.
          // Reaching an old cursor through a new edge is a regression cycle.
          const cursorHistory = await transaction.$queryRaw<Array<{
            currentRunReuse: boolean;
            priorRunReuse: boolean;
            exactEdgeReplay: boolean;
          }>>(Prisma.sql`
            with prior_run_edges as materialized (
              select historical_page.requested_cursor, historical_page.next_cursor
              from public.import_runs as historical_run
              join public.import_pages as historical_page
                on historical_page.run_id = historical_run.id
               and historical_page.organization_id = historical_run.organization_id
               and historical_page.provider_id = historical_run.provider_id
              where historical_run.organization_id = ${uuid(input.organizationId)}
                and historical_run.provider_id = ${uuid(input.providerId)}
                and historical_run.trigger <> 'archive'::public.import_trigger
                and historical_run.id <> ${uuid(input.runId)}
                and historical_page.id <> ${uuid(insertedPage.id)}
            )
            select
              exists (
                select 1
                from public.import_pages as current_page
                where current_page.organization_id = ${uuid(input.organizationId)}
                  and current_page.run_id = ${uuid(input.runId)}
                  and current_page.id <> ${uuid(insertedPage.id)}
                  and current_page.requested_cursor = ${input.nextCursor}
                limit 1
              ) as "currentRunReuse",
              exists (
                select 1
                from prior_run_edges
                where requested_cursor = ${input.nextCursor}
                   or next_cursor = ${input.nextCursor}
                limit 1
              ) as "priorRunReuse",
              exists (
                select 1
                from prior_run_edges
                where requested_cursor is not distinct from ${input.requestedCursor}
                  and next_cursor = ${input.nextCursor}
                limit 1
              ) as "exactEdgeReplay"
          `);
          if (
            cursorHistory[0]?.currentRunReuse ||
            (cursorHistory[0]?.priorRunReuse &&
              !cursorHistory[0].exactEdgeReplay)
          ) {
            throw new PersistenceError(
              "CURSOR_SAFETY_VIOLATION",
              "A live provider page attempted to reuse an earlier provider cursor.",
            );
          }
        }
      }

      const changedPacks = new Map<string, ChangedPackInput>();
      const changedEvInputs = new Map<string, ChangedEvInput>();
      const persisted = await persistPageRecordsInBatches(
        transaction,
        this.policy,
        input,
        insertedPage.id,
        expiresAt,
      );
      for (const created of persisted.createdCanonicalProjections) {
        this.recordEstimatedEvTrigger(
          created.projection,
          created.publicChangeSequence,
          changedPacks,
          changedEvInputs,
        );
      }
      await this.enqueueEstimatedEvRecomputations(transaction, {
        organizationId: input.organizationId,
        providerId: input.providerId,
        configurationRevisionId: input.configRevisionId,
        changedPacks: [...changedPacks.values()],
        changedEvInputs: [...changedEvInputs.values()],
        createdAt: input.committedAt,
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId: input.organizationId,
        settledAt: input.committedAt,
      });

      const counters: RunCounters = {
        accepted: context.counters.accepted + persisted.accepted,
        duplicate: context.counters.duplicate + persisted.duplicate,
        quarantined:
          context.counters.quarantined + persisted.quarantined,
        pages: context.counters.pages + 1,
        records:
          context.counters.records + input.records.length + (input.quarantines?.length ?? 0),
        requestAttempts: context.counters.requestAttempts ?? 0,
        transientRetries: context.counters.transientRetries ?? 0,
      };
      const persistedCounters =
        nextArchiveUncompressedBytes === null
          ? counters
          : {
              ...counters,
              archiveUncompressedBytes: nextArchiveUncompressedBytes,
              archiveMaximumElapsedMs: context.archiveMaximumElapsedMs,
            };
      const updatedRuns =
        input.checkpointMode === "archive"
          ? await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
              with deadline_clock as materialized (
                select clock_timestamp() as checked_at
              ), updated_run as (
                update public.import_runs as run
                set final_cursor = ${input.nextCursor},
                    counters_json = ${jsonValue(persistedCounters)}
                from deadline_clock
                where run.id = ${uuid(input.runId)}
                  and run.organization_id = ${uuid(input.organizationId)}
                  and run.started_at is not null
                  and deadline_clock.checked_at < run.started_at +
                    (${context.archiveMaximumElapsedMs} * interval '1 millisecond')
                returning run.id, deadline_clock.checked_at
              )
              update public.import_pages as page
              set committed_at = updated_run.checked_at
              from updated_run
              where page.id = ${uuid(insertedPage.id)}
                and page.run_id = ${uuid(input.runId)}
                and page.organization_id = ${uuid(input.organizationId)}
              returning updated_run.id
            `)
          : await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
              update public.import_runs as run
              set final_cursor = ${input.nextCursor},
                  counters_json = ${jsonValue(persistedCounters)}
              where run.id = ${uuid(input.runId)}
                and run.organization_id = ${uuid(input.organizationId)}
              returning run.id
            `);
      if (updatedRuns.length !== 1) {
        throw new PersistenceError(
          input.checkpointMode === "archive"
            ? "ARCHIVE_DEADLINE_EXCEEDED"
            : "TENANT_SCOPE_VIOLATION",
          input.checkpointMode === "archive"
            ? "Archive page persistence crossed the immutable run deadline."
            : "Import run disappeared from its locked tenant scope.",
        );
      }
      if (input.checkpointMode === "provider") {
        await transaction.$executeRaw(Prisma.sql`
          insert into public.provider_cursor_checkpoints (
            config_revision_id, organization_id, provider_id, cursor,
            advanced_by_run_id, updated_at
          ) values (
            ${uuid(input.configRevisionId)}, ${uuid(input.organizationId)},
            ${uuid(input.providerId)}, ${input.nextCursor}, ${uuid(input.runId)},
            ${input.committedAt}
          )
          on conflict (config_revision_id) do update
          set cursor = excluded.cursor,
              advanced_by_run_id = excluded.advanced_by_run_id,
              updated_at = excluded.updated_at
        `);
      }
      return {
        kind: "committed",
        pageId: insertedPage.id,
        counters,
        newCanonicalRevisions: persisted.newCanonicalRevisions,
        duplicateSourceRecords: persisted.duplicate,
      };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async projectSourceRecord(
    input: ProjectSourceRecordInput,
  ): Promise<{ canonicalRevisionCount: number }> {
    return this.database.$transaction(async (transaction) => {
      const sources = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        select source.id
        from public.source_records as source
        join public.quarantine_records as quarantine
          on quarantine.id = ${uuid(input.quarantineId)}
         and quarantine.organization_id = source.organization_id
         and quarantine.provider_id = source.provider_id
         and quarantine.source_record_id = source.id
        join public.quarantine_attempts as attempt
          on attempt.id = ${uuid(input.attemptId)}
         and attempt.organization_id = source.organization_id
         and attempt.quarantine_id = quarantine.id
         and attempt.state = 'running'
        join public.provider_config_revisions as revision
          on revision.id = ${uuid(input.configurationRevisionId)}
         and revision.organization_id = source.organization_id
         and revision.provider_id = source.provider_id
        where source.id = ${uuid(input.sourceRecordId)}
          and source.organization_id = ${uuid(input.organizationId)}
          and source.provider_id = ${uuid(input.providerId)}
          and quarantine.state = 'open'
          and quarantine.expires_at > ${input.acceptedAt}
        for update of source
        limit 1
      `);
      if (!sources[0]) {
        throw new PersistenceError(
          "TENANT_SCOPE_VIOLATION",
          "Source record is outside the organization, provider, or configuration scope.",
        );
      }
      const results = await writeCanonicalProjectionBatch(
        transaction,
        this.policy,
        input.projections.map((projection, projectionIndex) => ({
          organizationId: input.organizationId,
          providerId: input.providerId,
          configRevisionId: input.configurationRevisionId,
          sourceRecordId: input.sourceRecordId,
          projection,
          projectionIndex,
          acceptedAt: input.acceptedAt,
          publicChangeKind: "quarantine_correction",
        })),
      );
      const changedPacks = new Map<string, ChangedPackInput>();
      const changedEvInputs = new Map<string, ChangedEvInput>();
      results.forEach((result, index) => {
        if (!result.created) return;
        this.recordEstimatedEvTrigger(
          input.projections[index]!,
          result.publicChangeSequence,
          changedPacks,
          changedEvInputs,
        );
      });
      await this.enqueueEstimatedEvRecomputations(transaction, {
        organizationId: input.organizationId,
        providerId: input.providerId,
        configurationRevisionId: input.configurationRevisionId,
        changedPacks: [...changedPacks.values()],
        changedEvInputs: [...changedEvInputs.values()],
        createdAt: input.acceptedAt,
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId: input.organizationId,
        settledAt: input.acceptedAt,
      });
      return { canonicalRevisionCount: results.filter(({ created }) => created).length };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async projectDerivedSourceRecord(
    input: ProjectDerivedSourceRecordInput,
  ): Promise<{ canonicalRevisionCount: number }> {
    return this.database.$transaction(async (transaction) => {
      const sources = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        select source.id
        from public.source_records as source
        join public.provider_config_revisions as revision
          on revision.id = ${uuid(input.configurationRevisionId)}
         and revision.organization_id = source.organization_id
         and revision.provider_id = source.provider_id
        where source.id = ${uuid(input.sourceRecordId)}
          and source.organization_id = ${uuid(input.organizationId)}
          and source.provider_id = ${uuid(input.providerId)}
        for update of source
        limit 1
      `);
      if (!sources[0]) {
        throw new PersistenceError(
          "TENANT_SCOPE_VIOLATION",
          "Derived projection source is outside the organization, provider, or configuration scope.",
        );
      }
      const results = await writeCanonicalProjectionBatch(
        transaction,
        this.policy,
        input.projections.map((projection, projectionIndex) => ({
          organizationId: input.organizationId,
          providerId: input.providerId,
          configRevisionId: input.configurationRevisionId,
          sourceRecordId: input.sourceRecordId,
          projection,
          projectionIndex,
          acceptedAt: input.acceptedAt,
          publicChangeKind: "estimated_ev_outcome",
        })),
      );
      await advanceSettledPublicWatermark(transaction, {
        organizationId: input.organizationId,
        settledAt: input.acceptedAt,
      });
      return { canonicalRevisionCount: results.filter(({ created }) => created).length };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async materializeAndProjectSourceRecord(
    input: MaterializeAndProjectSourceRecordInput,
  ): Promise<{ sourceRecordId: string; canonicalRevisionCount: number }> {
    return this.database.$transaction(async (transaction) => {
      const quarantines = await transaction.$queryRaw<Array<{
        sourceRecordId: string | null;
      }>>(Prisma.sql`
        select quarantine.source_record_id as "sourceRecordId"
        from public.quarantine_records as quarantine
        join public.import_runs as run
          on run.id = quarantine.run_id
         and run.organization_id = quarantine.organization_id
         and run.provider_id = quarantine.provider_id
         and run.config_revision_id = ${uuid(input.configurationRevisionId)}
        join public.quarantine_attempts as attempt
          on attempt.id = ${uuid(input.attemptId)}
         and attempt.organization_id = quarantine.organization_id
         and attempt.quarantine_id = quarantine.id
         and attempt.state = 'running'
        where quarantine.id = ${uuid(input.quarantineId)}
          and quarantine.organization_id = ${uuid(input.organizationId)}
          and quarantine.provider_id = ${uuid(input.providerId)}
          and quarantine.run_id = ${uuid(input.runId)}
          and quarantine.page_id = ${uuid(input.pageId)}
          and quarantine.record_kind = cast(${input.recordKind} as public.source_record_kind)
          and quarantine.state = 'open'
          and quarantine.expires_at > ${input.acceptedAt}
        for update of quarantine
        limit 1
      `);
      const quarantine = quarantines[0];
      if (!quarantine) {
        throw new PersistenceError(
          "TENANT_SCOPE_VIOLATION",
          "Quarantine record is outside the organization, provider, or configuration scope.",
        );
      }

      let sourceRecordId = quarantine.sourceRecordId;
      if (!sourceRecordId) {
        const contentHash = providerStreamContentHashV2(input.payload);
        const recordIdentityHash = providerStreamRecordIdentityHashV2(input.payload);
        const sourceFactsHash = providerStreamSourceFactsHashV2(input.payload);
        const createdSources = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          insert into public.source_records (
            organization_id, provider_id, first_run_id, first_page_id,
            record_kind, external_id, source_time, collected_at, payload_json,
            content_hash, record_identity_hash, source_facts_hash, expires_at, created_at
          ) values (
            ${uuid(input.organizationId)}, ${uuid(input.providerId)},
            ${uuid(input.runId)}, ${uuid(input.pageId)},
            cast(${input.recordKind} as public.source_record_kind),
            ${input.externalId}, ${input.sourceTime}, ${input.collectedAt},
            ${jsonValue(input.payload)}, ${contentHash}, ${recordIdentityHash},
            ${sourceFactsHash}, ${input.expiresAt},
            ${input.acceptedAt}
          )
          on conflict do nothing
          returning id
        `);
        sourceRecordId = createdSources[0]?.id ?? await this.findSourceRecordId(
          transaction,
          {
            organizationId: input.organizationId,
            providerId: input.providerId,
            recordKind: input.recordKind,
            externalId: input.externalId,
            sourceFactsHash,
          },
        );
        await transaction.$executeRaw(Prisma.sql`
          insert into public.source_record_observations (
            source_record_id, organization_id, run_id, page_id, observed_at,
            source_collected_at
          ) values (
            ${uuid(sourceRecordId)}, ${uuid(input.organizationId)},
            ${uuid(input.runId)}, ${uuid(input.pageId)}, ${input.acceptedAt},
            ${input.collectedAt}
          )
          on conflict do nothing
        `);
        await transaction.$executeRaw(Prisma.sql`
          update public.source_record_outcomes
          set source_record_id = ${uuid(sourceRecordId)},
              external_id = ${input.externalId}
          where organization_id = ${uuid(input.organizationId)}
            and run_id = ${uuid(input.runId)}
            and page_id = ${uuid(input.pageId)}
            and record_kind = cast(${input.recordKind} as public.source_record_kind)
            and record_index = ${input.recordIndex}
        `);
        await transaction.$executeRaw(Prisma.sql`
          update public.quarantine_records
          set source_record_id = ${uuid(sourceRecordId)},
              external_id = ${input.externalId}
          where id = ${uuid(input.quarantineId)}
            and organization_id = ${uuid(input.organizationId)}
            and source_record_id is null
        `);
      }

      const results = await writeCanonicalProjectionBatch(
        transaction,
        this.policy,
        input.projections.map((projection, projectionIndex) => ({
          organizationId: input.organizationId,
          providerId: input.providerId,
          configRevisionId: input.configurationRevisionId,
          sourceRecordId,
          projection,
          projectionIndex,
          acceptedAt: input.acceptedAt,
          publicChangeKind: "quarantine_correction",
        })),
      );
      const changedPacks = new Map<string, ChangedPackInput>();
      const changedEvInputs = new Map<string, ChangedEvInput>();
      results.forEach((result, index) => {
        if (!result.created) return;
        this.recordEstimatedEvTrigger(
          input.projections[index]!,
          result.publicChangeSequence,
          changedPacks,
          changedEvInputs,
        );
      });
      await this.enqueueEstimatedEvRecomputations(transaction, {
        organizationId: input.organizationId,
        providerId: input.providerId,
        configurationRevisionId: input.configurationRevisionId,
        changedPacks: [...changedPacks.values()],
        changedEvInputs: [...changedEvInputs.values()],
        createdAt: input.acceptedAt,
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId: input.organizationId,
        settledAt: input.acceptedAt,
      });
      return {
        sourceRecordId,
        canonicalRevisionCount: results.filter(({ created }) => created).length,
      };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async getCurrentProjection(
    organizationId: string,
    identity: CanonicalIdentity,
  ): Promise<CurrentProjection | null> {
    const records = await this.database.$queryRaw<CanonicalRevisionRow[]>(Prisma.sql`
      select
        entity.id as "entityId",
        revision.id as "revisionId",
        revision.revision_number as "revisionNumber",
        revision.content_json as content,
        revision.provenance_json as provenance,
        revision.actor_key as "actorKey",
        revision.source_record_id as "sourceRecordId",
        revision.source_updated_at as "sourceUpdatedAt",
        revision.source_collected_at as "sourceCollectedAt",
        revision.accepted_at as "acceptedAt"
      from public.canonical_entities as entity
      join public.canonical_revisions as revision
        on revision.id = entity.current_revision_id
      where entity.organization_id = ${uuid(organizationId)}
        and entity.platform_key = ${identity.platformKey}
        and entity.record_kind = cast(${identity.recordKind} as public.canonical_record_kind)
        and entity.external_id = ${identity.externalId}
      limit 1
    `);
    const record = records[0];
    if (!record) return null;
    return {
      identity,
      entityId: record.entityId,
      revisionId: record.revisionId,
      revisionNumber: record.revisionNumber,
      content: record.content,
      provenance: record.provenance,
      actorKey: record.actorKey,
      sourceUpdatedAt: record.sourceUpdatedAt,
      sourceCollectedAt: record.sourceCollectedAt,
      acceptedAt: record.acceptedAt,
    };
  }

  async listCanonicalRevisions(
    organizationId: string,
    identity: CanonicalIdentity,
  ): Promise<CanonicalRevisionRecord[]> {
    const records = await this.database.$queryRaw<CanonicalRevisionRow[]>(Prisma.sql`
      select
        entity.id as "entityId",
        revision.id as "revisionId",
        revision.revision_number as "revisionNumber",
        revision.content_json as content,
        revision.provenance_json as provenance,
        revision.actor_key as "actorKey",
        revision.source_record_id as "sourceRecordId",
        revision.source_updated_at as "sourceUpdatedAt",
        revision.source_collected_at as "sourceCollectedAt",
        revision.accepted_at as "acceptedAt"
      from public.canonical_entities as entity
      join public.canonical_revisions as revision on revision.entity_id = entity.id
      where entity.organization_id = ${uuid(organizationId)}
        and entity.platform_key = ${identity.platformKey}
        and entity.record_kind = cast(${identity.recordKind} as public.canonical_record_kind)
        and entity.external_id = ${identity.externalId}
      order by revision.revision_number
    `);
    return records.map((record) => ({ ...record, identity }));
  }

  async reconcileRelationships(input: {
    organizationId: string;
    target: CanonicalIdentity;
    resolvedAt: Date;
  }): Promise<number> {
    return this.database.$transaction(async (transaction) => {
      const targets = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        select id
        from public.canonical_entities
        where organization_id = ${uuid(input.organizationId)}
          and platform_key = ${input.target.platformKey}
          and record_kind = cast(${input.target.recordKind} as public.canonical_record_kind)
          and external_id = ${input.target.externalId}
        for update
        limit 1
      `);
      const target = targets[0];
      if (!target) return 0;
      let reconciledCount = 0;
      while (true) {
        const relationshipBatch = await transaction.$queryRaw<Array<{
          id: string;
          sourceEntityId: string;
          sourcePlatformKey: string;
          sourceRecordKind: CanonicalIdentity["recordKind"];
          relationshipKind: string;
          targetPlatformKey: string;
          targetRecordKind: CanonicalIdentity["recordKind"];
          targetExternalId: string;
        }>>(Prisma.sql`
          select relationship.id,
                 relationship.source_entity_id as "sourceEntityId",
                 source_entity.platform_key as "sourcePlatformKey",
                 source_entity.record_kind::text as "sourceRecordKind",
                 relationship.relationship_kind as "relationshipKind",
                 relationship.target_platform_key as "targetPlatformKey",
                 relationship.target_record_kind::text as "targetRecordKind",
                 relationship.target_external_id as "targetExternalId"
          from public.canonical_relationships as relationship
          join public.canonical_entities as source_entity
            on source_entity.id = relationship.source_entity_id
           and source_entity.organization_id = relationship.organization_id
          where relationship.organization_id = ${uuid(input.organizationId)}
            and relationship.target_platform_key = ${input.target.platformKey}
            and relationship.target_record_kind = cast(${input.target.recordKind} as public.canonical_record_kind)
            and relationship.target_external_id = ${input.target.externalId}
            and relationship.target_entity_id is null
          order by relationship.id
          for update of relationship
          limit ${maximumRowsPerWrite}
        `);
        if (relationshipBatch.length === 0) break;
        const causes = await allocatePublicChangeCauses(transaction, {
          organizationId: input.organizationId,
          changes: relationshipBatch.map((relationship) => ({
            changeKind: "relationship_resolution",
            entityKey: relationshipPublicEntityKey(relationship),
            sourceKey: input.target.platformKey,
            metadata: { relationshipState: "resolved" },
            occurredAt: input.resolvedAt,
            catalogImpact: relationshipCatalogImpact(relationship),
          })),
        });
        const rows = relationshipBatch.map((relationship, index) => {
          const sequence = causes[index]?.sequence;
          if (sequence === undefined) throw new Error("Resolution cause is missing.");
          return Prisma.sql`(${uuid(relationship.id)}, ${sequence})`;
        });
        await transaction.$executeRaw(Prisma.sql`
          update public.canonical_relationships as relationship
          set target_entity_id = ${uuid(target.id)},
              resolved_at = ${input.resolvedAt},
              resolved_public_change_sequence = resolved.public_change_sequence
          from (values ${Prisma.join(rows)})
            as resolved(relationship_id, public_change_sequence)
          where relationship.id = resolved.relationship_id
            and relationship.organization_id = ${uuid(input.organizationId)}
            and relationship.target_entity_id is null
        `);
        reconciledCount += relationshipBatch.length;
      }
      await advanceSettledPublicWatermark(transaction, {
        organizationId: input.organizationId,
        settledAt: input.resolvedAt,
      });
      return reconciledCount;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  private recordEstimatedEvTrigger(
    projection: CanonicalProjectionInput,
    publicChangeSequence: bigint,
    changedPacks: Map<string, ChangedPackInput>,
    changedEvInputs: Map<string, ChangedEvInput>,
  ): void {
    if (projection.recordKind === "pack") {
      const key = `${projection.platformKey}\u0000${projection.externalId}`;
      const existing = changedPacks.get(key);
      const changed = {
        platformKey: projection.platformKey,
        packExternalId: projection.externalId,
        causeSequences: [
          ...(existing?.causeSequences ?? []),
          publicChangeSequence,
        ],
      };
      changedPacks.set(key, changed);
      return;
    }
    if (projection.recordKind !== "ev_input") return;
    const contentPackExternalId = projection.content.packExternalId;
    const relatedPackExternalId = projection.relationships?.find(
      (relationship) =>
        relationship.relationshipKind === "supports_pack" &&
        relationship.targetRecordKind === "pack" &&
        relationship.targetPlatformKey === projection.platformKey,
    )?.targetExternalId;
    const packExternalId =
      typeof contentPackExternalId === "string" && contentPackExternalId.trim().length > 0
        ? contentPackExternalId
        : relatedPackExternalId;
    if (!packExternalId) return;
    const changed = {
      platformKey: projection.platformKey,
      packExternalId,
      evInputExternalId: projection.externalId,
      causeSequences: [publicChangeSequence],
    };
    const key =
      `${changed.platformKey}\u0000${changed.packExternalId}\u0000${changed.evInputExternalId}`;
    const existing = changedEvInputs.get(key);
    changedEvInputs.set(key, {
      ...changed,
      causeSequences: [
        ...(existing?.causeSequences ?? []),
        publicChangeSequence,
      ],
    });
  }

  private async enqueueEstimatedEvRecomputations(
    database: PackscoutTransactionClient,
    input: {
      organizationId: string;
      providerId: string;
      configurationRevisionId: string;
      changedPacks: readonly ChangedPackInput[];
      changedEvInputs: readonly ChangedEvInput[];
      createdAt: Date;
    },
  ): Promise<void> {
    const targets = new Map<string, ChangedEvInput>();
    const addTarget = (target: ChangedEvInput) => {
      const key =
        `${target.platformKey}\u0000${target.packExternalId}\u0000${target.evInputExternalId}`;
      const existing = targets.get(key);
      targets.set(key, {
        ...target,
        causeSequences: [
          ...new Set([
            ...(existing?.causeSequences ?? []),
            ...target.causeSequences,
          ]),
        ],
      });
    };
    input.changedEvInputs.forEach(addTarget);
    const relatedByPack = new Map<string, string[]>();
    for (const batch of batches(input.changedPacks)) {
      const rows = batch.map((pack) => Prisma.sql`(
        ${pack.platformKey}, ${pack.platformKey}, ${pack.packExternalId}
      )`);
      const relatedInputs = await database.$queryRaw<Array<{
        platformKey: string;
        packExternalId: string | null;
        evInputExternalId: string;
      }>>(Prisma.sql`
        with ranked_related_inputs as (
          select
            relationship.target_platform_key as "platformKey",
            relationship.target_external_id as "packExternalId",
            entity.external_id as "evInputExternalId",
            row_number() over (
              partition by relationship.target_platform_key, relationship.target_external_id
              order by entity.external_id
            ) as relationship_rank
          from public.canonical_entities as entity
          join public.canonical_relationships as relationship
            on relationship.source_entity_id = entity.id
           and relationship.organization_id = entity.organization_id
          where entity.organization_id = ${uuid(input.organizationId)}
            and entity.record_kind = 'ev_input'
            and entity.current_revision_id is not null
            and relationship.relationship_kind = 'supports_pack'
            and relationship.target_record_kind = 'pack'
            and (
              entity.platform_key,
              relationship.target_platform_key,
              relationship.target_external_id
            ) in (values ${Prisma.join(rows)})
        )
        select "platformKey", "packExternalId", "evInputExternalId"
        from ranked_related_inputs
        where relationship_rank <= 100
      `);
      for (const related of relatedInputs) {
        if (!related.packExternalId) continue;
        const key = `${related.platformKey}\u0000${related.packExternalId}`;
        const evInputs = relatedByPack.get(key) ?? [];
        evInputs.push(related.evInputExternalId);
        relatedByPack.set(key, evInputs);
      }
    }

    for (const pack of input.changedPacks) {
      const relatedInputs =
        relatedByPack.get(`${pack.platformKey}\u0000${pack.packExternalId}`) ?? [];
      if (relatedInputs.length === 0) {
        addTarget({ ...pack, evInputExternalId: pack.packExternalId });
      } else {
        relatedInputs.forEach((evInputExternalId) => addTarget({ ...pack, evInputExternalId }));
      }
    }

    const targetValues = [...targets.values()];
    const revisionByIdentity = new Map<string, string | null>();
    const revisionIdentities = targetValues.flatMap((target) => [
      { platformKey: target.platformKey, recordKind: "pack" as const, externalId: target.packExternalId },
      { platformKey: target.platformKey, recordKind: "ev_input" as const, externalId: target.evInputExternalId },
    ]);
    for (const batch of batches(revisionIdentities)) {
      const rows = batch.map((identity) => Prisma.sql`(
        ${identity.platformKey},
        cast(${identity.recordKind} as public.canonical_record_kind),
        ${identity.externalId}
      )`);
      const revisions = await database.$queryRaw<Array<{
        platformKey: string;
        recordKind: string;
        externalId: string;
        revisionId: string | null;
      }>>(Prisma.sql`
        select
          platform_key as "platformKey",
          record_kind::text as "recordKind",
          external_id as "externalId",
          current_revision_id as "revisionId"
        from public.canonical_entities
        where organization_id = ${uuid(input.organizationId)}
          and (platform_key, record_kind, external_id) in (
            values ${Prisma.join(rows)}
          )
      `);
      for (const revision of revisions) {
        revisionByIdentity.set(
          `${revision.platformKey}\u0000${revision.recordKind}\u0000${revision.externalId}`,
          revision.revisionId,
        );
      }
    }

    const requests = targetValues.map((target) => {
      const identity = {
        organizationId: input.organizationId,
        platformKey: target.platformKey,
        packExternalId: target.packExternalId,
        evInputExternalId: target.evInputExternalId,
        packRevisionId:
          revisionByIdentity.get(`${target.platformKey}\u0000pack\u0000${target.packExternalId}`) ?? null,
        evInputRevisionId:
          revisionByIdentity.get(
            `${target.platformKey}\u0000ev_input\u0000${target.evInputExternalId}`,
          ) ?? null,
      };
      return {
        requestKey: estimatedEvRecomputationRequestKey(identity),
        ...identity,
        providerId: input.providerId,
        configurationRevisionId: input.configurationRevisionId,
        originatingPublicChangeSequence: [...target.causeSequences].sort(
          (left, right) => (left < right ? -1 : left > right ? 1 : 0),
        )[0]!,
        causeSequences: target.causeSequences,
        availableAt: input.createdAt,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      };
    });
    for (const batch of batches(requests)) {
      const rows = batch.map((request) => Prisma.sql`(
        ${request.requestKey}, ${uuid(request.organizationId)},
        ${uuid(request.providerId)}, ${uuid(request.configurationRevisionId)},
        ${request.platformKey}, ${request.packExternalId}, ${request.evInputExternalId},
        ${request.packRevisionId ? uuid(request.packRevisionId) : Prisma.sql`null::uuid`},
        ${request.evInputRevisionId ? uuid(request.evInputRevisionId) : Prisma.sql`null::uuid`},
        ${request.originatingPublicChangeSequence},
        ${request.availableAt}, ${request.createdAt}, ${request.updatedAt}
      )`);
      await database.$executeRaw(Prisma.sql`
        insert into public.estimated_ev_recomputation_requests (
          request_key, organization_id, provider_id, configuration_revision_id,
          platform_key, pack_external_id, ev_input_external_id,
          pack_revision_id, ev_input_revision_id,
          originating_public_change_sequence, available_at, created_at, updated_at
        )
        values ${Prisma.join(rows)}
        on conflict do nothing
      `);
    }
    for (const requestBatch of batches(requests)) {
      await createPublicDerivationObligationBatch(database, {
        organizationId: input.organizationId,
        obligations: requestBatch.map((request) => ({
          causeSequences: request.causeSequences,
          derivationKind: "estimated_ev" as const,
          derivationKey: request.requestKey,
          createdAt: request.createdAt,
        })),
      });
    }
  }

  private async loadRunContext(
    database: PackscoutQueryClient,
    input: Pick<
      CommitPageInput,
      | "organizationId"
      | "providerId"
      | "configRevisionId"
      | "runId"
      | "committedAt"
      | "checkpointMode"
      | "workerId"
    >,
  ): Promise<{
    counters: RunCounters;
    platformKey: string;
    committedArchiveUncompressedBytes: number;
    archiveMaximumElapsedMs: number;
  }> {
    const contexts = await database.$queryRaw<Array<{
      counters: Prisma.JsonValue;
      platformKey: string;
      state: string;
      leaseOwner: string | null;
      leaseExpiresAt: Date | null;
      trigger: string;
    }>>(Prisma.sql`
      select
        run.counters_json as counters,
        provider.platform_key as "platformKey",
        run.state::text as state,
        run.lease_owner as "leaseOwner",
        run.lease_expires_at as "leaseExpiresAt",
        run.trigger::text as trigger
      from public.import_runs as run
      join public.provider_sources as provider
        on provider.id = run.provider_id
       and provider.organization_id = run.organization_id
      join public.provider_config_revisions as revision
        on revision.id = run.config_revision_id
       and revision.provider_id = run.provider_id
       and revision.organization_id = run.organization_id
      where run.id = ${uuid(input.runId)}
        and run.organization_id = ${uuid(input.organizationId)}
        and run.provider_id = ${uuid(input.providerId)}
        and run.config_revision_id = ${uuid(input.configRevisionId)}
      for update of run
      limit 1
    `);
    const context = contexts[0];
    if (!context) {
      throw new PersistenceError(
        "TENANT_SCOPE_VIOLATION",
        "Import run is outside the organization, provider, or configuration scope.",
      );
    }
    if (
      input.workerId !== undefined &&
      (context.state !== "running" ||
        context.leaseOwner !== input.workerId ||
        !context.leaseExpiresAt ||
        context.leaseExpiresAt < input.committedAt)
    ) {
      throw new PersistenceError(
        "RUN_OWNERSHIP_LOST",
        "The import run is not owned by this worker.",
      );
    }
    if (
      (input.checkpointMode === "archive") !== (context.trigger === "archive")
    ) {
      throw new PersistenceError(
        "TENANT_SCOPE_VIOLATION",
        "Import page checkpoint mode does not match the run trigger.",
      );
    }
    const archiveResources =
      context.trigger === "archive" ? archiveResourceCounters(context.counters) : null;
    return {
      counters: (context.counters ?? emptyCounters()) as RunCounters,
      platformKey: context.platformKey,
      committedArchiveUncompressedBytes: archiveResources?.uncompressedBytes ?? 0,
      archiveMaximumElapsedMs:
        archiveResources?.maximumElapsedMs ?? maximumArchiveOperationElapsedMs,
    };
  }

  private async findSourceRecordId(
    database: PackscoutQueryClient,
    identity: {
      organizationId: string;
      providerId: string;
      recordKind: SourceRecordKind;
      externalId: string;
      sourceFactsHash: string;
    },
  ): Promise<string> {
    const records = await database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      select id
      from public.source_records
      where organization_id = ${uuid(identity.organizationId)}
        and provider_id = ${uuid(identity.providerId)}
        and record_kind = cast(${identity.recordKind} as public.source_record_kind)
        and external_id = ${identity.externalId}
        and source_facts_hash = ${identity.sourceFactsHash}
      limit 1
    `);
    const record = records[0];
    if (!record) throw new Error("Source record conflict could not be resolved.");
    return record.id;
  }
}

export class RetentionRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async expireRawEvidence(input: {
    organizationId: string;
    before: Date;
    expiredAt: Date;
    batchSize: number;
  }): Promise<{ pages: number; sourceRecords: number; quarantines: number }> {
    if (!Number.isInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 10_000) {
      throw new RangeError("Retention batch size must be between 1 and 10000.");
    }
    return this.database.$transaction(async (transaction) => {
      const pageIds = await transaction.import_pages.findMany({
        where: {
          organization_id: input.organizationId,
          expires_at: { lte: input.before },
          payload_json: { not: Prisma.DbNull },
        },
        orderBy: { expires_at: "asc" },
        take: input.batchSize,
        select: { id: true },
      });
      const sourceIds = await transaction.source_records.findMany({
        where: {
          organization_id: input.organizationId,
          expires_at: { lte: input.before },
          payload_json: { not: Prisma.DbNull },
        },
        orderBy: { expires_at: "asc" },
        take: input.batchSize,
        select: { id: true },
      });
      const quarantineIds = await transaction.quarantine_records.findMany({
        where: {
          organization_id: input.organizationId,
          expires_at: { lte: input.before },
          payload_json: { not: Prisma.DbNull },
        },
        orderBy: { expires_at: "asc" },
        take: input.batchSize,
        select: { id: true },
      });
      if (pageIds.length > 0) {
        await transaction.import_pages.updateMany({
          where: { id: { in: pageIds.map(({ id }) => id) } },
          data: { payload_json: Prisma.DbNull, payload_expired_at: input.expiredAt },
        });
      }
      if (sourceIds.length > 0) {
        await transaction.source_records.updateMany({
          where: { id: { in: sourceIds.map(({ id }) => id) } },
          data: { payload_json: Prisma.DbNull, payload_expired_at: input.expiredAt },
        });
      }
      if (quarantineIds.length > 0) {
        await transaction.quarantine_records.updateMany({
          where: { id: { in: quarantineIds.map(({ id }) => id) } },
          data: {
            payload_json: Prisma.DbNull,
            payload_expired_at: input.expiredAt,
            state: "expired",
          },
        });
      }
      return {
        pages: pageIds.length,
        sourceRecords: sourceIds.length,
        quarantines: quarantineIds.length,
      };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }
}
