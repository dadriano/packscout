import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import type { PackscoutDatabase } from "./database.ts";
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
} from "./pipeline-types.ts";
import { PersistenceError } from "./persistence-error.ts";
import { quarantineAttempts } from "./schema/quarantine-retry.ts";
import {
  canonicalEntities,
  canonicalRelationships,
  canonicalRevisions,
  estimatedEvRecomputationRequests,
  importPages,
  importRuns,
  providerConfigRevisions,
  providerCursorCheckpoints,
  providerSources,
  quarantineRecords,
  sourceRecordObservations,
  sourceRecordOutcomes,
  sourceRecords,
  type RunCounters,
} from "./schema/index.ts";
import { hashJson } from "./security.ts";

const millisecondsPerDay = 24 * 60 * 60 * 1_000;

interface ChangedPackInput {
  readonly platformKey: string;
  readonly packExternalId: string;
}

interface ChangedEvInput extends ChangedPackInput {
  readonly evInputExternalId: string;
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

export class IngestionPersistenceRepository<TQueryResult extends PgQueryResultHKT> {
  constructor(
    private readonly database: PackscoutDatabase<TQueryResult>,
    private readonly policy: RawEvidencePolicy,
  ) {
    if (policy.retentionDays !== 90) {
      throw new Error("Raw evidence retention must be exactly 90 days.");
    }
  }

