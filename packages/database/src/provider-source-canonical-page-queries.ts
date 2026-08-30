import { createHash } from "node:crypto";
import {
  canonicalKindByLaunchScope,
  type LaunchProviderKey,
  type ProviderSourceCanonicalProjectionPlan,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import type { PackscoutTransactionClient } from "./database.ts";

const MAXIMUM_ROWS_PER_QUERY = 500;

function batches<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += MAXIMUM_ROWS_PER_QUERY) {
    result.push(values.slice(index, index + MAXIMUM_ROWS_PER_QUERY));
  }
  return result;
}

export interface ProviderSourceCanonicalScope {
  readonly organizationId: string;
  readonly provider: LaunchProviderKey;
}

export interface ProviderSourceCanonicalHistoryRow {
  readonly canonicalRevisionId: string | null;
  readonly contentFingerprint: string;
  readonly effectiveAt: Date;
}

function canonicalIdentityLockKey(
  organizationId: string,
  platformKey: string,
  recordKind: string,
  providerRecordId: string,
): string {
  return JSON.stringify([
    organizationId,
    platformKey,
    recordKind,
    providerRecordId,
  ]);
}

/**
 * Serializes source-native lifecycle reads and writes for each exact canonical
 * identity, including the absent-entity case where a row lock cannot exist yet.
 */
export async function lockProviderSourceCanonicalProjectionIdentities(
  transaction: PackscoutTransactionClient,
  organizationId: string,
  projections: readonly ProviderSourceCanonicalProjectionPlan[],
): Promise<void> {
  const keys = [...new Set(projections.flatMap((projection) => [
    canonicalIdentityLockKey(
      organizationId,
      projection.platformKey,
      projection.recordKind,
      projection.providerRecordId,
    ),
    ...projection.relationships.map((relationship) =>
      canonicalIdentityLockKey(
        organizationId,
        projection.platformKey,
        relationship.targetCanonicalKind,
        relationship.targetProviderRecordId,
      )
    ),
  ]))].sort();
  if (keys.length === 0) return;
  // One statement acquires every lock; unnest preserves the sorted key order,
  // so acquisition order (and deadlock avoidance) matches the per-key loop.
  const lockIds = keys.map((key) =>
    createHash("sha256").update(key).digest().readBigInt64BE(0)
  );
  await transaction.$queryRaw<Array<{ locked: string }>>(Prisma.sql`
    select pg_advisory_xact_lock(k)::text as locked
    from unnest(array[${Prisma.join(lockIds)}]::bigint[]) as k
  `);
}

export function providerSourceProjectionCommand(
  projection: ProviderSourceCanonicalProjectionPlan,
  collectedAt: string,
) {
  return {
    platformKey: projection.platformKey,
    recordKind: projection.recordKind,
    externalId: projection.providerRecordId,
    content: { ...projection.content },
    provenance: {},
    sourceUpdatedAt: new Date(projection.effectiveAt),
    sourceCollectedAt: new Date(collectedAt),
    relationships: projection.relationships.map((relationship) => ({
      relationshipKind: relationship.relationship,
      targetPlatformKey: projection.platformKey,
      targetRecordKind: relationship.targetCanonicalKind,
      targetExternalId: relationship.targetProviderRecordId,
    })),
  };
}

export async function loadProviderSourceCanonicalHistory(
  transaction: PackscoutTransactionClient,
  scope: ProviderSourceCanonicalScope,
  projection: ProviderSourceCanonicalProjectionPlan,
): Promise<readonly ProviderSourceCanonicalHistoryRow[]> {
  return transaction.$queryRaw<ProviderSourceCanonicalHistoryRow[]>(Prisma.sql`
    select revision.id as "canonicalRevisionId",
           revision.content_hash as "contentFingerprint",
           revision.source_updated_at as "effectiveAt"
    from public.canonical_entities as entity
    join public.canonical_revisions as revision on revision.entity_id = entity.id
    where entity.organization_id = ${scope.organizationId}::uuid
      and entity.platform_key = ${projection.platformKey}
      and entity.record_kind = cast(${projection.recordKind} as public.canonical_record_kind)
      and entity.external_id = ${projection.providerRecordId}
    order by revision.revision_number
    for share of entity, revision
  `);
}

interface ProviderSourceCanonicalProjectionIdentity {
  readonly platformKey: string;
  readonly recordKind: string;
  readonly providerRecordId: string;
}

