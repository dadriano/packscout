import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_BYTES_TOTAL,
  REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_KEYS_PER_SNAPSHOT,
  REPACK_HEAT_MAXIMUM_CATALOG_SEQUENCE,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import type { PackscoutQueryClient, PackscoutTransactionClient } from
  "./database.ts";
import {
  loadAssetPackAssociationsForPullSources,
  loadAssetPackAssociationsForRevisionSources,
} from "./normalized-heat-association-queries.ts";
import {
  boundedRoundedRatio,
  finiteDecimalRatio,
} from "./normalized-heat-arithmetic.ts";
import {
  canonicalAvailabilities,
  compareCodeUnits,
  compareNormalizedHeatCatalogOrder,
  mappingKey,
  maximumAvailableChaseCount,
  normalizedHeatRetainedUntilSql,
  NormalizedHeatRelationshipBackfillIncompleteError,
  normalizedHeatSourceRequestKey as sourceRequestKey,
  requireCanonicalDate,
  requireUuid,
  stablePublicEvidenceKey,
  uuid,
  type CanonicalHeatSourceEvidence,
  type CanonicalHeatSourceRevision,
  type NormalizedHeatOutcomeReason,
  type ResolvedRelationshipSourceRow,
} from "./normalized-heat-observation-repository.ts";
import type { NormalizedHeatRelationshipBackfillPhase } from
  "./normalized-heat-relationship-backfill-repository.ts";
import {
  assertNormalizedHeatExpandedWriteBound,
  NORMALIZED_HEAT_MAXIMUM_WRITE_CANDIDATES,
} from "./normalized-heat-write-bound.ts";
import type {
  PublicRepackIdentityMappingRow as MappingRow,
} from "./public-repack-identity-mapping-repository.ts";

interface PreparedCandidate {
  source: CanonicalHeatSourceEvidence;
  kind: "pull" | "catalog_snapshot";
  packExternalId: string;
  occurredAt: Date;
}

interface PreparedObservation {
  source: CanonicalHeatSourceEvidence;
  occurredAt: Date;
  packExternalId: string;
  observationKey: string;
  mapping: MappingRow;
  kind: "pull" | "catalog_snapshot";
  catalogSequence: number | null;
  catalogOrderSequence: number | null;
  realizedReturnBasisPoints: number | null;
  valueMultipleBasisPoints: number | null;
  availableChaseCount: number | null;
  outcomeKeys: readonly string[];
}

interface PreparedOutcome {
  source: CanonicalHeatSourceEvidence;
  occurredAt: Date;
  candidateKind: "pull" | "catalog_snapshot" | "unscoped";
  candidateKey: string;
  packExternalId: string | null;
  mapping: MappingRow | null;
  status: "normalized" | "deferred" | "rejected" | "duplicate";
  reasonCode: NormalizedHeatOutcomeReason;
  observationId: string | null;
}

interface PackEvidenceRow {
  candidateKey: string;
  content: unknown | null;
}

interface CatalogAssetRow {
  candidateKey: string;
  platformKey: string;
  packExternalId: string;
  externalId: string;
  content: unknown;
}

