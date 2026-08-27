import { REPACK_HEAT_MAXIMUM_CATALOG_SEQUENCE } from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutQueryClient,
  type PackscoutTransactionClient,
} from "./database.ts";
import {
  normalizedHeatRelationshipBackfillIsReady,
  requireCanonicalDate,
  requireUuid,
  uuid,
} from "./normalized-heat-observation-repository.ts";
import { persistNormalizedHeatObservations } from
  "./normalized-heat-persistence.ts";
import { NormalizedHeatExpandedWriteBoundError } from
  "./normalized-heat-write-bound.ts";

export const NORMALIZED_HEAT_RELATIONSHIP_BACKFILL_MAXIMUM_SOURCES = 500;
export const NORMALIZED_HEAT_RELATIONSHIP_BACKFILL_MAXIMUM_ORDERING_ROWS = 1_000;

export type NormalizedHeatRelationshipBackfillPhase =
  | "awaiting_confirmations"
  | "relationships"
  | "catalog_order"
  | "complete"
  | "failed";

export interface NormalizedHeatRelationshipBackfillProgress {
  readonly phase: NormalizedHeatRelationshipBackfillPhase;
  readonly targetPublicChangeSequence: bigint;
  readonly processedThroughPublicChangeSequence: bigint;
  readonly targetRelationshipSourceCount: bigint;
  readonly relationshipSourceCount: bigint;
  readonly targetCatalogObservationCount: bigint | null;
  readonly catalogObservationCount: bigint;
  readonly failureCode: string | null;
}

interface BackfillCheckpointRow extends NormalizedHeatRelationshipBackfillProgress {
  nextCatalogOrderSequence: bigint;
  processedThroughConfirmationPublicChangeSequence: bigint;
  processedThroughConfirmationSetId: string | null;
  processedThroughRelationshipId: string | null;
}

interface BackfillRelationshipRow {
  confirmationSetId: string;
  confirmationPublicChangeSequence: bigint;
  relationshipId: string;
  canonicalRevisionId: string;
  publicChangeSequence: bigint;
}

interface ConfirmationBackfillCoverageRow {
  phase: "pending" | "running" | "complete" | "failed";
  targetSemanticSetCount: bigint;
  confirmedSemanticSetCount: bigint;
  failureCode: string | null;
}

interface ConfirmationBackfillCoverageSummaryRow {
  missingCount: bigint;
}

interface HeatRelationshipFreezeRow {
  targetPublicChangeSequence: bigint;
  sourceCount: bigint;
}

interface BackfillCatalogRow {
  observationId: string;
}

type BackfillAdvanceResult =
  | Readonly<{ status: "busy" }>
  | Readonly<{
      status: "advanced" | "complete" | "failed";
      progress: NormalizedHeatRelationshipBackfillProgress;
    }>;

type ConfirmationCoverageStatus = "ready" | "busy" | "failed";

