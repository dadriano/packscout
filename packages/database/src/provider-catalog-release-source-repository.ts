import {
  approvedPublicCatalogConfigurationV1Schema,
  containsProtectedPublicationField,
  sha256CanonicalJson,
  type ApprovedPublicCatalogConfigurationV1,
  type ApprovedPublicCollectibleMapping,
  type ApprovedPublicPlatformConfiguration,
  type ApprovedPublicRepackIdentityMapping,
  type PublicCategory,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import { PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN } from "./catalog-release-source-repository.ts";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutTransactionClient,
} from "./database.ts";
import type {
  ProviderCausalReadinessRecord,
  ProviderCatalogCheckpointRecord,
  SharedPublicConfigurationEpochRecord,
} from "./public-change-settlement-repository.provider-read.ts";
import {
  loadProviderCausalReadinessInTransaction,
  ProviderCausalReadinessPersistenceError,
} from "./public-change-settlement-repository.provider-read.ts";
import { loadProviderV1AssetPackAssociations } from
  "./provider-v1-asset-pack-association-reader.ts";
import { assertCanonicalActorDataSafe } from "./security.ts";
import {
  loadProviderV1RelationshipConfirmationReadiness,
  providerV1ConfirmedRelationshipCtes,
} from "./source-relationship-confirmation-repository.ts";

export type ProviderCatalogReleaseSourceErrorCode =
  | "PROVIDER_RELEASE_SCOPE_MISMATCH"
  | "PROVIDER_RELEASE_CHECKPOINT_UNSETTLED"
  | "PROVIDER_RELEASE_CHECKPOINT_REGRESSED"
  | "PROVIDER_RELEASE_EPOCH_MISMATCH"
  | "PROVIDER_RELEASE_LIFECYCLE_INELIGIBLE"
  | "PROVIDER_RELEASE_BACKFILL_INCOMPLETE"
  | "PROVIDER_RELEASE_SOURCE_INVALID"
  | "PROVIDER_RELEASE_PROTECTED_FIELD";

export class ProviderCatalogReleaseSourcePersistenceError extends Error {
  constructor(readonly code: ProviderCatalogReleaseSourceErrorCode) {
    super("Provider catalog release source state is unavailable or invalid.");
    this.name = "ProviderCatalogReleaseSourcePersistenceError";
  }
}

export interface ProviderCatalogReleaseCheckpointSnapshot {
  readonly platformKey: string;
  readonly sharedConfigurationEpoch: SharedPublicConfigurationEpochRecord;
  readonly settledSequence: bigint;
  readonly sourceHeadSequence: bigint;
  readonly settledAt: Date;
  readonly sourceHeadAt: Date;
}

export interface ProviderCatalogReleaseConfigurationSnapshot {
  readonly schemaVersion: ApprovedPublicCatalogConfigurationV1["schemaVersion"];
  readonly configurationKey: string;
  readonly revision: number;
  readonly approvedAt: string;
  readonly staleAfterSeconds: number;
  readonly confidencePolicy: ApprovedPublicCatalogConfigurationV1["confidencePolicy"];
  readonly publicAssetOrigins: readonly string[];
  readonly verifiedUsdStablecoins: readonly string[];
  readonly categories: readonly PublicCategory[];
  readonly platform: ApprovedPublicPlatformConfiguration;
  readonly repacks: readonly ApprovedPublicRepackIdentityMapping[];
  readonly collectibles: readonly ApprovedPublicCollectibleMapping[];
  readonly configurationHash: string;
  readonly publicChangeSequence: bigint;
}

export interface ProviderCatalogReleaseReadinessSnapshot {
  readonly lifecycleState: "active";
  readonly lifecycleSequence: bigint;
  readonly sourceRevisionId: string;
  readonly completedBackfillAt: Date;
}

export type ProviderCatalogCanonicalRecordKind =
  | "platform" | "pack" | "catalog_asset" | "ev_input" | "estimated_ev";

export interface ProviderCatalogCanonicalRevisionSnapshot {
  readonly entityId: string;
  readonly revisionId: string;
  readonly platformKey: string;
  readonly recordKind: ProviderCatalogCanonicalRecordKind;
  readonly externalId: string;
  readonly content: unknown;
  readonly sourceUpdatedAt: Date;
  readonly sourceCollectedAt: Date;
  readonly acceptedAt: Date;
  readonly publicChangeSequence: bigint;
}

