import { randomUUID } from "node:crypto";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_OBSERVATION_HASH_VERSION,
  normalizedObservationSemanticContentSchema,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import type {
  PackscoutQueryClient,
  PackscoutTransactionClient,
} from "./database.ts";
import type { CanonicalRecordKind } from "./pipeline-types.ts";
import {
  allocatePublicChangeCauses,
  relationshipConfirmationPublicEntityKey,
} from "./public-change-settlement-repository.ts";
import { hashJson } from "./security.ts";

const maximumConfirmationSetsPerWrite = 500;

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

function confirmationIdentity(input: {
  sourceRevisionId: string;
  semanticObservationId: string;
}): string {
  return `${input.sourceRevisionId}\u0000${input.semanticObservationId}`;
}

export interface SourceRelationshipDeclarationIdentity {
  readonly canonicalRelationshipId: string;
  readonly relationshipKind: "card" | "pack";
  readonly targetPlatformKey: string;
  readonly targetRecordKind: "catalog_asset" | "pack";
  readonly targetExternalId: string;
  readonly createdPublicChangeSequence: bigint;
  readonly resolvedPublicChangeSequence: bigint | null;
  readonly insertedInCurrentWrite: boolean;
}

export interface SourceRelationshipConfirmationWriteSet {
  readonly sourceRevisionId: string;
  readonly semanticObservationId: string;
  readonly sourceEntityId: string;
  readonly sourceCanonicalRevisionId: string;
  readonly sourceCanonicalContentHash: string;
  readonly declarations: readonly SourceRelationshipDeclarationIdentity[];
}

interface CanonicalDeclaration {
  readonly relationshipKind: "card" | "pack";
  readonly targetPlatformKey: string;
  readonly targetRecordKind: "catalog_asset" | "pack";
  readonly targetExternalId: string;
}

interface ConfirmationLineageRow {
  readonly sourceRevisionId: string;
  readonly semanticObservationId: string;
  readonly sourceInstanceId: string;
  readonly sourceRecordId: string;
  readonly semanticEffectiveAt: Date;
  readonly normalizedContent: unknown;
  readonly hashVersion: string;
  readonly platformKey: string;
  readonly sourceExternalId: string;
  readonly providerRecordId: string;
}

interface ExistingConfirmationRow {
  readonly confirmationSetId: string;
  readonly sourceRevisionId: string;
  readonly semanticObservationId: string;
  readonly sourceEntityId: string;
  readonly sourceCanonicalRevisionId: string;
  readonly sourceCanonicalContentHash: string;
  readonly declarationHash: string;
  readonly relationshipCount: number;
  readonly confirmationPublicChangeSequence: bigint;
  readonly itemConfirmationPublicChangeSequence: bigint;
  readonly heatEffectivePublicChangeSequence: bigint | null;
  readonly confirmedAt: Date;
  readonly canonicalRelationshipId: string;
  readonly relationshipKind: "card" | "pack";
  readonly targetPlatformKey: string;
  readonly targetRecordKind: "catalog_asset" | "pack";
  readonly targetExternalId: string;
  readonly resolvedPublicChangeSequence: bigint | null;
  readonly resolvedAt: Date | null;
}

export interface ConfirmedSourceRelationship {
  readonly confirmationSetId: string;
  readonly sourceRevisionId: string;
  readonly semanticObservationId: string;
  readonly sourceEntityId: string;
  readonly sourceCanonicalRevisionId: string;
  readonly sourceCanonicalContentHash: string;
  readonly canonicalRelationshipId: string;
  readonly relationshipKind: "card" | "pack";
  readonly targetPlatformKey: string;
  readonly targetRecordKind: "catalog_asset" | "pack";
  readonly targetExternalId: string;
  readonly confirmationPublicChangeSequence: bigint;
  readonly confirmedAt: Date;
  readonly resolvedPublicChangeSequence: bigint | null;
  readonly resolvedAt: Date | null;
  readonly effectivePublicChangeSequence: bigint | null;
  readonly effectiveAt: Date | null;
}

export interface SourceRelationshipConfirmationWriteResult {
  readonly confirmations: readonly ConfirmedSourceRelationship[];
  /** Every item in a confirmation set first persisted by this call. A later
   * semantic/canonical revision that reuses an already-confirmed physical edge
   * appears here even though it is not a first edge-origin transition. */
  readonly newlyPersistedConfirmations: readonly ConfirmedSourceRelationship[];
  /** One resolved edge-origin transition for each physical edge first
   * confirmed by this call. Replays and later semantic confirmations are
   * deliberately absent. */
  readonly newlyConfirmedRelationships: readonly ConfirmedSourceRelationship[];
}

