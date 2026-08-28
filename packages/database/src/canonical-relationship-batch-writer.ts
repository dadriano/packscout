import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { PackscoutTransactionClient } from "./database.ts";
import { persistNormalizedHeatObservationsForCanonicalWrites } from
  "./normalized-heat-persistence.ts";
import {
  NORMALIZED_HEAT_MAXIMUM_WRITE_CANDIDATES,
  assertNormalizedHeatExpandedWriteBound,
} from "./normalized-heat-write-bound.ts";
import type { CanonicalProjectionInput } from "./pipeline-types.ts";
import {
  allocatePublicChangeCauses,
  canonicalCatalogPlatformKeys,
  relationshipPublicEntityKey,
  type PublicCatalogImpact,
} from "./public-change-settlement-repository.ts";
import {
  isProviderV1PullRelationshipIdentity,
  loadConfirmedRelationshipSourcesForResolutions,
  persistSourceRelationshipConfirmationSetsForCanonicalWrites,
  sourceRelationshipConfirmationCauseMetadata,
  sourceRelationshipDeclarationHash,
  type ConfirmedSourceRelationship,
  type SourceRelationshipConfirmationWriteResult,
  type SourceRelationshipConfirmationWriteSet,
} from "./source-relationship-confirmation-repository.ts";

const maximumRowsPerWrite = 500;

type RelationshipProjectionOrigin =
  | Readonly<{
      kind: "legacy_source_record";
      configurationRevisionId: string;
      sourceRecordId: string;
    }>
  | Readonly<{
      kind: "semantic_observation";
      sourceRevisionId: string;
      semanticObservationId: string;
    }>
  | Readonly<{
      kind: "ev_recomputation";
      sourceRevisionId: string;
      recomputationRequestId: string;
    }>;

export interface CanonicalRelationshipProjection {
  readonly organizationId: string;
  readonly origin: RelationshipProjectionOrigin;
  readonly projection: CanonicalProjectionInput;
  readonly entityId: string;
  readonly contentHash: string;
}

export interface CanonicalRelationshipEntityRecord {
  readonly id: string;
  readonly platformKey: string;
  readonly recordKind: CanonicalProjectionInput["recordKind"];
  readonly externalId: string;
  readonly publicChangeSequence: bigint | null;
}

interface RelationshipInsert {
  readonly id: string;
  readonly organizationId: string;
  readonly sourceEntityId: string;
  readonly sourcePlatformKey: string;
  readonly sourceRecordKind: CanonicalProjectionInput["recordKind"];
  readonly relationshipKind: string;
  readonly targetPlatformKey: string;
  readonly targetRecordKind: CanonicalProjectionInput["recordKind"];
  readonly targetExternalId: string | null;
  readonly targetEntityId: string | null;
  createdPublicChangeSequence: bigint;
  resolvedPublicChangeSequence: bigint | null;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
  nativeConfirmationMetadata?: Readonly<Record<string, string | number>>;
}

function batches<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += maximumRowsPerWrite) {
    result.push(values.slice(index, index + maximumRowsPerWrite));
  }
  return result;
}

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

function canonicalIdentityKey(input: {
  platformKey: string;
  recordKind: CanonicalProjectionInput["recordKind"];
  externalId: string;
}): string {
  return [input.platformKey, input.recordKind, input.externalId].join("\u0000");
}

function relationshipIdentityKey(input: {
  sourceEntityId: string;
  relationshipKind: string;
  targetPlatformKey: string;
  targetRecordKind: CanonicalProjectionInput["recordKind"];
  targetExternalId: string | null;
}): string {
  return [
    input.sourceEntityId,
    input.relationshipKind,
    input.targetPlatformKey,
    input.targetRecordKind,
    input.targetExternalId ?? "<null>",
  ].join("\u0000");
}

