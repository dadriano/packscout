import { Prisma } from "@prisma/client";
import type { PackscoutQueryClient } from "./database.ts";
import { providerV1ConfirmedRelationshipCtes } from
  "./source-relationship-confirmation-repository.ts";

/**
 * One settled, source-native V1 card-to-pack association. The relationship is
 * derived from the latest complete confirmation set for one pull; no legacy
 * field copied onto a catalog asset participates in this read.
 */
export interface ProviderV1AssetPackAssociationSnapshot {
  readonly sourceEntityId: string;
  readonly platformKey: string;
  readonly assetExternalId: string;
  readonly packExternalId: string;
  readonly associatedAt: Date;
  readonly publicChangeSequence: bigint;
}

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

/**
 * Loads the first durable proof for every asset/pack pair visible through one
 * settled public sequence and read clock. A later replay can replace a pull's
 * declaration set, so only its latest confirmation visible at the requested
 * clock is eligible. The time fence is independent of the sequence fence:
 * native confirmation sets can reuse an already-visible relationship cause.
 */
export function loadProviderV1AssetPackAssociations(
  database: PackscoutQueryClient,
  input: Readonly<{
    organizationId: string;
    platformKey: string;
    sourceRevisionId: string;
    throughSequence: bigint;
    throughOccurredAt: Date;
  }>,
): Promise<ProviderV1AssetPackAssociationSnapshot[]> {
  if (!Number.isFinite(input.throughOccurredAt.getTime())) {
    throw new TypeError("Provider V1 association read clock is invalid.");
  }
  return database.$queryRaw<ProviderV1AssetPackAssociationSnapshot[]>(Prisma.sql`
    with ${providerV1ConfirmedRelationshipCtes({
      organizationId: input.organizationId,
      sourceRevisionId: input.sourceRevisionId,
      throughSequence: input.throughSequence,
      materialization: "not_materialized",
    })},
    latest_v1_pull_sets as (
      select distinct on (source_entity_id)
             confirmation_set_id,
             source_entity_id
      from confirmed_provider_v1_pull_relationship_sets
      where confirmed_at <= ${input.throughOccurredAt}
      order by source_entity_id,
               semantic_effective_at desc,
               confirmation_public_change_sequence desc,
               confirmation_set_id desc
    ),
    latest_v1_pull_relationships as (
      select relationship.*
      from confirmed_provider_v1_pull_relationships as relationship
      join latest_v1_pull_sets as latest
        on latest.confirmation_set_id = relationship.confirmation_set_id
       and latest.source_entity_id = relationship.source_entity_id
      where relationship.effective_at <= ${input.throughOccurredAt}
    ),
    latest_v1_pull_pairs as (
      select relationship.confirmation_set_id,
             relationship.organization_id,
             relationship.source_entity_id,
             (array_agg(relationship.target_entity_id)
               filter (where relationship.relationship_kind = 'card'))[1]
               as card_target_entity_id,
             max(relationship.target_external_id)
               filter (where relationship.relationship_kind = 'card')
               as card_target_external_id,
             max(relationship.resolved_public_change_sequence)
               filter (where relationship.relationship_kind = 'card')
               as card_resolved_public_change_sequence,
             max(relationship.effective_public_change_sequence)
               filter (where relationship.relationship_kind = 'card')
               as card_effective_public_change_sequence,
             max(relationship.effective_at)
               filter (where relationship.relationship_kind = 'card')
               as card_effective_at,
             (array_agg(relationship.target_entity_id)
               filter (where relationship.relationship_kind = 'pack'))[1]
               as pack_target_entity_id,
             max(relationship.target_external_id)
               filter (where relationship.relationship_kind = 'pack')
               as pack_target_external_id,
             max(relationship.resolved_public_change_sequence)
               filter (where relationship.relationship_kind = 'pack')
               as pack_resolved_public_change_sequence,
             max(relationship.effective_public_change_sequence)
               filter (where relationship.relationship_kind = 'pack')
               as pack_effective_public_change_sequence,
             max(relationship.effective_at)
               filter (where relationship.relationship_kind = 'pack')
               as pack_effective_at
      from latest_v1_pull_relationships as relationship
      where relationship.target_platform_key = ${input.platformKey}
        and relationship.target_entity_id is not null
        and relationship.effective_public_change_sequence is not null
        and (
          relationship.relationship_kind = 'card'
            and relationship.target_record_kind = 'catalog_asset'
          or relationship.relationship_kind = 'pack'
            and relationship.target_record_kind = 'pack'
        )
      group by relationship.confirmation_set_id,
               relationship.organization_id,
               relationship.source_entity_id
      having count(*) filter (
               where relationship.relationship_kind = 'card'
             ) = 1
         and count(*) filter (
               where relationship.relationship_kind = 'pack'
             ) = 1
    ),
    complete_v1_pairs as (
      select source.id::text as "sourceEntityId",
             source.platform_key as "platformKey",
             card_target.external_id as "assetExternalId",
             pack_target.external_id as "packExternalId",
             greatest(pair.card_effective_at, pair.pack_effective_at)
               as "associatedAt",
             greatest(
               pair.card_effective_public_change_sequence,
               pair.pack_effective_public_change_sequence
             ) as "publicChangeSequence"
      from public.canonical_entities as source
      join latest_v1_pull_pairs as pair
        on pair.organization_id = source.organization_id
       and pair.source_entity_id = source.id
      join public.canonical_entities as card_target
        on card_target.organization_id = pair.organization_id
       and card_target.id = pair.card_target_entity_id
       and card_target.platform_key = source.platform_key
       and card_target.record_kind = 'catalog_asset'
       and card_target.external_id = pair.card_target_external_id
      join public.canonical_entities as pack_target
        on pack_target.organization_id = pair.organization_id
       and pack_target.id = pair.pack_target_entity_id
       and pack_target.platform_key = source.platform_key
       and pack_target.record_kind = 'pack'
       and pack_target.external_id = pair.pack_target_external_id
      where source.organization_id = ${uuid(input.organizationId)}
        and source.platform_key = ${input.platformKey}
        and source.record_kind = 'pull'
        and exists (
          select 1
          from public.canonical_revisions as revision
          join public.public_change_catalog_impacts as impact
            on impact.organization_id = revision.organization_id
           and impact.cause_sequence = revision.public_change_sequence
          where revision.organization_id = card_target.organization_id
            and revision.entity_id = card_target.id
            and revision.public_change_sequence <=
              pair.card_resolved_public_change_sequence
            and ${input.platformKey} = any(impact.provider_platform_keys)
        )
        and exists (
          select 1
          from public.canonical_revisions as revision
          join public.public_change_catalog_impacts as impact
            on impact.organization_id = revision.organization_id
           and impact.cause_sequence = revision.public_change_sequence
          where revision.organization_id = pack_target.organization_id
            and revision.entity_id = pack_target.id
            and revision.public_change_sequence <=
              pair.pack_resolved_public_change_sequence
            and ${input.platformKey} = any(impact.provider_platform_keys)
        )
        and exists (
          select 1
          from public.public_change_catalog_impacts as impact
          where impact.organization_id = pair.organization_id
            and impact.cause_sequence =
              pair.card_effective_public_change_sequence
            and ${input.platformKey} = any(impact.provider_platform_keys)
        )
        and exists (
          select 1
          from public.public_change_catalog_impacts as impact
          where impact.organization_id = pair.organization_id
            and impact.cause_sequence =
              pair.pack_effective_public_change_sequence
            and ${input.platformKey} = any(impact.provider_platform_keys)
        )
    )
    select distinct on (
             "assetExternalId" collate "C", "packExternalId" collate "C"
           ) *
    from complete_v1_pairs
    order by "assetExternalId" collate "C", "packExternalId" collate "C",
             "publicChangeSequence", "sourceEntityId" collate "C"
  `);
}