export interface ProviderCatalogGovernedRepackIdentitySnapshot {
  readonly platformKey: string;
  readonly packExternalId: string;
  readonly publicRepackId: string;
  readonly approvedConfigurationKey: string;
  readonly publicChangeSequence: bigint;
  readonly approvedAt: Date;
}

export interface ProviderCatalogAssetPackAssociationSnapshot {
  readonly sourceEntityId: string;
  readonly platformKey: string;
  readonly assetExternalId: string;
  readonly packExternalId: string;
  readonly associatedAt: Date;
  readonly publicChangeSequence: bigint;
}

export interface ProviderCatalogReleaseSourceSnapshot {
  readonly checkpoint: ProviderCatalogReleaseCheckpointSnapshot;
  readonly configuration: ProviderCatalogReleaseConfigurationSnapshot;
  readonly readiness: ProviderCatalogReleaseReadinessSnapshot;
  readonly revisions: readonly ProviderCatalogCanonicalRevisionSnapshot[];
  readonly assetPackAssociations:
    readonly ProviderCatalogAssetPackAssociationSnapshot[];
  readonly repackIdentities: readonly ProviderCatalogGovernedRepackIdentitySnapshot[];
  readonly observation: Readonly<{ lastSuccessfulObservationAt: Date }>;
}

export interface ProviderCatalogReleaseSourceRepository {
  loadProviderSnapshot(input: Readonly<{
    checkpoint: ProviderCatalogCheckpointRecord;
  }>): Promise<ProviderCatalogReleaseSourceSnapshot>;
}

interface CheckpointRow {
  platformKey: string;
  settledSequence: bigint;
  sourceHeadSequence: bigint;
  settledAt: Date | null;
  sourceHeadAt: Date | null;
}

interface ConfigurationRow {
  configurationKey: string;
  revision: number;
  publicChangeSequence: bigint;
  configurationHash: string;
  configurationJson: unknown;
}

interface RevisionRow extends ProviderCatalogCanonicalRevisionSnapshot {
  catalogImpactMatches: boolean;
}

type ReadyProviderCatalogCheckpointRecord = ProviderCatalogCheckpointRecord &
  Readonly<{ settledAt: Date }>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const platformKeyPattern = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

function refuse(code: ProviderCatalogReleaseSourceErrorCode): never {
  throw new ProviderCatalogReleaseSourcePersistenceError(code);
}

function sameDate(left: Date | null, right: Date): boolean {
  return left !== null && left.getTime() === right.getTime();
}

function sameEpoch(
  row: ConfigurationRow,
  epoch: SharedPublicConfigurationEpochRecord,
): boolean {
  return row.configurationKey === epoch.configurationKey &&
    row.revision === epoch.revision &&
    row.publicChangeSequence === epoch.publicChangeSequence &&
    row.configurationHash === epoch.configurationHash;
}

function assertInputReady(
  checkpoint: ProviderCatalogCheckpointRecord,
  organizationId: string,
  platformKey: string,
): asserts checkpoint is ReadyProviderCatalogCheckpointRecord {
  if (checkpoint.organizationId !== organizationId ||
      checkpoint.platformKey !== platformKey) {
    refuse("PROVIDER_RELEASE_SCOPE_MISMATCH");
  }
  if (checkpoint.blockedState.kind !== "ready" ||
      checkpoint.settledSequence <= 0n ||
      checkpoint.settledSequence !== checkpoint.sourceHeadSequence ||
      checkpoint.sharedConfigurationEpoch.publicChangeSequence >
        checkpoint.settledSequence) {
    refuse("PROVIDER_RELEASE_CHECKPOINT_UNSETTLED");
  }
  if (checkpoint.settledAt === null ||
      !Number.isFinite(checkpoint.settledAt.getTime()) ||
      !Number.isFinite(checkpoint.sourceHeadAt.getTime())) {
    refuse("PROVIDER_RELEASE_SOURCE_INVALID");
  }
}