function relationshipCatalogImpact(
  sourcePlatformKey: string,
  targetPlatformKey: string,
): PublicCatalogImpact {
  return {
    kind: "catalog",
    providerPlatformKeys: canonicalCatalogPlatformKeys([
      sourcePlatformKey,
      targetPlatformKey,
    ]),
  };
}

async function loadRelationshipTargets(
  database: PackscoutTransactionClient,
  organizationId: string,
  identities: readonly Readonly<{
    platformKey: string;
    recordKind: CanonicalProjectionInput["recordKind"];
    externalId: string;
  }>[],
  existing: ReadonlyMap<string, CanonicalRelationshipEntityRecord>,
): Promise<Map<string, CanonicalRelationshipEntityRecord>> {
  const targets = new Map(existing);
  const missingByIdentity = new Map<string, typeof identities[number]>();
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
    const records = await database.$queryRaw<
      CanonicalRelationshipEntityRecord[]
    >(Prisma.sql`
      select
        entity.id,
        entity.platform_key as "platformKey",
        entity.record_kind::text as "recordKind",
        entity.external_id as "externalId",
        revision.public_change_sequence as "publicChangeSequence"
      from public.canonical_entities as entity
      join public.canonical_revisions as revision
        on revision.id = entity.current_revision_id
      where entity.organization_id = ${uuid(organizationId)}
        and (entity.platform_key, entity.record_kind, entity.external_id) in (
          values ${Prisma.join(rows)}
        )
    `);
    for (const record of records) {
      targets.set(canonicalIdentityKey(record), record);
    }
  }
  return targets;
}

export async function persistConfirmedRelationshipHeatSources(
  database: PackscoutTransactionClient,
  input: {
    organizationId: string;
    createdAt: Date;
    relationships: readonly ConfirmedSourceRelationship[];
  },
): Promise<void> {
  const eligible = input.relationships.filter(
    (relationship) => relationship.effectivePublicChangeSequence !== null,
  );
  assertNormalizedHeatExpandedWriteBound(eligible, []);
  if (eligible.length === 0) return;
  await persistNormalizedHeatObservationsForCanonicalWrites(database, {
    organizationId: input.organizationId,
    revisions: [],
    confirmedRelationships: eligible.map((relationship) => ({
      relationshipId: relationship.canonicalRelationshipId,
      confirmationSetId: relationship.confirmationSetId,
      canonicalRevisionId: relationship.sourceCanonicalRevisionId,
      publicChangeSequence: relationship.effectivePublicChangeSequence!,
    })),
    createdAt: input.createdAt,
  });
}