/** Stable per-page map key for one exact canonical projection identity. */
export function providerSourceCanonicalProjectionIdentityKey(
  projection: ProviderSourceCanonicalProjectionIdentity,
): string {
  return JSON.stringify([
    projection.platformKey,
    projection.recordKind,
    projection.providerRecordId,
  ]);
}

/**
 * Loads the complete committed history for every projection identity in one
 * statement. Row-level semantics match {@link loadProviderSourceCanonicalHistory}:
 * the same columns, the same revision-number ordering per identity, and the
 * same `for share` entity and revision locks. Identities with no committed
 * revisions map to an empty list.
 */
export async function loadProviderSourceCanonicalHistoryByIdentity(
  transaction: PackscoutTransactionClient,
  scope: ProviderSourceCanonicalScope,
  projections: readonly ProviderSourceCanonicalProjectionPlan[],
): Promise<ReadonlyMap<string, readonly ProviderSourceCanonicalHistoryRow[]>> {
  const identitiesByKey = new Map<
    string,
    ProviderSourceCanonicalProjectionIdentity
  >();
  for (const projection of projections) {
    const key = providerSourceCanonicalProjectionIdentityKey(projection);
    if (!identitiesByKey.has(key)) identitiesByKey.set(key, projection);
  }
  const history = new Map<string, ProviderSourceCanonicalHistoryRow[]>();
  for (const key of identitiesByKey.keys()) history.set(key, []);
  if (identitiesByKey.size === 0) return history;
  for (const batch of batches([...identitiesByKey.values()])) {
    const identityRows = batch.map((identity) =>
      Prisma.sql`(
        ${identity.platformKey},
        cast(${identity.recordKind} as public.canonical_record_kind),
        ${identity.providerRecordId}
      )`
    );
    const rows = await transaction.$queryRaw<Array<{
      platformKey: string;
      recordKind: string;
      providerRecordId: string;
      canonicalRevisionId: string;
      contentFingerprint: string;
      effectiveAt: Date;
    }>>(Prisma.sql`
      select entity.platform_key as "platformKey",
             entity.record_kind::text as "recordKind",
             entity.external_id as "providerRecordId",
             revision.id as "canonicalRevisionId",
             revision.content_hash as "contentFingerprint",
             revision.source_updated_at as "effectiveAt"
      from public.canonical_entities as entity
      join public.canonical_revisions as revision on revision.entity_id = entity.id
      where entity.organization_id = ${scope.organizationId}::uuid
        and (entity.platform_key, entity.record_kind, entity.external_id) in (
          values ${Prisma.join(identityRows)}
        )
      order by entity.platform_key, entity.record_kind, entity.external_id,
               revision.revision_number
      for share of entity, revision
    `);
    for (const row of rows) {
      history.get(providerSourceCanonicalProjectionIdentityKey(row))?.push({
        canonicalRevisionId: row.canonicalRevisionId,
        contentFingerprint: row.contentFingerprint,
        effectiveAt: row.effectiveAt,
      });
    }
  }
  return history;
}

export async function hasProviderSourceCanonicalKindConflict(
  transaction: PackscoutTransactionClient,
  organizationId: string,
  sourceRecordId: string,
  projections: readonly ProviderSourceCanonicalProjectionPlan[],
): Promise<boolean> {
  const scope = projections[0]?.recordIdScopeKey;
  if (!scope) return true;
  const allowed = new Set<string>([canonicalKindByLaunchScope[scope]]);
  if (scope === "catalog-pack-v1") allowed.add("ev_input");
  const rows = await transaction.$queryRaw<Array<{ recordKind: string }>>(Prisma.sql`
    select distinct entity.record_kind::text as "recordKind"
    from public.source_semantic_observations as observation
    join public.canonical_revisions as revision
      on revision.origin_semantic_observation_id = observation.id
     and revision.organization_id = observation.organization_id
    join public.canonical_entities as entity
      on entity.id = revision.entity_id
     and entity.organization_id = revision.organization_id
    where observation.organization_id = ${organizationId}::uuid
      and observation.source_record_id = ${sourceRecordId}::uuid
  `);
  return rows.some(({ recordKind }) => !allowed.has(recordKind));
}

