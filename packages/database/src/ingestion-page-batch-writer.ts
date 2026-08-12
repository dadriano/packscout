import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import type { PackscoutDatabase } from "./database.ts";
import type {
  CanonicalProjectionInput,
  CommitPageInput,
  RawEvidencePolicy,
} from "./pipeline-types.ts";
import {
  canonicalEntities,
  canonicalRelationships,
  canonicalRevisions,
  quarantineRecords,
  sourceRecordObservations,
  sourceRecordOutcomes,
  sourceRecordProjectionRevisions,
  sourceRecords,
} from "./schema/index.ts";
import {
  assertCanonicalActorDataSafe,
  hashJson,
  pseudonymizeProviderActor,
} from "./security.ts";

const maximumRowsPerWrite = 500;

interface CanonicalProjectionWriteInput {
  readonly organizationId: string;
  readonly providerId: string;
  readonly configRevisionId: string;
  readonly sourceRecordId: string;
  readonly projection: CanonicalProjectionInput;
  readonly projectionIndex: number;
  readonly acceptedAt: Date;
}

export interface CanonicalProjectionWriteResult {
  readonly revisionId: string;
  readonly created: boolean;
}

interface PreparedSourceRecord {
  readonly sourcePosition: number;
  readonly recordIndex: number;
  readonly input: CommitPageInput["records"][number];
  readonly contentHash: string;
  readonly identityKey: string;
}

interface ResolvedSourceRecord extends PreparedSourceRecord {
  readonly sourceRecordId: string;
  readonly created: boolean;
}

interface CanonicalEntityIdentity {
  readonly platformKey: string;
  readonly recordKind: CanonicalProjectionInput["recordKind"];
  readonly externalId: string;
}

interface CanonicalEntityRecord extends CanonicalEntityIdentity {
  readonly id: string;
}

interface PreparedCanonicalProjection extends CanonicalProjectionWriteInput {
  readonly entityId: string;
  readonly contentHash: string;
  readonly provenance: Record<string, unknown>;
  readonly provenanceHash: string;
}

export interface PageRecordBatchResult {
  readonly accepted: number;
  readonly duplicate: number;
  readonly quarantined: number;
  readonly newCanonicalRevisions: number;
  readonly createdCanonicalProjections: readonly CanonicalProjectionInput[];
}

function batches<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += maximumRowsPerWrite) {
    result.push(values.slice(index, index + maximumRowsPerWrite));
  }
  return result;
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceIdentityKey(input: {
  recordKind: CommitPageInput["records"][number]["recordKind"];
  externalId: string;
  sourceTime: Date;
  contentHash: string;
}): string {
  return [
    input.recordKind,
    input.externalId,
    input.sourceTime.toISOString(),
    input.contentHash,
  ].join("\u0000");
}

function canonicalIdentityKey(identity: CanonicalEntityIdentity): string {
  return [identity.platformKey, identity.recordKind, identity.externalId].join(
    "\u0000",
  );
}

function canonicalRevisionKey(input: {
  entityId: string;
  contentHash: string;
  provenanceHash: string;
}): string {
  return [input.entityId, input.contentHash, input.provenanceHash].join("\u0000");
}

