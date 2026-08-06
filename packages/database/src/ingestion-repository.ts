import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  max,
} from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import type { PackscoutDatabase } from "./database.ts";
import type {
  CanonicalIdentity,
  CanonicalProjectionInput,
  CanonicalRevisionRecord,
  CommitPageInput,
  CommitPageResult,
  CurrentProjection,
  RawEvidencePolicy,
} from "./pipeline-types.ts";
import { PersistenceError } from "./persistence-error.ts";
import {
  canonicalEntities,
  canonicalRelationships,
  canonicalRevisions,
  importPages,
  importRuns,
  providerConfigRevisions,
  providerCursorCheckpoints,
  providerSources,
  quarantineRecords,
  sourceRecordObservations,
  sourceRecordOutcomes,
  sourceRecordProjectionRevisions,
  sourceRecords,
  type RunCounters,
} from "./schema/index.ts";
import {
  assertCanonicalActorDataSafe,
  hashJson,
  pseudonymizeProviderActor,
} from "./security.ts";

const millisecondsPerDay = 24 * 60 * 60 * 1_000;

interface CanonicalUpsertResult {
  revisionId: string;
  created: boolean;
}

function addRetentionPeriod(at: Date, retentionDays: number): Date {
  return new Date(at.getTime() + retentionDays * millisecondsPerDay);
}

