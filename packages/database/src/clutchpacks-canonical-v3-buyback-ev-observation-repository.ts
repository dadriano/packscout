import { Prisma } from "@prisma/client";
import type { PackscoutPrismaClient } from "./database.ts";
import { DataReleaseV3CanonicalSourceError } from "./data-release-v3-canonical-catalog-adapter.ts";

/**
 * Read-only source-native evidence projection for the ClutchPacks canonical V3
 * catalog. Protected payloads and legacy provider configuration rows are
 * deliberately outside this boundary.
 */

export interface ClutchpacksCanonicalV3SourcePinsV1 {
  readonly providerSourceRevisionId: string;
  readonly sourceInstanceId: string;
  readonly sourceTypeKey: string;
  readonly sourceAdapterVersion: string;
  readonly normalizedContractVersion: string;
  readonly mapperKey: string;
  readonly mapperVersion: string;
  readonly identityNamespaceKey: string;
  readonly cursorCodecVersion: string;
  readonly configurationHash: string;
}

export interface ClutchpacksCanonicalV3ObservationV1 {
  readonly semanticObservationId: string;
  readonly originSemanticObservationId: string;
  readonly sourceRecordId: string;
  readonly providerRecordId: string;
  readonly normalizedContentHash: string;
  readonly hashVersion: string;
  readonly normalizedContent: unknown;
  readonly effectiveSourceTime: string;
  readonly deliveryOccurrenceId: string;
  readonly collectedAt: string;
  readonly pins: ClutchpacksCanonicalV3SourcePinsV1;
}

export interface ClutchpacksCanonicalV3ProductObservationV1 {
  readonly productKey: string;
  readonly productRevisionId: string;
  readonly canonicalContentHash: string;
  readonly canonicalProvenanceHash: string;
  readonly canonicalPublicChangeSequence: string;
  readonly evInputStatus: "ready" | "unavailable";
  readonly evInputRevision: Readonly<{
    readonly revisionId: string;
    readonly canonicalContentHash: string;
    readonly canonicalProvenanceHash: string;
    readonly canonicalPublicChangeSequence: string;
  }> | null;
  /** Null is a governed pack without coherent source-native evidence. */
  readonly observation: ClutchpacksCanonicalV3ObservationV1 | null;
}

export interface ClutchpacksCanonicalV3ObservationSnapshotV1 {
  readonly organizationId: string;
  readonly platformKey: "clutchpacks";
  readonly providerId: string | null;
  readonly readAt: string;
  readonly throughSequence: string;
  readonly products: readonly ClutchpacksCanonicalV3ProductObservationV1[];
}

interface ObservationRow {
  readonly productKey: string;
  readonly productRevisionId: string;
  readonly canonicalContentHash: string;
  readonly canonicalProvenanceHash: string;
  readonly canonicalPublicChangeSequence: bigint;
  readonly evInputStatus: "ready" | "unavailable";
  readonly evInputRevisionId: string | null;
  readonly evInputCanonicalContentHash: string | null;
  readonly evInputCanonicalProvenanceHash: string | null;
  readonly evInputCanonicalPublicChangeSequence: bigint | null;
  readonly providerId: string | null;
  readonly originSemanticObservationId: string | null;
  readonly semanticObservationId: string | null;
  readonly sourceRecordId: string | null;
  readonly providerRecordId: string | null;
  readonly normalizedContentHash: string | null;
  readonly hashVersion: string | null;
  readonly normalizedContent: unknown | null;
  readonly effectiveSourceTime: Date | null;
  readonly deliveryOccurrenceId: bigint | null;
  readonly collectedAt: Date | null;
  readonly providerSourceRevisionId: string | null;
  readonly sourceInstanceId: string | null;
  readonly sourceTypeKey: string | null;
  readonly sourceAdapterVersion: string | null;
  readonly normalizedContractVersion: string | null;
  readonly mapperKey: string | null;
  readonly mapperVersion: string | null;
  readonly identityNamespaceKey: string | null;
  readonly cursorCodecVersion: string | null;
  readonly configurationHash: string | null;
}

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

function parseReadAt(readAt: string): Date {
  const parsed = new Date(readAt);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== readAt) {
    throw new DataReleaseV3CanonicalSourceError("CANONICAL_READ_AT_INVALID");
  }
  return parsed;
}