  async commitPage(input: CommitPageInput): Promise<CommitPageResult> {
    return this.database.transaction(async (transaction) => {
      const context = await this.loadRunContext(transaction, input);
      const payloadHash = hashJson(input.payload);
      const expiresAt = addRetentionPeriod(input.committedAt, this.policy.retentionDays);
      const recordKindCount = (recordKind: "catalog" | "pull" | "sale") =>
        input.records.filter((record) => record.recordKind === recordKind).length +
        (input.quarantines ?? []).filter(
          (quarantine) => quarantine.recordKind === recordKind,
        ).length;
      const recordCountsJson = {
        catalog: recordKindCount("catalog"),
        pulls: recordKindCount("pull"),
        sales: recordKindCount("sale"),
      };
      const [insertedPage] = await transaction
        .insert(importPages)
        .values({
          organizationId: input.organizationId,
          providerId: input.providerId,
          runId: input.runId,
          pageNumber: input.pageNumber,
          requestedCursor: input.requestedCursor,
          nextCursor: input.nextCursor,
          hasMore: input.hasMore,
          payloadJson: input.payload,
          payloadHash,
          recordCountsJson,
          committedAt: input.committedAt,
          expiresAt,
        })
        .onConflictDoNothing()
        .returning({ id: importPages.id });
      if (!insertedPage) {
        const [existingPage] = await transaction
          .select({ id: importPages.id, payloadHash: importPages.payloadHash })
          .from(importPages)
          .where(
            and(
              eq(importPages.organizationId, input.organizationId),
              eq(importPages.runId, input.runId),
              eq(importPages.pageNumber, input.pageNumber),
            ),
          )
          .limit(1);
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

      const changedPacks = new Map<string, ChangedPackInput>();
      const changedEvInputs = new Map<string, ChangedEvInput>();
      const persisted = await persistPageRecordsInBatches(
        transaction,
        this.policy,
        input,
        insertedPage.id,
        expiresAt,
      );
      for (const projection of persisted.createdCanonicalProjections) {
        this.recordEstimatedEvTrigger(projection, changedPacks, changedEvInputs);
      }

      await this.enqueueEstimatedEvRecomputations(transaction, {
        organizationId: input.organizationId,
        providerId: input.providerId,
        configurationRevisionId: input.configRevisionId,
        changedPacks: [...changedPacks.values()],
        changedEvInputs: [...changedEvInputs.values()],
        createdAt: input.committedAt,
      });

      const counters: RunCounters = {
        accepted: context.counters.accepted + persisted.accepted,
        duplicate: context.counters.duplicate + persisted.duplicate,
        quarantined:
          context.counters.quarantined +
          persisted.quarantined +
          (input.quarantines?.length ?? 0),
        pages: context.counters.pages + 1,
        records:
          context.counters.records + input.records.length + (input.quarantines?.length ?? 0),
        requestAttempts: context.counters.requestAttempts ?? 0,
        transientRetries: context.counters.transientRetries ?? 0,
      };
      await transaction
        .update(importRuns)
        .set({ finalCursor: input.nextCursor, countersJson: counters })
        .where(
          and(
            eq(importRuns.id, input.runId),
            eq(importRuns.organizationId, input.organizationId),
          ),
        );
      await transaction
        .insert(providerCursorCheckpoints)
        .values({
          configRevisionId: input.configRevisionId,
          organizationId: input.organizationId,
          providerId: input.providerId,
          cursor: input.nextCursor,
          advancedByRunId: input.runId,
          updatedAt: input.committedAt,
        })
        .onConflictDoUpdate({
          target: providerCursorCheckpoints.configRevisionId,
          set: {
            cursor: input.nextCursor,
            advancedByRunId: input.runId,
            updatedAt: input.committedAt,
          },
        });
      return {
        kind: "committed",
        pageId: insertedPage.id,
        counters,
        newCanonicalRevisions: persisted.newCanonicalRevisions,
        duplicateSourceRecords: persisted.duplicate,
      };
    });
  }

  async projectSourceRecord(
    input: ProjectSourceRecordInput,
  ): Promise<{ canonicalRevisionCount: number }> {
    return this.database.transaction(async (transaction) => {
      const [source] = await transaction
        .select({ id: sourceRecords.id })
        .from(sourceRecords)
        .innerJoin(
          quarantineRecords,
          and(
            eq(quarantineRecords.id, input.quarantineId),
            eq(quarantineRecords.organizationId, sourceRecords.organizationId),
            eq(quarantineRecords.providerId, sourceRecords.providerId),
            eq(quarantineRecords.sourceRecordId, sourceRecords.id),
          ),
        )
        .innerJoin(
          quarantineAttempts,
          and(
            eq(quarantineAttempts.id, input.attemptId),
            eq(quarantineAttempts.organizationId, sourceRecords.organizationId),
            eq(quarantineAttempts.quarantineId, quarantineRecords.id),
            eq(quarantineAttempts.state, "running"),
          ),
        )
        .innerJoin(
          providerConfigRevisions,
          and(
            eq(providerConfigRevisions.id, input.configurationRevisionId),
            eq(providerConfigRevisions.organizationId, sourceRecords.organizationId),
            eq(providerConfigRevisions.providerId, sourceRecords.providerId),
          ),
        )
        .where(
          and(
            eq(sourceRecords.id, input.sourceRecordId),
            eq(sourceRecords.organizationId, input.organizationId),
            eq(sourceRecords.providerId, input.providerId),
            eq(quarantineRecords.state, "open"),
            gt(quarantineRecords.expiresAt, input.acceptedAt),
          ),
        )
        .for("update", { of: sourceRecords })
        .limit(1);
      if (!source) {
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
        })),
      );
      return {
        canonicalRevisionCount: results.filter(({ created }) => created).length,
      };
    });
  }

  async projectDerivedSourceRecord(
    input: ProjectDerivedSourceRecordInput,
  ): Promise<{ canonicalRevisionCount: number }> {
    return this.database.transaction(async (transaction) => {
      const [source] = await transaction
        .select({ id: sourceRecords.id })
        .from(sourceRecords)
        .innerJoin(
          providerConfigRevisions,
          and(
            eq(providerConfigRevisions.id, input.configurationRevisionId),
            eq(providerConfigRevisions.organizationId, sourceRecords.organizationId),
            eq(providerConfigRevisions.providerId, sourceRecords.providerId),
          ),
        )
        .where(
          and(
            eq(sourceRecords.id, input.sourceRecordId),
            eq(sourceRecords.organizationId, input.organizationId),
            eq(sourceRecords.providerId, input.providerId),
          ),
        )
        .for("update", { of: sourceRecords })
        .limit(1);
      if (!source) {
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
        })),
      );
      return {
        canonicalRevisionCount: results.filter(({ created }) => created).length,
      };
    });
  }

  async materializeAndProjectSourceRecord(
    input: MaterializeAndProjectSourceRecordInput,
  ): Promise<{ sourceRecordId: string; canonicalRevisionCount: number }> {
    return this.database.transaction(async (transaction) => {
      const [quarantine] = await transaction
        .select({ sourceRecordId: quarantineRecords.sourceRecordId })
        .from(quarantineRecords)
        .innerJoin(
          importRuns,
          and(
            eq(importRuns.id, quarantineRecords.runId),
            eq(importRuns.organizationId, quarantineRecords.organizationId),
            eq(importRuns.providerId, quarantineRecords.providerId),
            eq(importRuns.configRevisionId, input.configurationRevisionId),
          ),
        )
        .innerJoin(
          quarantineAttempts,
          and(
            eq(quarantineAttempts.id, input.attemptId),
            eq(
              quarantineAttempts.organizationId,
              quarantineRecords.organizationId,
            ),
            eq(quarantineAttempts.quarantineId, quarantineRecords.id),
            eq(quarantineAttempts.state, "running"),
          ),
        )
        .where(
          and(
            eq(quarantineRecords.id, input.quarantineId),
            eq(quarantineRecords.organizationId, input.organizationId),
            eq(quarantineRecords.providerId, input.providerId),
            eq(quarantineRecords.runId, input.runId),
            eq(quarantineRecords.pageId, input.pageId),
            eq(quarantineRecords.recordKind, input.recordKind),
            eq(quarantineRecords.state, "open"),
            gt(quarantineRecords.expiresAt, input.acceptedAt),
          ),
        )
        .for("update", { of: quarantineRecords })
        .limit(1);
      if (!quarantine) {
        throw new PersistenceError(
          "TENANT_SCOPE_VIOLATION",
          "Quarantine record is outside the organization, provider, or configuration scope.",
        );
      }

      let sourceRecordId = quarantine.sourceRecordId;
      if (!sourceRecordId) {
        const contentHash = hashJson(input.payload);
        const [created] = await transaction
          .insert(sourceRecords)
          .values({
            organizationId: input.organizationId,
            providerId: input.providerId,
            firstRunId: input.runId,
            firstPageId: input.pageId,
            recordKind: input.recordKind,
            externalId: input.externalId,
            sourceTime: input.sourceTime,
            collectedAt: input.collectedAt,
            payloadJson: input.payload,
            contentHash,
            expiresAt: input.expiresAt,
            createdAt: input.acceptedAt,
          })
          .onConflictDoNothing()
          .returning({ id: sourceRecords.id });
        sourceRecordId =
          created?.id ??
          (await this.findSourceRecordId(transaction, {
            organizationId: input.organizationId,
            providerId: input.providerId,
            recordKind: input.recordKind,
            externalId: input.externalId,
            sourceTime: input.sourceTime,
            contentHash,
          }));
        await transaction
          .insert(sourceRecordObservations)
          .values({
            sourceRecordId,
            organizationId: input.organizationId,
            runId: input.runId,
            pageId: input.pageId,
            observedAt: input.acceptedAt,
          })
          .onConflictDoNothing();
        await transaction
          .update(sourceRecordOutcomes)
          .set({ sourceRecordId, externalId: input.externalId })
          .where(
            and(
              eq(sourceRecordOutcomes.organizationId, input.organizationId),
              eq(sourceRecordOutcomes.runId, input.runId),
              eq(sourceRecordOutcomes.pageId, input.pageId),
              eq(sourceRecordOutcomes.recordKind, input.recordKind),
              eq(sourceRecordOutcomes.recordIndex, input.recordIndex),
            ),
          );
        await transaction
          .update(quarantineRecords)
          .set({ sourceRecordId, externalId: input.externalId })
          .where(
            and(
              eq(quarantineRecords.id, input.quarantineId),
              eq(quarantineRecords.organizationId, input.organizationId),
              isNull(quarantineRecords.sourceRecordId),
            ),
          );
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
        })),
      );
      return {
        sourceRecordId,
        canonicalRevisionCount: results.filter(({ created }) => created).length,
      };
    });
  }

  async getCurrentProjection(
    organizationId: string,
    identity: CanonicalIdentity,
  ): Promise<CurrentProjection | null> {
    const [record] = await this.database
      .select({
        entityId: canonicalEntities.id,
        revisionId: canonicalRevisions.id,
        revisionNumber: canonicalRevisions.revisionNumber,
        content: canonicalRevisions.contentJson,
        provenance: canonicalRevisions.provenanceJson,
        actorKey: canonicalRevisions.actorKey,
        sourceUpdatedAt: canonicalRevisions.sourceUpdatedAt,
        sourceCollectedAt: canonicalRevisions.sourceCollectedAt,
        acceptedAt: canonicalRevisions.acceptedAt,
      })
      .from(canonicalEntities)
      .innerJoin(
        canonicalRevisions,
        eq(canonicalRevisions.id, canonicalEntities.currentRevisionId),
      )
      .where(
        and(
          eq(canonicalEntities.organizationId, organizationId),
          eq(canonicalEntities.platformKey, identity.platformKey),
          eq(canonicalEntities.recordKind, identity.recordKind),
          eq(canonicalEntities.externalId, identity.externalId),
        ),
      )
      .limit(1);
    return record ? { ...record, identity } : null;
  }

  async listCanonicalRevisions(
    organizationId: string,
    identity: CanonicalIdentity,
  ): Promise<CanonicalRevisionRecord[]> {
    const records = await this.database
      .select({
        entityId: canonicalEntities.id,
        revisionId: canonicalRevisions.id,
        revisionNumber: canonicalRevisions.revisionNumber,
        content: canonicalRevisions.contentJson,
        provenance: canonicalRevisions.provenanceJson,
        actorKey: canonicalRevisions.actorKey,
        sourceRecordId: canonicalRevisions.sourceRecordId,
        sourceUpdatedAt: canonicalRevisions.sourceUpdatedAt,
        sourceCollectedAt: canonicalRevisions.sourceCollectedAt,
        acceptedAt: canonicalRevisions.acceptedAt,
      })
      .from(canonicalEntities)
      .innerJoin(canonicalRevisions, eq(canonicalRevisions.entityId, canonicalEntities.id))
      .where(
        and(
          eq(canonicalEntities.organizationId, organizationId),
          eq(canonicalEntities.platformKey, identity.platformKey),
          eq(canonicalEntities.recordKind, identity.recordKind),
          eq(canonicalEntities.externalId, identity.externalId),
        ),
      )
      .orderBy(asc(canonicalRevisions.revisionNumber));
    return records.map((record) => ({ ...record, identity }));
  }

  async reconcileRelationships(input: {
    organizationId: string;
    target: CanonicalIdentity;
    resolvedAt: Date;
  }): Promise<number> {
    const [targetEntity] = await this.database
      .select({ id: canonicalEntities.id })
      .from(canonicalEntities)
      .where(
        and(
          eq(canonicalEntities.organizationId, input.organizationId),
          eq(canonicalEntities.platformKey, input.target.platformKey),
          eq(canonicalEntities.recordKind, input.target.recordKind),
          eq(canonicalEntities.externalId, input.target.externalId),
        ),
      )
      .limit(1);
    if (!targetEntity) return 0;
    const reconciled = await this.database
      .update(canonicalRelationships)
      .set({ targetEntityId: targetEntity.id, resolvedAt: input.resolvedAt })
      .where(
        and(
          eq(canonicalRelationships.organizationId, input.organizationId),
          eq(canonicalRelationships.targetPlatformKey, input.target.platformKey),
          eq(canonicalRelationships.targetRecordKind, input.target.recordKind),
          eq(canonicalRelationships.targetExternalId, input.target.externalId),
          isNull(canonicalRelationships.targetEntityId),
        ),
      )
      .returning({ id: canonicalRelationships.id });
    return reconciled.length;
  }

  private recordEstimatedEvTrigger(
    projection: CanonicalProjectionInput,
    changedPacks: Map<string, ChangedPackInput>,
    changedEvInputs: Map<string, ChangedEvInput>,
  ): void {
    if (projection.recordKind === "pack") {
      const changed = {
        platformKey: projection.platformKey,
        packExternalId: projection.externalId,
      };
      changedPacks.set(
        `${changed.platformKey}\u0000${changed.packExternalId}`,
        changed,
      );
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
      typeof contentPackExternalId === "string" &&
      contentPackExternalId.trim().length > 0
        ? contentPackExternalId
        : relatedPackExternalId;
    if (!packExternalId) return;
    const changed = {
      platformKey: projection.platformKey,
      packExternalId,
      evInputExternalId: projection.externalId,
    };
    changedEvInputs.set(
      `${changed.platformKey}\u0000${changed.packExternalId}\u0000${changed.evInputExternalId}`,
      changed,
    );
  }

  private async enqueueEstimatedEvRecomputations(
    database: PackscoutDatabase<TQueryResult>,
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
      targets.set(
        `${target.platformKey}\u0000${target.packExternalId}\u0000${target.evInputExternalId}`,
        target,
      );
    };
    input.changedEvInputs.forEach(addTarget);
    const relatedByPack = new Map<string, string[]>();
    for (let offset = 0; offset < input.changedPacks.length; offset += 500) {
      const batch = input.changedPacks.slice(offset, offset + 500);
      if (batch.length === 0) continue;
      const rankedRelatedInputs = database
        .select({
          platformKey: canonicalRelationships.targetPlatformKey,
          packExternalId: canonicalRelationships.targetExternalId,
          evInputExternalId: canonicalEntities.externalId,
          relationshipRank: sql<number>`row_number() over (
            partition by ${canonicalRelationships.targetPlatformKey}, ${canonicalRelationships.targetExternalId}
            order by ${canonicalEntities.externalId}
          )`.as("relationship_rank"),
        })
        .from(canonicalEntities)
        .innerJoin(
          canonicalRelationships,
          and(
            eq(canonicalRelationships.sourceEntityId, canonicalEntities.id),
            eq(
              canonicalRelationships.organizationId,
              canonicalEntities.organizationId,
            ),
          ),
        )
        .where(
          and(
            eq(canonicalEntities.organizationId, input.organizationId),
            eq(canonicalEntities.recordKind, "ev_input"),
            isNotNull(canonicalEntities.currentRevisionId),
            eq(canonicalRelationships.relationshipKind, "supports_pack"),
            eq(canonicalRelationships.targetRecordKind, "pack"),
            or(
              ...batch.map((pack) =>
                and(
                  eq(canonicalEntities.platformKey, pack.platformKey),
                  eq(
                    canonicalRelationships.targetPlatformKey,
                    pack.platformKey,
                  ),
                  eq(
                    canonicalRelationships.targetExternalId,
                    pack.packExternalId,
                  ),
                ),
              ),
            ),
          ),
        )
        .as("ranked_related_inputs");
      const relatedInputs = await database
        .select({
          platformKey: rankedRelatedInputs.platformKey,
          packExternalId: rankedRelatedInputs.packExternalId,
          evInputExternalId: rankedRelatedInputs.evInputExternalId,
        })
        .from(rankedRelatedInputs)
        .where(lte(rankedRelatedInputs.relationshipRank, 100));
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
        // A pack-only request deliberately produces durable unavailable evidence.
        addTarget({ ...pack, evInputExternalId: pack.packExternalId });
      } else {
        relatedInputs.forEach((evInputExternalId) =>
          addTarget({ ...pack, evInputExternalId }),
        );
      }
    }

    const targetValues = [...targets.values()];
    const revisionByIdentity = new Map<string, string | null>();
    const revisionIdentities = targetValues.flatMap((target) => [
      {
        platformKey: target.platformKey,
        recordKind: "pack" as const,
        externalId: target.packExternalId,
      },
      {
        platformKey: target.platformKey,
        recordKind: "ev_input" as const,
        externalId: target.evInputExternalId,
      },
    ]);
    for (let offset = 0; offset < revisionIdentities.length; offset += 500) {
      const batch = revisionIdentities.slice(offset, offset + 500);
      if (batch.length === 0) continue;
      const revisions = await database
        .select({
          platformKey: canonicalEntities.platformKey,
          recordKind: canonicalEntities.recordKind,
          externalId: canonicalEntities.externalId,
          revisionId: canonicalEntities.currentRevisionId,
        })
        .from(canonicalEntities)
        .where(
          and(
            eq(canonicalEntities.organizationId, input.organizationId),
            or(
              ...batch.map((identity) =>
                and(
                  eq(canonicalEntities.platformKey, identity.platformKey),
                  eq(canonicalEntities.recordKind, identity.recordKind),
                  eq(canonicalEntities.externalId, identity.externalId),
                ),
              ),
            ),
          ),
        );
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
          revisionByIdentity.get(
            `${target.platformKey}\u0000pack\u0000${target.packExternalId}`,
          ) ?? null,
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
        availableAt: input.createdAt,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      };
    });
    for (let offset = 0; offset < requests.length; offset += 500) {
      const batch = requests.slice(offset, offset + 500);
      await database
        .insert(estimatedEvRecomputationRequests)
        .values(batch)
        .onConflictDoNothing();
    }
  }

  private async loadRunContext(
    database: PackscoutDatabase<TQueryResult>,
    input: Pick<
      CommitPageInput,
      | "organizationId"
      | "providerId"
      | "configRevisionId"
      | "runId"
      | "committedAt"
      | "workerId"
    >,
  ): Promise<{ counters: RunCounters; platformKey: string }> {
    const [context] = await database
      .select({
        counters: importRuns.countersJson,
        platformKey: providerSources.platformKey,
        state: importRuns.state,
        leaseOwner: importRuns.leaseOwner,
        leaseExpiresAt: importRuns.leaseExpiresAt,
      })
      .from(importRuns)
      .innerJoin(
        providerSources,
        and(
          eq(providerSources.id, importRuns.providerId),
          eq(providerSources.organizationId, importRuns.organizationId),
        ),
      )
      .innerJoin(
        providerConfigRevisions,
        and(
          eq(providerConfigRevisions.id, importRuns.configRevisionId),
          eq(providerConfigRevisions.providerId, importRuns.providerId),
          eq(providerConfigRevisions.organizationId, importRuns.organizationId),
        ),
      )
      .where(
        and(
          eq(importRuns.id, input.runId),
          eq(importRuns.organizationId, input.organizationId),
          eq(importRuns.providerId, input.providerId),
          eq(importRuns.configRevisionId, input.configRevisionId),
        ),
      )
      .for("update", { of: importRuns })
      .limit(1);
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
    return { counters: context.counters ?? emptyCounters(), platformKey: context.platformKey };
  }

  private async findSourceRecordId(
    database: PackscoutDatabase<TQueryResult>,
    identity: {
      organizationId: string;
      providerId: string;
      recordKind: "catalog" | "pull" | "sale";
      externalId: string;
      sourceTime: Date;
      contentHash: string;
    },
  ): Promise<string> {
    const [record] = await database
      .select({ id: sourceRecords.id })
      .from(sourceRecords)
      .where(
        and(
          eq(sourceRecords.organizationId, identity.organizationId),
          eq(sourceRecords.providerId, identity.providerId),
          eq(sourceRecords.recordKind, identity.recordKind),
          eq(sourceRecords.externalId, identity.externalId),
          eq(sourceRecords.sourceTime, identity.sourceTime),
          eq(sourceRecords.contentHash, identity.contentHash),
        ),
      )
      .limit(1);
    if (!record) throw new Error("Source record conflict could not be resolved.");
    return record.id;
  }

}

