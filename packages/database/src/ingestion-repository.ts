import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  max,
} from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import type { PackscoutDatabase } from "./database.ts";
import { estimatedEvRecomputationRequestKey } from "./estimated-ev-recomputation-repository.ts";
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
      let quarantined = 0;
      let newCanonicalRevisions = 0;
      const changedPacks = new Map<string, ChangedPackInput>();
      const changedEvInputs = new Map<string, ChangedEvInput>();
      for (const [sourcePosition, sourceInput] of input.records.entries()) {
        const recordIndex = sourceInput.recordIndex ?? sourcePosition;
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
        if (!sourceInput.quarantine) {
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
            if (result.created) {
              newCanonicalRevisions += 1;
              this.recordEstimatedEvTrigger(
                projection,
                changedPacks,
                changedEvInputs,
              );
            }
          }
        }
        const outcome = sourceInput.quarantine
          ? "quarantined"
          : sourceCreatedRevision || newSource
            ? "accepted"
            : "duplicate";
        if (outcome === "accepted") accepted += 1;
        else if (outcome === "duplicate") duplicate += 1;
        else quarantined += 1;
        await transaction.insert(sourceRecordOutcomes).values({
          organizationId: input.organizationId,
          runId: input.runId,
          pageId: insertedPage.id,
          sourceRecordId,
          recordKind: sourceInput.recordKind,
          recordIndex,
          externalId: sourceInput.externalId,
          outcome,
          reasonCode: sourceInput.quarantine?.reasonCode,
          createdAt: input.committedAt,
        });
        if (sourceInput.quarantine) {
          await transaction.insert(quarantineRecords).values({
            organizationId: input.organizationId,
            providerId: input.providerId,
            runId: input.runId,
            pageId: insertedPage.id,
            sourceRecordId,
            recordKind: sourceInput.recordKind,
            recordIndex,
            externalId: sourceInput.externalId,
            reasonCode: sourceInput.quarantine.reasonCode,
            fieldPath: sourceInput.quarantine.fieldPath,
            sanitizedSummary: sourceInput.quarantine.sanitizedSummary,
            payloadJson: null,
            expiresAt,
            createdAt: input.committedAt,
          });
        }
      }

      for (const quarantine of input.quarantines ?? []) {
        await transaction.insert(quarantineRecords).values({
          organizationId: input.organizationId,
          providerId: input.providerId,
          runId: input.runId,
          pageId: insertedPage.id,
          recordKind: quarantine.recordKind,
          recordIndex: quarantine.recordIndex,
          externalId: quarantine.externalId,
          reasonCode: quarantine.reasonCode,
          fieldPath: quarantine.fieldPath,
          sanitizedSummary: quarantine.sanitizedSummary,
          payloadJson: quarantine.payload,
          expiresAt,
          createdAt: input.committedAt,
        });
        await transaction.insert(sourceRecordOutcomes).values({
          organizationId: input.organizationId,
          runId: input.runId,
          pageId: insertedPage.id,
          sourceRecordId: null,
          recordKind: quarantine.recordKind,
          recordIndex: quarantine.recordIndex,
          externalId: quarantine.externalId,
          outcome: "quarantined",
          reasonCode: quarantine.reasonCode,
          createdAt: input.committedAt,
        });
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
        accepted: context.counters.accepted + accepted,
        duplicate: context.counters.duplicate + duplicate,
        quarantined:
          context.counters.quarantined +
          quarantined +
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
        newCanonicalRevisions,
        duplicateSourceRecords: duplicate,
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
      let canonicalRevisionCount = 0;
      for (const [projectionIndex, projection] of input.projections.entries()) {
        const result = await this.upsertCanonicalRevision(transaction, {
          organizationId: input.organizationId,
          providerId: input.providerId,
          configRevisionId: input.configurationRevisionId,
          sourceRecordId: input.sourceRecordId,
          projection,
          projectionIndex,
          acceptedAt: input.acceptedAt,
        });
        if (result.created) canonicalRevisionCount += 1;
      }
      return { canonicalRevisionCount };
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
      let canonicalRevisionCount = 0;
      for (const [projectionIndex, projection] of input.projections.entries()) {
        const result = await this.upsertCanonicalRevision(transaction, {
          organizationId: input.organizationId,
          providerId: input.providerId,
          configRevisionId: input.configurationRevisionId,
          sourceRecordId: input.sourceRecordId,
          projection,
          projectionIndex,
          acceptedAt: input.acceptedAt,
        });
        if (result.created) canonicalRevisionCount += 1;
      }
      return { canonicalRevisionCount };
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

      let canonicalRevisionCount = 0;
      for (const [projectionIndex, projection] of input.projections.entries()) {
        const result = await this.upsertCanonicalRevision(transaction, {
          organizationId: input.organizationId,
          providerId: input.providerId,
          configRevisionId: input.configurationRevisionId,
          sourceRecordId,
          projection,
          projectionIndex,
          acceptedAt: input.acceptedAt,
        });
        if (result.created) canonicalRevisionCount += 1;
      }
      return { sourceRecordId, canonicalRevisionCount };
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
    for (const pack of input.changedPacks) {
      const relatedInputs = await database
        .select({ evInputExternalId: canonicalEntities.externalId })
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
            eq(canonicalEntities.platformKey, pack.platformKey),
            eq(canonicalEntities.recordKind, "ev_input"),
            isNotNull(canonicalEntities.currentRevisionId),
            eq(canonicalRelationships.relationshipKind, "supports_pack"),
            eq(canonicalRelationships.targetPlatformKey, pack.platformKey),
            eq(canonicalRelationships.targetRecordKind, "pack"),
            eq(
              canonicalRelationships.targetExternalId,
              pack.packExternalId,
            ),
          ),
        )
        .orderBy(asc(canonicalEntities.externalId))
        .limit(100);
      if (relatedInputs.length === 0) {
        addTarget({
          ...pack,
          // A pack-only request deliberately produces durable unavailable evidence.
          evInputExternalId: pack.packExternalId,
        });
      } else {
        relatedInputs.forEach(({ evInputExternalId }) =>
          addTarget({ ...pack, evInputExternalId }),
        );
      }
    }

    for (const target of targets.values()) {
      const [pack, evInput] = await Promise.all([
        database
          .select({ revisionId: canonicalEntities.currentRevisionId })
          .from(canonicalEntities)
          .where(
            and(
              eq(canonicalEntities.organizationId, input.organizationId),
              eq(canonicalEntities.platformKey, target.platformKey),
              eq(canonicalEntities.recordKind, "pack"),
              eq(canonicalEntities.externalId, target.packExternalId),
            ),
          )
          .limit(1),
        database
          .select({ revisionId: canonicalEntities.currentRevisionId })
          .from(canonicalEntities)
          .where(
            and(
              eq(canonicalEntities.organizationId, input.organizationId),
              eq(canonicalEntities.platformKey, target.platformKey),
              eq(canonicalEntities.recordKind, "ev_input"),
              eq(canonicalEntities.externalId, target.evInputExternalId),
            ),
          )
          .limit(1),
      ]);
      const identity = {
        organizationId: input.organizationId,
        platformKey: target.platformKey,
        packExternalId: target.packExternalId,
        evInputExternalId: target.evInputExternalId,
        packRevisionId: pack[0]?.revisionId ?? null,
        evInputRevisionId: evInput[0]?.revisionId ?? null,
      };
      await database
        .insert(estimatedEvRecomputationRequests)
        .values({
          requestKey: estimatedEvRecomputationRequestKey(identity),
          ...identity,
          providerId: input.providerId,
          configurationRevisionId: input.configurationRevisionId,
          availableAt: input.createdAt,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        })
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
    await database
      .update(canonicalRelationships)
      .set({ targetEntityId: entity.id, resolvedAt: input.acceptedAt })
      .where(
        and(
          eq(canonicalRelationships.organizationId, input.organizationId),
          eq(
            canonicalRelationships.targetPlatformKey,
            input.projection.platformKey,
          ),
          eq(
            canonicalRelationships.targetRecordKind,
            input.projection.recordKind,
          ),
          eq(
            canonicalRelationships.targetExternalId,
            input.projection.externalId,
          ),
          isNull(canonicalRelationships.targetEntityId),
        ),
      );
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