function configurationSlice(
  configuration: ApprovedPublicCatalogConfigurationV1,
  row: ConfigurationRow,
  platformKey: string,
): ProviderCatalogReleaseConfigurationSnapshot {
  const platform = configuration.platforms.find(
    (candidate) => candidate.platformKey === platformKey,
  );
  if (!platform) refuse("PROVIDER_RELEASE_SCOPE_MISMATCH");
  return Object.freeze({
    schemaVersion: configuration.schemaVersion,
    configurationKey: configuration.configurationKey,
    revision: configuration.revision,
    approvedAt: configuration.approvedAt,
    staleAfterSeconds: configuration.staleAfterSeconds,
    confidencePolicy: Object.freeze({ ...configuration.confidencePolicy }),
    publicAssetOrigins: Object.freeze([...configuration.publicAssetOrigins]),
    verifiedUsdStablecoins: Object.freeze([
      ...configuration.verifiedUsdStablecoins,
    ]),
    categories: Object.freeze(configuration.categories.map((value) =>
      Object.freeze(structuredClone(value)))),
    platform: Object.freeze(structuredClone(platform)),
    repacks: Object.freeze(configuration.repacks
      .filter((value) => value.platformKey === platformKey)
      .map((value) => Object.freeze({ ...value }))),
    collectibles: Object.freeze(configuration.collectibles
      .filter((value) => value.platformKey === platformKey)
      .map((value) => Object.freeze(structuredClone(value)))),
    configurationHash: row.configurationHash,
    publicChangeSequence: row.publicChangeSequence,
  });
}

