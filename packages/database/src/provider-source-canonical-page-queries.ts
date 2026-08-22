import { createHash } from "node:crypto";
import {
  canonicalKindByLaunchScope,
  type LaunchProviderKey,
  type ProviderSourceCanonicalProjectionPlan,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import type { PackscoutTransactionClient } from "./database.ts";

export interface ProviderSourceCanonicalScope {
  readonly organizationId: string;
  readonly provider: LaunchProviderKey;
}

export interface ProviderSourceCanonicalHistoryRow {
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
  for (const key of keys) {
    const lockId = createHash("sha256").update(key).digest().readBigInt64BE(0);
    await transaction.$queryRaw<Array<{ locked: string }>>(Prisma.sql`
      select pg_advisory_xact_lock(${lockId})::text as locked
    `);
  }
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
    select revision.content_hash as "contentFingerprint",
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

export async function loadCompleteProviderSourceEvInput(
  transaction: PackscoutTransactionClient,
  scope: ProviderSourceCanonicalScope,
  packExternalId: string,
): Promise<Readonly<{
  packRevisionId: string;
  evInputRevisionId: string;
  evInputExternalId: string;
}> | null> {
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
