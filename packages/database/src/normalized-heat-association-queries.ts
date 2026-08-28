import { Prisma } from "@prisma/client";
import type { PackscoutQueryClient } from "./database.ts";
import {
  normalizedHeatSourceRequestKey as sourceRequestKey,
  uuid,
  type CanonicalHeatSourceEvidence,
} from "./normalized-heat-observation-repository.ts";
import { NORMALIZED_HEAT_MAXIMUM_WRITE_CANDIDATES } from
  "./normalized-heat-write-bound.ts";

interface AssetPackAssociationRow {
  requestKey: string;
  packExternalId: string;
}

export async function loadAssetPackAssociationsForRevisionSources(
  database: PackscoutQueryClient,
  organizationId: string,
  sources: readonly CanonicalHeatSourceEvidence[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const assets = sources.filter(
    ({ revision }) => revision.recordKind === "catalog_asset",
  );
  if (assets.length === 0) return new Map();
  const requests = assets.map(({ revision, causalSequence }) => Prisma.sql`(
    ${revision.revisionId}, ${uuid(revision.entityId)}, ${revision.platformKey},
    ${revision.externalId}, ${causalSequence}
  )`);
  const rows = await database.$queryRaw<AssetPackAssociationRow[]>(Prisma.sql`
    with requested(
      request_key, asset_entity_id, platform_key, asset_external_id,
      causal_sequence
    )
      as (values ${Prisma.join(requests)}),
    requested_card_sources as materialized (
      select requested.request_key,
             requested.platform_key,
             requested.causal_sequence,
             card_relationship.id as card_relationship_id,
             card_relationship.organization_id,
             card_relationship.source_entity_id as pull_entity_id
      from requested
      join public.canonical_relationships as card_relationship
        on card_relationship.organization_id = ${uuid(organizationId)}
       and card_relationship.target_entity_id = requested.asset_entity_id
       and card_relationship.relationship_kind = 'card'
       and card_relationship.target_platform_key = requested.platform_key
       and card_relationship.target_record_kind = 'catalog_asset'
       and card_relationship.target_external_id = requested.asset_external_id
       and card_relationship.created_public_change_sequence <=
         requested.causal_sequence
       and card_relationship.resolved_public_change_sequence <=
         requested.causal_sequence
      join public.canonical_entities as pull
        on pull.id = card_relationship.source_entity_id
       and pull.organization_id = card_relationship.organization_id
       and pull.platform_key = requested.platform_key
       and pull.record_kind = 'pull'
    ),
    associations as (
      select distinct requested.request_key,
             pack.external_id as pack_external_id
      from requested_card_sources as requested
    left join lateral (
      select confirmation.id
      from public.source_relationship_confirmation_sets as confirmation
      where confirmation.organization_id = requested.organization_id
        and confirmation.source_entity_id = requested.pull_entity_id
        and confirmation.public_change_sequence <= requested.causal_sequence
      order by confirmation.semantic_effective_at desc,
               confirmation.public_change_sequence desc,
               confirmation.id::text collate "C" desc
      limit 1
    ) as latest_confirmation on true
    join lateral (
      select pack_relationship.id,
             pack_relationship.organization_id,
             pack_relationship.target_entity_id,
             pack_relationship.target_external_id
      from public.canonical_relationships as pack_relationship
      where pack_relationship.organization_id = requested.organization_id
        and pack_relationship.source_entity_id = requested.pull_entity_id
        and pack_relationship.relationship_kind = 'pack'
        and pack_relationship.target_platform_key = requested.platform_key
        and pack_relationship.target_record_kind = 'pack'
        and pack_relationship.target_entity_id is not null
        and pack_relationship.created_public_change_sequence <=
          requested.causal_sequence
        and pack_relationship.resolved_public_change_sequence <=
          requested.causal_sequence
      -- Keep the lookup correlated to one already-anchored card source. Without
      -- this boundary, fresh PostgreSQL statistics can reorder the two fanout
      -- relationship scans into a quadratic nested loop before the 1,001-row
      -- safety limit is reached.
      offset 0
    ) as pack_relationship on true
    join public.canonical_entities as pack
      on pack.id = pack_relationship.target_entity_id
     and pack.organization_id = pack_relationship.organization_id
     and pack.platform_key = requested.platform_key
     and pack.record_kind = 'pack'
     and pack.external_id = pack_relationship.target_external_id
    left join public.source_relationship_confirmations as confirmed_card
      on confirmed_card.organization_id = requested.organization_id
     and confirmed_card.confirmation_set_id = latest_confirmation.id
     and confirmed_card.canonical_relationship_id =
       requested.card_relationship_id
    left join public.source_relationship_confirmations as confirmed_pack
      on confirmed_pack.organization_id = requested.organization_id
     and confirmed_pack.confirmation_set_id = latest_confirmation.id
     and confirmed_pack.canonical_relationship_id = pack_relationship.id
      where exists (
        select 1 from public.canonical_revisions as pack_revision
        where pack_revision.organization_id = pack.organization_id
          and pack_revision.entity_id = pack.id
          and pack_revision.public_change_sequence <= requested.causal_sequence
      )
        and (
          latest_confirmation.id is null
          or (
            confirmed_card.canonical_relationship_id is not null
            and confirmed_pack.canonical_relationship_id is not null
          )
        )
    )
    select request_key as "requestKey", pack_external_id as "packExternalId"
    from associations
    order by request_key collate "C", pack_external_id collate "C"
    limit ${NORMALIZED_HEAT_MAXIMUM_WRITE_CANDIDATES + 1}
  `);
  const result = new Map(assets.map(({ revision }) => [revision.revisionId, [] as string[]]));
  for (const row of rows) result.get(row.requestKey)?.push(row.packExternalId);
  return result;
}

export async function loadAssetPackAssociationsForPullSources(
  database: PackscoutQueryClient,
  organizationId: string,
  sources: readonly CanonicalHeatSourceEvidence[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const relationshipSources = sources.filter(
    ({ sourceRelationshipId }) => sourceRelationshipId !== null,
  );
  if (relationshipSources.length === 0) return new Map();
  const requests = relationshipSources.map((source) => Prisma.sql`(
    ${sourceRequestKey(source)}, ${uuid(source.sourceRelationshipId!)},
    ${uuid(source.sourceConfirmationSetId!)},
    ${uuid(source.revision.entityId)},
    ${source.revision.platformKey}, ${source.causalSequence}
  )`);
  const rows = await database.$queryRaw<AssetPackAssociationRow[]>(Prisma.sql`
    with requested(
      request_key, relationship_id, confirmation_set_id, pull_entity_id,
      platform_key, causal_sequence
    )
      as (values ${Prisma.join(requests)}),
    selected_requested as (
      select requested.*
      from requested
      join public.canonical_relationships as source_relationship
        on source_relationship.id = requested.relationship_id
       and source_relationship.organization_id = ${uuid(organizationId)}
       and source_relationship.source_entity_id = requested.pull_entity_id
       and source_relationship.resolved_public_change_sequence is not null
       and source_relationship.resolved_public_change_sequence <=
         requested.causal_sequence
      join lateral (
        select item.confirmation_set_id
        from public.source_relationship_confirmations as item
        join public.source_relationship_confirmation_sets as confirmation
          on confirmation.id = item.confirmation_set_id
         and confirmation.organization_id = item.organization_id
        where item.organization_id = source_relationship.organization_id
          and item.canonical_relationship_id = source_relationship.id
          and item.confirmation_set_id = requested.confirmation_set_id
        order by confirmation.public_change_sequence asc,
                 confirmation.id asc
        limit 1
      ) as first_confirmation on true
      where not exists (
        select 1
        from public.source_relationship_confirmations as other_item
        join public.canonical_relationships as other_relationship
          on other_relationship.id = other_item.canonical_relationship_id
         and other_relationship.organization_id = other_item.organization_id
        where other_item.organization_id = source_relationship.organization_id
          and other_item.confirmation_set_id =
            first_confirmation.confirmation_set_id
          and other_relationship.resolved_public_change_sequence is not null
          and other_relationship.resolved_public_change_sequence <=
            requested.causal_sequence
          and (
            other_relationship.resolved_public_change_sequence >
              source_relationship.resolved_public_change_sequence
            or (
              other_relationship.resolved_public_change_sequence =
                source_relationship.resolved_public_change_sequence
              and other_relationship.relationship_kind = 'card'
              and source_relationship.relationship_kind <> 'card'
            )
          )
      )
    ),
    associations as (
      select distinct requested.request_key,
             pack.external_id as pack_external_id
      from selected_requested as requested
    join public.canonical_relationships as card_relationship
      on card_relationship.organization_id = ${uuid(organizationId)}
     and card_relationship.source_entity_id = requested.pull_entity_id
     and card_relationship.relationship_kind = 'card'
     and card_relationship.target_platform_key = requested.platform_key
     and card_relationship.target_record_kind = 'catalog_asset'
     and card_relationship.target_entity_id is not null
     and card_relationship.created_public_change_sequence <= requested.causal_sequence
     and card_relationship.resolved_public_change_sequence <= requested.causal_sequence
    join public.source_relationship_confirmations as confirmed_card
      on confirmed_card.organization_id = card_relationship.organization_id
     and confirmed_card.confirmation_set_id = requested.confirmation_set_id
     and confirmed_card.canonical_relationship_id = card_relationship.id
    join public.canonical_entities as asset
      on asset.id = card_relationship.target_entity_id
     and asset.organization_id = card_relationship.organization_id
     and asset.platform_key = requested.platform_key
     and asset.record_kind = 'catalog_asset'
     and asset.external_id = card_relationship.target_external_id
    join public.canonical_relationships as pack_relationship
      on pack_relationship.organization_id = card_relationship.organization_id
     and pack_relationship.source_entity_id = requested.pull_entity_id
     and pack_relationship.relationship_kind = 'pack'
     and pack_relationship.target_platform_key = requested.platform_key
     and pack_relationship.target_record_kind = 'pack'
     and pack_relationship.target_entity_id is not null
     and pack_relationship.created_public_change_sequence <= requested.causal_sequence
     and pack_relationship.resolved_public_change_sequence <= requested.causal_sequence
    join public.source_relationship_confirmations as confirmed_pack
      on confirmed_pack.organization_id = pack_relationship.organization_id
     and confirmed_pack.confirmation_set_id = requested.confirmation_set_id
     and confirmed_pack.canonical_relationship_id = pack_relationship.id
    join public.canonical_entities as pack
      on pack.id = pack_relationship.target_entity_id
     and pack.organization_id = pack_relationship.organization_id
     and pack.platform_key = requested.platform_key
     and pack.record_kind = 'pack'
     and pack.external_id = pack_relationship.target_external_id
      where exists (
        select 1 from public.canonical_revisions as asset_revision
        where asset_revision.organization_id = asset.organization_id
          and asset_revision.entity_id = asset.id
          and asset_revision.public_change_sequence <= requested.causal_sequence
      ) and exists (
        select 1 from public.canonical_revisions as pack_revision
        where pack_revision.organization_id = pack.organization_id
          and pack_revision.entity_id = pack.id
          and pack_revision.public_change_sequence <= requested.causal_sequence
      )
    )
    select request_key as "requestKey", pack_external_id as "packExternalId"
    from associations
    order by request_key collate "C", pack_external_id collate "C"
    limit ${NORMALIZED_HEAT_MAXIMUM_WRITE_CANDIDATES + 1}
  `);
  const result = new Map(
    relationshipSources.map((source) => [sourceRequestKey(source), [] as string[]]),
  );
  for (const row of rows) result.get(row.requestKey)?.push(row.packExternalId);
  return result;
}