async function resolveReadClock(
  database: PackscoutPrismaClient,
  organizationId: string,
  readAtInput: string,
): Promise<Readonly<{ readAt: Date; throughSequence: bigint }>> {
  const readAt = parseReadAt(readAtInput);
  const watermarks = await database.$queryRaw<
    Array<{ settledSequence: bigint; settledAt: Date | null }>
  >(Prisma.sql`
    select settled_sequence as "settledSequence",
           settled_at as "settledAt"
    from public.settled_public_watermarks
    where organization_id = ${uuid(organizationId)}
  `);
  const watermark = watermarks[0];
  if (
    watermark === undefined ||
    watermark.settledAt === null ||
    watermark.settledSequence <= 0n ||
    readAt.getTime() > watermark.settledAt.getTime()
  ) {
    throw new DataReleaseV3CanonicalSourceError("CANONICAL_STATE_UNSETTLED");
  }
  const throughRows = await database.$queryRaw<
    Array<{ throughSequence: bigint | null }>
  >(Prisma.sql`
    select max(sequence) as "throughSequence"
    from public.public_change_causes
    where organization_id = ${uuid(organizationId)}
      and occurred_at <= ${readAt}
      and sequence <= ${watermark.settledSequence}
  `);
  return {
    readAt,
    throughSequence: throughRows[0]?.throughSequence ?? 0n,
  };
}

function completeObservation(
  row: ObservationRow,
): ClutchpacksCanonicalV3ObservationV1 | null {
  if (
    row.originSemanticObservationId === null ||
    row.semanticObservationId === null ||
    row.sourceRecordId === null ||
    row.providerRecordId === null ||
    row.normalizedContentHash === null ||
    row.hashVersion === null ||
    row.normalizedContent === null ||
    row.effectiveSourceTime === null ||
    row.deliveryOccurrenceId === null ||
    row.collectedAt === null ||
    row.providerSourceRevisionId === null ||
    row.sourceInstanceId === null ||
    row.sourceTypeKey === null ||
    row.sourceAdapterVersion === null ||
    row.normalizedContractVersion === null ||
    row.mapperKey === null ||
    row.mapperVersion === null ||
    row.identityNamespaceKey === null ||
    row.cursorCodecVersion === null ||
    row.configurationHash === null
  ) {
    return null;
  }
  return {
    semanticObservationId: row.semanticObservationId,
    originSemanticObservationId: row.originSemanticObservationId,
    sourceRecordId: row.sourceRecordId,
    providerRecordId: row.providerRecordId,
    normalizedContentHash: row.normalizedContentHash,
    hashVersion: row.hashVersion,
    normalizedContent: row.normalizedContent,
    effectiveSourceTime: row.effectiveSourceTime.toISOString(),
    deliveryOccurrenceId: row.deliveryOccurrenceId.toString(),
    collectedAt: row.collectedAt.toISOString(),
    pins: {
      providerSourceRevisionId: row.providerSourceRevisionId,
      sourceInstanceId: row.sourceInstanceId,
      sourceTypeKey: row.sourceTypeKey,
      sourceAdapterVersion: row.sourceAdapterVersion,
      normalizedContractVersion: row.normalizedContractVersion,
      mapperKey: row.mapperKey,
      mapperVersion: row.mapperVersion,
      identityNamespaceKey: row.identityNamespaceKey,
      cursorCodecVersion: row.cursorCodecVersion,
      configurationHash: row.configurationHash,
    },
  };
}

export class PrismaClutchpacksCanonicalV3BuybackEvObservationRepository {
  constructor(
    private readonly database: PackscoutPrismaClient,
    private readonly organizationId: string,
  ) {}