export interface ProviderSourceCanonicalKindConflictCandidate {
  readonly sourceRecordId: string;
  readonly projections: readonly ProviderSourceCanonicalProjectionPlan[];
}

/**
 * Resolves immutable source-identity/canonical-kind conflicts for a whole page
 * in bounded grouped reads. The returned ids have at least one historical kind
 * outside the exact launch scope allowed by their candidate projections.
 */
export async function findProviderSourceCanonicalKindConflictSourceRecordIds(
  transaction: PackscoutTransactionClient,
  organizationId: string,
  candidates: readonly ProviderSourceCanonicalKindConflictCandidate[],
): Promise<ReadonlySet<string>> {
  const allowedBySourceRecordId = new Map<string, ReadonlySet<string>>();
  for (const candidate of candidates) {
    const scope = candidate.projections[0]?.recordIdScopeKey;
    if (!scope) {
      allowedBySourceRecordId.set(candidate.sourceRecordId, new Set());
      continue;
    }
    const allowed = new Set<string>([canonicalKindByLaunchScope[scope]]);
    if (scope === "catalog-pack-v1") allowed.add("ev_input");
    allowedBySourceRecordId.set(candidate.sourceRecordId, allowed);
  }
  const conflicts = new Set<string>();
  const sourceRecordIds = [...allowedBySourceRecordId.keys()];
  for (const batch of batches(sourceRecordIds)) {
    const rows = await transaction.$queryRaw<Array<{
      sourceRecordId: string;
      recordKind: string;
    }>>(Prisma.sql`
      select distinct observation.source_record_id as "sourceRecordId",
                      entity.record_kind::text as "recordKind"
      from public.source_semantic_observations as observation
      join public.canonical_revisions as revision
        on revision.origin_semantic_observation_id = observation.id
       and revision.organization_id = observation.organization_id
      join public.canonical_entities as entity
        on entity.id = revision.entity_id
       and entity.organization_id = revision.organization_id
      where observation.organization_id = ${organizationId}::uuid
        and observation.source_record_id in (
          ${Prisma.join(batch.map((id) => Prisma.sql`${id}::uuid`))}
        )
    `);
    for (const row of rows) {
      if (!allowedBySourceRecordId.get(row.sourceRecordId)?.has(row.recordKind)) {
        conflicts.add(row.sourceRecordId);
      }
    }
  }
  return conflicts;
}

