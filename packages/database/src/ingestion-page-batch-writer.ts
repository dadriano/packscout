import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { PackscoutQueryClient } from "./database.ts";
import type {
  CanonicalProjectionInput,
  CommitPageInput,
  RawEvidencePolicy,
  SourceRecordKind,
} from "./pipeline-types.ts";
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

interface ExistingCanonicalRevision {
  readonly id: string;
  readonly entityId: string;
  readonly revisionNumber: number;
  readonly contentHash: string;
  readonly provenanceHash: string;
}

interface CanonicalRevisionInsert extends ExistingCanonicalRevision {
  readonly organizationId: string;
  readonly sourceRecordId: string;
  readonly content: Record<string, unknown>;
  readonly provenance: Record<string, unknown>;
  readonly actorKey: string | null;
  readonly sourceUpdatedAt: Date;
  readonly sourceCollectedAt: Date;
  readonly acceptedAt: Date;
}

interface ProjectionLinkInsert {
  readonly sourceRecordId: string;
  readonly canonicalRevisionId: string;
  readonly organizationId: string;
  readonly projectionIndex: number;
  readonly createdAt: Date;
}

interface RelationshipInsert {
  readonly organizationId: string;
  readonly sourceEntityId: string;
  readonly relationshipKind: string;
  readonly targetPlatformKey: string;
  readonly targetRecordKind: CanonicalProjectionInput["recordKind"];
  readonly targetExternalId: string | null;
  readonly targetEntityId: string | null;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

interface SourceOutcomeInsert {
  readonly organizationId: string;
  readonly runId: string;
  readonly pageId: string;
  readonly sourceRecordId: string | null;
  readonly recordKind: SourceRecordKind;
  readonly recordIndex: number;
  readonly externalId: string | null;
  readonly outcome: "accepted" | "duplicate" | "quarantined";
  readonly reasonCode: string | null;
  readonly createdAt: Date;
}

interface QuarantineInsert {
  readonly organizationId: string;
  readonly providerId: string;
  readonly runId: string;
  readonly pageId: string;
  readonly sourceRecordId: string | null;
  readonly recordKind: SourceRecordKind;
  readonly recordIndex: number;
  readonly externalId: string | null;
  readonly reasonCode: string;
  readonly fieldPath: string | null;
  readonly sanitizedSummary: string;
  readonly payload: unknown;
  readonly hasStandalonePayload: boolean;
  readonly expiresAt: Date;
  readonly createdAt: Date;
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

function sourceIdentityKey(input: {
  recordKind: SourceRecordKind;
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

async function resolveSourceRecords(
  database: PackscoutQueryClient,
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
    const rows = batch.map((record) => Prisma.sql`(
      ${uuid(input.organizationId)},
      ${uuid(input.providerId)},
      ${uuid(input.runId)},
      ${uuid(pageId)},
      cast(${record.input.recordKind} as public.source_record_kind),
      ${record.input.externalId},
      ${record.input.sourceTime},
      ${record.input.collectedAt},
      ${jsonValue(record.input.payload)},
      ${record.contentHash},
      ${expiresAt},
      ${input.committedAt}
    )`);
    const inserted = await database.$queryRaw<Array<{
      recordKind: SourceRecordKind;
      externalId: string;
      sourceTime: Date;
      contentHash: string;
    }>>(Prisma.sql`
      insert into public.source_records (
        organization_id, provider_id, first_run_id, first_page_id,
        record_kind, external_id, source_time, collected_at, payload_json,
        content_hash, expires_at, created_at
      )
      values ${Prisma.join(rows)}
      on conflict do nothing
      returning
        record_kind::text as "recordKind",
        external_id as "externalId",
        source_time as "sourceTime",
        content_hash as "contentHash"
    `);
    for (const record of inserted) {
      createdIdentityKeys.add(sourceIdentityKey(record));
    }
  }

  const resolvedByIdentity = new Map<string, string>();
  for (const batch of batches(uniqueRecords)) {
    const identities = batch.map((record) => Prisma.sql`(
      cast(${record.input.recordKind} as public.source_record_kind),
      ${record.input.externalId},
      ${record.input.sourceTime},
      ${record.contentHash}
    )`);
    const resolved = await database.$queryRaw<Array<{
      id: string;
      recordKind: SourceRecordKind;
      externalId: string;
      sourceTime: Date;
      contentHash: string;
    }>>(Prisma.sql`
      select
        id,
        record_kind::text as "recordKind",
        external_id as "externalId",
        source_time as "sourceTime",
        content_hash as "contentHash"
      from public.source_records
      where organization_id = ${uuid(input.organizationId)}
        and provider_id = ${uuid(input.providerId)}
        and (record_kind, external_id, source_time, content_hash) in (
          values ${Prisma.join(identities)}
        )
    `);
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

async function loadCanonicalEntities(
  database: PackscoutQueryClient,
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
    const rows = batch.map((identity) => Prisma.sql`(
      ${uuid(organizationId)},
      ${identity.platformKey},
      cast(${identity.recordKind} as public.canonical_record_kind),
      ${identity.externalId},
      ${acceptedAt},
      ${acceptedAt}
    )`);
    await database.$executeRaw(Prisma.sql`
      insert into public.canonical_entities (
        organization_id, platform_key, record_kind, external_id, created_at, updated_at
      )
      values ${Prisma.join(rows)}
      on conflict do nothing
    `);
  }

  const entitiesByIdentity = new Map<string, CanonicalEntityRecord>();
  for (const batch of batches(uniqueIdentities)) {
    const rows = batch.map((identity) => Prisma.sql`(
      ${identity.platformKey},
      cast(${identity.recordKind} as public.canonical_record_kind),
      ${identity.externalId}
    )`);
    const entities = await database.$queryRaw<CanonicalEntityRecord[]>(Prisma.sql`
      select
        id,
        platform_key as "platformKey",
        record_kind::text as "recordKind",
        external_id as "externalId"
      from public.canonical_entities
      where organization_id = ${uuid(organizationId)}
        and (platform_key, record_kind, external_id) in (
          values ${Prisma.join(rows)}
        )
      order by platform_key, record_kind, external_id
      for update
    `);
    for (const entity of entities) {
      entitiesByIdentity.set(canonicalIdentityKey(entity), entity);
    }
  }
  if (entitiesByIdentity.size !== uniqueIdentities.length) {
    throw new Error("Canonical entity insert returned no identity.");
  }
  return entitiesByIdentity;
}

async function loadRelationshipTargets(
  database: PackscoutQueryClient,
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
    const rows = batch.map((identity) => Prisma.sql`(
      ${identity.platformKey},
      cast(${identity.recordKind} as public.canonical_record_kind),
      ${identity.externalId}
    )`);
    const records = await database.$queryRaw<CanonicalEntityRecord[]>(Prisma.sql`
      select
        id,
        platform_key as "platformKey",
        record_kind::text as "recordKind",
        external_id as "externalId"
      from public.canonical_entities
      where organization_id = ${uuid(organizationId)}
        and (platform_key, record_kind, external_id) in (
          values ${Prisma.join(rows)}
        )
    `);
    for (const record of records) {
      targets.set(canonicalIdentityKey(record), record);
    }
  }
  return targets;
}

export async function writeCanonicalProjectionBatch(
  database: PackscoutQueryClient,
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
  const existingRevisions: ExistingCanonicalRevision[] = [];
  for (const batch of batches(entityIds)) {
    existingRevisions.push(
      ...(await database.$queryRaw<ExistingCanonicalRevision[]>(Prisma.sql`
        select
          id,
          entity_id as "entityId",
          revision_number as "revisionNumber",
          content_hash as "contentHash",
          provenance_hash as "provenanceHash"
        from public.canonical_revisions
        where entity_id in (${Prisma.join(batch.map(uuid))})
      `)),
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

  const revisionsToInsert: CanonicalRevisionInsert[] = [];
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
    const revision: CanonicalRevisionInsert = {
      id: revisionId,
      organizationId: projection.organizationId,
      entityId: projection.entityId,
      revisionNumber,
      sourceRecordId: projection.sourceRecordId,
      content: projection.projection.content,
      contentHash: projection.contentHash,
      provenance: projection.provenance,
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
    };
    revisionsByIdentity.set(revisionKey, revision);
    revisionsToInsert.push(revision);
    currentRevisionByEntity.set(projection.entityId, revisionId);
    results.push({ revisionId, created: true });
  }

  for (const batch of batches(revisionsToInsert)) {
    const rows = batch.map((revision) => Prisma.sql`(
      ${uuid(revision.id)},
      ${uuid(revision.organizationId)},
      ${uuid(revision.entityId)},
      ${revision.revisionNumber},
      ${uuid(revision.sourceRecordId)},
      ${jsonValue(revision.content)},
      ${revision.contentHash},
      ${jsonValue(revision.provenance)},
      ${revision.provenanceHash},
      ${revision.actorKey},
      ${revision.sourceUpdatedAt},
      ${revision.sourceCollectedAt},
      ${revision.acceptedAt}
    )`);
    await database.$executeRaw(Prisma.sql`
      insert into public.canonical_revisions (
        id, organization_id, entity_id, revision_number, source_record_id,
        content_json, content_hash, provenance_json, provenance_hash, actor_key,
        source_updated_at, source_collected_at, accepted_at
      )
      values ${Prisma.join(rows)}
    `);
  }
  for (const batch of batches([...currentRevisionByEntity.entries()])) {
    const rows = batch.map(([entityId, revisionId]) =>
      Prisma.sql`(${uuid(entityId)}, ${uuid(revisionId)})`,
    );
    await database.$executeRaw(Prisma.sql`
      update public.canonical_entities as entity
      set current_revision_id = revisions.revision_id,
          updated_at = ${scope.acceptedAt}
      from (values ${Prisma.join(rows)}) as revisions(entity_id, revision_id)
      where entity.id = revisions.entity_id
        and entity.organization_id = ${uuid(scope.organizationId)}
    `);
  }

  const projectionLinks: ProjectionLinkInsert[] = prepared.map((projection, index) => ({
    sourceRecordId: projection.sourceRecordId,
    canonicalRevisionId: results[index]!.revisionId,
    organizationId: projection.organizationId,
    projectionIndex: projection.projectionIndex,
    createdAt: projection.acceptedAt,
  }));
  for (const batch of batches(projectionLinks)) {
    const rows = batch.map((link) => Prisma.sql`(
      ${uuid(link.sourceRecordId)},
      ${uuid(link.canonicalRevisionId)},
      ${uuid(link.organizationId)},
      ${link.projectionIndex},
      ${link.createdAt}
    )`);
    await database.$executeRaw(Prisma.sql`
      insert into public.source_record_projection_revisions (
        source_record_id, canonical_revision_id, organization_id,
        projection_index, created_at
      )
      values ${Prisma.join(rows)}
      on conflict do nothing
    `);
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
  const relationships: RelationshipInsert[] = prepared.flatMap((projection) => {
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
    const rows = batch.map((relationship) => Prisma.sql`(
      ${uuid(relationship.organizationId)},
      ${uuid(relationship.sourceEntityId)},
      ${relationship.relationshipKind},
      ${relationship.targetPlatformKey},
      cast(${relationship.targetRecordKind} as public.canonical_record_kind),
      ${relationship.targetExternalId},
      ${relationship.targetEntityId ? uuid(relationship.targetEntityId) : Prisma.sql`null::uuid`},
      ${relationship.createdAt},
      ${relationship.resolvedAt}
    )`);
    await database.$executeRaw(Prisma.sql`
      insert into public.canonical_relationships (
        organization_id, source_entity_id, relationship_kind,
        target_platform_key, target_record_kind, target_external_id,
        target_entity_id, created_at, resolved_at
      )
      values ${Prisma.join(rows)}
      on conflict do nothing
    `);
  }

  for (const batch of batches([...entitiesByIdentity.values()])) {
    const rows = batch.map((entity) => Prisma.sql`(
      ${entity.platformKey},
      cast(${entity.recordKind} as public.canonical_record_kind),
      ${entity.externalId},
      ${uuid(entity.id)}
    )`);
    await database.$executeRaw(Prisma.sql`
      update public.canonical_relationships as relationship
      set target_entity_id = targets.entity_id,
          resolved_at = ${scope.acceptedAt}
      from (values ${Prisma.join(rows)})
        as targets(platform_key, record_kind, external_id, entity_id)
      where relationship.organization_id = ${uuid(scope.organizationId)}
        and relationship.target_entity_id is null
        and relationship.target_platform_key = targets.platform_key
        and relationship.target_record_kind = targets.record_kind
        and relationship.target_external_id = targets.external_id
    `);
  }
  return results;
}

export async function persistPageRecordsInBatches(
  database: PackscoutQueryClient,
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

  const observationByIdentity = new Map<string, {
    sourceRecordId: string;
    organizationId: string;
    runId: string;
    pageId: string;
    observedAt: Date;
  }>();
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
    const rows = batch.map((observation) => Prisma.sql`(
      ${uuid(observation.sourceRecordId)},
      ${uuid(observation.organizationId)},
      ${uuid(observation.runId)},
      ${uuid(observation.pageId)},
      ${observation.observedAt}
    )`);
    await database.$executeRaw(Prisma.sql`
      insert into public.source_record_observations (
        source_record_id, organization_id, run_id, page_id, observed_at
      )
      values ${Prisma.join(rows)}
      on conflict do nothing
    `);
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
  const outcomeRows: SourceOutcomeInsert[] = [];
  const quarantineRows: QuarantineInsert[] = [];
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
      reasonCode: record.input.quarantine?.reasonCode ?? null,
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
        fieldPath: record.input.quarantine.fieldPath ?? null,
        sanitizedSummary: record.input.quarantine.sanitizedSummary,
        payload: null,
        hasStandalonePayload: false,
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
      sourceRecordId: null,
      recordKind: quarantine.recordKind,
      recordIndex: quarantine.recordIndex,
      externalId: quarantine.externalId,
      reasonCode: quarantine.reasonCode,
      fieldPath: quarantine.fieldPath ?? null,
      sanitizedSummary: quarantine.sanitizedSummary,
      payload: quarantine.payload,
      hasStandalonePayload: true,
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
    const rows = batch.map((outcome) => Prisma.sql`(
      ${uuid(outcome.organizationId)},
      ${uuid(outcome.runId)},
      ${uuid(outcome.pageId)},
      ${outcome.sourceRecordId ? uuid(outcome.sourceRecordId) : Prisma.sql`null::uuid`},
      cast(${outcome.recordKind} as public.source_record_kind),
      ${outcome.recordIndex},
      ${outcome.externalId},
      cast(${outcome.outcome} as public.source_record_outcome),
      ${outcome.reasonCode},
      ${outcome.createdAt}
    )`);
    await database.$executeRaw(Prisma.sql`
      insert into public.source_record_outcomes (
        organization_id, run_id, page_id, source_record_id, record_kind,
        record_index, external_id, outcome, reason_code, created_at
      )
      values ${Prisma.join(rows)}
    `);
  }
  for (const batch of batches(quarantineRows)) {
    const rows = batch.map((quarantine) => Prisma.sql`(
      ${uuid(quarantine.organizationId)},
      ${uuid(quarantine.providerId)},
      ${uuid(quarantine.runId)},
      ${uuid(quarantine.pageId)},
      ${quarantine.sourceRecordId ? uuid(quarantine.sourceRecordId) : Prisma.sql`null::uuid`},
      cast(${quarantine.recordKind} as public.source_record_kind),
      ${quarantine.recordIndex},
      ${quarantine.externalId},
      ${quarantine.reasonCode},
      ${quarantine.fieldPath},
      ${quarantine.sanitizedSummary},
      ${quarantine.hasStandalonePayload ? jsonValue(quarantine.payload) : Prisma.sql`null::jsonb`},
      ${quarantine.expiresAt},
      ${quarantine.createdAt}
    )`);
    await database.$executeRaw(Prisma.sql`
      insert into public.quarantine_records (
        organization_id, provider_id, run_id, page_id, source_record_id,
        record_kind, record_index, external_id, reason_code, field_path,
        sanitized_summary, payload_json, expires_at, created_at
      )
      values ${Prisma.join(rows)}
    `);
  }
  return {
    accepted,
    duplicate,
    quarantined,
    newCanonicalRevisions: canonicalResults.filter(({ created }) => created).length,
    createdCanonicalProjections,
  };
}