async function resolveSourceRecords<TQueryResult extends PgQueryResultHKT>(
  database: PackscoutDatabase<TQueryResult>,
  input: CommitPageInput,
  prepared: readonly PreparedSourceRecord[],
  pageId: string,
  expiresAt: Date,
): Promise<ResolvedSourceRecord[]> {
  if (prepared.length === 0) return [];
  const uniqueByIdentity = new Map<string, PreparedSourceRecord>();
  for (const record of prepared) {
    if (!uniqueByIdentity.has(record.identityKey)) {
      uniqueByIdentity.set(record.identityKey, record);
    }
  }
  const uniqueRecords = [...uniqueByIdentity.values()].sort((left, right) =>
    compareKeys(left.identityKey, right.identityKey),
  );
  const createdIdentityKeys = new Set<string>();
  for (const batch of batches(uniqueRecords)) {
    const inserted = await database
      .insert(sourceRecords)
      .values(
        batch.map((record) => ({
          organizationId: input.organizationId,
          providerId: input.providerId,
          firstRunId: input.runId,
          firstPageId: pageId,
          recordKind: record.input.recordKind,
          externalId: record.input.externalId,
          sourceTime: record.input.sourceTime,
          collectedAt: record.input.collectedAt,
          payloadJson: record.input.payload,
          contentHash: record.contentHash,
          expiresAt,
          createdAt: input.committedAt,
        })),
      )
      .onConflictDoNothing()
      .returning({
        recordKind: sourceRecords.recordKind,
        externalId: sourceRecords.externalId,
        sourceTime: sourceRecords.sourceTime,
        contentHash: sourceRecords.contentHash,
      });
    for (const record of inserted) {
      createdIdentityKeys.add(sourceIdentityKey(record));
    }
  }

  const resolvedByIdentity = new Map<string, string>();
  for (const batch of batches(uniqueRecords)) {
    const resolved = await database
      .select({
        id: sourceRecords.id,
        recordKind: sourceRecords.recordKind,
        externalId: sourceRecords.externalId,
        sourceTime: sourceRecords.sourceTime,
        contentHash: sourceRecords.contentHash,
      })
      .from(sourceRecords)
      .where(
        and(
          eq(sourceRecords.organizationId, input.organizationId),
          eq(sourceRecords.providerId, input.providerId),
          or(
            ...batch.map((record) =>
              and(
                eq(sourceRecords.recordKind, record.input.recordKind),
                eq(sourceRecords.externalId, record.input.externalId),
                eq(sourceRecords.sourceTime, record.input.sourceTime),
                eq(sourceRecords.contentHash, record.contentHash),
              ),
            ),
          ),
        ),
      );
    for (const record of resolved) {
      resolvedByIdentity.set(sourceIdentityKey(record), record.id);
    }
  }

  const unclaimedCreatedIdentities = new Set(createdIdentityKeys);
  return prepared.map((record) => {
    const sourceRecordId = resolvedByIdentity.get(record.identityKey);
    if (!sourceRecordId) {
      throw new Error("Source record conflict could not be resolved.");
    }
    const created = unclaimedCreatedIdentities.delete(record.identityKey);
    return { ...record, sourceRecordId, created };
  });
}