export interface ProviderV1RelationshipConfirmationReadiness {
  readonly organizationId: string;
  readonly providerId: string;
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  readonly phase: "missing" | "pending" | "running" | "complete" | "failed";
  readonly targetDeliveryOccurrenceId: bigint | null;
  readonly targetSemanticSetCount: bigint | null;
  readonly confirmedSemanticSetCount: bigint | null;
  readonly failureCode: string | null;
  readonly ready: boolean;
}

function compareDeclarations(
  left: CanonicalDeclaration,
  right: CanonicalDeclaration,
): number {
  const leftKey = [
    left.relationshipKind,
    left.targetPlatformKey,
    left.targetRecordKind,
    left.targetExternalId,
  ].join("\u0000");
  const rightKey = [
    right.relationshipKind,
    right.targetPlatformKey,
    right.targetRecordKind,
    right.targetExternalId,
  ].join("\u0000");
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function canonicalDeclarations(
  declarations: readonly Pick<
    SourceRelationshipDeclarationIdentity,
    | "relationshipKind"
    | "targetPlatformKey"
    | "targetRecordKind"
    | "targetExternalId"
  >[],
): readonly CanonicalDeclaration[] {
  const canonical = declarations.map((declaration) => ({
    relationshipKind: declaration.relationshipKind,
    targetPlatformKey: declaration.targetPlatformKey,
    targetRecordKind: declaration.targetRecordKind,
    targetExternalId: declaration.targetExternalId,
  })).sort(compareDeclarations);
  if (
    canonical.length < 1
    || canonical.length > 2
    || new Set(canonical.map(({ relationshipKind }) => relationshipKind)).size
      !== canonical.length
    || canonical.some((declaration) =>
      declaration.targetExternalId.trim().length === 0
      || (declaration.relationshipKind === "pack"
        ? declaration.targetRecordKind !== "pack"
        : declaration.targetRecordKind !== "catalog_asset")
    )
  ) {
    throw new TypeError("Source relationship declaration set is invalid.");
  }
  return canonical;
}

export function sourceRelationshipDeclarationHash(
  declarations: readonly Pick<
    SourceRelationshipDeclarationIdentity,
    | "relationshipKind"
    | "targetPlatformKey"
    | "targetRecordKind"
    | "targetExternalId"
  >[],
): string {
  return hashJson(canonicalDeclarations(declarations));
}

export function sourceRelationshipConfirmationCauseMetadata(input: {
  semanticObservationId: string;
  sourceCanonicalRevisionId: string;
  sourceCanonicalContentHash: string;
  declarationHash: string;
  relationshipCount: number;
  relationshipState: "resolved" | "unresolved";
}): Readonly<Record<string, string | number>> {
  return Object.freeze({
    relationshipState: input.relationshipState,
    semanticObservationId: input.semanticObservationId,
    sourceCanonicalRevisionId: input.sourceCanonicalRevisionId,
    sourceCanonicalContentHash: input.sourceCanonicalContentHash,
    relationshipDeclarationHash: input.declarationHash,
    relationshipCount: input.relationshipCount,
  });
}

function semanticDeclarations(
  normalizedContent: unknown,
  platformKey: string,
): readonly CanonicalDeclaration[] {
  const semantic = normalizedObservationSemanticContentSchema.parse(
    normalizedContent,
  );
  if (semantic.kind !== "pull") {
    throw new TypeError("Relationship confirmation semantic must be a pull.");
  }
  return canonicalDeclarations(semantic.relationships.map((relationship) => ({
    relationshipKind: relationship.relationship,
    targetPlatformKey: platformKey,
    targetRecordKind:
      relationship.relationship === "pack" ? "pack" : "catalog_asset",
    targetExternalId: relationship.target.providerRecordId,
  })));
}

function assertSameDeclarations(
  expected: readonly CanonicalDeclaration[],
  actual: readonly CanonicalDeclaration[],
): void {
  if (hashJson(expected) !== hashJson(actual)) {
    throw new TypeError(
      "Canonical relationship declarations do not match their semantic observation.",
    );
  }
}

function mapConfirmedRelationships(
  rows: readonly ExistingConfirmationRow[],
): ConfirmedSourceRelationship[] {
  return rows.map((row) => ({
    confirmationSetId: row.confirmationSetId,
    sourceRevisionId: row.sourceRevisionId,
    semanticObservationId: row.semanticObservationId,
    sourceEntityId: row.sourceEntityId,
    sourceCanonicalRevisionId: row.sourceCanonicalRevisionId,
    sourceCanonicalContentHash: row.sourceCanonicalContentHash,
    canonicalRelationshipId: row.canonicalRelationshipId,
    relationshipKind: row.relationshipKind,
    targetPlatformKey: row.targetPlatformKey,
    targetRecordKind: row.targetRecordKind,
    targetExternalId: row.targetExternalId,
    confirmationPublicChangeSequence:
      row.confirmationPublicChangeSequence,
    confirmedAt: row.confirmedAt,
    resolvedPublicChangeSequence: row.resolvedPublicChangeSequence,
    resolvedAt: row.resolvedAt,
    effectivePublicChangeSequence: row.heatEffectivePublicChangeSequence,
    effectiveAt: row.heatEffectivePublicChangeSequence === null
        || row.resolvedAt === null
      ? null
      : row.resolvedAt > row.confirmedAt
        ? row.resolvedAt
        : row.confirmedAt,
  }));
}

async function loadConfirmationRows(
  transaction: PackscoutTransactionClient,
  input: {
    organizationId: string;
    sourceRevisionId: string;
    semanticObservationIds: readonly string[];
  },
): Promise<ExistingConfirmationRow[]> {
  if (input.semanticObservationIds.length === 0) return [];
  return transaction.$queryRaw<ExistingConfirmationRow[]>(Prisma.sql`
    select confirmation.id as "confirmationSetId",
           confirmation.source_revision_id as "sourceRevisionId",
           confirmation.semantic_observation_id as "semanticObservationId",
           confirmation.source_entity_id as "sourceEntityId",
           confirmation.source_canonical_revision_id as
             "sourceCanonicalRevisionId",
           confirmation.source_canonical_content_hash as
             "sourceCanonicalContentHash",
           confirmation.declaration_hash as "declarationHash",
           confirmation.relationship_count as "relationshipCount",
           confirmation.public_change_sequence as
             "confirmationPublicChangeSequence",
           item.confirmation_public_change_sequence as
             "itemConfirmationPublicChangeSequence",
           item.heat_effective_public_change_sequence as
             "heatEffectivePublicChangeSequence",
           confirmation.confirmed_at as "confirmedAt",
           item.canonical_relationship_id as "canonicalRelationshipId",
           item.relationship_kind as "relationshipKind",
           item.target_platform_key as "targetPlatformKey",
           item.target_record_kind::text as "targetRecordKind",
           item.target_external_id as "targetExternalId",
           relationship.resolved_public_change_sequence as
             "resolvedPublicChangeSequence",
           relationship.resolved_at as "resolvedAt"
    from public.source_relationship_confirmation_sets as confirmation
    join public.source_relationship_confirmations as item
      on item.confirmation_set_id = confirmation.id
     and item.organization_id = confirmation.organization_id
    join public.canonical_relationships as relationship
      on relationship.id = item.canonical_relationship_id
     and relationship.organization_id = item.organization_id
    where confirmation.organization_id = ${uuid(input.organizationId)}
      and confirmation.source_revision_id = ${uuid(input.sourceRevisionId)}
      and confirmation.semantic_observation_id in (
        ${Prisma.join(input.semanticObservationIds.map(uuid))}
      )
    order by confirmation.semantic_observation_id,
             item.relationship_kind collate "C"
  `);
}

/**
 * Persists source-native V1 relationship confirmation sets inside the same
 * transaction as canonical projection and delivery occurrence writes.
 * Replays return the immutable existing set and never allocate another cause.
 */
export async function persistSourceRelationshipConfirmationSetsForCanonicalWrites(
  transaction: PackscoutTransactionClient,
  input: {
    organizationId: string;
    providerId: string;
    confirmedAt: Date;
    sets: readonly SourceRelationshipConfirmationWriteSet[];
  },
): Promise<SourceRelationshipConfirmationWriteResult> {
  if (input.sets.length === 0) {
    return {
      confirmations: [],
      newlyPersistedConfirmations: [],
      newlyConfirmedRelationships: [],
    };
  }
  if (input.sets.length > maximumConfirmationSetsPerWrite) {
    throw new RangeError("Source relationship confirmation batch is too large.");
  }
  const sourceRevisionIds = new Set(
    input.sets.map(({ sourceRevisionId }) => sourceRevisionId),
  );
  if (sourceRevisionIds.size !== 1) {
    throw new TypeError(
      "Source relationship confirmation writes cannot span source revisions.",
    );
  }
  const sourceRevisionId = input.sets[0]!.sourceRevisionId;

  const uniqueSets = new Map<string, SourceRelationshipConfirmationWriteSet>();
  for (const set of input.sets) {
    const key = confirmationIdentity(set);
    const existing = uniqueSets.get(key);
    if (existing) {
      if (
        existing.sourceEntityId !== set.sourceEntityId
        || existing.sourceCanonicalRevisionId
          !== set.sourceCanonicalRevisionId
        || existing.sourceCanonicalContentHash
          !== set.sourceCanonicalContentHash
        || sourceRelationshipDeclarationHash(existing.declarations)
          !== sourceRelationshipDeclarationHash(set.declarations)
      ) {
        throw new TypeError(
          "A semantic observation cannot confirm multiple relationship sets.",
        );
      }
      continue;
    }
    uniqueSets.set(key, set);
  }
  const sets = [...uniqueSets.values()];
  const pairs = sets.map((set) => Prisma.sql`(
    ${uuid(set.sourceRevisionId)}, ${uuid(set.semanticObservationId)},
    ${uuid(set.sourceEntityId)}, ${uuid(set.sourceCanonicalRevisionId)},
    ${set.sourceCanonicalContentHash}
  )`);
  // A time-only replay intentionally reuses the retained content revision.
  // Bind lineage by stable entity and exact content hash; the later semantic
  // occurrence keeps its own effective time on the confirmation set.
  const lineageRows = await transaction.$queryRaw<ConfirmationLineageRow[]>(Prisma.sql`
    select source_revision.id as "sourceRevisionId",
           semantic.id as "semanticObservationId",
           source_revision.source_instance_id as "sourceInstanceId",
           semantic.source_record_id as "sourceRecordId",
           semantic.effective_source_time as "semanticEffectiveAt",
           semantic.normalized_content_json as "normalizedContent",
           semantic.hash_version as "hashVersion",
           provider.platform_key as "platformKey",
           source_entity.external_id as "sourceExternalId",
           source_record.provider_record_id as "providerRecordId"
    from (values ${Prisma.join(pairs)})
      as requested(
        source_revision_id, semantic_observation_id, source_entity_id,
        canonical_revision_id, canonical_content_hash
      )
    join public.provider_source_revisions as source_revision
      on source_revision.id = requested.source_revision_id
     and source_revision.organization_id = ${uuid(input.organizationId)}
     and source_revision.provider_id = ${uuid(input.providerId)}
     and source_revision.normalized_contract_version =
       ${PROVIDER_OBSERVATION_CONTRACT_VERSION}
    join public.provider_sources as provider
      on provider.id = source_revision.provider_id
     and provider.organization_id = source_revision.organization_id
    join public.source_semantic_observations as semantic
      on semantic.id = requested.semantic_observation_id
     and semantic.organization_id = source_revision.organization_id
     and semantic.normalized_contract_version =
       source_revision.normalized_contract_version
    join public.source_record_identities as source_record
      on source_record.id = semantic.source_record_id
     and source_record.organization_id = semantic.organization_id
     and source_record.provider_id = source_revision.provider_id
     and source_record.source_instance_id = source_revision.source_instance_id
     and source_record.record_id_scope_key = 'pull-v1'
     and source_record.record_kind = 'pull'
     and source_record.record_discriminator = 'pull'
    join public.canonical_entities as source_entity
      on source_entity.id = requested.source_entity_id
     and source_entity.organization_id = source_revision.organization_id
     and source_entity.platform_key = provider.platform_key
     and source_entity.record_kind = 'pull'
     and source_entity.external_id = source_record.provider_record_id
    join public.canonical_revisions as canonical_revision
      on canonical_revision.id = requested.canonical_revision_id
     and canonical_revision.entity_id = source_entity.id
     and canonical_revision.organization_id = source_entity.organization_id
     and canonical_revision.content_hash = requested.canonical_content_hash
  `);
  if (lineageRows.length !== sets.length) {
    throw new TypeError("Source relationship confirmation scope is invalid.");
  }
  const lineageByIdentity = new Map(
    lineageRows.map((row) => [confirmationIdentity(row), row]),
  );
  const prepared = sets.map((set) => {
    const lineage = lineageByIdentity.get(confirmationIdentity(set));
    if (!lineage || lineage.hashVersion !== PROVIDER_OBSERVATION_HASH_VERSION) {
      throw new TypeError("Source relationship confirmation lineage is invalid.");
    }
    if (lineage.sourceExternalId !== lineage.providerRecordId) {
      throw new TypeError("Source relationship confirmation pull identity is invalid.");
    }
    const declarations = canonicalDeclarations(set.declarations);
    assertSameDeclarations(
      semanticDeclarations(lineage.normalizedContent, lineage.platformKey),
      declarations,
    );
    return {
      set,
      lineage,
      declarations,
      declarationHash: hashJson(declarations),
    };
  });

  const requestedRelationshipIds = [
    ...new Set(prepared.flatMap(({ set }) =>
      set.declarations.map(({ canonicalRelationshipId }) =>
        canonicalRelationshipId
      )
    )),
  ];
  const previouslyConfirmedRows = await transaction.$queryRaw<Array<{
    canonicalRelationshipId: string;
  }>>(Prisma.sql`
    select distinct canonical_relationship_id as "canonicalRelationshipId"
    from public.source_relationship_confirmations
    where organization_id = ${uuid(input.organizationId)}
      and canonical_relationship_id in (
        ${Prisma.join(requestedRelationshipIds.map(uuid))}
      )
  `);
  const previouslyConfirmedIds = new Set(
    previouslyConfirmedRows.map(({ canonicalRelationshipId }) =>
      canonicalRelationshipId
    ),
  );

  const existingRows = await loadConfirmationRows(transaction, {
    organizationId: input.organizationId,
    sourceRevisionId,
    semanticObservationIds: prepared.map(
      ({ set }) => set.semanticObservationId,
    ),
  });
  const existingBySemantic = new Map<string, ExistingConfirmationRow[]>();
  for (const row of existingRows) {
    const rows = existingBySemantic.get(row.semanticObservationId) ?? [];
    rows.push(row);
    existingBySemantic.set(row.semanticObservationId, rows);
  }
  const missing = prepared.filter(({ set, declarationHash, declarations }) => {
    const rows = existingBySemantic.get(set.semanticObservationId);
    if (!rows) return true;
    if (
      rows.length !== declarations.length
      || rows.some((row) =>
        row.sourceEntityId !== set.sourceEntityId
        || row.sourceCanonicalRevisionId
          !== set.sourceCanonicalRevisionId
        || row.sourceCanonicalContentHash
          !== set.sourceCanonicalContentHash
        || row.declarationHash !== declarationHash
        || row.relationshipCount !== declarations.length
        || row.itemConfirmationPublicChangeSequence
          !== row.confirmationPublicChangeSequence
        || row.heatEffectivePublicChangeSequence !== (
          row.resolvedPublicChangeSequence === null
            ? null
            : row.resolvedPublicChangeSequence
                > row.confirmationPublicChangeSequence
              ? row.resolvedPublicChangeSequence
              : row.confirmationPublicChangeSequence
        )
      )
    ) {
      throw new TypeError("Stored relationship confirmation replay is invalid.");
    }
    assertSameDeclarations(
      declarations,
      canonicalDeclarations(rows.map((row) => row)),
    );
    return false;
  });

  const adopted = missing.filter(({ set }) =>
    !set.declarations.every(({ insertedInCurrentWrite }) =>
      insertedInCurrentWrite
    )
  );
  const adoptedCauses = await allocatePublicChangeCauses(transaction, {
    organizationId: input.organizationId,
    changes: adopted.map(({ set, lineage, declarationHash, declarations }) => ({
      changeKind: "relationship_confirmation",
      entityKey: relationshipConfirmationPublicEntityKey({
        sourceRevisionId: set.sourceRevisionId,
        semanticObservationId: set.semanticObservationId,
        declarationHash,
      }),
      sourceKey: lineage.platformKey,
      sourceRevisionKey: set.sourceRevisionId,
      metadata: {
        semanticObservationId: set.semanticObservationId,
        sourceCanonicalRevisionId: set.sourceCanonicalRevisionId,
        sourceCanonicalContentHash: set.sourceCanonicalContentHash,
        relationshipDeclarationHash: declarationHash,
        relationshipCount: declarations.length,
      },
      occurredAt: input.confirmedAt,
      catalogImpact: {
        kind: "catalog",
        providerPlatformKeys: [lineage.platformKey],
      },
    })),
  });
  const adoptedCauseBySemantic = new Map(
    adopted.map(({ set }, index) => [
      set.semanticObservationId,
      adoptedCauses[index]!,
    ]),
  );

  const newSets = missing.map((candidate) => {
    const adoptedCause = adoptedCauseBySemantic.get(
      candidate.set.semanticObservationId,
    );
    const nativeSequence = candidate.set.declarations.reduce(
      (maximum, declaration) =>
        declaration.createdPublicChangeSequence > maximum
          ? declaration.createdPublicChangeSequence
          : maximum,
      0n,
    );
    return {
      ...candidate,
      id: randomUUID(),
      confirmationMode: adoptedCause ? "adopted" as const : "native" as const,
      publicChangeSequence: adoptedCause?.sequence ?? nativeSequence,
    };
  });
  if (newSets.some(({ publicChangeSequence }) => publicChangeSequence <= 0n)) {
    throw new TypeError("Source relationship confirmation cause is invalid.");
  }

  if (newSets.length > 0) {
    const headerRows = newSets.map((confirmation) => Prisma.sql`(
      ${uuid(confirmation.id)}, ${uuid(input.organizationId)},
      ${uuid(input.providerId)}, ${uuid(confirmation.lineage.sourceInstanceId)},
      ${uuid(confirmation.set.sourceRevisionId)},
      ${uuid(confirmation.lineage.sourceRecordId)},
      ${uuid(confirmation.set.semanticObservationId)},
      ${uuid(confirmation.set.sourceEntityId)},
      ${uuid(confirmation.set.sourceCanonicalRevisionId)},
      ${confirmation.set.sourceCanonicalContentHash},
      ${PROVIDER_OBSERVATION_CONTRACT_VERSION},
      ${confirmation.lineage.semanticEffectiveAt},
      ${confirmation.declarationHash}, ${confirmation.declarations.length},
      ${confirmation.publicChangeSequence}, ${confirmation.confirmationMode},
      ${input.confirmedAt}, ${input.confirmedAt}
    )`);
    await transaction.$executeRaw(Prisma.sql`
      insert into public.source_relationship_confirmation_sets (
        id, organization_id, provider_id, source_instance_id,
        source_revision_id, source_record_id, semantic_observation_id,
        source_entity_id, source_canonical_revision_id,
        source_canonical_content_hash,
        normalized_contract_version, semantic_effective_at,
        declaration_hash, relationship_count, public_change_sequence,
        confirmation_mode, confirmed_at, created_at
      ) values ${Prisma.join(headerRows)}
    `);

    const itemRows = newSets.flatMap((confirmation) =>
      confirmation.set.declarations.map((declaration) => Prisma.sql`(
        ${uuid(confirmation.id)}, ${uuid(input.organizationId)},
        ${uuid(declaration.canonicalRelationshipId)},
        ${uuid(confirmation.set.sourceEntityId)},
        ${declaration.relationshipKind}, ${declaration.targetPlatformKey},
        cast(${declaration.targetRecordKind} as public.canonical_record_kind),
        ${declaration.targetExternalId}, ${confirmation.publicChangeSequence},
        ${declaration.resolvedPublicChangeSequence === null
          ? Prisma.sql`null::bigint`
          : declaration.resolvedPublicChangeSequence
                > confirmation.publicChangeSequence
            ? declaration.resolvedPublicChangeSequence
            : confirmation.publicChangeSequence},
        ${input.confirmedAt}
      )`)
    );
    await transaction.$executeRaw(Prisma.sql`
      insert into public.source_relationship_confirmations (
        confirmation_set_id, organization_id, canonical_relationship_id,
        source_entity_id, relationship_kind, target_platform_key,
        target_record_kind, target_external_id,
        confirmation_public_change_sequence,
        heat_effective_public_change_sequence, created_at
      ) values ${Prisma.join(itemRows)}
    `);
  }

  const confirmedRows = await loadConfirmationRows(transaction, {
    organizationId: input.organizationId,
    sourceRevisionId,
    semanticObservationIds: prepared.map(
      ({ set }) => set.semanticObservationId,
    ),
  });
  if (
    confirmedRows.length
      !== prepared.reduce((count, { declarations }) =>
        count + declarations.length, 0)
  ) {
    throw new Error("Source relationship confirmation persistence is incomplete.");
  }
  const confirmations = mapConfirmedRelationships(confirmedRows);
  const newlyPersistedSetIds = new Set<string>(newSets.map(({ id }) => id));
  const newlyConfirmedByRelationship = new Map<
    string,
    ConfirmedSourceRelationship
  >();
  for (const confirmation of confirmations) {
    if (
      previouslyConfirmedIds.has(confirmation.canonicalRelationshipId)
      || confirmation.effectivePublicChangeSequence === null
    ) {
      continue;
    }
    const existing = newlyConfirmedByRelationship.get(
      confirmation.canonicalRelationshipId,
    );
    if (
      !existing
      || confirmation.confirmationPublicChangeSequence
        < existing.confirmationPublicChangeSequence
    ) {
      newlyConfirmedByRelationship.set(
        confirmation.canonicalRelationshipId,
        confirmation,
      );
    }
  }
  return {
    confirmations,
    newlyPersistedConfirmations: confirmations.filter(({ confirmationSetId }) =>
      newlyPersistedSetIds.has(confirmationSetId)
    ),
    newlyConfirmedRelationships: [...newlyConfirmedByRelationship.values()],
  };
}

/**
 * Fixed CTE contract shared by provider release and Heat. Consumers append
 * this fragment immediately after `with` and query
 * `confirmed_provider_v1_pull_relationships`. No semantic JSON or delivery
 * arrival state participates in checkpoint reads.
 */
export function providerV1ConfirmedRelationshipCtes(input: {
  organizationId: string;
  sourceRevisionId: string;
  throughSequence: bigint;
  materialization?: "default" | "not_materialized";
}): Prisma.Sql {
  const confirmationSetMaterialization = input.materialization ===
      "not_materialized"
    ? Prisma.sql`not materialized`
    : Prisma.empty;
  return Prisma.sql`
    confirmed_provider_v1_pull_relationship_sets as
      ${confirmationSetMaterialization} (
      select confirmation.id as confirmation_set_id,
             confirmation.organization_id,
             confirmation.provider_id,
             confirmation.source_instance_id,
             confirmation.source_revision_id,
             confirmation.semantic_observation_id,
             confirmation.source_entity_id,
             confirmation.source_canonical_revision_id,
             confirmation.source_canonical_content_hash,
             confirmation.semantic_effective_at,
             confirmation.confirmed_at,
             confirmation.declaration_hash,
             confirmation.relationship_count,
             confirmation.public_change_sequence as
               confirmation_public_change_sequence
      from public.source_relationship_confirmation_sets as confirmation
      where confirmation.organization_id = ${uuid(input.organizationId)}
        and confirmation.source_revision_id = ${uuid(input.sourceRevisionId)}
        and confirmation.public_change_sequence <= ${input.throughSequence}
    ),
    confirmed_provider_v1_pull_relationships as (
      select confirmation.*,
             item.canonical_relationship_id,
             item.relationship_kind,
             item.target_platform_key,
             item.target_record_kind,
             item.target_external_id,
             relationship.target_entity_id,
             relationship.created_public_change_sequence,
             relationship.resolved_public_change_sequence,
             relationship.resolved_at,
             case
               when item.heat_effective_public_change_sequence is null
                 or item.heat_effective_public_change_sequence >
                   ${input.throughSequence}
                 then null
               else item.heat_effective_public_change_sequence
             end as effective_public_change_sequence,
             case
               when item.heat_effective_public_change_sequence is null
                 or item.heat_effective_public_change_sequence >
                   ${input.throughSequence}
                 then null
               else greatest(
                 confirmation.confirmed_at,
                 relationship.resolved_at
               )
             end as effective_at
      from confirmed_provider_v1_pull_relationship_sets as confirmation
      join public.source_relationship_confirmations as item
        on item.confirmation_set_id = confirmation.confirmation_set_id
       and item.organization_id = confirmation.organization_id
       and item.source_entity_id = confirmation.source_entity_id
       and item.confirmation_public_change_sequence =
         confirmation.confirmation_public_change_sequence
      join public.canonical_relationships as relationship
        on relationship.id = item.canonical_relationship_id
       and relationship.organization_id = item.organization_id
       and relationship.source_entity_id = item.source_entity_id
       and relationship.relationship_kind = item.relationship_kind
       and relationship.target_platform_key = item.target_platform_key
       and relationship.target_record_kind = item.target_record_kind
       and relationship.target_external_id = item.target_external_id
      where relationship.created_public_change_sequence <=
        ${input.throughSequence}
    )
  `;
}

export async function loadProviderV1RelationshipConfirmationReadiness(
  database: PackscoutQueryClient,
  input: {
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
    sourceRevisionId: string;
  },
): Promise<ProviderV1RelationshipConfirmationReadiness> {
  const rows = await database.$queryRaw<Array<{
    phase: "pending" | "running" | "complete" | "failed";
    targetDeliveryOccurrenceId: bigint;
    targetSemanticSetCount: bigint;
    confirmedSemanticSetCount: bigint;
    failureCode: string | null;
  }>>(Prisma.sql`
    select phase,
           target_delivery_occurrence_id as "targetDeliveryOccurrenceId",
           target_semantic_set_count as "targetSemanticSetCount",
           confirmed_semantic_set_count as "confirmedSemanticSetCount",
           failure_code as "failureCode"
    from public.source_relationship_confirmation_backfills
    where organization_id = ${uuid(input.organizationId)}
      and provider_id = ${uuid(input.providerId)}
      and source_instance_id = ${uuid(input.sourceInstanceId)}
      and source_revision_id = ${uuid(input.sourceRevisionId)}
  `);
  const row = rows[0];
  return {
    ...input,
    phase: row?.phase ?? "missing",
    targetDeliveryOccurrenceId: row?.targetDeliveryOccurrenceId ?? null,
    targetSemanticSetCount: row?.targetSemanticSetCount ?? null,
    confirmedSemanticSetCount: row?.confirmedSemanticSetCount ?? null,
    failureCode: row?.failureCode ?? null,
    ready: row?.phase === "complete"
      && row.confirmedSemanticSetCount === row.targetSemanticSetCount,
  };
}

export async function loadConfirmedRelationshipSourcesForResolutions(
  database: PackscoutQueryClient,
  input: {
    organizationId: string;
    canonicalRelationshipIds: readonly string[];
    maximumResults: number;
  },
): Promise<readonly ConfirmedSourceRelationship[]> {
  if (input.canonicalRelationshipIds.length === 0) return [];
  if (!Number.isSafeInteger(input.maximumResults) || input.maximumResults < 1) {
    throw new RangeError(
      "Resolved relationship confirmation source bound is invalid.",
    );
  }
  const rows = await database.$queryRaw<ExistingConfirmationRow[]>(Prisma.sql`
    select confirmation.id as "confirmationSetId",
           confirmation.source_revision_id as "sourceRevisionId",
           confirmation.semantic_observation_id as "semanticObservationId",
           confirmation.source_entity_id as "sourceEntityId",
           confirmation.source_canonical_revision_id as
             "sourceCanonicalRevisionId",
           confirmation.source_canonical_content_hash as
             "sourceCanonicalContentHash",
           confirmation.declaration_hash as "declarationHash",
           confirmation.relationship_count as "relationshipCount",
           confirmation.public_change_sequence as
             "confirmationPublicChangeSequence",
           item.confirmation_public_change_sequence as
             "itemConfirmationPublicChangeSequence",
           item.heat_effective_public_change_sequence as
             "heatEffectivePublicChangeSequence",
           confirmation.confirmed_at as "confirmedAt",
           item.canonical_relationship_id as "canonicalRelationshipId",
           item.relationship_kind as "relationshipKind",
           item.target_platform_key as "targetPlatformKey",
           item.target_record_kind::text as "targetRecordKind",
           item.target_external_id as "targetExternalId",
           relationship.resolved_public_change_sequence as
             "resolvedPublicChangeSequence",
           relationship.resolved_at as "resolvedAt"
    from public.source_relationship_confirmations as item
    join public.source_relationship_confirmation_sets as confirmation
      on confirmation.id = item.confirmation_set_id
     and confirmation.organization_id = item.organization_id
    join public.canonical_relationships as relationship
      on relationship.id = item.canonical_relationship_id
     and relationship.organization_id = item.organization_id
    where item.organization_id = ${uuid(input.organizationId)}
      and item.canonical_relationship_id in (
        ${Prisma.join(input.canonicalRelationshipIds.map(uuid))}
      )
    order by item.canonical_relationship_id,
             confirmation.public_change_sequence asc,
             confirmation.id asc
    limit ${input.maximumResults + 1}
  `);
  return mapConfirmedRelationships(rows);
}

export function isProviderV1PullRelationshipIdentity(input: {
  recordKind: CanonicalRecordKind;
  relationshipKind: string;
  targetRecordKind: CanonicalRecordKind;
  targetExternalId: string | null;
}): input is typeof input & {
  relationshipKind: "card" | "pack";
  targetRecordKind: "catalog_asset" | "pack";
  targetExternalId: string;
} {
  return input.recordKind === "pull"
    && input.targetExternalId !== null
    && (
      (input.relationshipKind === "card"
        && input.targetRecordKind === "catalog_asset")
      || (input.relationshipKind === "pack"
        && input.targetRecordKind === "pack")
    );
}