export class PrismaProviderCatalogReleaseSourceRepository
  implements ProviderCatalogReleaseSourceRepository
{
  readonly #organizationId: string;
  readonly #platformKey: string;

  constructor(
    private readonly database: PackscoutPrismaClient,
    binding: Readonly<{ organizationId: string; platformKey: string }>,
  ) {
    if (!uuidPattern.test(binding.organizationId) ||
        binding.platformKey.length > 128 ||
        !platformKeyPattern.test(binding.platformKey)) {
      throw new RangeError("Provider catalog release source binding is invalid.");
    }
    this.#organizationId = binding.organizationId.toLowerCase();
    this.#platformKey = binding.platformKey;
  }

  async loadProviderSnapshot(input: Readonly<{
    checkpoint: ProviderCatalogCheckpointRecord;
  }>): Promise<ProviderCatalogReleaseSourceSnapshot> {
    const checkpoint = input.checkpoint;
    assertInputReady(checkpoint, this.#organizationId, this.#platformKey);
    return this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`set transaction read only`);
      await this.assertPersistedCheckpoint(transaction, checkpoint);
      const lifecycleDecisionSequence =
        await this.loadLifecycleDecisionSequence(transaction);
      const configuration = await this.loadConfiguration(
        transaction,
        checkpoint.sharedConfigurationEpoch,
      );
      const readiness = await this.loadReadiness(
        transaction,
        checkpoint,
        lifecycleDecisionSequence,
      );
      const relationshipReadiness =
        await loadProviderV1RelationshipConfirmationReadiness(transaction, {
          organizationId: this.#organizationId,
          providerId: readiness.providerId,
          sourceInstanceId: readiness.sourceInstanceId,
          sourceRevisionId: readiness.sourceRevisionId,
        });
      if (!relationshipReadiness.ready) {
        refuse("PROVIDER_RELEASE_BACKFILL_INCOMPLETE");
      }
      const revisions = await this.loadRevisions(
        transaction,
        checkpoint.settledSequence,
      );
      const assetPackAssociations = await this.loadAssetPackAssociations(
        transaction,
        checkpoint.settledSequence,
        checkpoint.settledAt,
        readiness.sourceRevisionId,
      );
      const repackIdentities = await this.loadRepackIdentities(
        transaction,
        checkpoint.settledSequence,
        configuration.repacks.map(({ packExternalId }) => packExternalId),
      );
      await this.assertCompleteSource(
        transaction,
        checkpoint.settledSequence,
        readiness.sourceRevisionId,
        configuration,
        revisions,
        assetPackAssociations,
        repackIdentities,
      );
      return Object.freeze({
        checkpoint: Object.freeze({
          platformKey: this.#platformKey,
          sharedConfigurationEpoch: Object.freeze({
            ...checkpoint.sharedConfigurationEpoch,
          }),
          settledSequence: checkpoint.settledSequence,
          sourceHeadSequence: checkpoint.sourceHeadSequence,
          settledAt: new Date(checkpoint.settledAt.getTime()),
          sourceHeadAt: new Date(checkpoint.sourceHeadAt.getTime()),
        }),
        configuration,
        readiness: Object.freeze({
          lifecycleState: "active",
          lifecycleSequence: readiness.lifecycleSequence,
          sourceRevisionId: readiness.sourceRevisionId,
          completedBackfillAt: new Date(readiness.completedBackfillAt.getTime()),
        }),
        revisions: Object.freeze(revisions),
        assetPackAssociations: Object.freeze(assetPackAssociations),
        repackIdentities: Object.freeze(repackIdentities),
        observation: Object.freeze({
          lastSuccessfulObservationAt: new Date(
            readiness.lastSuccessfulObservationAt.getTime(),
          ),
        }),
      });
    }, {
      ...PACKSCOUT_TRANSACTION_OPTIONS,
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }

  private async assertPersistedCheckpoint(
    database: PackscoutTransactionClient,
    requested: ReadyProviderCatalogCheckpointRecord,
  ): Promise<void> {
    const rows = await database.$queryRaw<CheckpointRow[]>(Prisma.sql`
      select platform_key as "platformKey", settled_sequence as "settledSequence",
             source_head_sequence as "sourceHeadSequence",
             settled_at as "settledAt", source_head_at as "sourceHeadAt"
      from public.provider_catalog_checkpoints
      where organization_id = ${uuid(this.#organizationId)}
        and platform_key = ${this.#platformKey}
    `);
    const row = rows[0];
    if (!row) refuse("PROVIDER_RELEASE_SCOPE_MISMATCH");
    if (row.settledSequence > requested.settledSequence ||
        row.sourceHeadSequence > requested.sourceHeadSequence) {
      refuse("PROVIDER_RELEASE_CHECKPOINT_REGRESSED");
    }
    if (row.settledSequence !== requested.settledSequence ||
        row.sourceHeadSequence !== requested.sourceHeadSequence ||
        !sameDate(row.settledAt, requested.settledAt) ||
        !sameDate(row.sourceHeadAt, requested.sourceHeadAt)) {
      refuse("PROVIDER_RELEASE_CHECKPOINT_UNSETTLED");
    }
  }

  private async loadConfiguration(
    database: PackscoutTransactionClient,
    epoch: SharedPublicConfigurationEpochRecord,
  ): Promise<ProviderCatalogReleaseConfigurationSnapshot> {
    const rows = await database.$queryRaw<ConfigurationRow[]>(Prisma.sql`
      select approved.configuration_key as "configurationKey",
             approved.revision,
             approved.public_change_sequence as "publicChangeSequence",
             approved.configuration_hash as "configurationHash",
             approved.configuration_json as "configurationJson"
      from public.catalog_manifest_lifecycle_checkpoints as lifecycle
      join lateral (
        select configuration.*
        from public.public_change_catalog_impacts as impact
        join public.approved_public_catalog_configurations as configuration
          on configuration.organization_id = impact.organization_id
         and configuration.public_change_sequence = impact.cause_sequence
         and configuration.configuration_key = impact.shared_configuration_key
         and configuration.revision = impact.shared_configuration_revision
         and configuration.configuration_hash = impact.shared_configuration_hash
        where impact.organization_id = lifecycle.organization_id
          and impact.shared_configuration_hash is not null
          and impact.cause_sequence <= lifecycle.settled_sequence
        order by impact.cause_sequence desc
        limit 1
      ) as approved on true
      where lifecycle.organization_id = ${uuid(this.#organizationId)}
    `);
    const row = rows[0];
    if (!row || !sameEpoch(row, epoch)) {
      refuse("PROVIDER_RELEASE_EPOCH_MISMATCH");
    }
    const parsed = approvedPublicCatalogConfigurationV1Schema.safeParse(
      row.configurationJson,
    );
    if (!parsed.success ||
        parsed.data.configurationKey !== row.configurationKey ||
        parsed.data.revision !== row.revision ||
        await sha256CanonicalJson(
          PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN,
          parsed.data,
        ) !== row.configurationHash) {
      refuse("PROVIDER_RELEASE_SOURCE_INVALID");
    }
    return configurationSlice(parsed.data, row, this.#platformKey);
  }

  private async loadLifecycleDecisionSequence(
    database: PackscoutTransactionClient,
  ): Promise<bigint> {
    const rows = await database.$queryRaw<
      Array<{ lifecycleDecisionSequence: bigint }>
    >(Prisma.sql`
      select settled_sequence as "lifecycleDecisionSequence"
      from public.catalog_manifest_lifecycle_checkpoints
      where organization_id = ${uuid(this.#organizationId)}
    `);
    if (!rows[0]) refuse("PROVIDER_RELEASE_EPOCH_MISMATCH");
    return rows[0].lifecycleDecisionSequence;
  }

  private async loadReadiness(
    database: PackscoutTransactionClient,
    checkpoint: ReadyProviderCatalogCheckpointRecord,
    lifecycleDecisionSequence: bigint,
  ): Promise<Readonly<{
    lifecycleSequence: bigint;
    providerId: string;
    sourceInstanceId: string;
    sourceRevisionId: string;
    completedBackfillAt: Date;
    lastSuccessfulObservationAt: Date;
  }>> {
    let row: ProviderCausalReadinessRecord | undefined;
    try {
      [row] = await loadProviderCausalReadinessInTransaction(database, {
        organizationId: this.#organizationId,
        checkpoints: [checkpoint],
        lifecycleDecisionSequence,
      });
    } catch (error) {
      if (error instanceof ProviderCausalReadinessPersistenceError &&
          error.code === "LIFECYCLE_INELIGIBLE") {
        refuse("PROVIDER_RELEASE_LIFECYCLE_INELIGIBLE");
      }
      refuse("PROVIDER_RELEASE_SOURCE_INVALID");
    }
    if (!row || row.platformKey !== this.#platformKey ||
        !uuidPattern.test(row.sourceRevisionId)) {
      refuse("PROVIDER_RELEASE_SOURCE_INVALID");
    }
    if (!row.completedBackfillAt || !row.lastSuccessfulObservationAt) {
      refuse("PROVIDER_RELEASE_BACKFILL_INCOMPLETE");
    }
    return {
      lifecycleSequence: row.lifecycleSequence,
      providerId: row.providerId,
      sourceInstanceId: row.sourceInstanceId,
      sourceRevisionId: row.sourceRevisionId,
      completedBackfillAt: row.completedBackfillAt,
      lastSuccessfulObservationAt: row.lastSuccessfulObservationAt,
    };
  }

  private async loadRevisions(
    database: PackscoutTransactionClient,
    throughSequence: bigint,
  ): Promise<ProviderCatalogCanonicalRevisionSnapshot[]> {
    const rows = await database.$queryRaw<RevisionRow[]>(Prisma.sql`
      select entity.id::text as "entityId",
             revision.id::text as "revisionId",
             entity.platform_key as "platformKey",
             entity.record_kind::text as "recordKind",
             entity.external_id as "externalId", revision.content_json as content,
             revision.source_updated_at as "sourceUpdatedAt",
             revision.source_collected_at as "sourceCollectedAt",
             revision.accepted_at as "acceptedAt",
             revision.public_change_sequence as "publicChangeSequence",
             exists (
               select 1 from public.public_change_catalog_impacts as impact
               where impact.organization_id = revision.organization_id
                 and impact.cause_sequence = revision.public_change_sequence
                 and ${this.#platformKey} = any(impact.provider_platform_keys)
             ) as "catalogImpactMatches"
      from public.canonical_entities as entity
      join public.canonical_revisions as revision
        on revision.id = entity.current_revision_id
       and revision.entity_id = entity.id
       and revision.organization_id = entity.organization_id
      where entity.organization_id = ${uuid(this.#organizationId)}
        and entity.platform_key = ${this.#platformKey}
        and entity.record_kind in (
          'platform', 'pack', 'catalog_asset', 'ev_input', 'estimated_ev'
        )
      order by entity.record_kind::text collate "C",
               entity.external_id collate "C", entity.id::text collate "C"
    `);
    const identities = new Set<string>();
    return rows.map((row) => {
      const key = `${row.recordKind}\u0000${row.externalId}`;
      if (row.publicChangeSequence > throughSequence) {
        refuse("PROVIDER_RELEASE_SCOPE_MISMATCH");
      }
      if (identities.has(key) || !row.catalogImpactMatches) {
        refuse("PROVIDER_RELEASE_SOURCE_INVALID");
      }
      identities.add(key);
      if (containsProtectedPublicationField(row.content)) {
        refuse("PROVIDER_RELEASE_PROTECTED_FIELD");
      }
      try {
        assertCanonicalActorDataSafe(row.content);
      } catch {
        refuse("PROVIDER_RELEASE_PROTECTED_FIELD");
      }
      return Object.freeze({
        entityId: row.entityId,
        revisionId: row.revisionId,
        platformKey: row.platformKey,
        recordKind: row.recordKind,
        externalId: row.externalId,
        content: row.content,
        sourceUpdatedAt: row.sourceUpdatedAt,
        sourceCollectedAt: row.sourceCollectedAt,
        acceptedAt: row.acceptedAt,
        publicChangeSequence: row.publicChangeSequence,
      });
    });
  }

  private async loadRepackIdentities(
    database: PackscoutTransactionClient,
    throughSequence: bigint,
    configuredPackExternalIds: readonly string[],
  ): Promise<ProviderCatalogGovernedRepackIdentitySnapshot[]> {
    if (configuredPackExternalIds.length === 0) return [];
    return database.$queryRaw<ProviderCatalogGovernedRepackIdentitySnapshot[]>(
      Prisma.sql`
        select platform_key as "platformKey", pack_external_id as "packExternalId",
               public_repack_id::text as "publicRepackId",
               approved_configuration_key as "approvedConfigurationKey",
               public_change_sequence as "publicChangeSequence",
               approved_at as "approvedAt"
        from public.public_repack_identity_mappings
        where organization_id = ${uuid(this.#organizationId)}
          and platform_key = ${this.#platformKey}
          and public_change_sequence <= ${throughSequence}
          and pack_external_id = any(${[...configuredPackExternalIds]}::text[])
        order by pack_external_id collate "C", public_repack_id::text collate "C"
      `,
    );
  }

  private async loadAssetPackAssociations(
    database: PackscoutTransactionClient,
    throughSequence: bigint,
    throughOccurredAt: Date,
    sourceRevisionId: string,
  ): Promise<ProviderCatalogAssetPackAssociationSnapshot[]> {
    const rows = await loadProviderV1AssetPackAssociations(database, {
      organizationId: this.#organizationId,
      platformKey: this.#platformKey,
      sourceRevisionId,
      throughSequence,
      throughOccurredAt,
    });
    const sourceIds = new Set<string>();
    return rows.map((row) => {
      if (sourceIds.has(row.sourceEntityId) ||
          row.platformKey !== this.#platformKey ||
          row.publicChangeSequence > throughSequence ||
          row.associatedAt.getTime() > throughOccurredAt.getTime() ||
          !Number.isFinite(row.associatedAt.getTime())) {
        refuse("PROVIDER_RELEASE_SOURCE_INVALID");
      }
      sourceIds.add(row.sourceEntityId);
      return Object.freeze(row);
    });
  }

  private async assertCompleteSource(
    database: PackscoutTransactionClient,
    throughSequence: bigint,
    sourceRevisionId: string,
    configuration: ProviderCatalogReleaseConfigurationSnapshot,
    revisions: readonly ProviderCatalogCanonicalRevisionSnapshot[],
    associations: readonly ProviderCatalogAssetPackAssociationSnapshot[],
    identities: readonly ProviderCatalogGovernedRepackIdentitySnapshot[],
  ): Promise<void> {
    const configured = configuration.repacks.map(({ packExternalId, publicRepackId }) =>
      `${packExternalId}\u0000${publicRepackId}`);
    const governed = identities.map(({ platformKey, packExternalId, publicRepackId }) => {
      if (platformKey !== this.#platformKey) refuse("PROVIDER_RELEASE_SCOPE_MISMATCH");
      return `${packExternalId}\u0000${publicRepackId}`;
    });
    if (new Set(governed).size !== governed.length ||
        configured.length !== governed.length ||
        configured.some((value, index) => value !== governed[index])) {
      refuse("PROVIDER_RELEASE_SOURCE_INVALID");
    }
    if (revisions.some(({ platformKey, publicChangeSequence }) =>
      platformKey !== this.#platformKey || publicChangeSequence > throughSequence)) {
      refuse("PROVIDER_RELEASE_SCOPE_MISMATCH");
    }
    if (associations.some(({ platformKey, publicChangeSequence }) =>
      platformKey !== this.#platformKey || publicChangeSequence > throughSequence)) {
      refuse("PROVIDER_RELEASE_SCOPE_MISMATCH");
    }
    const invalid = await database.$queryRaw<Array<{ invalid: boolean }>>(
      Prisma.sql`
        with ${providerV1ConfirmedRelationshipCtes({
          organizationId: this.#organizationId,
          sourceRevisionId,
          throughSequence,
          materialization: "not_materialized",
        })},
        latest_v1_pull_sets as (
          select distinct on (source_entity_id) *
          from confirmed_provider_v1_pull_relationship_sets
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
        ),
        -- Complete-source validation needs the two cardinalities for every
        -- latest set. Compute them once rather than rescanning the materialized
        -- relationship CTE in two correlated subqueries per pull.
        latest_v1_pull_relationship_counts as (
          select confirmation_set_id,
                 count(*) as relationship_count,
                 count(distinct relationship_kind) as relationship_kind_count
          from latest_v1_pull_relationships
          group by confirmation_set_id
        )
        select exists (
          select 1
          from public.public_change_catalog_impacts as impact
          join public.public_derivation_obligations as obligation
            on obligation.organization_id = impact.organization_id
           and obligation.cause_sequence = impact.cause_sequence
          where impact.organization_id = ${uuid(this.#organizationId)}
            and ${this.#platformKey} = any(impact.provider_platform_keys)
            and impact.cause_sequence <= ${throughSequence}
            and obligation.state not in ('succeeded', 'business_unavailable')
        ) or exists (
          select 1
          from public.canonical_relationships as relationship
          join public.canonical_entities as source
            on source.id = relationship.source_entity_id
           and source.organization_id = relationship.organization_id
          left join public.canonical_entities as target
            on target.id = relationship.target_entity_id
           and target.organization_id = relationship.organization_id
          where relationship.organization_id = ${uuid(this.#organizationId)}
            and source.platform_key = ${this.#platformKey}
            and source.record_kind in (
              'platform', 'pack', 'catalog_asset', 'ev_input', 'estimated_ev'
            )
            and relationship.target_record_kind in (
              'platform', 'pack', 'catalog_asset', 'ev_input', 'estimated_ev'
            )
            and relationship.created_public_change_sequence <= ${throughSequence}
            and (
              not exists (
                select 1
                from public.public_change_catalog_impacts as impact
                where impact.organization_id = relationship.organization_id
                  and impact.cause_sequence =
                    relationship.created_public_change_sequence
                  and ${this.#platformKey} = any(impact.provider_platform_keys)
              )
              or relationship.target_platform_key <> ${this.#platformKey}
              or relationship.target_entity_id is null
              or relationship.resolved_public_change_sequence is null
              or relationship.resolved_public_change_sequence > ${throughSequence}
              or not exists (
                select 1
                from public.public_change_catalog_impacts as resolved_impact
                where resolved_impact.organization_id =
                    relationship.organization_id
                  and resolved_impact.cause_sequence =
                    relationship.resolved_public_change_sequence
                  and ${this.#platformKey} = any(
                    resolved_impact.provider_platform_keys
                  )
              )
              or target.id is null
              or target.platform_key is distinct from
                relationship.target_platform_key
              or target.record_kind is distinct from
                relationship.target_record_kind
              or target.external_id is distinct from
                relationship.target_external_id
              or not exists (
                select 1
                from public.canonical_revisions as target_revision
                where target_revision.organization_id =
                    relationship.organization_id
                  and target_revision.entity_id = target.id
                  and target_revision.public_change_sequence <=
                    relationship.resolved_public_change_sequence
              )
            )
        ) or exists (
          select 1
          from latest_v1_pull_relationships as relationship
          join public.canonical_entities as source
            on source.id = relationship.source_entity_id
           and source.organization_id = relationship.organization_id
          left join public.canonical_entities as target
            on target.id = relationship.target_entity_id
           and target.organization_id = relationship.organization_id
          where relationship.organization_id = ${uuid(this.#organizationId)}
            and source.platform_key = ${this.#platformKey}
            and source.record_kind = 'pull'
            and (
              not exists (
                select 1
                from public.public_change_catalog_impacts as impact
                where impact.organization_id = relationship.organization_id
                  and impact.cause_sequence =
                    relationship.confirmation_public_change_sequence
                  and ${this.#platformKey} = any(impact.provider_platform_keys)
              )
              or relationship.target_platform_key <> ${this.#platformKey}
              or relationship.target_external_id is null
              or btrim(relationship.target_external_id) = ''
              or not (
                relationship.relationship_kind = 'card'
                  and relationship.target_record_kind = 'catalog_asset'
                or relationship.relationship_kind = 'pack'
                  and relationship.target_record_kind = 'pack'
              )
              or relationship.resolved_public_change_sequence is null
                and (relationship.target_entity_id is not null
                  or relationship.resolved_at is not null)
              or (
                relationship.resolved_public_change_sequence is not null
                and (
                  relationship.target_entity_id is null
                  or relationship.resolved_at is null
                  or relationship.resolved_public_change_sequence <
                    relationship.created_public_change_sequence
                  or not exists (
                    select 1
                    from public.public_change_catalog_impacts as resolved_impact
                    join public.public_change_causes as resolved_cause
                      on resolved_cause.organization_id =
                          resolved_impact.organization_id
                     and resolved_cause.sequence =
                          resolved_impact.cause_sequence
                     and resolved_cause.change_kind =
                          'relationship_resolution'
                    where resolved_impact.organization_id =
                        relationship.organization_id
                      and resolved_impact.cause_sequence =
                        relationship.resolved_public_change_sequence
                      and ${this.#platformKey} = any(
                        resolved_impact.provider_platform_keys
                      )
                  )
                  or target.id is null
                  or target.platform_key is distinct from
                    relationship.target_platform_key
                  or target.record_kind is distinct from
                    relationship.target_record_kind
                  or target.external_id is distinct from
                    relationship.target_external_id
                  or not exists (
                    select 1
                    from public.canonical_revisions as target_revision
                    where target_revision.organization_id =
                        relationship.organization_id
                      and target_revision.entity_id = target.id
                      and target_revision.public_change_sequence <=
                        relationship.resolved_public_change_sequence
                  )
                )
              )
            )
        ) or exists (
          select 1
          from latest_v1_pull_sets as latest
          join public.canonical_entities as pull
            on pull.organization_id = latest.organization_id
           and pull.id = latest.source_entity_id
          left join latest_v1_pull_relationship_counts as present
            on present.confirmation_set_id = latest.confirmation_set_id
          where pull.platform_key <> ${this.#platformKey}
             or pull.record_kind <> 'pull'
             or latest.relationship_count not between 1 and 2
             or latest.confirmation_public_change_sequence > ${throughSequence}
             or not exists (
               select 1
               from public.canonical_revisions as source_revision
               where source_revision.organization_id = latest.organization_id
                 and source_revision.entity_id = latest.source_entity_id
                 and source_revision.id = latest.source_canonical_revision_id
                 and source_revision.public_change_sequence <=
                   latest.confirmation_public_change_sequence
             )
             or latest.relationship_count <>
               coalesce(present.relationship_count, 0)
             or coalesce(present.relationship_kind_count, 0) <>
               latest.relationship_count
        ) as invalid
      `,
    );
    if (invalid[0]?.invalid) refuse("PROVIDER_RELEASE_SOURCE_INVALID");
  }
}