function requireBackfillBatchSize(
  value: number,
  maximum: number,
  field: string,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${field} is invalid.`);
  }
  return value;
}

function backfillProgress(row: BackfillCheckpointRow):
NormalizedHeatRelationshipBackfillProgress {
  return {
    phase: row.phase,
    targetPublicChangeSequence: row.targetPublicChangeSequence,
    processedThroughPublicChangeSequence:
      row.processedThroughPublicChangeSequence,
    targetRelationshipSourceCount: row.targetRelationshipSourceCount,
    relationshipSourceCount: row.relationshipSourceCount,
    targetCatalogObservationCount: row.targetCatalogObservationCount,
    catalogObservationCount: row.catalogObservationCount,
    failureCode: row.failureCode,
  };
}

async function loadBackfillCheckpoint(
  database: PackscoutQueryClient,
  organizationId: string,
  lock: boolean,
): Promise<BackfillCheckpointRow | null> {
  const rows = await database.$queryRaw<BackfillCheckpointRow[]>(Prisma.sql`
    select phase,
           target_public_change_sequence as "targetPublicChangeSequence",
           processed_through_public_change_sequence
             as "processedThroughPublicChangeSequence",
           processed_through_confirmation_public_change_sequence
             as "processedThroughConfirmationPublicChangeSequence",
           processed_through_confirmation_set_id
             as "processedThroughConfirmationSetId",
           processed_through_relationship_id
             as "processedThroughRelationshipId",
           next_catalog_order_sequence as "nextCatalogOrderSequence",
           target_relationship_source_count as "targetRelationshipSourceCount",
           relationship_source_count as "relationshipSourceCount",
           target_catalog_observation_count as "targetCatalogObservationCount",
           catalog_observation_count as "catalogObservationCount",
           failure_code as "failureCode"
    from public.normalized_heat_relationship_backfills
    where organization_id = ${uuid(organizationId)}
    ${lock ? Prisma.sql`for update` : Prisma.empty}
  `);
  return rows[0] ?? null;
}

/**
 * Resumes the migration-scoped V1 relationship repair before import and Heat
 * promotion lanes start. Every step is one bounded transaction; the durable
 * phase/cursors make process restarts and competing workers idempotent.
 */
export class PrismaNormalizedHeatRelationshipBackfillRepository {
  readonly #organizationId: string;
  readonly #clock: { now(): Date };

  constructor(
    private readonly database: PackscoutPrismaClient,
    configuration: Readonly<{
      organizationId: string;
      clock?: { now(): Date };
    }>,
  ) {
    this.#organizationId = requireUuid(
      configuration.organizationId,
      "organizationId",
    );
    this.#clock = configuration.clock ?? { now: () => new Date() };
  }

  async loadProgress(): Promise<NormalizedHeatRelationshipBackfillProgress> {
    const row = await loadBackfillCheckpoint(
      this.database,
      this.#organizationId,
      false,
    );
    if (!row) throw new Error("Normalized Heat relationship backfill is missing.");
    return backfillProgress(row);
  }

  async runToCompletion(input: Readonly<{
    relationshipBatchSize?: number;
    catalogOrderBatchSize?: number;
    signal?: AbortSignal;
  }> = {}): Promise<NormalizedHeatRelationshipBackfillProgress> {
    const relationshipBatchSize = requireBackfillBatchSize(
      input.relationshipBatchSize
        ?? NORMALIZED_HEAT_RELATIONSHIP_BACKFILL_MAXIMUM_SOURCES,
      NORMALIZED_HEAT_RELATIONSHIP_BACKFILL_MAXIMUM_SOURCES,
      "relationshipBatchSize",
    );
    const catalogOrderBatchSize = requireBackfillBatchSize(
      input.catalogOrderBatchSize
        ?? NORMALIZED_HEAT_RELATIONSHIP_BACKFILL_MAXIMUM_ORDERING_ROWS,
      NORMALIZED_HEAT_RELATIONSHIP_BACKFILL_MAXIMUM_ORDERING_ROWS,
      "catalogOrderBatchSize",
    );
    for (;;) {
      if (input.signal?.aborted) {
        throw new Error("Normalized Heat relationship backfill was stopped.");
      }
      let result: BackfillAdvanceResult;
      try {
        result = await this.#advance({
          relationshipBatchSize,
          catalogOrderBatchSize,
        });
      } catch (error) {
        if (
          error instanceof NormalizedHeatExpandedWriteBoundError
        ) {
          await this.#markFailed("RELATIONSHIP_EXPANSION_LIMIT_EXCEEDED");
        }
        throw error;
      }
      if (result.status === "busy") {
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      if (result.status === "failed") {
        throw new Error(
          `Normalized Heat relationship backfill failed: ${result.progress.failureCode}`,
        );
      }
      if (result.status === "complete") return result.progress;
    }
  }

  async #advance(input: Readonly<{
    relationshipBatchSize: number;
    catalogOrderBatchSize: number;
  }>): Promise<BackfillAdvanceResult> {
    return this.database.$transaction(async (transaction) => {
      const locks = await transaction.$queryRaw<Array<{ acquired: boolean }>>(
        Prisma.sql`
          select pg_try_advisory_xact_lock(
            hashtextextended(
              ${`normalized_heat_relationship_backfill:${this.#organizationId}`},
              0
            )
          ) as acquired
        `,
      );
      if (locks[0]?.acquired !== true) return { status: "busy" };
      const observedState = await loadBackfillCheckpoint(
        transaction,
        this.#organizationId,
        false,
      );
      if (!observedState) {
        throw new Error("Normalized Heat relationship backfill is missing.");
      }
      let confirmationCoverage: ConfirmationCoverageStatus | null = null;
      let frozenSourceHeadSequence: bigint | null = null;
      if (observedState.phase === "awaiting_confirmations") {
        confirmationCoverage = await this.#loadConfirmationCoverage(transaction);
        if (confirmationCoverage === "busy") return { status: "busy" };
        const watermarks = await transaction.$queryRaw<
          Array<{ sourceHeadSequence: bigint }>
        >(Prisma.sql`
          select source_head_sequence as "sourceHeadSequence"
          from public.settled_public_watermarks
          where organization_id = ${uuid(this.#organizationId)}
          for update
        `);
        frozenSourceHeadSequence = watermarks[0]?.sourceHeadSequence ?? null;
        if (frozenSourceHeadSequence === null) {
          throw new Error("Normalized Heat causal watermark is missing.");
        }
      }
      const state = await loadBackfillCheckpoint(
        transaction,
        this.#organizationId,
        true,
      );
      if (!state) {
        throw new Error("Normalized Heat relationship backfill is missing.");
      }
      if (
        state.phase === "awaiting_confirmations"
        && confirmationCoverage === "failed"
      ) {
        const failed = await this.#failInTransaction(
          transaction,
          "RELATIONSHIP_CONFIRMATION_BACKFILL_FAILED",
        );
        return { status: "failed", progress: failed };
      }
      if (state.phase === "failed") {
        return { status: "failed", progress: backfillProgress(state) };
      }
      if (state.phase === "complete") {
        if (!await normalizedHeatRelationshipBackfillIsReady(
          transaction,
          this.#organizationId,
        )) {
          throw new Error(
            "Normalized Heat completed backfill state is inconsistent.",
          );
        }
        return { status: "complete", progress: backfillProgress(state) };
      }
      const now = this.#clock.now();
      requireCanonicalDate(now, "backfillNow");
      await transaction.$executeRaw(Prisma.sql`
        update public.normalized_heat_relationship_backfills
        set started_at = coalesce(started_at, ${now}),
            updated_at = ${now}
        where organization_id = ${uuid(this.#organizationId)}
      `);
      if (
        state.phase === "awaiting_confirmations"
        && frozenSourceHeadSequence === null
      ) {
        throw new Error("Normalized Heat causal watermark lock is missing.");
      }
      return state.phase === "awaiting_confirmations"
        ? this.#freezeConfirmedRelationships(
          transaction,
          frozenSourceHeadSequence!,
          now,
        )
        : state.phase === "relationships"
          ? this.#advanceRelationships(
            transaction,
            state,
            input.relationshipBatchSize,
            now,
          )
          : this.#advanceCatalogOrder(
              transaction,
              state,
              input.catalogOrderBatchSize,
              now,
            );
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async #loadConfirmationCoverage(
    transaction: PackscoutTransactionClient,
  ): Promise<ConfirmationCoverageStatus> {
    const confirmationBackfills = await transaction.$queryRaw<
      ConfirmationBackfillCoverageRow[]
    >(Prisma.sql`
      select phase,
             target_semantic_set_count as "targetSemanticSetCount",
             confirmed_semantic_set_count as "confirmedSemanticSetCount",
             failure_code as "failureCode"
      from public.source_relationship_confirmation_backfills
      where organization_id = ${uuid(this.#organizationId)}
      order by source_revision_id
      for share
    `);
    const confirmationCoverage = await transaction.$queryRaw<
      ConfirmationBackfillCoverageSummaryRow[]
    >(Prisma.sql`
      select count(*) filter (
               where confirmation_backfill.source_revision_id is null
                  or confirmation_backfill.provider_id <>
                    source_revision.provider_id
                  or confirmation_backfill.source_instance_id <>
                    source_revision.source_instance_id
             )::bigint as "missingCount"
      from public.provider_source_revisions as source_revision
      left join public.source_relationship_confirmation_backfills
        as confirmation_backfill
        on confirmation_backfill.organization_id =
             source_revision.organization_id
       and confirmation_backfill.source_revision_id = source_revision.id
      where source_revision.organization_id = ${uuid(this.#organizationId)}
    `);
    if (confirmationBackfills.some(({ phase, failureCode }) =>
      phase === "failed" || failureCode !== null)) return "failed";
    return confirmationCoverage[0]?.missingCount === 0n
        && confirmationBackfills.every((row) =>
          row.phase === "complete"
          && row.confirmedSemanticSetCount === row.targetSemanticSetCount)
      ? "ready"
      : "busy";
  }

  async #freezeConfirmedRelationships(
    transaction: PackscoutTransactionClient,
    targetPublicChangeSequence: bigint,
    now: Date,
  ): Promise<BackfillAdvanceResult> {
    const frozen = await transaction.$queryRaw<HeatRelationshipFreezeRow[]>(
      Prisma.sql`
        select ${targetPublicChangeSequence}::bigint
                 as "targetPublicChangeSequence",
               (
                 select count(*)::bigint
                 from public.source_relationship_confirmations as item
                 where item.organization_id = ${uuid(this.#organizationId)}
                   and item.heat_effective_public_change_sequence is not null
                   and item.heat_effective_public_change_sequence <=
                     ${targetPublicChangeSequence}
               ) as "sourceCount"
      `,
    );
    const freeze = frozen[0];
    if (!freeze) {
      throw new Error("Normalized Heat causal watermark is missing.");
    }
    const rows = await transaction.$queryRaw<BackfillCheckpointRow[]>(Prisma.sql`
      update public.normalized_heat_relationship_backfills
      set phase = 'relationships',
          target_public_change_sequence =
            ${freeze.targetPublicChangeSequence},
          processed_through_public_change_sequence = 0,
          processed_through_confirmation_public_change_sequence = 0,
          processed_through_confirmation_set_id = null,
          processed_through_relationship_id = null,
          target_relationship_source_count = ${freeze.sourceCount},
          relationship_source_count = 0,
          updated_at = ${now}
      where organization_id = ${uuid(this.#organizationId)}
        and phase = 'awaiting_confirmations'
      returning phase,
                target_public_change_sequence as "targetPublicChangeSequence",
                processed_through_public_change_sequence
                  as "processedThroughPublicChangeSequence",
                processed_through_confirmation_public_change_sequence
                  as "processedThroughConfirmationPublicChangeSequence",
                processed_through_confirmation_set_id
                  as "processedThroughConfirmationSetId",
                processed_through_relationship_id
                  as "processedThroughRelationshipId",
                next_catalog_order_sequence as "nextCatalogOrderSequence",
                target_relationship_source_count
                  as "targetRelationshipSourceCount",
                relationship_source_count as "relationshipSourceCount",
                target_catalog_observation_count
                  as "targetCatalogObservationCount",
                catalog_observation_count as "catalogObservationCount",
                failure_code as "failureCode"
    `);
    if (!rows[0]) {
      throw new Error("Normalized Heat confirmation freeze lost its lock.");
    }
    return { status: "advanced", progress: backfillProgress(rows[0]) };
  }

  async #advanceRelationships(
    transaction: PackscoutTransactionClient,
    state: BackfillCheckpointRow,
    batchSize: number,
    now: Date,
  ): Promise<BackfillAdvanceResult> {
    if (
      state.relationshipSourceCount > state.targetRelationshipSourceCount
    ) {
      const failed = await this.#failInTransaction(
        transaction,
        "FROZEN_RELATIONSHIP_SET_CHANGED",
      );
      return { status: "failed", progress: failed };
    }
    const relationships = await transaction.$queryRaw<BackfillRelationshipRow[]>(
      Prisma.sql`
        select item.confirmation_set_id::text as "confirmationSetId",
               item.confirmation_public_change_sequence
                 as "confirmationPublicChangeSequence",
               item.canonical_relationship_id::text as "relationshipId",
               confirmation.source_canonical_revision_id::text
                 as "canonicalRevisionId",
               item.heat_effective_public_change_sequence
                 as "publicChangeSequence"
        from public.source_relationship_confirmations as item
        join public.source_relationship_confirmation_sets as confirmation
          on confirmation.id = item.confirmation_set_id
         and confirmation.organization_id = item.organization_id
        where item.organization_id = ${uuid(this.#organizationId)}
          and item.heat_effective_public_change_sequence is not null
          and item.heat_effective_public_change_sequence <=
            ${state.targetPublicChangeSequence}
          ${state.processedThroughConfirmationSetId === null
            ? Prisma.empty
            : Prisma.sql`
              and (
                item.heat_effective_public_change_sequence,
                item.confirmation_public_change_sequence,
                item.confirmation_set_id,
                item.canonical_relationship_id
              ) > (
                ${state.processedThroughPublicChangeSequence},
                ${state.processedThroughConfirmationPublicChangeSequence},
                ${uuid(state.processedThroughConfirmationSetId)},
                ${uuid(state.processedThroughRelationshipId!)}
              )
            `}
        order by item.heat_effective_public_change_sequence asc,
                 item.confirmation_public_change_sequence asc,
                 item.confirmation_set_id asc,
                 item.canonical_relationship_id asc
        limit ${batchSize}
      `,
    );
    if (relationships.length === 0) {
      if (
        state.relationshipSourceCount !== state.targetRelationshipSourceCount
      ) {
        const failed = await this.#failInTransaction(
          transaction,
          "RELATIONSHIP_CURSOR_INCOMPLETE",
        );
        return { status: "failed", progress: failed };
      }
      const catalogCounts = await transaction.$queryRaw<
        Array<{ observationCount: bigint }>
      >(Prisma.sql`
        select count(*)::bigint as "observationCount"
        from public.normalized_heat_observations
        where organization_id = ${uuid(this.#organizationId)}
          and observation_kind = 'catalog_snapshot'
      `);
      const targetCatalogCount = catalogCounts[0]?.observationCount ?? 0n;
      if (
        targetCatalogCount < state.catalogObservationCount
        || targetCatalogCount > BigInt(REPACK_HEAT_MAXIMUM_CATALOG_SEQUENCE)
      ) {
        const failed = await this.#failInTransaction(
          transaction,
          "CATALOG_ORDER_LIMIT_EXCEEDED",
        );
        return { status: "failed", progress: failed };
      }
      const rows = await transaction.$queryRaw<BackfillCheckpointRow[]>(Prisma.sql`
        update public.normalized_heat_relationship_backfills
        set phase = 'catalog_order',
            processed_through_public_change_sequence =
              target_public_change_sequence,
            processed_through_confirmation_public_change_sequence = 0,
            processed_through_confirmation_set_id = null,
            processed_through_relationship_id = null,
            target_catalog_observation_count = ${targetCatalogCount},
            next_catalog_order_sequence = 1,
            catalog_observation_count = 0,
            updated_at = ${now}
        where organization_id = ${uuid(this.#organizationId)}
        returning phase,
                  target_public_change_sequence as "targetPublicChangeSequence",
                  processed_through_public_change_sequence
                    as "processedThroughPublicChangeSequence",
                  processed_through_confirmation_public_change_sequence
                    as "processedThroughConfirmationPublicChangeSequence",
                  processed_through_confirmation_set_id
                    as "processedThroughConfirmationSetId",
                  processed_through_relationship_id
                    as "processedThroughRelationshipId",
                  next_catalog_order_sequence as "nextCatalogOrderSequence",
                  target_relationship_source_count
                    as "targetRelationshipSourceCount",
                  relationship_source_count as "relationshipSourceCount",
                  target_catalog_observation_count
                    as "targetCatalogObservationCount",
                  catalog_observation_count as "catalogObservationCount",
                  failure_code as "failureCode"
      `);
      return { status: "advanced", progress: backfillProgress(rows[0]!) };
    }
    await persistNormalizedHeatObservations(transaction, {
      organizationId: this.#organizationId,
      revisions: [],
      confirmedRelationships: relationships,
      createdAt: now,
    }, "relationship_backfill");
    const through = relationships.at(-1)!.publicChangeSequence;
    const throughConfirmationPublicChangeSequence =
      relationships.at(-1)!.confirmationPublicChangeSequence;
    const throughConfirmationSetId = relationships.at(-1)!.confirmationSetId;
    const throughRelationshipId = relationships.at(-1)!.relationshipId;
    const rows = await transaction.$queryRaw<BackfillCheckpointRow[]>(Prisma.sql`
      update public.normalized_heat_relationship_backfills
      set processed_through_public_change_sequence = ${through},
          processed_through_confirmation_public_change_sequence =
            ${throughConfirmationPublicChangeSequence},
          processed_through_confirmation_set_id =
            ${uuid(throughConfirmationSetId)},
          processed_through_relationship_id = ${uuid(throughRelationshipId)},
          relationship_source_count =
            relationship_source_count + ${relationships.length},
          updated_at = ${now}
      where organization_id = ${uuid(this.#organizationId)}
      returning phase,
                target_public_change_sequence as "targetPublicChangeSequence",
                processed_through_public_change_sequence
                  as "processedThroughPublicChangeSequence",
                processed_through_confirmation_public_change_sequence
                  as "processedThroughConfirmationPublicChangeSequence",
                processed_through_confirmation_set_id
                  as "processedThroughConfirmationSetId",
                processed_through_relationship_id
                  as "processedThroughRelationshipId",
                next_catalog_order_sequence as "nextCatalogOrderSequence",
                target_relationship_source_count
                  as "targetRelationshipSourceCount",
                relationship_source_count as "relationshipSourceCount",
                target_catalog_observation_count
                  as "targetCatalogObservationCount",
                catalog_observation_count as "catalogObservationCount",
                failure_code as "failureCode"
    `);
    return { status: "advanced", progress: backfillProgress(rows[0]!) };
  }

  async #advanceCatalogOrder(
    transaction: PackscoutTransactionClient,
    state: BackfillCheckpointRow,
    batchSize: number,
    now: Date,
  ): Promise<BackfillAdvanceResult> {
    if (
      state.targetCatalogObservationCount === null
      || state.catalogObservationCount > state.targetCatalogObservationCount
      || state.nextCatalogOrderSequence !== state.catalogObservationCount + 1n
    ) {
      const failed = await this.#failInTransaction(
        transaction,
        "FROZEN_CATALOG_SET_CHANGED",
      );
      return { status: "failed", progress: failed };
    }
    const observations = await transaction.$queryRaw<BackfillCatalogRow[]>(Prisma.sql`
      select id::text as "observationId"
      from public.normalized_heat_observations
      where organization_id = ${uuid(this.#organizationId)}
        and observation_kind = 'catalog_snapshot'
        and catalog_order_sequence is null
      order by public_change_sequence asc, observation_key collate "C" asc
      limit ${batchSize}
      for update
    `);
    if (observations.length === 0) {
      if (
        state.catalogObservationCount !== state.targetCatalogObservationCount
      ) {
        const failed = await this.#failInTransaction(
          transaction,
          "CATALOG_ORDER_CURSOR_INCOMPLETE",
        );
        return { status: "failed", progress: failed };
      }
      await transaction.$executeRaw(Prisma.sql`
        insert into public.normalized_heat_window_checkpoints (
          organization_id, next_catalog_sequence, updated_at
        ) values (
          ${uuid(this.#organizationId)}, ${state.nextCatalogOrderSequence}, ${now}
        )
        on conflict (organization_id) do update
        set next_catalog_sequence = excluded.next_catalog_sequence,
            updated_at = excluded.updated_at
      `);
      const rows = await transaction.$queryRaw<BackfillCheckpointRow[]>(Prisma.sql`
        update public.normalized_heat_relationship_backfills
        set phase = 'complete', completed_at = ${now}, updated_at = ${now}
        where organization_id = ${uuid(this.#organizationId)}
        returning phase,
                  target_public_change_sequence as "targetPublicChangeSequence",
                  processed_through_public_change_sequence
                    as "processedThroughPublicChangeSequence",
                  processed_through_confirmation_public_change_sequence
                    as "processedThroughConfirmationPublicChangeSequence",
                  processed_through_confirmation_set_id
                    as "processedThroughConfirmationSetId",
                  processed_through_relationship_id
                    as "processedThroughRelationshipId",
                  next_catalog_order_sequence as "nextCatalogOrderSequence",
                  target_relationship_source_count
                    as "targetRelationshipSourceCount",
                  relationship_source_count as "relationshipSourceCount",
                  target_catalog_observation_count
                    as "targetCatalogObservationCount",
                  catalog_observation_count as "catalogObservationCount",
                  failure_code as "failureCode"
      `);
      return { status: "complete", progress: backfillProgress(rows[0]!) };
    }
    const assignments = observations.map((observation, index) => Prisma.sql`(
      ${uuid(observation.observationId)},
      ${state.nextCatalogOrderSequence + BigInt(index)}
    )`);
    const updated = await transaction.$queryRaw<Array<{ observationId: string }>>(
      Prisma.sql`
        update public.normalized_heat_observations as observation
        set catalog_order_sequence = assignment.catalog_order_sequence
        from (values ${Prisma.join(assignments)})
          as assignment(observation_id, catalog_order_sequence)
        where observation.id = assignment.observation_id
          and observation.organization_id = ${uuid(this.#organizationId)}
          and observation.catalog_order_sequence is null
        returning observation.id::text as "observationId"
      `,
    );
    if (updated.length !== observations.length) {
      throw new Error("Normalized Heat catalog order update lost its lock.");
    }
    const rows = await transaction.$queryRaw<BackfillCheckpointRow[]>(Prisma.sql`
      update public.normalized_heat_relationship_backfills
      set next_catalog_order_sequence =
            next_catalog_order_sequence + ${observations.length},
          catalog_observation_count =
            catalog_observation_count + ${observations.length},
          updated_at = ${now}
      where organization_id = ${uuid(this.#organizationId)}
      returning phase,
                target_public_change_sequence as "targetPublicChangeSequence",
                processed_through_public_change_sequence
                  as "processedThroughPublicChangeSequence",
                processed_through_confirmation_public_change_sequence
                  as "processedThroughConfirmationPublicChangeSequence",
                processed_through_confirmation_set_id
                  as "processedThroughConfirmationSetId",
                processed_through_relationship_id
                  as "processedThroughRelationshipId",
                next_catalog_order_sequence as "nextCatalogOrderSequence",
                target_relationship_source_count
                  as "targetRelationshipSourceCount",
                relationship_source_count as "relationshipSourceCount",
                target_catalog_observation_count
                  as "targetCatalogObservationCount",
                catalog_observation_count as "catalogObservationCount",
                failure_code as "failureCode"
    `);
    return { status: "advanced", progress: backfillProgress(rows[0]!) };
  }

  async #failInTransaction(
    transaction: PackscoutTransactionClient,
    failureCode: string,
  ): Promise<NormalizedHeatRelationshipBackfillProgress> {
    const now = this.#clock.now();
    requireCanonicalDate(now, "backfillFailureAt");
    const rows = await transaction.$queryRaw<BackfillCheckpointRow[]>(Prisma.sql`
      update public.normalized_heat_relationship_backfills
      set phase = 'failed', failure_code = ${failureCode}, updated_at = ${now}
      where organization_id = ${uuid(this.#organizationId)}
      returning phase,
                target_public_change_sequence as "targetPublicChangeSequence",
                processed_through_public_change_sequence
                  as "processedThroughPublicChangeSequence",
                processed_through_confirmation_public_change_sequence
                  as "processedThroughConfirmationPublicChangeSequence",
                processed_through_confirmation_set_id
                  as "processedThroughConfirmationSetId",
                processed_through_relationship_id
                  as "processedThroughRelationshipId",
                next_catalog_order_sequence as "nextCatalogOrderSequence",
                target_relationship_source_count
                  as "targetRelationshipSourceCount",
                relationship_source_count as "relationshipSourceCount",
                target_catalog_observation_count
                  as "targetCatalogObservationCount",
                catalog_observation_count as "catalogObservationCount",
                failure_code as "failureCode"
    `);
    return backfillProgress(rows[0]!);
  }

  async #markFailed(failureCode: string): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const state = await loadBackfillCheckpoint(
        transaction,
        this.#organizationId,
        true,
      );
      if (!state || state.phase !== "relationships") return;
      await this.#failInTransaction(transaction, failureCode);
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }
}