  async loadSnapshot(input: {
    readonly readAt: string;
  }): Promise<ClutchpacksCanonicalV3ObservationSnapshotV1> {
    const clock = await resolveReadClock(
      this.database,
      this.organizationId,
      input.readAt,
    );
    const rows = await this.database.$queryRaw<ObservationRow[]>(Prisma.sql`
      with governed_packs as (
        select distinct on (entity.id)
               entity.external_id as "productKey",
               revision.id::text as "productRevisionId",
               revision.content_hash as "canonicalContentHash",
               revision.provenance_hash as "canonicalProvenanceHash",
               revision.public_change_sequence as "canonicalPublicChangeSequence",
               revision.content_json ->> 'evInputStatus' as "evInputStatus",
               revision.origin_semantic_observation_id as
                 "packOriginSemanticObservationId"
        from public.canonical_entities as entity
        join public.canonical_revisions as revision
          on revision.entity_id = entity.id
         and revision.organization_id = entity.organization_id
        where entity.organization_id = ${uuid(this.organizationId)}
          and entity.platform_key = 'clutchpacks'
          and entity.record_kind = 'pack'
          and revision.public_change_sequence <= ${clock.throughSequence}
        order by entity.id,
                 revision.public_change_sequence desc,
                 revision.revision_number desc
      ),
      governed_ev_inputs as (
        select distinct on (entity.id)
               entity.external_id as "productKey",
               revision.id::text as "evInputRevisionId",
               revision.content_hash as "evInputCanonicalContentHash",
               revision.provenance_hash as "evInputCanonicalProvenanceHash",
               revision.public_change_sequence as "evInputCanonicalPublicChangeSequence"
        from public.canonical_entities as entity
        join public.canonical_revisions as revision
          on revision.entity_id = entity.id
         and revision.organization_id = entity.organization_id
        where entity.organization_id = ${uuid(this.organizationId)}
          and entity.platform_key = 'clutchpacks'
          and entity.record_kind = 'ev_input'
          and revision.public_change_sequence <= ${clock.throughSequence}
        order by entity.id,
                 revision.public_change_sequence desc,
                 revision.revision_number desc
      )
      select governed."productKey",
             governed."productRevisionId",
             governed."canonicalContentHash",
             governed."canonicalProvenanceHash",
             governed."canonicalPublicChangeSequence",
             governed."evInputStatus",
             ev_input."evInputRevisionId",
             ev_input."evInputCanonicalContentHash",
             ev_input."evInputCanonicalProvenanceHash",
             ev_input."evInputCanonicalPublicChangeSequence",
             provider.id::text as "providerId",
             governed."packOriginSemanticObservationId"::text as
               "originSemanticObservationId",
             evidence."semanticObservationId",
             evidence."sourceRecordId",
             evidence."providerRecordId",
             evidence."normalizedContentHash",
             evidence."hashVersion",
             evidence."normalizedContent",
             evidence."effectiveSourceTime",
             evidence."deliveryOccurrenceId",
             evidence."collectedAt",
             evidence."providerSourceRevisionId",
             evidence."sourceInstanceId",
             evidence."sourceTypeKey",
             evidence."sourceAdapterVersion",
             evidence."normalizedContractVersion",
             evidence."mapperKey",
             evidence."mapperVersion",
             evidence."identityNamespaceKey",
             evidence."cursorCodecVersion",
             evidence."configurationHash"
      from governed_packs as governed
      left join governed_ev_inputs as ev_input
        on ev_input."productKey" = governed."productKey"
       and governed."evInputStatus" = 'ready'
      left join public.provider_sources as provider
        on provider.organization_id = ${uuid(this.organizationId)}
       and provider.platform_key = 'clutchpacks'
      left join public.source_semantic_observations as origin
        on origin.id = governed."packOriginSemanticObservationId"
       and origin.organization_id = ${uuid(this.organizationId)}
      left join public.source_record_identities as identity
        on identity.id = origin.source_record_id
       and identity.organization_id = origin.organization_id
      left join lateral (
        select semantic.id::text as "semanticObservationId",
               semantic.source_record_id::text as "sourceRecordId",
               identity.provider_record_id as "providerRecordId",
               semantic.normalized_content_hash as "normalizedContentHash",
               semantic.hash_version as "hashVersion",
               semantic.normalized_content_json as "normalizedContent",
               semantic.effective_source_time as "effectiveSourceTime",
               occurrence.id as "deliveryOccurrenceId",
               occurrence.collected_at as "collectedAt",
               source_revision.id::text as "providerSourceRevisionId",
               source_revision.source_instance_id::text as "sourceInstanceId",
               source_revision.source_type_key as "sourceTypeKey",
               source_revision.source_adapter_version as "sourceAdapterVersion",
               source_revision.normalized_contract_version as "normalizedContractVersion",
               source_revision.mapper_key as "mapperKey",
               source_revision.mapper_version as "mapperVersion",
               source_revision.identity_namespace_key as "identityNamespaceKey",
               source_revision.cursor_codec_version as "cursorCodecVersion",
               source_revision.configuration_hash as "configurationHash"
        from public.source_semantic_observations as semantic
        join public.source_delivery_occurrences as occurrence
          on occurrence.semantic_observation_id = semantic.id
         and occurrence.organization_id = semantic.organization_id
         and occurrence.source_record_id = semantic.source_record_id
         and occurrence.normalized_contract_version =
           semantic.normalized_contract_version
        join public.import_pages as occurrence_page
          on occurrence_page.id = occurrence.page_id
         and occurrence_page.organization_id = occurrence.organization_id
         and occurrence_page.provider_id = occurrence.provider_id
         and occurrence_page.run_id = occurrence.run_id
         and occurrence_page.source_instance_id = occurrence.source_instance_id
         and occurrence_page.source_revision_id = occurrence.source_revision_id
         and occurrence_page.request_attempt_id = occurrence.request_attempt_id
         and occurrence_page.source_type_key = occurrence.source_type_key
         and occurrence_page.source_adapter_version =
           occurrence.source_adapter_version
         and occurrence_page.normalized_contract_version =
           occurrence.normalized_contract_version
         and occurrence_page.mapper_key = occurrence.mapper_key
         and occurrence_page.mapper_version = occurrence.mapper_version
         and occurrence_page.identity_namespace_key =
           occurrence.identity_namespace_key
         and occurrence_page.connection_profile_id =
           occurrence.connection_profile_id
         and occurrence_page.connection_revision_id =
           occurrence.connection_revision_id
         and occurrence_page.supervisor_epoch_id = occurrence.supervisor_epoch_id
         and occurrence_page.cursor_codec_version =
           occurrence.cursor_codec_version
         and occurrence_page.cursor_generation = occurrence.cursor_generation
         and occurrence_page.connection_health_generation =
           occurrence.connection_health_generation
         and occurrence_page.committed_at <= ${clock.readAt}
        join public.provider_source_revisions as source_revision
          on source_revision.id = occurrence.source_revision_id
         and source_revision.organization_id = occurrence.organization_id
         and source_revision.provider_id = occurrence.provider_id
         and source_revision.source_instance_id = occurrence.source_instance_id
         and source_revision.source_type_key = occurrence.source_type_key
         and source_revision.source_adapter_version =
           occurrence.source_adapter_version
         and source_revision.normalized_contract_version =
           occurrence.normalized_contract_version
         and source_revision.mapper_key = occurrence.mapper_key
         and source_revision.mapper_version = occurrence.mapper_version
         and source_revision.identity_namespace_key =
           occurrence.identity_namespace_key
         and source_revision.cursor_codec_version =
           occurrence.cursor_codec_version
        join public.provider_source_instances as source_instance
          on source_instance.id = source_revision.source_instance_id
         and source_instance.organization_id = source_revision.organization_id
         and source_instance.provider_id = source_revision.provider_id
        where semantic.organization_id = ${uuid(this.organizationId)}
          and origin.id is not null
          and semantic.source_record_id = origin.source_record_id
          and semantic.normalized_contract_version =
            origin.normalized_contract_version
          and semantic.hash_version = origin.hash_version
          and occurrence.provider_id = provider.id
          and occurrence.collected_at <= ${clock.readAt}
          and occurrence.created_at <= ${clock.readAt}
          and occurrence.disposition in ('inserted', 'revised', 'duplicate')
        order by semantic.effective_source_time desc,
                 occurrence.collected_at desc,
                 occurrence.id desc,
                 semantic.id desc
        limit 1
      ) as evidence on true
      order by governed."productKey" collate "C"
    `);
    const providerIds = new Set(
      rows.flatMap(({ providerId }) => providerId === null ? [] : [providerId]),
    );
    return {
      organizationId: this.organizationId,
      platformKey: "clutchpacks",
      providerId: providerIds.size === 1 ? [...providerIds][0]! : null,
      readAt: clock.readAt.toISOString(),
      throughSequence: clock.throughSequence.toString(),
      products: rows.map((row) => ({
        productKey: row.productKey,
        productRevisionId: row.productRevisionId,
        canonicalContentHash: row.canonicalContentHash,
        canonicalProvenanceHash: row.canonicalProvenanceHash,
        canonicalPublicChangeSequence:
          row.canonicalPublicChangeSequence.toString(),
        evInputStatus: row.evInputStatus,
        evInputRevision:
          row.evInputRevisionId === null ||
            row.evInputCanonicalContentHash === null ||
            row.evInputCanonicalProvenanceHash === null ||
            row.evInputCanonicalPublicChangeSequence === null
            ? null
            : {
                revisionId: row.evInputRevisionId,
                canonicalContentHash: row.evInputCanonicalContentHash,
                canonicalProvenanceHash: row.evInputCanonicalProvenanceHash,
                canonicalPublicChangeSequence:
                  row.evInputCanonicalPublicChangeSequence.toString(),
              },
        observation: completeObservation(row),
      })),
    };
  }
}