async function loadCanonicalEntities<TQueryResult extends PgQueryResultHKT>(
  database: PackscoutDatabase<TQueryResult>,
  organizationId: string,
  identities: readonly CanonicalEntityIdentity[],
  acceptedAt: Date,
): Promise<Map<string, CanonicalEntityRecord>> {
  const uniqueByIdentity = new Map<string, CanonicalEntityIdentity>();
  for (const identity of identities) {
    uniqueByIdentity.set(canonicalIdentityKey(identity), identity);
  }
  const uniqueIdentities = [...uniqueByIdentity.values()].sort((left, right) =>
    compareKeys(canonicalIdentityKey(left), canonicalIdentityKey(right)),
  );
  if (uniqueIdentities.length === 0) return new Map();

  for (const batch of batches(uniqueIdentities)) {
    await database
      .insert(canonicalEntities)
      .values(
        batch.map((identity) => ({
          organizationId,
          ...identity,
          createdAt: acceptedAt,
          updatedAt: acceptedAt,
        })),
      )
      .onConflictDoNothing();
  }

  const entitiesByIdentity = new Map<string, CanonicalEntityRecord>();
  for (const batch of batches(uniqueIdentities)) {
    const entities = await database
      .select({
        id: canonicalEntities.id,
        platformKey: canonicalEntities.platformKey,
        recordKind: canonicalEntities.recordKind,
        externalId: canonicalEntities.externalId,
      })
      .from(canonicalEntities)
      .where(
        and(
          eq(canonicalEntities.organizationId, organizationId),
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
      )
      .orderBy(
        asc(canonicalEntities.platformKey),
        asc(canonicalEntities.recordKind),
        asc(canonicalEntities.externalId),
      )
      .for("update");
    for (const entity of entities) {
      entitiesByIdentity.set(canonicalIdentityKey(entity), entity);
    }
  }
  if (entitiesByIdentity.size !== uniqueIdentities.length) {
    throw new Error("Canonical entity insert returned no identity.");
  }
  return entitiesByIdentity;
}

async function loadRelationshipTargets<TQueryResult extends PgQueryResultHKT>(
  database: PackscoutDatabase<TQueryResult>,
  organizationId: string,
  identities: readonly CanonicalEntityIdentity[],
  knownEntities: ReadonlyMap<string, CanonicalEntityRecord>,
): Promise<Map<string, CanonicalEntityRecord>> {
  const targets = new Map(knownEntities);
  const missingByIdentity = new Map<string, CanonicalEntityIdentity>();
  for (const identity of identities) {
    const key = canonicalIdentityKey(identity);
    if (!targets.has(key)) missingByIdentity.set(key, identity);
  }
  for (const batch of batches([...missingByIdentity.values()])) {
    const records = await database
      .select({
        id: canonicalEntities.id,
        platformKey: canonicalEntities.platformKey,
        recordKind: canonicalEntities.recordKind,
        externalId: canonicalEntities.externalId,
      })
      .from(canonicalEntities)
      .where(
        and(
          eq(canonicalEntities.organizationId, organizationId),
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
    for (const record of records) {
      targets.set(canonicalIdentityKey(record), record);
    }
  }
  return targets;
}

export async function writeCanonicalProjectionBatch<
  TQueryResult extends PgQueryResultHKT,
>(
  database: PackscoutDatabase<TQueryResult>,
  policy: RawEvidencePolicy,
  inputs: readonly CanonicalProjectionWriteInput[],
): Promise<CanonicalProjectionWriteResult[]> {
  if (inputs.length === 0) return [];
  const scope = inputs[0]!;
  if (
    inputs.some(
      (input) =>
        input.organizationId !== scope.organizationId ||
        input.providerId !== scope.providerId ||
        input.configRevisionId !== scope.configRevisionId ||
        input.acceptedAt.getTime() !== scope.acceptedAt.getTime(),
    )
  ) {
    throw new Error(
      "Canonical projection batches cannot span tenant, provider, configuration, or commit scopes.",
    );
  }
  for (const input of inputs) {
    assertCanonicalActorDataSafe(input.projection.content);
  }
  const entitiesByIdentity = await loadCanonicalEntities(
    database,
    scope.organizationId,
    inputs.map(({ projection }) => projection),
    scope.acceptedAt,
  );
  const prepared: PreparedCanonicalProjection[] = inputs.map((input) => {
    const entity = entitiesByIdentity.get(canonicalIdentityKey(input.projection));
    if (!entity) throw new Error("Canonical entity insert returned no identity.");
    const provenance = {
      ...(input.projection.provenance ?? {}),
      configRevisionId: input.configRevisionId,
      providerId: input.providerId,
      sourceRecordId: input.sourceRecordId,
    };
    return {
      ...input,
      entityId: entity.id,
      contentHash: hashJson(input.projection.content),
      provenance,
      provenanceHash: hashJson(provenance),
    };
  });

  const entityIds = [...new Set(prepared.map(({ entityId }) => entityId))];
  const existingRevisions = [];
  for (const batch of batches(entityIds)) {
    existingRevisions.push(
      ...(await database
        .select({
          id: canonicalRevisions.id,
          entityId: canonicalRevisions.entityId,
          revisionNumber: canonicalRevisions.revisionNumber,
          contentHash: canonicalRevisions.contentHash,
          provenanceHash: canonicalRevisions.provenanceHash,
        })
        .from(canonicalRevisions)
        .where(inArray(canonicalRevisions.entityId, batch))),
    );
  }
  const revisionsByIdentity = new Map(
    existingRevisions.map((revision) => [canonicalRevisionKey(revision), revision]),
  );
  const latestRevisionNumberByEntity = new Map<string, number>();
  for (const revision of existingRevisions) {
    latestRevisionNumberByEntity.set(
      revision.entityId,
      Math.max(
        latestRevisionNumberByEntity.get(revision.entityId) ?? 0,
        revision.revisionNumber,
      ),
    );
  }

  const revisionsToInsert: (typeof canonicalRevisions.$inferInsert)[] = [];
  const currentRevisionByEntity = new Map<string, string>();
  const results: CanonicalProjectionWriteResult[] = [];
  for (const projection of prepared) {
    const revisionKey = canonicalRevisionKey(projection);
    const existing = revisionsByIdentity.get(revisionKey);
    if (existing) {
      results.push({ revisionId: existing.id, created: false });
      continue;
    }
    const revisionId = randomUUID();
    const revisionNumber =
      (latestRevisionNumberByEntity.get(projection.entityId) ?? 0) + 1;
    latestRevisionNumberByEntity.set(projection.entityId, revisionNumber);
    revisionsByIdentity.set(revisionKey, {
      id: revisionId,
      entityId: projection.entityId,
      revisionNumber,
      contentHash: projection.contentHash,
      provenanceHash: projection.provenanceHash,
    });
    revisionsToInsert.push({
      id: revisionId,
      organizationId: projection.organizationId,
      entityId: projection.entityId,
      revisionNumber,
      sourceRecordId: projection.sourceRecordId,
      contentJson: projection.projection.content,
      contentHash: projection.contentHash,
      provenanceJson: projection.provenance,
      provenanceHash: projection.provenanceHash,
      actorKey: projection.projection.sourceActorIdentifier
        ? pseudonymizeProviderActor({
            key: policy.actorPseudonymKey,
            platformKey: projection.projection.platformKey,
            sourceIdentifier: projection.projection.sourceActorIdentifier,
          })
        : null,
      sourceUpdatedAt: projection.projection.sourceUpdatedAt,
      sourceCollectedAt: projection.projection.sourceCollectedAt,
      acceptedAt: projection.acceptedAt,
    });
    currentRevisionByEntity.set(projection.entityId, revisionId);
    results.push({ revisionId, created: true });
  }

  for (const batch of batches(revisionsToInsert)) {
    await database.insert(canonicalRevisions).values(batch);
  }
  for (const batch of batches([...currentRevisionByEntity.entries()])) {
    const rows = batch.map(([entityId, revisionId]) =>
      sql`(${entityId}::uuid, ${revisionId}::uuid)`,
    );
    await database.execute(sql`
      update ${canonicalEntities}
      set
        current_revision_id = revisions.revision_id,
        updated_at = ${scope.acceptedAt}
      from (values ${sql.join(rows, sql`, `)}) as revisions(entity_id, revision_id)
      where ${canonicalEntities.id} = revisions.entity_id
        and ${canonicalEntities.organizationId} = ${scope.organizationId}
    `);
  }

  const projectionLinks = prepared.map((projection, index) => ({
    sourceRecordId: projection.sourceRecordId,
    canonicalRevisionId: results[index]!.revisionId,
    organizationId: projection.organizationId,
    projectionIndex: projection.projectionIndex,
    createdAt: projection.acceptedAt,
  }));
  for (const batch of batches(projectionLinks)) {
    await database
      .insert(sourceRecordProjectionRevisions)
      .values(batch)
      .onConflictDoNothing();
  }

  const relationshipTargets = prepared.flatMap(({ projection }) =>
    (projection.relationships ?? [])
      .filter(({ targetExternalId }) => targetExternalId !== null)
      .map((relationship) => ({
        platformKey: relationship.targetPlatformKey,
        recordKind: relationship.targetRecordKind,
        externalId: relationship.targetExternalId!,
      })),
  );
  const targetsByIdentity = await loadRelationshipTargets(
    database,
    scope.organizationId,
    relationshipTargets,
    entitiesByIdentity,
  );
  const relationships = prepared.flatMap((projection) => {
    const sourceEntity = entitiesByIdentity.get(
      canonicalIdentityKey(projection.projection),
    );
    if (!sourceEntity) throw new Error("Canonical relationship source is missing.");
    return (projection.projection.relationships ?? []).map((relationship) => {
      const target = relationship.targetExternalId
        ? targetsByIdentity.get(
            canonicalIdentityKey({
              platformKey: relationship.targetPlatformKey,
              recordKind: relationship.targetRecordKind,
              externalId: relationship.targetExternalId,
            }),
          )
        : undefined;
      return {
        organizationId: projection.organizationId,
        sourceEntityId: sourceEntity.id,
        relationshipKind: relationship.relationshipKind,
        targetPlatformKey: relationship.targetPlatformKey,
        targetRecordKind: relationship.targetRecordKind,
        targetExternalId: relationship.targetExternalId,
        targetEntityId: target?.id ?? null,
        createdAt: projection.acceptedAt,
        resolvedAt: target ? projection.acceptedAt : null,
      };
    });
  });
  for (const batch of batches(relationships)) {
    await database
      .insert(canonicalRelationships)
      .values(batch)
      .onConflictDoNothing();
  }

  for (const batch of batches([...entitiesByIdentity.values()])) {
    const rows = batch.map((entity) =>
      sql`(${entity.platformKey}::text, ${entity.recordKind}::text, ${entity.externalId}::text, ${entity.id}::uuid)`,
    );
    await database.execute(sql`
      update ${canonicalRelationships}
      set
        target_entity_id = targets.entity_id,
        resolved_at = ${scope.acceptedAt}
      from (values ${sql.join(rows, sql`, `)})
        as targets(platform_key, record_kind, external_id, entity_id)
      where ${canonicalRelationships.organizationId} = ${scope.organizationId}
        and ${canonicalRelationships.targetEntityId} is null
        and ${canonicalRelationships.targetPlatformKey} = targets.platform_key
        and ${canonicalRelationships.targetRecordKind}::text = targets.record_kind
        and ${canonicalRelationships.targetExternalId} = targets.external_id
    `);
  }
  return results;
}

export async function persistPageRecordsInBatches<
  TQueryResult extends PgQueryResultHKT,
>(
  database: PackscoutDatabase<TQueryResult>,
  policy: RawEvidencePolicy,
  input: CommitPageInput,
  pageId: string,
  expiresAt: Date,
): Promise<PageRecordBatchResult> {
  const prepared = input.records.map((record, sourcePosition) => {
    const contentHash = hashJson(record.payload);
    return {
      sourcePosition,
      recordIndex: record.recordIndex ?? sourcePosition,
      input: record,
      contentHash,
      identityKey: sourceIdentityKey({ ...record, contentHash }),
    };
  });
  const resolved = await resolveSourceRecords(
    database,
    input,
    prepared,
    pageId,
    expiresAt,
  );

  const observationByIdentity = new Map<string, (typeof sourceRecordObservations.$inferInsert)>();
  for (const record of resolved) {
    const key = [record.sourceRecordId, input.runId, pageId].join("\u0000");
    observationByIdentity.set(key, {
      sourceRecordId: record.sourceRecordId,
      organizationId: input.organizationId,
      runId: input.runId,
      pageId,
      observedAt: input.committedAt,
    });
  }
  for (const batch of batches([...observationByIdentity.values()])) {
    await database
      .insert(sourceRecordObservations)
      .values(batch)
      .onConflictDoNothing();
  }

  const projectionWrites = resolved.flatMap((record) =>
    record.input.quarantine
      ? []
      : record.input.projections.map((projection, projectionIndex) => ({
          organizationId: input.organizationId,
          providerId: input.providerId,
          configRevisionId: input.configRevisionId,
          sourceRecordId: record.sourceRecordId,
          projection,
          projectionIndex,
          acceptedAt: input.committedAt,
          sourcePosition: record.sourcePosition,
        })),
  );
  const canonicalResults = await writeCanonicalProjectionBatch(
    database,
    policy,
    projectionWrites,
  );
  const sourcePositionsWithNewRevisions = new Set<number>();
  const createdCanonicalProjections: CanonicalProjectionInput[] = [];
  for (const [index, result] of canonicalResults.entries()) {
    if (!result.created) continue;
    sourcePositionsWithNewRevisions.add(projectionWrites[index]!.sourcePosition);
    createdCanonicalProjections.push(projectionWrites[index]!.projection);
  }

  let accepted = 0;
  let duplicate = 0;
  let quarantined = 0;
  const outcomeRows: (typeof sourceRecordOutcomes.$inferInsert)[] = [];
  const quarantineRows: (typeof quarantineRecords.$inferInsert)[] = [];
  for (const record of resolved) {
    const outcome = record.input.quarantine
      ? "quarantined"
      : sourcePositionsWithNewRevisions.has(record.sourcePosition) || record.created
        ? "accepted"
        : "duplicate";
    if (outcome === "accepted") accepted += 1;
    else if (outcome === "duplicate") duplicate += 1;
    else quarantined += 1;
    outcomeRows.push({
      organizationId: input.organizationId,
      runId: input.runId,
      pageId,
      sourceRecordId: record.sourceRecordId,
      recordKind: record.input.recordKind,
      recordIndex: record.recordIndex,
      externalId: record.input.externalId,
      outcome,
      reasonCode: record.input.quarantine?.reasonCode,
      createdAt: input.committedAt,
    });
    if (record.input.quarantine) {
      quarantineRows.push({
        organizationId: input.organizationId,
        providerId: input.providerId,
        runId: input.runId,
        pageId,
        sourceRecordId: record.sourceRecordId,
        recordKind: record.input.recordKind,
        recordIndex: record.recordIndex,
        externalId: record.input.externalId,
        reasonCode: record.input.quarantine.reasonCode,
        fieldPath: record.input.quarantine.fieldPath,
        sanitizedSummary: record.input.quarantine.sanitizedSummary,
        payloadJson: null,
        expiresAt,
        createdAt: input.committedAt,
      });
    }
  }
  for (const quarantine of input.quarantines ?? []) {
    quarantineRows.push({
      organizationId: input.organizationId,
      providerId: input.providerId,
      runId: input.runId,
      pageId,
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
    outcomeRows.push({
      organizationId: input.organizationId,
      runId: input.runId,
      pageId,
      sourceRecordId: null,
      recordKind: quarantine.recordKind,
      recordIndex: quarantine.recordIndex,
      externalId: quarantine.externalId,
      outcome: "quarantined",
      reasonCode: quarantine.reasonCode,
      createdAt: input.committedAt,
    });
  }
  for (const batch of batches(outcomeRows)) {
    await database.insert(sourceRecordOutcomes).values(batch);
  }
  for (const batch of batches(quarantineRows)) {
    await database.insert(quarantineRecords).values(batch);
  }
  return {
    accepted,
    duplicate,
    quarantined,
    newCanonicalRevisions: canonicalResults.filter(({ created }) => created).length,
    createdCanonicalProjections,
  };
}