export async function persistCanonicalRelationshipConfirmations(
  database: PackscoutTransactionClient,
  input: {
    organizationId: string;
    providerId: string;
    sourceRevisionKey: string;
    acceptedAt: Date;
    projections: readonly CanonicalRelationshipProjection[];
    revisionResults: readonly Readonly<{ revisionId: string }>[];
    entitiesByIdentity: ReadonlyMap<
      string,
      CanonicalRelationshipEntityRecord
    >;
  },
): Promise<SourceRelationshipConfirmationWriteResult> {
  const relationshipTargets = input.projections.flatMap(({ projection }) =>
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
    input.organizationId,
    relationshipTargets,
    input.entitiesByIdentity,
  );
  const proposedRelationships = input.projections.flatMap((projection) => {
    const sourceEntity = input.entitiesByIdentity.get(
      canonicalIdentityKey(projection.projection),
    );
    if (!sourceEntity) {
      throw new Error("Canonical relationship source is missing.");
    }
    return (projection.projection.relationships ?? []).map((relationship) => {
      const target = relationship.targetExternalId
        ? targetsByIdentity.get(canonicalIdentityKey({
            platformKey: relationship.targetPlatformKey,
            recordKind: relationship.targetRecordKind,
            externalId: relationship.targetExternalId,
          }))
        : undefined;
      return {
        id: randomUUID(),
        organizationId: projection.organizationId,
        sourceEntityId: sourceEntity.id,
        sourcePlatformKey: sourceEntity.platformKey,
        sourceRecordKind: sourceEntity.recordKind,
        relationshipKind: relationship.relationshipKind,
        targetPlatformKey: relationship.targetPlatformKey,
        targetRecordKind: relationship.targetRecordKind,
        targetExternalId: relationship.targetExternalId,
        targetEntityId: target?.id ?? null,
        createdPublicChangeSequence: 0n,
        resolvedPublicChangeSequence: null,
        createdAt: input.acceptedAt,
        resolvedAt: target ? input.acceptedAt : null,
      } satisfies RelationshipInsert;
    });
  });
  const proposedByIdentity = new Map<string, RelationshipInsert>();
  for (const relationship of proposedRelationships) {
    proposedByIdentity.set(relationshipIdentityKey(relationship), relationship);
  }
  const existingRelationshipsByIdentity = new Map<string, RelationshipInsert>();
  const sourceEntityIds = [
    ...new Set([...proposedByIdentity.values()].map(
      ({ sourceEntityId }) => sourceEntityId,
    )),
  ];
  for (const batch of batches(sourceEntityIds)) {
    const existing = await database.$queryRaw<Array<
      Omit<RelationshipInsert, "organizationId">
    >>(Prisma.sql`
      select relationship.id,
             relationship.source_entity_id as "sourceEntityId",
             source_entity.platform_key as "sourcePlatformKey",
             source_entity.record_kind::text as "sourceRecordKind",
             relationship_kind as "relationshipKind",
             target_platform_key as "targetPlatformKey",
             target_record_kind::text as "targetRecordKind",
             target_external_id as "targetExternalId",
             target_entity_id as "targetEntityId",
             created_public_change_sequence as "createdPublicChangeSequence",
             resolved_public_change_sequence as "resolvedPublicChangeSequence",
             relationship.created_at as "createdAt",
             relationship.resolved_at as "resolvedAt"
      from public.canonical_relationships as relationship
      join public.canonical_entities as source_entity
        on source_entity.id = relationship.source_entity_id
       and source_entity.organization_id = relationship.organization_id
      where relationship.organization_id = ${uuid(input.organizationId)}
        and relationship.source_entity_id in (${Prisma.join(batch.map(uuid))})
    `);
    existing.forEach((relationship) => {
      existingRelationshipsByIdentity.set(
        relationshipIdentityKey(relationship),
        { ...relationship, organizationId: input.organizationId },
      );
    });
  }
  const relationships = [...proposedByIdentity.entries()]
    .filter(([key]) => !existingRelationshipsByIdentity.has(key))
    .map(([, relationship]) => relationship);
  const relationshipByIdentity = new Map(existingRelationshipsByIdentity);
  for (const relationship of relationships) {
    relationshipByIdentity.set(
      relationshipIdentityKey(relationship),
      relationship,
    );
  }

  const confirmationCandidates = input.projections.flatMap(
    (projection, index) => {
      if (
        projection.origin.kind !== "semantic_observation"
        || projection.projection.recordKind !== "pull"
      ) {
        return [];
      }
      const relationshipInputs = projection.projection.relationships ?? [];
      if (
        relationshipInputs.length < 1
        || relationshipInputs.some((relationship) =>
          !isProviderV1PullRelationshipIdentity({
            recordKind: projection.projection.recordKind,
            relationshipKind: relationship.relationshipKind,
            targetRecordKind: relationship.targetRecordKind,
            targetExternalId: relationship.targetExternalId,
          })
        )
      ) {
        throw new TypeError(
          "Source-native pull relationship declarations are invalid.",
        );
      }
      const revision = input.revisionResults[index];
      if (!revision) {
        throw new Error("Relationship confirmation revision is missing.");
      }
      const sourceEntity = input.entitiesByIdentity.get(
        canonicalIdentityKey(projection.projection),
      );
      if (!sourceEntity) {
        throw new Error("Relationship confirmation source is missing.");
      }
      return [{
        sourceRevisionId: projection.origin.sourceRevisionId,
        semanticObservationId: projection.origin.semanticObservationId,
        sourceEntityId: sourceEntity.id,
        sourceCanonicalRevisionId: revision.revisionId,
        sourceCanonicalContentHash: projection.contentHash,
        relationshipKeys: relationshipInputs.map((relationship) =>
          relationshipIdentityKey({
            sourceEntityId: sourceEntity.id,
            relationshipKind: relationship.relationshipKind,
            targetPlatformKey: relationship.targetPlatformKey,
            targetRecordKind: relationship.targetRecordKind,
            targetExternalId: relationship.targetExternalId,
          })
        ),
      }];
    },
  );
  const newRelationshipKeys = new Set(relationships.map(
    relationshipIdentityKey,
  ));
  const nativeCandidateIds = new Set<string>();
  const ownedNewRelationshipKeys = new Set<string>();
  for (const candidate of [...confirmationCandidates].sort((left, right) =>
    left.semanticObservationId < right.semanticObservationId
      ? -1
      : left.semanticObservationId > right.semanticObservationId ? 1 : 0
  )) {
    if (!candidate.relationshipKeys.every((key) =>
      newRelationshipKeys.has(key) && !ownedNewRelationshipKeys.has(key)
    )) {
      continue;
    }
    nativeCandidateIds.add(candidate.semanticObservationId);
    candidate.relationshipKeys.forEach((key) =>
      ownedNewRelationshipKeys.add(key)
    );
    const declared = candidate.relationshipKeys.map((key) => {
      const relationship = relationshipByIdentity.get(key);
      if (!relationship || relationship.targetExternalId === null) {
        throw new Error("Native relationship declaration is missing.");
      }
      return relationship;
    });
    const declarationHash = sourceRelationshipDeclarationHash(
      declared.map((relationship) => ({
        relationshipKind: relationship.relationshipKind as "card" | "pack",
        targetPlatformKey: relationship.targetPlatformKey,
        targetRecordKind: relationship.targetRecordKind as
          | "catalog_asset"
          | "pack",
        targetExternalId: relationship.targetExternalId!,
      })),
    );
    for (const relationship of declared) {
      relationship.nativeConfirmationMetadata =
        sourceRelationshipConfirmationCauseMetadata({
          semanticObservationId: candidate.semanticObservationId,
          sourceCanonicalRevisionId: candidate.sourceCanonicalRevisionId,
          sourceCanonicalContentHash: candidate.sourceCanonicalContentHash,
          declarationHash,
          relationshipCount: declared.length,
          relationshipState: relationship.targetEntityId
            ? "resolved"
            : "unresolved",
        });
    }
  }
  const relationshipCauses = await allocatePublicChangeCauses(database, {
    organizationId: input.organizationId,
    changes: relationships.map((relationship) => ({
      changeKind: "relationship_resolution",
      entityKey: relationshipPublicEntityKey(relationship),
      sourceKey: relationship.targetPlatformKey,
      sourceRevisionKey: input.sourceRevisionKey,
      metadata: relationship.nativeConfirmationMetadata ?? {
        relationshipState: relationship.targetEntityId
          ? "resolved"
          : "unresolved",
      },
      occurredAt: relationship.createdAt,
      catalogImpact: relationshipCatalogImpact(
        relationship.sourcePlatformKey,
        relationship.targetPlatformKey,
      ),
    })),
  });
  relationships.forEach((relationship, index) => {
    const sequence = relationshipCauses[index]?.sequence;
    if (sequence === undefined) {
      throw new Error("Relationship cause is missing.");
    }
    relationship.createdPublicChangeSequence = sequence;
    relationship.resolvedPublicChangeSequence = relationship.targetEntityId
      ? sequence
      : null;
  });
  for (const batch of batches(relationships)) {
    const rows = batch.map((relationship) => Prisma.sql`(
      ${uuid(relationship.id)},
      ${uuid(relationship.organizationId)},
      ${uuid(relationship.sourceEntityId)},
      ${relationship.relationshipKind},
      ${relationship.targetPlatformKey},
      cast(${relationship.targetRecordKind} as public.canonical_record_kind),
      ${relationship.targetExternalId},
      ${relationship.targetEntityId
        ? uuid(relationship.targetEntityId)
        : Prisma.sql`null::uuid`},
      ${relationship.createdPublicChangeSequence},
      ${relationship.resolvedPublicChangeSequence},
      ${relationship.createdAt},
      ${relationship.resolvedAt}
    )`);
    await database.$executeRaw(Prisma.sql`
      insert into public.canonical_relationships (
        id, organization_id, source_entity_id, relationship_kind,
        target_platform_key, target_record_kind, target_external_id,
        target_entity_id, created_public_change_sequence,
        resolved_public_change_sequence, created_at, resolved_at
      )
      values ${Prisma.join(rows)}
      on conflict do nothing
    `);
  }
  const confirmationSets: SourceRelationshipConfirmationWriteSet[] =
    confirmationCandidates.map((candidate) => ({
      sourceRevisionId: candidate.sourceRevisionId,
      semanticObservationId: candidate.semanticObservationId,
      sourceEntityId: candidate.sourceEntityId,
      sourceCanonicalRevisionId: candidate.sourceCanonicalRevisionId,
      sourceCanonicalContentHash: candidate.sourceCanonicalContentHash,
      declarations: candidate.relationshipKeys.map((key) => {
        const relationship = relationshipByIdentity.get(key);
        if (
          !relationship
          || !isProviderV1PullRelationshipIdentity({
            recordKind: relationship.sourceRecordKind,
            relationshipKind: relationship.relationshipKind,
            targetRecordKind: relationship.targetRecordKind,
            targetExternalId: relationship.targetExternalId,
          })
        ) {
          throw new Error("Relationship confirmation item is missing.");
        }
        if (relationship.targetExternalId === null) {
          throw new Error("Relationship confirmation target is missing.");
        }
        return {
          canonicalRelationshipId: relationship.id,
          relationshipKind: relationship.relationshipKind as "card" | "pack",
          targetPlatformKey: relationship.targetPlatformKey,
          targetRecordKind: relationship.targetRecordKind as
            | "catalog_asset"
            | "pack",
          targetExternalId: relationship.targetExternalId,
          createdPublicChangeSequence:
            relationship.createdPublicChangeSequence,
          resolvedPublicChangeSequence:
            relationship.resolvedPublicChangeSequence,
          insertedInCurrentWrite: nativeCandidateIds.has(
            candidate.semanticObservationId,
          ),
        };
      }),
    }));
  return persistSourceRelationshipConfirmationSetsForCanonicalWrites(
    database,
    {
      organizationId: input.organizationId,
      providerId: input.providerId,
      confirmedAt: input.acceptedAt,
      sets: confirmationSets,
    },
  );
}