export class RetentionRepository<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly database: PackscoutDatabase<TQueryResult>) {}

  async expireRawEvidence(input: {
    organizationId: string;
    before: Date;
    expiredAt: Date;
    batchSize: number;
  }): Promise<{ pages: number; sourceRecords: number; quarantines: number }> {
    if (!Number.isInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 10_000) {
      throw new RangeError("Retention batch size must be between 1 and 10000.");
    }
    return this.database.transaction(async (transaction) => {
      const pageIds = await transaction
        .select({ id: importPages.id })
        .from(importPages)
        .where(
          and(
            eq(importPages.organizationId, input.organizationId),
            lte(importPages.expiresAt, input.before),
            isNotNull(importPages.payloadJson),
          ),
        )
        .orderBy(asc(importPages.expiresAt))
        .limit(input.batchSize);
      const sourceIds = await transaction
        .select({ id: sourceRecords.id })
        .from(sourceRecords)
        .where(
          and(
            eq(sourceRecords.organizationId, input.organizationId),
            lte(sourceRecords.expiresAt, input.before),
            isNotNull(sourceRecords.payloadJson),
          ),
        )
        .orderBy(asc(sourceRecords.expiresAt))
        .limit(input.batchSize);
      const quarantineIds = await transaction
        .select({ id: quarantineRecords.id })
        .from(quarantineRecords)
        .where(
          and(
            eq(quarantineRecords.organizationId, input.organizationId),
            lte(quarantineRecords.expiresAt, input.before),
            isNotNull(quarantineRecords.payloadJson),
          ),
        )
        .orderBy(asc(quarantineRecords.expiresAt))
        .limit(input.batchSize);
      if (pageIds.length > 0) {
        await transaction
          .update(importPages)
          .set({ payloadJson: null, payloadExpiredAt: input.expiredAt })
          .where(inArray(importPages.id, pageIds.map(({ id }) => id)));
      }
      if (sourceIds.length > 0) {
        await transaction
          .update(sourceRecords)
          .set({ payloadJson: null, payloadExpiredAt: input.expiredAt })
          .where(inArray(sourceRecords.id, sourceIds.map(({ id }) => id)));
      }
      if (quarantineIds.length > 0) {
        await transaction
          .update(quarantineRecords)
          .set({ payloadJson: null, payloadExpiredAt: input.expiredAt, state: "expired" })
          .where(inArray(quarantineRecords.id, quarantineIds.map(({ id }) => id)));
      }
      return {
        pages: pageIds.length,
        sourceRecords: sourceIds.length,
        quarantines: quarantineIds.length,
      };
    });
  }
}