interface PullPackRelationshipRow {
  requestKey: string;
  packExternalId: string | null;
  createdPublicChangeSequence: bigint;
  resolvedPublicChangeSequence: bigint | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertTransactionClient(
  database: PackscoutTransactionClient,
): void {
  if ("$transaction" in (database as unknown as Record<string, unknown>)) {
    throw new TypeError(
      "Normalized Heat writes require the caller's active database transaction.",
    );
  }
}

function candidateKey(candidate: PreparedCandidate): string {
  return normalizationOutcomeKey(
    candidate.source,
    candidate.packExternalId,
    candidate.kind,
  );
}

function normalizationOutcomeKey(
  source: CanonicalHeatSourceEvidence,
  packExternalId: string | null,
  candidateKind: PreparedOutcome["candidateKind"],
): string {
  return stablePublicEvidenceKey("normalization:outcome", [
    source.sourceRelationshipId === null ? "revision" : "relationship",
    source.sourceRelationshipId === null
      ? source.revision.revisionId
      : [source.sourceConfirmationSetId, source.sourceRelationshipId].join(":"),
    String(source.causalSequence),
    candidateKind,
    packExternalId ?? "unscoped",
  ]);
}

function preparedOutcome(input: {
  source: CanonicalHeatSourceEvidence;
  occurredAt?: Date;
  candidateKind?: PreparedOutcome["candidateKind"];
  packExternalId: string | null;
  status: PreparedOutcome["status"];
  reasonCode: NormalizedHeatOutcomeReason;
  observationId?: string | null;
  mapping?: MappingRow | null;
}): PreparedOutcome {
  return {
    source: input.source,
    occurredAt: input.occurredAt ?? input.source.revision.occurredAt,
    candidateKind: input.candidateKind ?? "unscoped",
    candidateKey: normalizationOutcomeKey(
      input.source,
      input.packExternalId,
      input.candidateKind ?? "unscoped",
    ),
    packExternalId: input.packExternalId,
    mapping: input.mapping ?? null,
    status: input.status,
    reasonCode: input.reasonCode,
    observationId: input.observationId ?? null,
  };
}

function optionalMoney(value: unknown): Readonly<{
  amountMinor: number;
  currency: string;
}> | null | "malformed" {
  if (value === null) return null;
  if (!isObject(value)) return "malformed";
  const amountMinor = value.amountMinor;
  const currency = value.currency;
  if (
    !Number.isSafeInteger(amountMinor)
    || (amountMinor as number) < 0
    || typeof currency !== "string"
    || !/^[A-Z]{3}$/.test(currency)
  ) {
    return "malformed";
  }
  return { amountMinor: amountMinor as number, currency };
}

function textArray(values: readonly string[]): Prisma.Sql {
  if (values.length === 0) return Prisma.sql`array[]::text[]`;
  return Prisma.sql`array[${Prisma.join(values)}]::text[]`;
}

function validPackExternalId(value: unknown): string | null {
  return typeof value === "string"
      && value === value.trim()
      && value.length >= 1
      && value.length <= 512
    ? value
    : null;
}

function revisionSource(
  revision: CanonicalHeatSourceRevision,
): CanonicalHeatSourceEvidence {
  return {
    revision,
    sourceRelationshipId: null,
    sourceConfirmationSetId: null,
    sourceConfirmationSequence: null,
    causalSequence: revision.publicChangeSequence,
    causeOccurredAt: revision.occurredAt,
  };
}

function candidate(
  source: CanonicalHeatSourceEvidence,
  kind: PreparedCandidate["kind"],
  packExternalId: string,
  occurredAt: Date,
): PreparedCandidate {
  return { source, kind, packExternalId, occurredAt };
}

function pullContentReason(
  content: Readonly<Record<string, unknown>>,
): NormalizedHeatOutcomeReason | null {
  return content.eventKind !== "pull" || optionalMoney(content.value) === "malformed"
    ? "EVIDENCE_MALFORMED"
    : null;
}

function packContentReason(
  content: Readonly<Record<string, unknown>>,
): NormalizedHeatOutcomeReason | null {
  return content.entityType !== "pack"
      || typeof content.availability !== "string"
      || !canonicalAvailabilities.has(content.availability)
    ? "EVIDENCE_MALFORMED"
    : null;
}

function assetContentReason(
  content: Readonly<Record<string, unknown>>,
): NormalizedHeatOutcomeReason | null {
  return content.entityType !== "catalog_asset"
      || content.relatedPackExternalId !== null
      || typeof content.availability !== "string"
      || !canonicalAvailabilities.has(content.availability)
    ? "EVIDENCE_MALFORMED"
    : null;
}

function catalogContentIsActive(content: unknown): boolean {
  return isObject(content)
    && content.entityType === "catalog_asset"
    && content.relatedPackExternalId === null
    && content.availability === "available";
}

function packContentIsActive(content: unknown): boolean {
  return isObject(content)
    && content.entityType === "pack"
    && content.availability === "available";
}

function pullValues(
  pullContent: Readonly<Record<string, unknown>>,
  packContent: unknown,
): Readonly<{
  realizedReturnBasisPoints: number | null;
  valueMultipleBasisPoints: number | null;
}> {
  const pullValue = optionalMoney(pullContent.value);
  if (pullValue === null || pullValue === "malformed" || !isObject(packContent)) {
    return { realizedReturnBasisPoints: null, valueMultipleBasisPoints: null };
  }
  const priceValueMinor = packContent.priceValueMinor;
  const priceCurrency = packContent.priceCurrency;
  if (
    !Number.isSafeInteger(priceValueMinor)
    || (priceValueMinor as number) <= 0
    || typeof priceCurrency !== "string"
    || priceCurrency !== pullValue.currency
  ) {
    return { realizedReturnBasisPoints: null, valueMultipleBasisPoints: null };
  }
  const valueMultipleBasisPoints = boundedRoundedRatio(
    BigInt(pullValue.amountMinor) * 10_000n,
    BigInt(priceValueMinor as number),
  );
  if (valueMultipleBasisPoints === null) {
    return { realizedReturnBasisPoints: null, valueMultipleBasisPoints: null };
  }
  const buybackPercent = packContent.buybackPercent;
  const buybackRatio = typeof buybackPercent === "number"
      && buybackPercent <= 100
    ? finiteDecimalRatio(buybackPercent)
    : null;
  const realizedReturnBasisPoints = buybackRatio
    ? boundedRoundedRatio(
        BigInt(valueMultipleBasisPoints) * buybackRatio.numerator,
        100n * buybackRatio.denominator,
      )
    : null;
  return { realizedReturnBasisPoints, valueMultipleBasisPoints };
}

async function loadMappings(
  database: PackscoutQueryClient,
  organizationId: string,
  candidates: readonly PreparedCandidate[],
): Promise<ReadonlyMap<string, MappingRow>> {
  const unique = new Map<string, { platformKey: string; packExternalId: string }>();
  for (const candidate of candidates) {
    unique.set(mappingKey(
      candidate.source.revision.platformKey,
      candidate.packExternalId,
    ), {
      platformKey: candidate.source.revision.platformKey,
      packExternalId: candidate.packExternalId,
    });
  }
  if (unique.size === 0) return new Map();
  const values = [...unique.values()].map(({ platformKey, packExternalId }) =>
    Prisma.sql`(${platformKey}, ${packExternalId})`,
  );
  const rows = await database.$queryRaw<MappingRow[]>(Prisma.sql`
    select mapping.platform_key as "platformKey",
           mapping.pack_external_id as "packExternalId",
           mapping.public_repack_id::text as "publicRepackId",
           mapping.approved_configuration_key as "approvedConfigurationKey",
           mapping.public_change_sequence as "publicChangeSequence",
           mapping.approved_at as "approvedAt"
    from public.public_repack_identity_mappings as mapping
    join (values ${Prisma.join(values)}) as requested(platform_key, pack_external_id)
      on requested.platform_key = mapping.platform_key
     and requested.pack_external_id = mapping.pack_external_id
    where mapping.organization_id = ${uuid(organizationId)}
  `);
  return new Map(
    rows.map((mapping) => [
      mappingKey(mapping.platformKey, mapping.packExternalId),
      mapping,
    ]),
  );
}

async function loadResolvedRelationshipSources(
  database: PackscoutTransactionClient,
  organizationId: string,
  confirmations: readonly Readonly<{
    relationshipId: string;
    confirmationSetId?: string;
    canonicalRevisionId: string;
    publicChangeSequence: bigint;
  }>[],
): Promise<readonly ResolvedRelationshipSourceRow[]> {
  if (confirmations.length === 0) return [];
  const requested = confirmations.map(({
    relationshipId,
    confirmationSetId,
    canonicalRevisionId,
    publicChangeSequence,
  }) =>
    Prisma.sql`(
      ${uuid(relationshipId)}, ${confirmationSetId
        ? uuid(confirmationSetId)
        : Prisma.sql`null::uuid`}, ${uuid(canonicalRevisionId)},
      ${publicChangeSequence}
    )`
  );
  const rows = await database.$queryRaw<ResolvedRelationshipSourceRow[]>(Prisma.sql`
    with requested(
      relationship_id, confirmation_set_id, canonical_revision_id,
      public_change_sequence
    ) as (values ${Prisma.join(requested)}),
    selected_confirmations as (
      select distinct on (
               requested.relationship_id,
               requested.confirmation_set_id,
               requested.canonical_revision_id,
               requested.public_change_sequence
             )
             requested.relationship_id as canonical_relationship_id,
             confirmation.id as confirmation_set_id,
             confirmation.source_canonical_revision_id,
             confirmation.public_change_sequence as confirmation_sequence
      from requested
      join public.source_relationship_confirmations as item
        on item.organization_id = ${uuid(organizationId)}
       and item.canonical_relationship_id = requested.relationship_id
      join public.source_relationship_confirmation_sets as confirmation
        on confirmation.id = item.confirmation_set_id
       and confirmation.organization_id = item.organization_id
      where (
          requested.confirmation_set_id is null
          or confirmation.id = requested.confirmation_set_id
        )
      order by requested.relationship_id,
               requested.confirmation_set_id,
               requested.canonical_revision_id,
               requested.public_change_sequence,
               confirmation.public_change_sequence asc,
               confirmation.id::text collate "C" asc
    )
    select relationship.id::text as "relationshipId",
           confirmation.confirmation_set_id::text as "confirmationSetId",
           confirmation.confirmation_sequence
             as "confirmationPublicChangeSequence",
           relationship.relationship_kind as "relationshipKind",
           relationship.target_platform_key as "targetPlatformKey",
           relationship.target_record_kind::text as "targetRecordKind",
           relationship.target_external_id as "targetExternalId",
           requested.public_change_sequence
             as "effectivePublicChangeSequence",
           cause.occurred_at as "causeOccurredAt",
           revision.id::text as "revisionId",
           source.id::text as "entityId",
           source.platform_key as "platformKey",
           source.external_id as "externalId",
           revision.content_json as content,
           revision.public_change_sequence as "revisionPublicChangeSequence",
           revision.source_updated_at as "revisionOccurredAt"
    from public.canonical_relationships as relationship
    join requested
      on requested.relationship_id = relationship.id
    join selected_confirmations as confirmation
      on confirmation.canonical_relationship_id = relationship.id
     and confirmation.confirmation_set_id = coalesce(
       requested.confirmation_set_id,
       confirmation.confirmation_set_id
     )
     and confirmation.source_canonical_revision_id =
       requested.canonical_revision_id
     and requested.public_change_sequence = greatest(
       confirmation.confirmation_sequence,
       relationship.resolved_public_change_sequence
     )
    join public.canonical_entities as source
      on source.id = relationship.source_entity_id
     and source.organization_id = relationship.organization_id
     and source.record_kind = 'pull'
    join public.canonical_entities as target
      on target.id = relationship.target_entity_id
     and target.organization_id = relationship.organization_id
     and target.platform_key = relationship.target_platform_key
     and target.record_kind = relationship.target_record_kind
     and target.external_id = relationship.target_external_id
    join public.public_change_causes as cause
      on cause.organization_id = relationship.organization_id
     and cause.sequence = requested.public_change_sequence
     and cause.change_kind in (
       'relationship_resolution', 'relationship_confirmation'
     )
    join public.public_change_catalog_impacts as impact
      on impact.organization_id = cause.organization_id
     and impact.cause_sequence = cause.sequence
     and source.platform_key = any(impact.provider_platform_keys)
    join public.canonical_revisions as revision
      on revision.id = requested.canonical_revision_id
     and revision.organization_id = relationship.organization_id
     and revision.entity_id = source.id
    where relationship.organization_id = ${uuid(organizationId)}
      and relationship.relationship_kind in ('pack', 'card')
      and relationship.target_record_kind = case relationship.relationship_kind
        when 'pack' then 'pack'::public.canonical_record_kind
        else 'catalog_asset'::public.canonical_record_kind
      end
      and relationship.target_platform_key = source.platform_key
      and relationship.target_external_id is not null
      and relationship.target_entity_id is not null
      and relationship.resolved_public_change_sequence is not null
    order by requested.public_change_sequence,
             confirmation.confirmation_sequence,
             confirmation.confirmation_set_id::text collate "C",
             relationship.id::text collate "C"
  `);
  if (rows.length !== confirmations.length) {
    throw new Error("Canonical Heat relationship source is invalid.");
  }
  return rows;
}

async function loadPullPackRelationshipState(
  database: PackscoutTransactionClient,
  organizationId: string,
  sources: readonly CanonicalHeatSourceEvidence[],
): Promise<ReadonlyMap<string, Readonly<{
  currentCount: number;
  resolvedPackExternalIds: readonly string[];
}>>> {
  const pullSources = sources.filter(({ revision }) => revision.recordKind === "pull");
  if (pullSources.length === 0) return new Map();
  const requests = pullSources.map((source) => Prisma.sql`(
    ${sourceRequestKey(source)}, ${uuid(source.revision.entityId)},
    ${source.revision.platformKey}, ${source.causalSequence}
  )`);
  const rows = await database.$queryRaw<PullPackRelationshipRow[]>(Prisma.sql`
    with requested(request_key, entity_id, platform_key, causal_sequence)
      as (values ${Prisma.join(requests)}),
    ranked as (
      select request.request_key,
             relationship.target_external_id,
             relationship.created_public_change_sequence,
             relationship.resolved_public_change_sequence,
             row_number() over (
               partition by request.request_key
               order by relationship.id::text collate "C"
             ) as relationship_rank
      from requested as request
      join public.canonical_relationships as relationship
        on relationship.organization_id = ${uuid(organizationId)}
       and relationship.source_entity_id = request.entity_id
       and relationship.relationship_kind = 'pack'
       and relationship.target_platform_key = request.platform_key
       and relationship.target_record_kind = 'pack'
       and relationship.target_external_id is not null
       and relationship.created_public_change_sequence <= request.causal_sequence
    )
    select request_key as "requestKey",
           target_external_id as "packExternalId",
           created_public_change_sequence as "createdPublicChangeSequence",
           resolved_public_change_sequence as "resolvedPublicChangeSequence"
    from ranked
    where relationship_rank <= 2
    order by request_key collate "C", relationship_rank
  `);
  const causalSequenceByRequest = new Map(
    pullSources.map((source) => [sourceRequestKey(source), source.causalSequence]),
  );
  const mutable = new Map<string, { currentCount: number; resolved: Set<string> }>();
  for (const source of pullSources) {
    mutable.set(sourceRequestKey(source), { currentCount: 0, resolved: new Set() });
  }
  for (const row of rows) {
    const state = mutable.get(row.requestKey);
    const through = causalSequenceByRequest.get(row.requestKey);
    if (!state || through === undefined) continue;
    if (row.createdPublicChangeSequence > through) continue;
    state.currentCount += 1;
    if (
      row.resolvedPublicChangeSequence !== null
      && row.resolvedPublicChangeSequence <= through
      && validPackExternalId(row.packExternalId) !== null
    ) state.resolved.add(row.packExternalId!);
  }
  return new Map([...mutable].map(([key, state]) => [key, {
    currentCount: state.currentCount,
    resolvedPackExternalIds: [...state.resolved].sort(),
  }]));
}

async function loadSourceNativeV1PullRevisionIds(
  database: PackscoutQueryClient,
  organizationId: string,
  sources: readonly CanonicalHeatSourceEvidence[],
): Promise<ReadonlySet<string>> {
  const revisionIds = sources
    .filter(({ revision, sourceRelationshipId }) =>
      revision.recordKind === "pull" && sourceRelationshipId === null)
    .map(({ revision }) => revision.revisionId);
  if (revisionIds.length === 0) return new Set();
  const rows = await database.$queryRaw<Array<{ revisionId: string }>>(Prisma.sql`
    select revision.id::text as "revisionId"
    from public.canonical_revisions as revision
    join public.source_semantic_observations as semantic
      on semantic.id = revision.origin_semantic_observation_id
     and semantic.organization_id = revision.organization_id
     and semantic.normalized_contract_version =
       ${PROVIDER_OBSERVATION_CONTRACT_VERSION}
    where revision.organization_id = ${uuid(organizationId)}
      and revision.id in (${Prisma.join(revisionIds.map(uuid))})
  `);
  return new Set(rows.map(({ revisionId }) => revisionId));
}

async function loadPackEvidence(
  database: PackscoutQueryClient,
  organizationId: string,
  candidates: readonly PreparedCandidate[],
): Promise<ReadonlyMap<string, unknown | null>> {
  if (candidates.length === 0) return new Map();
  const requests = candidates.map((candidate) => Prisma.sql`(
    ${candidateKey(candidate)}, ${candidate.source.revision.platformKey},
    ${candidate.packExternalId}, ${candidate.source.causalSequence}
  )`);
  const rows = await database.$queryRaw<PackEvidenceRow[]>(Prisma.sql`
    select request.candidate_key as "candidateKey",
           pack_revision.content_json as content
    from (values ${Prisma.join(requests)})
      as request(candidate_key, platform_key, pack_external_id, causal_sequence)
    left join lateral (
      select revision.content_json
      from public.canonical_entities as entity
      join public.canonical_revisions as revision
        on revision.entity_id = entity.id
       and revision.organization_id = entity.organization_id
      where entity.organization_id = ${uuid(organizationId)}
        and entity.platform_key = request.platform_key
        and entity.record_kind = 'pack'
        and entity.external_id = request.pack_external_id
        and revision.public_change_sequence <= request.causal_sequence
      order by revision.public_change_sequence desc, revision.revision_number desc
      limit 1
    ) as pack_revision on true
  `);
  return new Map(rows.map(({ candidateKey: key, content }) => [key, content]));
}

async function loadCatalogAssetsAsOfCauses(
  database: PackscoutQueryClient,
  organizationId: string,
  candidates: readonly PreparedCandidate[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const catalogCandidates = candidates.filter(
    (candidate) => candidate.kind === "catalog_snapshot",
  );
  const result = new Map<string, string[]>();
  for (const candidate of catalogCandidates) {
    result.set(candidateKey(candidate), []);
  }
  for (let offset = 0; offset < catalogCandidates.length; offset += 20) {
    const batch = catalogCandidates.slice(offset, offset + 20);
    const requests = batch.map((candidate) => Prisma.sql`(
      ${candidateKey(candidate)}, ${candidate.source.revision.platformKey},
      ${candidate.packExternalId}, ${candidate.source.causalSequence}
    )`);
    const rows = await database.$queryRaw<CatalogAssetRow[]>(Prisma.sql`
      with requested(candidate_key, platform_key, pack_external_id, causal_sequence)
        as (values ${Prisma.join(requests)}),
      associated_assets as (
        select distinct requested.candidate_key,
               requested.platform_key,
               requested.pack_external_id,
               entity.external_id,
               asset_revision.content_json
        from requested
        join public.canonical_relationships as pack_relationship
          on pack_relationship.organization_id = ${uuid(organizationId)}
         and pack_relationship.relationship_kind = 'pack'
         and pack_relationship.target_platform_key = requested.platform_key
         and pack_relationship.target_record_kind = 'pack'
         and pack_relationship.target_external_id = requested.pack_external_id
         and pack_relationship.target_entity_id is not null
         and pack_relationship.created_public_change_sequence <=
           requested.causal_sequence
         and pack_relationship.resolved_public_change_sequence <=
           requested.causal_sequence
        join public.canonical_entities as pack
          on pack.id = pack_relationship.target_entity_id
         and pack.organization_id = pack_relationship.organization_id
         and pack.platform_key = requested.platform_key
         and pack.record_kind = 'pack'
         and pack.external_id = pack_relationship.target_external_id
        join public.canonical_entities as pull
          on pull.id = pack_relationship.source_entity_id
         and pull.organization_id = pack_relationship.organization_id
         and pull.platform_key = requested.platform_key
         and pull.record_kind = 'pull'
        left join lateral (
          select confirmation.id
          from public.source_relationship_confirmation_sets as confirmation
          where confirmation.organization_id = pull.organization_id
            and confirmation.source_entity_id = pull.id
            and confirmation.public_change_sequence <= requested.causal_sequence
          order by confirmation.semantic_effective_at desc,
                   confirmation.public_change_sequence desc,
                   confirmation.id::text collate "C" desc
          limit 1
        ) as latest_confirmation on true
        join public.canonical_relationships as card_relationship
          on card_relationship.organization_id = pull.organization_id
         and card_relationship.source_entity_id = pull.id
         and card_relationship.relationship_kind = 'card'
         and card_relationship.target_platform_key = requested.platform_key
         and card_relationship.target_record_kind = 'catalog_asset'
         and card_relationship.target_entity_id is not null
         and card_relationship.created_public_change_sequence <=
           requested.causal_sequence
         and card_relationship.resolved_public_change_sequence <=
           requested.causal_sequence
        join public.canonical_entities as entity
          on entity.id = card_relationship.target_entity_id
         and entity.organization_id = card_relationship.organization_id
         and entity.platform_key = requested.platform_key
         and entity.record_kind = 'catalog_asset'
         and entity.external_id = card_relationship.target_external_id
        left join public.source_relationship_confirmations as confirmed_pack
          on confirmed_pack.organization_id = pull.organization_id
         and confirmed_pack.confirmation_set_id = latest_confirmation.id
         and confirmed_pack.canonical_relationship_id = pack_relationship.id
        left join public.source_relationship_confirmations as confirmed_card
          on confirmed_card.organization_id = pull.organization_id
         and confirmed_card.confirmation_set_id = latest_confirmation.id
         and confirmed_card.canonical_relationship_id = card_relationship.id
        join lateral (
          select revision.content_json
          from public.canonical_revisions as revision
          where revision.entity_id = entity.id
            and revision.organization_id = entity.organization_id
            and revision.public_change_sequence <= requested.causal_sequence
          order by revision.public_change_sequence desc, revision.revision_number desc
          limit 1
        ) as asset_revision on true
        where asset_revision.content_json ->> 'entityType' = 'catalog_asset'
          and asset_revision.content_json -> 'relatedPackExternalId' = 'null'::jsonb
          and asset_revision.content_json ->> 'availability' = 'available'
          and (
            latest_confirmation.id is null
            or (
              confirmed_pack.canonical_relationship_id is not null
              and confirmed_card.canonical_relationship_id is not null
            )
          )
      ),
      bounded_assets as (
        select associated_assets.*,
               row_number() over (
                 partition by candidate_key
                 order by external_id collate "C"
               ) as asset_rank
        from associated_assets
      )
      select candidate_key as "candidateKey",
             platform_key as "platformKey",
             pack_external_id as "packExternalId",
             external_id as "externalId",
             content_json as content
      from bounded_assets
      where asset_rank <= ${REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_KEYS_PER_SNAPSHOT + 1}
      order by candidate_key, external_id
    `);
    for (const row of rows) {
      if (!catalogContentIsActive(row.content)) continue;
      result.get(row.candidateKey)?.push(
        stablePublicEvidenceKey("catalog:outcome", [
          row.platformKey,
          "catalog_asset",
          row.externalId,
        ]),
      );
    }
  }
  for (const values of result.values()) values.sort();
  return result;
}

export interface NormalizedHeatPersistenceResult {
  readonly normalized: number;
  readonly deferred: number;
  readonly rejected: number;
  readonly duplicate: number;
}

export interface NormalizedHeatPersistenceInput {
  readonly organizationId: string;
  readonly revisions: readonly CanonicalHeatSourceRevision[];
  readonly confirmedRelationships?: readonly Readonly<{
    relationshipId: string;
    confirmationSetId?: string;
    canonicalRevisionId: string;
    publicChangeSequence: bigint;
  }>[];
  readonly createdAt: Date;
}

type NormalizedHeatPersistenceMode = "forward" | "relationship_backfill";

interface HeatBackfillGuardRow {
  phase: NormalizedHeatRelationshipBackfillPhase;
  targetPublicChangeSequence: bigint;
  processedThroughPublicChangeSequence: bigint;
  confirmationsReady: boolean;
}

/**
 * Persists public-safe Heat evidence inside the canonical writer transaction.
 * Inputs are exact canonical revision or confirmed-relationship causes; the
 * durable candidate key provides a second idempotency boundary for retries.
 */
export async function persistNormalizedHeatObservations(
  database: PackscoutTransactionClient,
  input: NormalizedHeatPersistenceInput,
  mode: NormalizedHeatPersistenceMode,
): Promise<NormalizedHeatPersistenceResult> {
  assertTransactionClient(database);
  const organizationId = requireUuid(input.organizationId, "organizationId");
  requireCanonicalDate(input.createdAt, "createdAt");
  const confirmedRelationships = input.confirmedRelationships ?? [];
  const backfills = await database.$queryRaw<HeatBackfillGuardRow[]>(Prisma.sql`
    select phase,
           target_public_change_sequence as "targetPublicChangeSequence",
           processed_through_public_change_sequence
             as "processedThroughPublicChangeSequence",
           not exists (
             select 1
             from public.provider_source_revisions as source_revision
             left join public.source_relationship_confirmation_backfills
               as confirmation_backfill
               on confirmation_backfill.organization_id =
                    source_revision.organization_id
              and confirmation_backfill.source_revision_id =
                    source_revision.id
             where source_revision.organization_id =
               normalized_heat_relationship_backfills.organization_id
               and (
                 confirmation_backfill.source_revision_id is null
                 or confirmation_backfill.provider_id <>
                   source_revision.provider_id
                 or confirmation_backfill.source_instance_id <>
                   source_revision.source_instance_id
                 or
                 confirmation_backfill.phase <> 'complete'
                 or confirmation_backfill.failure_code is not null
                 or confirmation_backfill.confirmed_semantic_set_count <>
                   confirmation_backfill.target_semantic_set_count
               )
           ) as "confirmationsReady"
    from public.normalized_heat_relationship_backfills
    where organization_id = ${uuid(organizationId)}
    for share
  `);
  const backfill = backfills[0];
  if (!backfill) {
    throw new Error("Normalized Heat relationship backfill state is missing.");
  }
  if (
    mode === "forward"
    && (backfill.phase !== "complete" || !backfill.confirmationsReady)
  ) {
    throw new NormalizedHeatRelationshipBackfillIncompleteError();
  }
  if (
    mode === "relationship_backfill"
    && (
      backfill.phase !== "relationships"
      || !backfill.confirmationsReady
      || input.revisions.length !== 0
      || confirmedRelationships.some(({ publicChangeSequence }) =>
        publicChangeSequence < backfill.processedThroughPublicChangeSequence
        || publicChangeSequence > backfill.targetPublicChangeSequence)
    )
  ) {
    throw new Error("Normalized Heat relationship backfill source is invalid.");
  }
  if (
    input.revisions.length + confirmedRelationships.length
    > NORMALIZED_HEAT_MAXIMUM_WRITE_CANDIDATES
  ) {
    throw new RangeError("Heat normalization write exceeds its transaction bound.");
  }
  for (const revision of input.revisions) {
    requireUuid(revision.revisionId, "revisionId");
    requireUuid(revision.entityId, "entityId");
    requireCanonicalDate(revision.occurredAt, "occurredAt");
    if (revision.publicChangeSequence < 1n) {
      throw new RangeError("Canonical Heat source sequence is invalid.");
    }
  }
  const seenRelationshipSources = new Set<string>();
  for (const confirmation of confirmedRelationships) {
    const relationshipId = requireUuid(
      confirmation.relationshipId,
      "relationshipId",
    );
    const confirmationSetId = confirmation.confirmationSetId === undefined
      ? null
      : requireUuid(confirmation.confirmationSetId, "confirmationSetId");
    const canonicalRevisionId = requireUuid(
      confirmation.canonicalRevisionId,
      "canonicalRevisionId",
    );
    if (confirmation.publicChangeSequence < 1n) {
      throw new RangeError("Canonical Heat relationship sequence is invalid.");
    }
    const sourceKey = [
      confirmationSetId ?? "first",
      relationshipId,
      canonicalRevisionId,
      String(confirmation.publicChangeSequence),
    ].join(":");
    if (seenRelationshipSources.has(sourceKey)) {
      throw new RangeError("Canonical Heat relationship source is duplicated.");
    }
    seenRelationshipSources.add(sourceKey);
  }

  const revisionSources = input.revisions.map(revisionSource);
  const relationshipRows = await loadResolvedRelationshipSources(
    database,
    organizationId,
    confirmedRelationships,
  );
  const relationshipRowBySourceKey = new Map(
    relationshipRows.map((row) => [
      [row.confirmationSetId, row.relationshipId].join(":"),
      row,
    ]),
  );
  const relationshipSources: CanonicalHeatSourceEvidence[] = relationshipRows.map(
    (row) => {
      if (!isObject(row.content)) {
        throw new Error("Canonical Heat pull source content is invalid.");
      }
      requireCanonicalDate(row.causeOccurredAt, "relationshipCauseOccurredAt");
      requireCanonicalDate(row.revisionOccurredAt, "relationshipRevisionOccurredAt");
      return {
        revision: {
          revisionId: row.revisionId,
          entityId: row.entityId,
          platformKey: row.platformKey,
          recordKind: "pull",
          externalId: row.externalId,
          content: row.content,
          publicChangeSequence: row.revisionPublicChangeSequence,
          occurredAt: row.revisionOccurredAt,
        },
        sourceRelationshipId: row.relationshipId,
        sourceConfirmationSetId: row.confirmationSetId,
        sourceConfirmationSequence: row.confirmationPublicChangeSequence,
        causalSequence: row.effectivePublicChangeSequence,
        causeOccurredAt: row.causeOccurredAt,
      };
    },
  );
  const allSources = [...revisionSources, ...relationshipSources];
  const sourceNativeV1PullRevisionIds =
    await loadSourceNativeV1PullRevisionIds(
      database,
      organizationId,
      revisionSources,
    );
  const pullPackState = await loadPullPackRelationshipState(
    database,
    organizationId,
    allSources.filter(({ revision, sourceRelationshipId }) =>
      sourceRelationshipId !== null
      || revision.recordKind !== "pull"
      || !sourceNativeV1PullRevisionIds.has(revision.revisionId)),
  );
  const assetRevisionAssociations = await loadAssetPackAssociationsForRevisionSources(
    database,
    organizationId,
    revisionSources,
  );
  const pullSourceAssociations = await loadAssetPackAssociationsForPullSources(
    database,
    organizationId,
    relationshipSources,
  );

  let outcomes: PreparedOutcome[] = [];
  let candidates: PreparedCandidate[] = [];
  for (const source of revisionSources) {
    const { revision } = source;
    if (revision.recordKind === "pull") {
      if (sourceNativeV1PullRevisionIds.has(revision.revisionId)) continue;
      const state = pullPackState.get(sourceRequestKey(source)) ?? {
        currentCount: 0,
        resolvedPackExternalIds: [],
      };
      const packExternalId = state.resolvedPackExternalIds[0] ?? null;
      if (state.currentCount > 1 || state.resolvedPackExternalIds.length > 1) {
        outcomes.push(preparedOutcome({
          source,
          candidateKind: "pull",
          packExternalId,
          status: "rejected",
          reasonCode: "EVIDENCE_MALFORMED",
        }));
        continue;
      }
      if (packExternalId === null) {
        continue;
      }
      const reason = pullContentReason(revision.content);
      if (reason) {
        outcomes.push(preparedOutcome({
          source,
          candidateKind: "pull",
          packExternalId,
          status: "rejected",
          reasonCode: reason,
        }));
      } else {
        candidates.push(candidate(
          source,
          "pull",
          packExternalId,
          revision.occurredAt,
        ));
      }
      continue;
    }
    if (revision.recordKind === "pack") {
      const packExternalId = validPackExternalId(revision.externalId);
      const reason = packContentReason(revision.content);
      if (packExternalId === null || reason) {
        outcomes.push(preparedOutcome({
          source,
          candidateKind: "catalog_snapshot",
          packExternalId,
          status: "rejected",
          reasonCode: reason ?? "EVIDENCE_MALFORMED",
        }));
      } else {
        candidates.push(candidate(
          source,
          "catalog_snapshot",
          packExternalId,
          revision.occurredAt,
        ));
      }
      continue;
    }
    if (revision.recordKind === "catalog_asset") {
      const associatedPacks = assetRevisionAssociations.get(revision.revisionId) ?? [];
      if (associatedPacks.length === 0) continue;
      const reason = assetContentReason(revision.content);
      for (const packExternalId of associatedPacks) {
        if (reason) {
          outcomes.push(preparedOutcome({
            source,
            candidateKind: "catalog_snapshot",
            packExternalId,
            status: "rejected",
            reasonCode: reason,
          }));
        } else {
          candidates.push(candidate(
            source,
            "catalog_snapshot",
            packExternalId,
            revision.occurredAt,
          ));
        }
      }
    }
  }
  for (const source of relationshipSources) {
    const relationship = relationshipRowBySourceKey.get(
      sourceRequestKey(source),
    );
    if (!relationship) {
      throw new Error("Canonical Heat relationship source is missing.");
    }
    if (relationship.relationshipKind === "pack") {
      const packExternalId = validPackExternalId(relationship.targetExternalId);
      const reason = pullContentReason(source.revision.content);
      if (packExternalId === null || reason) {
        outcomes.push(preparedOutcome({
          source,
          candidateKind: "pull",
          packExternalId,
          status: "rejected",
          reasonCode: reason ?? "EVIDENCE_MALFORMED",
        }));
      } else {
        candidates.push(candidate(
          source,
          "pull",
          packExternalId,
          source.revision.occurredAt,
        ));
      }
    }
    for (const packExternalId of
      pullSourceAssociations.get(sourceRequestKey(source)) ?? []) {
      candidates.push(candidate(
        source,
        "catalog_snapshot",
        packExternalId,
        source.causeOccurredAt,
      ));
    }
  }
  candidates = [...new Map(
    candidates.map((value) => [candidateKey(value), value]),
  ).values()];
  outcomes = [...new Map(
    outcomes.map((outcome) => [outcome.candidateKey, outcome]),
  ).values()];
  assertNormalizedHeatExpandedWriteBound(candidates, outcomes);
  if (candidates.length === 0 && outcomes.length === 0) {
    return { normalized: 0, deferred: 0, rejected: 0, duplicate: 0 };
  }

  const candidateKeys = [...new Set([
    ...candidates.map(candidateKey),
    ...outcomes.map(({ candidateKey: key }) => key),
  ])];
  const existingOutcomeKeys = new Set<string>();
  if (candidateKeys.length > 0) {
    const existing = await database.$queryRaw<Array<{ candidateKey: string }>>(
      Prisma.sql`
        select candidate_key as "candidateKey"
        from public.normalized_heat_observation_outcomes
        where organization_id = ${uuid(organizationId)}
          and candidate_key in (${Prisma.join(candidateKeys)})
      `,
    );
    for (const row of existing) existingOutcomeKeys.add(row.candidateKey);
  }
  const preexistingDuplicateCount = existingOutcomeKeys.size;
  candidates = candidates.filter(
    (value) => !existingOutcomeKeys.has(candidateKey(value)),
  );
  outcomes = outcomes.filter(
    ({ candidateKey: key }) => !existingOutcomeKeys.has(key),
  );
  if (candidates.length === 0 && outcomes.length === 0) {
    return {
      normalized: 0,
      deferred: 0,
      rejected: 0,
      duplicate: preexistingDuplicateCount,
    };
  }

  await database.$executeRaw(Prisma.sql`
    insert into public.normalized_heat_window_checkpoints (organization_id, updated_at)
    values (${uuid(organizationId)}, ${input.createdAt})
    on conflict (organization_id) do nothing
  `);
  const checkpoints = await database.$queryRaw<Array<{
    closedBefore: Date | null;
    nextCatalogSequence: bigint;
  }>>(
    Prisma.sql`
      select case
               when closed_before = '-infinity'::timestamp with time zone then null
               else closed_before
             end as "closedBefore",
             next_catalog_sequence as "nextCatalogSequence"
      from public.normalized_heat_window_checkpoints
      where organization_id = ${uuid(organizationId)}
      for update
    `,
  );

  const closedBefore = checkpoints[0]?.closedBefore ?? null;
  const openCandidates: PreparedCandidate[] = [];
  for (const value of candidates) {
    if (closedBefore && value.occurredAt < closedBefore) {
      outcomes.push(preparedOutcome({
        source: value.source,
        occurredAt: value.occurredAt,
        candidateKind: value.kind,
        packExternalId: value.packExternalId,
        status: "rejected",
        reasonCode: "WINDOW_CLOSED",
      }));
    } else {
      openCandidates.push(value);
    }
  }

  const mappingCandidates = [
    ...openCandidates,
    ...outcomes.flatMap((outcome): PreparedCandidate[] =>
      outcome.packExternalId && outcome.candidateKind !== "unscoped"
        ? [candidate(
            outcome.source,
            outcome.candidateKind,
            outcome.packExternalId,
            outcome.occurredAt,
          )]
        : []),
  ];
  const mappings = await loadMappings(database, organizationId, mappingCandidates);
  outcomes = outcomes.map((outcome) => {
    if (!outcome.packExternalId) return outcome;
    const mapping = mappings.get(mappingKey(
      outcome.source.revision.platformKey,
      outcome.packExternalId,
    ));
    return {
      ...outcome,
      mapping: mapping && mapping.publicChangeSequence <= outcome.source.causalSequence
        ? mapping
        : null,
    };
  });
  const mappedCandidates: Array<PreparedCandidate & { mapping: MappingRow }> = [];
  for (const value of openCandidates) {
    const mapping = mappings.get(mappingKey(
      value.source.revision.platformKey,
      value.packExternalId,
    ));
    if (!mapping || mapping.publicChangeSequence > value.source.causalSequence) {
      outcomes.push(preparedOutcome({
        source: value.source,
        occurredAt: value.occurredAt,
        candidateKind: value.kind,
        packExternalId: value.packExternalId,
        status: "deferred",
        reasonCode: "MAPPING_MISSING",
      }));
    } else {
      mappedCandidates.push({ ...value, mapping });
    }
  }

  const packEvidence = await loadPackEvidence(
    database,
    organizationId,
    mappedCandidates,
  );
  const catalogAssets = await loadCatalogAssetsAsOfCauses(
    database,
    organizationId,
    mappedCandidates,
  );
  let observations: PreparedObservation[] = [];
  for (const candidate of mappedCandidates) {
    if (candidate.kind === "pull") {
      const values = pullValues(
        candidate.source.revision.content,
        packEvidence.get(candidateKey(candidate)) ?? null,
      );
      observations.push({
        source: candidate.source,
        occurredAt: candidate.occurredAt,
        packExternalId: candidate.packExternalId,
        observationKey: stablePublicEvidenceKey("observation:pull", [
          organizationId,
          candidate.source.revision.platformKey,
          candidate.source.revision.recordKind,
          candidate.source.revision.externalId,
        ]),
        mapping: candidate.mapping,
        kind: "pull",
        catalogSequence: null,
        catalogOrderSequence: null,
        ...values,
        availableChaseCount: null,
        outcomeKeys: [],
      });
      continue;
    }
    const packContent = packEvidence.get(candidateKey(candidate)) ?? null;
    if (packContent === null) {
      outcomes.push(preparedOutcome({
        source: candidate.source,
        occurredAt: candidate.occurredAt,
        candidateKind: candidate.kind,
        packExternalId: candidate.packExternalId,
        mapping: candidate.mapping,
        status: "rejected",
        reasonCode: "EVIDENCE_UNSUPPORTED",
      }));
      continue;
    }
    if (
      !isObject(packContent)
      || packContent.entityType !== "pack"
      || typeof packContent.availability !== "string"
      || !canonicalAvailabilities.has(packContent.availability)
    ) {
      outcomes.push(preparedOutcome({
        source: candidate.source,
        occurredAt: candidate.occurredAt,
        candidateKind: candidate.kind,
        packExternalId: candidate.packExternalId,
        mapping: candidate.mapping,
        status: "rejected",
        reasonCode: "EVIDENCE_MALFORMED",
      }));
      continue;
    }
    const outcomeKeys = packContentIsActive(packContent)
      ? catalogAssets.get(candidateKey(candidate)) ?? []
      : [];
    const outcomeBytes = outcomeKeys.reduce(
      (total, value) => total + Buffer.byteLength(value, "utf8"),
      0,
    );
    if (
      outcomeKeys.length > REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_KEYS_PER_SNAPSHOT
      || outcomeKeys.length > maximumAvailableChaseCount
      || outcomeBytes > REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_BYTES_TOTAL
    ) {
      outcomes.push(preparedOutcome({
        source: candidate.source,
        occurredAt: candidate.occurredAt,
        candidateKind: candidate.kind,
        packExternalId: candidate.packExternalId,
        mapping: candidate.mapping,
        status: "rejected",
        reasonCode: "CATALOG_LIMIT_EXCEEDED",
      }));
      continue;
    }
    observations.push({
      source: candidate.source,
      occurredAt: candidate.occurredAt,
      packExternalId: candidate.packExternalId,
      observationKey: stablePublicEvidenceKey("observation:catalog", [
        organizationId,
        candidate.source.revision.platformKey,
        candidate.source.sourceRelationshipId === null
          ? "revision"
          : "relationship",
        ...(candidate.source.sourceRelationshipId === null
          ? []
          : [candidate.source.sourceConfirmationSetId!]),
        candidate.source.sourceRelationshipId
          ?? candidate.source.revision.revisionId,
        String(candidate.source.causalSequence),
        candidate.packExternalId,
        candidate.mapping.publicRepackId,
      ]),
      mapping: candidate.mapping,
      kind: "catalog_snapshot",
      catalogSequence: null,
      catalogOrderSequence: null,
      realizedReturnBasisPoints: null,
      valueMultipleBasisPoints: null,
      availableChaseCount: outcomeKeys.length,
      outcomeKeys,
    });
  }

  observations.sort((left, right) => {
    if (left.source.causalSequence < right.source.causalSequence) return -1;
    if (left.source.causalSequence > right.source.causalSequence) return 1;
    const leftConfirmation = left.source.sourceConfirmationSequence;
    const rightConfirmation = right.source.sourceConfirmationSequence;
    if (leftConfirmation !== null && rightConfirmation !== null) {
      if (leftConfirmation < rightConfirmation) return -1;
      if (leftConfirmation > rightConfirmation) return 1;
    } else if (leftConfirmation === null && rightConfirmation !== null) {
      return -1;
    } else if (leftConfirmation !== null && rightConfirmation === null) {
      return 1;
    }
    return compareCodeUnits(left.observationKey, right.observationKey);
  });
  const uniqueObservations: PreparedObservation[] = [];
  const preparedObservationKeys = new Set<string>();
  for (const observation of observations) {
    if (preparedObservationKeys.has(observation.observationKey)) {
      outcomes.push(preparedOutcome({
        source: observation.source,
        occurredAt: observation.occurredAt,
        candidateKind: observation.kind,
        packExternalId: observation.packExternalId,
        mapping: observation.mapping,
        status: "duplicate",
        reasonCode: "DUPLICATE_SOURCE_EVENT",
      }));
    } else {
      preparedObservationKeys.add(observation.observationKey);
      uniqueObservations.push(observation);
    }
  }
  observations = uniqueObservations;
  const catalogObservations = observations.filter(
    (observation) => observation.kind === "catalog_snapshot",
  );
  catalogObservations.sort(compareNormalizedHeatCatalogOrder);
  const nextCatalogSequence = checkpoints[0]?.nextCatalogSequence ?? 1n;
  const lastCatalogSequence = nextCatalogSequence
    + BigInt(catalogObservations.length) - 1n;
  if (
    catalogObservations.length > 0
    && lastCatalogSequence > BigInt(REPACK_HEAT_MAXIMUM_CATALOG_SEQUENCE)
  ) {
    const rejectedKeys = new Set(
      catalogObservations.map(({ observationKey }) => observationKey),
    );
    for (const observation of catalogObservations) {
      outcomes.push(preparedOutcome({
        source: observation.source,
        occurredAt: observation.occurredAt,
        candidateKind: observation.kind,
        packExternalId: observation.packExternalId,
        mapping: observation.mapping,
        status: "rejected",
        reasonCode: "CATALOG_LIMIT_EXCEEDED",
      }));
    }
    observations = observations.filter(
      ({ observationKey }) => !rejectedKeys.has(observationKey),
    );
  } else if (catalogObservations.length > 0) {
    catalogObservations.forEach((observation, index) => {
      const sequence = Number(nextCatalogSequence + BigInt(index));
      observation.catalogSequence = sequence;
      observation.catalogOrderSequence = mode === "forward" ? sequence : null;
    });
    await database.$executeRaw(Prisma.sql`
      update public.normalized_heat_window_checkpoints
      set next_catalog_sequence = next_catalog_sequence + ${catalogObservations.length},
          updated_at = ${input.createdAt}
      where organization_id = ${uuid(organizationId)}
    `);
  }
  const insertedByKey = new Map<string, string>();
  if (observations.length > 0) {
    const values = observations.map((observation) => Prisma.sql`(
      ${uuid(organizationId)}, ${observation.observationKey},
      ${uuid(observation.source.revision.revisionId)},
      ${observation.source.sourceRelationshipId
        ? uuid(observation.source.sourceRelationshipId)
        : Prisma.sql`null::uuid`},
      ${observation.source.causalSequence},
      ${observation.mapping.publicChangeSequence},
      ${uuid(observation.mapping.publicRepackId)}, ${observation.kind},
      ${observation.occurredAt}, ${observation.catalogSequence},
      ${observation.catalogOrderSequence},
      ${observation.realizedReturnBasisPoints},
      ${observation.valueMultipleBasisPoints},
      ${observation.availableChaseCount}, ${textArray(observation.outcomeKeys)},
      ${normalizedHeatRetainedUntilSql(observation.occurredAt)},
      ${input.createdAt}
    )`);
    const inserted = await database.$queryRaw<
      Array<{ observationId: string; observationKey: string }>
    >(Prisma.sql`
      insert into public.normalized_heat_observations (
        organization_id, observation_key, canonical_revision_id,
        source_relationship_id, public_change_sequence,
        mapping_public_change_sequence,
        public_repack_id, observation_kind, occurred_at,
        catalog_sequence, catalog_order_sequence, realized_return_basis_points,
        value_multiple_basis_points, available_chase_count, outcome_keys,
        retained_until, created_at
      ) values ${Prisma.join(values)}
      on conflict (organization_id, observation_key) do nothing
      returning id::text as "observationId", observation_key as "observationKey"
    `);
    for (const row of inserted) insertedByKey.set(row.observationKey, row.observationId);
  }
  outcomes = [...new Map(
    outcomes.map((outcome) => [outcome.candidateKey, outcome]),
  ).values()];
  const preparedOutcomeKeys = new Set(outcomes.map(({ candidateKey: key }) => key));
  for (const observation of observations) {
    const observationId = insertedByKey.get(observation.observationKey) ?? null;
    const outcome = preparedOutcome({
      source: observation.source,
      occurredAt: observation.occurredAt,
      candidateKind: observation.kind,
      packExternalId: observation.packExternalId,
      mapping: observation.mapping,
      status: observationId ? "normalized" : "duplicate",
      reasonCode: observationId ? "NORMALIZED" : "DUPLICATE_SOURCE_EVENT",
      observationId,
    });
    if (!preparedOutcomeKeys.has(outcome.candidateKey)) {
      outcomes.push(outcome);
      preparedOutcomeKeys.add(outcome.candidateKey);
    }
  }

  if (outcomes.length > 0) {
    const values = outcomes.map((outcome) => Prisma.sql`(
      ${uuid(organizationId)}, ${outcome.candidateKey},
      ${uuid(outcome.source.revision.revisionId)},
      ${outcome.source.sourceRelationshipId
        ? uuid(outcome.source.sourceRelationshipId)
        : Prisma.sql`null::uuid`},
      ${outcome.source.causalSequence}, ${outcome.occurredAt},
      ${outcome.mapping?.publicChangeSequence ?? Prisma.sql`null::bigint`},
      ${outcome.mapping ? uuid(outcome.mapping.publicRepackId) : Prisma.sql`null::uuid`},
      ${outcome.status}, ${outcome.reasonCode},
      ${outcome.observationId ? uuid(outcome.observationId) : Prisma.sql`null::uuid`},
      ${normalizedHeatRetainedUntilSql(outcome.occurredAt)},
      ${input.createdAt}
    )`);
    await database.$executeRaw(Prisma.sql`
      insert into public.normalized_heat_observation_outcomes (
        organization_id, candidate_key, canonical_revision_id,
        source_relationship_id, public_change_sequence, occurred_at,
        mapping_public_change_sequence,
        public_repack_id, status, reason_code, observation_id,
        retained_until, created_at
      ) values ${Prisma.join(values)}
      on conflict (organization_id, candidate_key) do nothing
    `);
  }

  return outcomes.reduce<NormalizedHeatPersistenceResult>(
    (counts, outcome) => ({ ...counts, [outcome.status]: counts[outcome.status] + 1 }),
    {
      normalized: 0,
      deferred: 0,
      rejected: 0,
      duplicate: preexistingDuplicateCount,
    },
  );
}

/** Public canonical-writer entry point. Pending repair state always fails closed. */
export function persistNormalizedHeatObservationsForCanonicalWrites(
  database: PackscoutTransactionClient,
  input: NormalizedHeatPersistenceInput,
): Promise<NormalizedHeatPersistenceResult> {
  return persistNormalizedHeatObservations(database, input, "forward");
}