export async function resolveConfirmedRelationshipsForNewTargets(
  database: PackscoutTransactionClient,
  input: {
    organizationId: string;
    sourceRevisionKey: string;
    acceptedAt: Date;
    mode: "forward" | "source_relationship_confirmation_backfill";
    entities: readonly CanonicalRelationshipEntityRecord[];
  },
): Promise<void> {
  for (const batch of batches(input.entities)) {
    const rows = batch.map((entity) => {
      if (entity.publicChangeSequence === null) {
        throw new Error("Canonical relationship target cause is missing.");
      }
      return Prisma.sql`(
        ${entity.platformKey},
        cast(${entity.recordKind} as public.canonical_record_kind),
        ${entity.externalId},
        ${uuid(entity.id)},
        ${entity.publicChangeSequence}
      )`;
    });
    const unresolved = await database.$queryRaw<Array<{
      id: string;
      sourceEntityId: string;
      sourcePlatformKey: string;
      sourceRecordKind: CanonicalProjectionInput["recordKind"];
      relationshipKind: string;
      targetPlatformKey: string;
      targetRecordKind: CanonicalProjectionInput["recordKind"];
      targetExternalId: string;
      targetEntityId: string;
    }>>(Prisma.sql`
      select relationship.id,
             relationship.source_entity_id as "sourceEntityId",
             source_entity.platform_key as "sourcePlatformKey",
             source_entity.record_kind::text as "sourceRecordKind",
             relationship.relationship_kind as "relationshipKind",
             relationship.target_platform_key as "targetPlatformKey",
             relationship.target_record_kind::text as "targetRecordKind",
             relationship.target_external_id as "targetExternalId",
             targets.entity_id as "targetEntityId"
      from public.canonical_relationships as relationship
      join public.canonical_entities as source_entity
        on source_entity.id = relationship.source_entity_id
       and source_entity.organization_id = relationship.organization_id
      join (values ${Prisma.join(rows)})
        as targets(
          platform_key, record_kind, external_id, entity_id,
          public_change_sequence
        )
        on relationship.target_platform_key = targets.platform_key
       and relationship.target_record_kind = targets.record_kind
       and relationship.target_external_id = targets.external_id
      where relationship.organization_id = ${uuid(input.organizationId)}
        and relationship.target_entity_id is null
      order by relationship.created_public_change_sequence asc,
               relationship.id asc
      for update of relationship
    `);
    for (const resolutionBatch of batches(unresolved)) {
      const resolutionCauses = await allocatePublicChangeCauses(database, {
        organizationId: input.organizationId,
        changes: resolutionBatch.map((relationship) => ({
          changeKind: "relationship_resolution",
          entityKey: relationshipPublicEntityKey(relationship),
          sourceKey: relationship.targetPlatformKey,
          sourceRevisionKey: input.sourceRevisionKey,
          metadata: { relationshipState: "resolved" },
          occurredAt: input.acceptedAt,
          catalogImpact: relationshipCatalogImpact(
            relationship.sourcePlatformKey,
            relationship.targetPlatformKey,
          ),
        })),
      });
      const resolvedRelationships = resolutionBatch.map(
        (relationship, index) => {
          const sequence = resolutionCauses[index]?.sequence;
          if (sequence === undefined) {
            throw new Error("Resolution cause is missing.");
          }
          return { ...relationship, publicChangeSequence: sequence };
        },
      );
      const resolutionRows = resolvedRelationships.map((relationship) =>
        Prisma.sql`(
          ${uuid(relationship.id)}, ${uuid(relationship.targetEntityId)},
          ${relationship.publicChangeSequence}
        )`
      );
      await database.$executeRaw(Prisma.sql`
        update public.canonical_relationships as relationship
        set target_entity_id = resolutions.target_entity_id,
            resolved_at = ${input.acceptedAt},
            resolved_public_change_sequence = resolutions.public_change_sequence
        from (values ${Prisma.join(resolutionRows)})
          as resolutions(
            relationship_id, target_entity_id, public_change_sequence
          )
        where relationship.id = resolutions.relationship_id
          and relationship.organization_id = ${uuid(input.organizationId)}
          and relationship.target_entity_id is null
      `);
      const confirmedResolutionSources =
        await loadConfirmedRelationshipSourcesForResolutions(database, {
          organizationId: input.organizationId,
          canonicalRelationshipIds: resolvedRelationships.map(({ id }) => id),
          maximumResults: NORMALIZED_HEAT_MAXIMUM_WRITE_CANDIDATES,
        });
      if (input.mode === "forward") {
        await persistConfirmedRelationshipHeatSources(database, {
          organizationId: input.organizationId,
          createdAt: input.acceptedAt,
          relationships: confirmedResolutionSources,
        });
      }
    }
  }
}