function emptyCounters(): RunCounters {
  return { accepted: 0, duplicate: 0, quarantined: 0, pages: 0, records: 0 };
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
      const recordCountsJson = {
        catalog: input.records.filter((record) => record.recordKind === "catalog").length,
        pulls: input.records.filter((record) => record.recordKind === "pull").length,
        sales: input.records.filter((record) => record.recordKind === "sale").length,
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

      let accepted = 0;
      let duplicate = 0;
      let newCanonicalRevisions = 0;
      for (const sourceInput of input.records) {
        const sourceHash = hashJson(sourceInput.payload);
        const [newSource] = await transaction
          .insert(sourceRecords)
          .values({
            organizationId: input.organizationId,
            providerId: input.providerId,
            firstRunId: input.runId,
            firstPageId: insertedPage.id,
            recordKind: sourceInput.recordKind,
            externalId: sourceInput.externalId,
            sourceTime: sourceInput.sourceTime,
            collectedAt: sourceInput.collectedAt,
            payloadJson: sourceInput.payload,
            contentHash: sourceHash,
            expiresAt,
            createdAt: input.committedAt,
          })
          .onConflictDoNothing()
          .returning({ id: sourceRecords.id });
        const sourceRecordId =
          newSource?.id ??
          (await this.findSourceRecordId(transaction, {
            organizationId: input.organizationId,
            providerId: input.providerId,
            recordKind: sourceInput.recordKind,
            externalId: sourceInput.externalId,
            sourceTime: sourceInput.sourceTime,
            contentHash: sourceHash,
          }));
        await transaction
          .insert(sourceRecordObservations)
          .values({
            sourceRecordId,
            organizationId: input.organizationId,
            runId: input.runId,
            pageId: insertedPage.id,
            observedAt: input.committedAt,
          })
          .onConflictDoNothing();

        let sourceCreatedRevision = false;
        for (const [projectionIndex, projection] of sourceInput.projections.entries()) {
          const result = await this.upsertCanonicalRevision(transaction, {
            organizationId: input.organizationId,
            providerId: input.providerId,
            configRevisionId: input.configRevisionId,
            sourceRecordId,
            projection,
            projectionIndex,
            acceptedAt: input.committedAt,
          });
          sourceCreatedRevision ||= result.created;
          if (result.created) newCanonicalRevisions += 1;
        }
        const outcome = sourceCreatedRevision || newSource ? "accepted" : "duplicate";
        if (outcome === "accepted") accepted += 1;
        else duplicate += 1;
        await transaction.insert(sourceRecordOutcomes).values({
          organizationId: input.organizationId,
          runId: input.runId,
          pageId: insertedPage.id,
          sourceRecordId,
          recordKind: sourceInput.recordKind,
          externalId: sourceInput.externalId,
          outcome,
          createdAt: input.committedAt,
        });
      }

      for (const quarantine of input.quarantines ?? []) {
        await transaction.insert(quarantineRecords).values({
          organizationId: input.organizationId,
          providerId: input.providerId,
          recordKind: quarantine.recordKind,
          externalId: quarantine.externalId,
          reasonCode: quarantine.reasonCode,
          fieldPath: quarantine.fieldPath,
          sanitizedSummary: quarantine.sanitizedSummary,
          payloadJson: quarantine.payload,
          expiresAt,
          createdAt: input.committedAt,
        });
      }

      const counters: RunCounters = {
        accepted: context.counters.accepted + accepted,
        duplicate: context.counters.duplicate + duplicate,
        quarantined: context.counters.quarantined + (input.quarantines?.length ?? 0),
        pages: context.counters.pages + 1,
        records:
          context.counters.records + input.records.length + (input.quarantines?.length ?? 0),
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
        newCanonicalRevisions,
        duplicateSourceRecords: duplicate,
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

  private async loadRunContext(
    database: PackscoutDatabase<TQueryResult>,
    input: Pick<CommitPageInput, "organizationId" | "providerId" | "configRevisionId" | "runId">,
  ): Promise<{ counters: RunCounters; platformKey: string }> {
    const [context] = await database
      .select({ counters: importRuns.countersJson, platformKey: providerSources.platformKey })
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

  private async upsertCanonicalRevision(
    database: PackscoutDatabase<TQueryResult>,
    input: {
      organizationId: string;
      providerId: string;
      configRevisionId: string;
      sourceRecordId: string;
      projection: CanonicalProjectionInput;
      projectionIndex: number;
      acceptedAt: Date;
    },
  ): Promise<CanonicalUpsertResult> {
    assertCanonicalActorDataSafe(input.projection.content);
    await database
      .insert(canonicalEntities)
      .values({
        organizationId: input.organizationId,
        platformKey: input.projection.platformKey,
        recordKind: input.projection.recordKind,
        externalId: input.projection.externalId,
        createdAt: input.acceptedAt,
        updatedAt: input.acceptedAt,
      })
      .onConflictDoNothing();
    const [entity] = await database
      .select({ id: canonicalEntities.id })
      .from(canonicalEntities)
      .where(
        and(
          eq(canonicalEntities.organizationId, input.organizationId),
          eq(canonicalEntities.platformKey, input.projection.platformKey),
          eq(canonicalEntities.recordKind, input.projection.recordKind),
          eq(canonicalEntities.externalId, input.projection.externalId),
        ),
      )
      .for("update")
      .limit(1);
    if (!entity) throw new Error("Canonical entity insert returned no identity.");

    const contentHash = hashJson(input.projection.content);
    const provenance = {
      ...(input.projection.provenance ?? {}),
      configRevisionId: input.configRevisionId,
      providerId: input.providerId,
      sourceRecordId: input.sourceRecordId,
    };
    const provenanceHash = hashJson(provenance);
    const [existing] = await database
      .select({ id: canonicalRevisions.id })
      .from(canonicalRevisions)
      .where(
        and(
          eq(canonicalRevisions.entityId, entity.id),
          eq(canonicalRevisions.contentHash, contentHash),
          eq(canonicalRevisions.provenanceHash, provenanceHash),
        ),
      )
      .limit(1);
    let result: CanonicalUpsertResult;
    if (existing) {
      result = { revisionId: existing.id, created: false };
    } else {
      const [latest] = await database
        .select({ revisionNumber: max(canonicalRevisions.revisionNumber) })
        .from(canonicalRevisions)
        .where(eq(canonicalRevisions.entityId, entity.id));
      const actorKey = input.projection.sourceActorIdentifier
        ? pseudonymizeProviderActor({
            key: this.policy.actorPseudonymKey,
            platformKey: input.projection.platformKey,
            sourceIdentifier: input.projection.sourceActorIdentifier,
          })
        : null;
      const [created] = await database
        .insert(canonicalRevisions)
        .values({
          organizationId: input.organizationId,
          entityId: entity.id,
          revisionNumber: (latest?.revisionNumber ?? 0) + 1,
          sourceRecordId: input.sourceRecordId,
          contentJson: input.projection.content,
          contentHash,
          provenanceJson: provenance,
          provenanceHash,
          actorKey,
          sourceUpdatedAt: input.projection.sourceUpdatedAt,
          sourceCollectedAt: input.projection.sourceCollectedAt,
          acceptedAt: input.acceptedAt,
        })
        .returning({ id: canonicalRevisions.id });
      if (!created) throw new Error("Canonical revision insert returned no identity.");
      await database
        .update(canonicalEntities)
        .set({ currentRevisionId: created.id, updatedAt: input.acceptedAt })
        .where(
          and(
            eq(canonicalEntities.id, entity.id),
            eq(canonicalEntities.organizationId, input.organizationId),
          ),
        );
      result = { revisionId: created.id, created: true };
    }
    await database
      .insert(sourceRecordProjectionRevisions)
      .values({
        sourceRecordId: input.sourceRecordId,
        canonicalRevisionId: result.revisionId,
        organizationId: input.organizationId,
        projectionIndex: input.projectionIndex,
        createdAt: input.acceptedAt,
      })
      .onConflictDoNothing();
    await this.upsertRelationships(database, {
      organizationId: input.organizationId,
      sourceEntityId: entity.id,
      projection: input.projection,
      createdAt: input.acceptedAt,
    });
    return result;
  }

  private async upsertRelationships(
    database: PackscoutDatabase<TQueryResult>,
    input: {
      organizationId: string;
      sourceEntityId: string;
      projection: CanonicalProjectionInput;
      createdAt: Date;
    },
  ): Promise<void> {
    for (const relationship of input.projection.relationships ?? []) {
      const [target] = relationship.targetExternalId
        ? await database
            .select({ id: canonicalEntities.id })
            .from(canonicalEntities)
            .where(
              and(
                eq(canonicalEntities.organizationId, input.organizationId),
                eq(canonicalEntities.platformKey, relationship.targetPlatformKey),
                eq(canonicalEntities.recordKind, relationship.targetRecordKind),
                eq(canonicalEntities.externalId, relationship.targetExternalId),
              ),
            )
            .limit(1)
        : [];
      await database
        .insert(canonicalRelationships)
        .values({
          organizationId: input.organizationId,
          sourceEntityId: input.sourceEntityId,
          relationshipKind: relationship.relationshipKind,
          targetPlatformKey: relationship.targetPlatformKey,
          targetRecordKind: relationship.targetRecordKind,
          targetExternalId: relationship.targetExternalId,
          targetEntityId: target?.id ?? null,
          createdAt: input.createdAt,
          resolvedAt: target ? input.createdAt : null,
        })
        .onConflictDoNothing();
    }
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