export async function countProviderSourceUnresolvedRelationships(
  transaction: PackscoutTransactionClient,
  scope: ProviderSourceCanonicalScope,
  projections: readonly ProviderSourceCanonicalProjectionPlan[],
): Promise<number> {
  let count = 0;
  for (const projection of projections) {
    for (const relationship of projection.relationships) {
      const rows = await transaction.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        select count(*)::bigint as count
        from public.canonical_relationships as stored
        join public.canonical_entities as entity
          on entity.id = stored.source_entity_id
         and entity.organization_id = stored.organization_id
        where entity.organization_id = ${scope.organizationId}::uuid
          and entity.platform_key = ${projection.platformKey}
          and entity.record_kind = cast(${projection.recordKind} as public.canonical_record_kind)
          and entity.external_id = ${projection.providerRecordId}
          and stored.relationship_kind = ${relationship.relationship}
          and stored.target_platform_key = ${projection.platformKey}
          and stored.target_record_kind = cast(${relationship.targetCanonicalKind} as public.canonical_record_kind)
          and stored.target_external_id = ${relationship.targetProviderRecordId}
          and stored.target_entity_id is null
      `);
      count += Number(rows[0]?.count ?? 0n);
    }
  }
  return count;
}

type ProviderSourceProjectionRelationshipPlan =
  ProviderSourceCanonicalProjectionPlan["relationships"][number];

/** Stable map key for one exact (projection identity, relationship) tuple. */
export function providerSourceUnresolvedRelationshipKey(
  projection: ProviderSourceCanonicalProjectionPlan,
  relationship: ProviderSourceProjectionRelationshipPlan,
): string {
  return JSON.stringify([
    projection.platformKey,
    projection.recordKind,
    projection.providerRecordId,
    relationship.relationship,
    relationship.targetCanonicalKind,
    relationship.targetProviderRecordId,
  ]);
}

/**
 * Counts stored unresolved relationships for every (projection, relationship)
 * tuple in one grouped statement. Each distinct tuple is queried once and the
 * predicate matches {@link countProviderSourceUnresolvedRelationships} exactly;
 * tuples with no unresolved rows map to zero.
 */
export async function countProviderSourceUnresolvedRelationshipsByTuple(
  transaction: PackscoutTransactionClient,
  scope: ProviderSourceCanonicalScope,
  projections: readonly ProviderSourceCanonicalProjectionPlan[],
): Promise<ReadonlyMap<string, number>> {
  const tuplesByKey = new Map<string, Readonly<{
    projection: ProviderSourceCanonicalProjectionPlan;
    relationship: ProviderSourceProjectionRelationshipPlan;
  }>>();
  for (const projection of projections) {
    for (const relationship of projection.relationships) {
      const key = providerSourceUnresolvedRelationshipKey(
        projection,
        relationship,
      );
      if (!tuplesByKey.has(key)) tuplesByKey.set(key, { projection, relationship });
    }
  }
  const counts = new Map<string, number>();
  for (const key of tuplesByKey.keys()) counts.set(key, 0);
  if (tuplesByKey.size === 0) return counts;
  for (const batch of batches([...tuplesByKey.values()])) {
    const tupleRows = batch.map(({ projection, relationship }) =>
      Prisma.sql`(
        ${projection.platformKey},
        cast(${projection.recordKind} as public.canonical_record_kind),
        ${projection.providerRecordId},
        ${relationship.relationship},
        cast(${relationship.targetCanonicalKind} as public.canonical_record_kind),
        ${relationship.targetProviderRecordId}
      )`
    );
    const rows = await transaction.$queryRaw<Array<{
      platformKey: string;
      recordKind: string;
      providerRecordId: string;
      relationshipKind: string;
      targetRecordKind: string;
      targetProviderRecordId: string;
      count: bigint;
    }>>(Prisma.sql`
      select tuple.platform_key as "platformKey",
             tuple.record_kind::text as "recordKind",
             tuple.external_id as "providerRecordId",
             tuple.relationship_kind as "relationshipKind",
             tuple.target_record_kind::text as "targetRecordKind",
             tuple.target_external_id as "targetProviderRecordId",
             count(stored.id)::bigint as count
      from (values ${Prisma.join(tupleRows)}) as tuple(
        platform_key, record_kind, external_id,
        relationship_kind, target_record_kind, target_external_id
      )
      left join public.canonical_entities as entity
        on entity.organization_id = ${scope.organizationId}::uuid
       and entity.platform_key = tuple.platform_key
       and entity.record_kind = tuple.record_kind
       and entity.external_id = tuple.external_id
      left join public.canonical_relationships as stored
        on stored.source_entity_id = entity.id
       and stored.organization_id = entity.organization_id
       and stored.relationship_kind = tuple.relationship_kind
       and stored.target_platform_key = tuple.platform_key
       and stored.target_record_kind = tuple.target_record_kind
       and stored.target_external_id = tuple.target_external_id
       and stored.target_entity_id is null
      group by tuple.platform_key, tuple.record_kind, tuple.external_id,
               tuple.relationship_kind, tuple.target_record_kind,
               tuple.target_external_id
    `);
    for (const row of rows) {
      counts.set(
        JSON.stringify([
          row.platformKey,
          row.recordKind,
          row.providerRecordId,
          row.relationshipKind,
          row.targetRecordKind,
          row.targetProviderRecordId,
        ]),
        Number(row.count),
      );
    }
  }
  return counts;
}

export interface CompleteProviderSourceEvInput {
  readonly packRevisionId: string;
  readonly evInputRevisionId: string;
  readonly evInputExternalId: string;
}

export async function loadCompleteProviderSourceEvInput(
  transaction: PackscoutTransactionClient,
  scope: ProviderSourceCanonicalScope,
  packExternalId: string,
): Promise<Readonly<CompleteProviderSourceEvInput> | null> {
  const rows = await transaction.$queryRaw<Array<{
    packRevisionId: string;
    evInputRevisionId: string;
    evInputExternalId: string;
  }>>(Prisma.sql`
    select pack.current_revision_id as "packRevisionId",
           ev_input.current_revision_id as "evInputRevisionId",
           ev_input.external_id as "evInputExternalId"
    from public.canonical_entities as pack
    join public.canonical_revisions as pack_revision
      on pack_revision.id = pack.current_revision_id
     and pack_revision.organization_id = pack.organization_id
    join public.canonical_relationships as relationship
      on relationship.organization_id = pack.organization_id
     and relationship.target_platform_key = pack.platform_key
     and relationship.target_record_kind = 'pack'::public.canonical_record_kind
     and relationship.target_external_id = pack.external_id
    join public.canonical_entities as ev_input
      on ev_input.id = relationship.source_entity_id
     and ev_input.organization_id = relationship.organization_id
     and ev_input.record_kind = 'ev_input'::public.canonical_record_kind
     and ev_input.current_revision_id is not null
    join public.canonical_revisions as ev_revision
      on ev_revision.id = ev_input.current_revision_id
     and ev_revision.organization_id = ev_input.organization_id
    where pack.organization_id = ${scope.organizationId}::uuid
      and pack.platform_key = ${scope.provider}
      and pack.record_kind = 'pack'::public.canonical_record_kind
      and pack.external_id = ${packExternalId}
      and pack.current_revision_id is not null
      and pack_revision.content_json ->> 'evInputStatus' = 'ready'
      and relationship.relationship_kind = 'supports_pack'
      and ev_revision.content_json ->> 'entityType' = 'ev_input'
      and ev_revision.content_json ->> 'evidenceCompleteness' = 'complete'
      and ev_revision.content_json #>> '{readiness,status}' = 'ready'
    order by ev_input.external_id
    limit 1
  `);
  return rows[0] ?? null;
}

/** Loads the same complete EV evidence as the scalar query for many packs. */
export async function loadCompleteProviderSourceEvInputs(
  transaction: PackscoutTransactionClient,
  scope: ProviderSourceCanonicalScope,
  packExternalIds: readonly string[],
): Promise<ReadonlyMap<string, Readonly<CompleteProviderSourceEvInput>>> {
  const complete = new Map<string, Readonly<CompleteProviderSourceEvInput>>();
  const uniquePackExternalIds = [...new Set(packExternalIds)];
  for (const batch of batches(uniquePackExternalIds)) {
    const rows = await transaction.$queryRaw<Array<
      CompleteProviderSourceEvInput & { packExternalId: string }
    >>(Prisma.sql`
      select distinct on (pack.external_id)
             pack.external_id as "packExternalId",
             pack.current_revision_id as "packRevisionId",
             ev_input.current_revision_id as "evInputRevisionId",
             ev_input.external_id as "evInputExternalId"
      from public.canonical_entities as pack
      join public.canonical_revisions as pack_revision
        on pack_revision.id = pack.current_revision_id
       and pack_revision.organization_id = pack.organization_id
      join public.canonical_relationships as relationship
        on relationship.organization_id = pack.organization_id
       and relationship.target_platform_key = pack.platform_key
       and relationship.target_record_kind = 'pack'::public.canonical_record_kind
       and relationship.target_external_id = pack.external_id
      join public.canonical_entities as ev_input
        on ev_input.id = relationship.source_entity_id
       and ev_input.organization_id = relationship.organization_id
       and ev_input.record_kind = 'ev_input'::public.canonical_record_kind
       and ev_input.current_revision_id is not null
      join public.canonical_revisions as ev_revision
        on ev_revision.id = ev_input.current_revision_id
       and ev_revision.organization_id = ev_input.organization_id
      where pack.organization_id = ${scope.organizationId}::uuid
        and pack.platform_key = ${scope.provider}
        and pack.record_kind = 'pack'::public.canonical_record_kind
        and pack.external_id in (
          ${Prisma.join(batch.map((id) => Prisma.sql`${id}`))}
        )
        and pack.current_revision_id is not null
        and pack_revision.content_json ->> 'evInputStatus' = 'ready'
        and relationship.relationship_kind = 'supports_pack'
        and ev_revision.content_json ->> 'entityType' = 'ev_input'
        and ev_revision.content_json ->> 'evidenceCompleteness' = 'complete'
        and ev_revision.content_json #>> '{readiness,status}' = 'ready'
      order by pack.external_id, ev_input.external_id
    `);
    for (const row of rows) {
      complete.set(row.packExternalId, {
        packRevisionId: row.packRevisionId,
        evInputRevisionId: row.evInputRevisionId,
        evInputExternalId: row.evInputExternalId,
      });
    }
  }
  return complete;
}
