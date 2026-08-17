import {
  approvedPublicCatalogConfigurationV1Schema,
  sha256CanonicalJson,
  type ApprovedPublicCatalogConfigurationV1,
  type ApprovedPublicRepackIdentityMapping,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import type {
  PackscoutPrismaClient,
  PackscoutQueryClient,
  PackscoutTransactionClient,
} from "./database.ts";
import {
  advanceSettledPublicWatermark,
  allocatePublicChangeCauses,
} from "./public-change-settlement-repository.ts";

export const PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN =
  "packscout.public-catalog.configuration.v1" as const;

export class ApprovedPublicCatalogConfigurationPersistenceError extends Error {
  constructor(
    readonly code:
      | "PUBLIC_CONFIGURATION_INVALID"
      | "PUBLIC_CONFIGURATION_PLATFORM_LIMIT_EXCEEDED"
      | "PUBLIC_CONFIGURATION_PLATFORM_UNREGISTERED"
      | "PUBLIC_CONFIGURATION_PROMOTION_RECOVERY_REQUIRED" =
        "PUBLIC_CONFIGURATION_INVALID",
  ) {
    super("Approved public catalog configuration is invalid.");
    this.name = "ApprovedPublicCatalogConfigurationPersistenceError";
  }
}

export type CatalogCanonicalRecordKind =
  | "platform" | "pack" | "catalog_asset" | "ev_input" | "estimated_ev";

export interface CatalogCanonicalRevisionSnapshot {
  readonly entityId: string;
  readonly platformKey: string;
  readonly recordKind: CatalogCanonicalRecordKind;
  readonly externalId: string;
  readonly content: unknown;
  readonly sourceUpdatedAt: Date;
  readonly sourceCollectedAt: Date;
  readonly acceptedAt: Date;
  readonly publicChangeSequence: bigint;
}

export interface CatalogProviderReadinessSnapshot {
  readonly platformKey: string;
  readonly state: string | null;
  readonly lifecycleSequence: bigint | null;
  readonly configurationRevisionId: string | null;
  readonly completedBackfillAt: Date | null;
}

export interface GovernedPublicRepackIdentity {
  readonly platformKey: string;
  readonly packExternalId: string;
  readonly publicRepackId: string;
  readonly approvedConfigurationKey: string;
  readonly publicChangeSequence: bigint;
  readonly approvedAt: Date;
}

export interface ApprovedPublicCatalogConfigurationRecord {
  readonly id: string;
  readonly configuration: ApprovedPublicCatalogConfigurationV1;
  readonly configurationHash: string;
  readonly publicChangeSequence: bigint;
}

export interface CatalogReleaseSourceSnapshot {
  readonly configuration: ApprovedPublicCatalogConfigurationRecord | null;
  readonly revisions: readonly CatalogCanonicalRevisionSnapshot[];
  readonly providers: readonly CatalogProviderReadinessSnapshot[];
  readonly repackIdentities: readonly GovernedPublicRepackIdentity[];
}

export interface CatalogReleaseSourceRepository {
  loadSnapshot(input: {
    throughSequence: bigint;
    throughOccurredAt: Date;
  }): Promise<CatalogReleaseSourceSnapshot>;
}

export interface ApprovedPublicRepackIdentityMaterializer {
  materializeApprovedMappings(
    database: PackscoutTransactionClient,
    input: {
      organizationId: string;
      approvedConfigurationKey: string;
      publicChangeSequence: bigint;
      approvedAt: Date;
      mappings: readonly ApprovedPublicRepackIdentityMapping[];
    },
  ): Promise<void>;
}

interface ConfigRow {
  id: string;
  configurationJson: unknown;
  configurationHash: string;
  publicChangeSequence: bigint;
}

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

export class PrismaCatalogReleaseSourceRepository
  implements CatalogReleaseSourceRepository
{
  constructor(
    private readonly database: PackscoutPrismaClient,
    private readonly organizationId: string,
  ) {}

  async approveConfiguration(
    input: ApprovedPublicCatalogConfigurationV1,
    identityMaterializer: ApprovedPublicRepackIdentityMaterializer,
  ): Promise<ApprovedPublicCatalogConfigurationRecord> {
    const parsed = approvedPublicCatalogConfigurationV1Schema.safeParse(input);
    if (!parsed.success) {
      const platformLimitExceeded = parsed.error.issues.some(
        ({ message }) => message === "public_config.platform_limit_exceeded",
      );
      throw new ApprovedPublicCatalogConfigurationPersistenceError(
        platformLimitExceeded
          ? "PUBLIC_CONFIGURATION_PLATFORM_LIMIT_EXCEEDED"
          : "PUBLIC_CONFIGURATION_INVALID",
      );
    }
    const configuration = parsed.data;
    const configurationHash = await sha256CanonicalJson(
      PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN,
      configuration,
    );
    const approvedAt = new Date(configuration.approvedAt);
    return this.database.$transaction(async (transaction) => {
      const promotionGuard = await transaction.$queryRaw<
        Array<{ result: "allowed" | "promotion_recovery_required" }>
      >(Prisma.sql`
        select public.prepare_catalog_configuration_provider_set_change(
          ${uuid(this.organizationId)},
          cast(${JSON.stringify(configuration)} as jsonb),
          ${approvedAt}
        ) as result
      `);
      if (promotionGuard[0]?.result !== "allowed") {
        throw new ApprovedPublicCatalogConfigurationPersistenceError(
          "PUBLIC_CONFIGURATION_PROMOTION_RECOVERY_REQUIRED",
        );
      }
      const registeredPlatforms = await transaction.$queryRaw<
        Array<{ platformKey: string }>
      >(Prisma.sql`
        select platform_key as "platformKey"
        from public.provider_sources
        where organization_id = ${uuid(this.organizationId)}
          and platform_key in (${Prisma.join(
            configuration.platforms.map(({ platformKey }) => platformKey),
          )})
        order by platform_key collate "C"
        for share
      `);
      const configuredPlatformKeys = configuration.platforms.map(
        ({ platformKey }) => platformKey,
      );
      if (
        registeredPlatforms.length !== configuredPlatformKeys.length ||
        registeredPlatforms.some(
          ({ platformKey }, index) =>
            platformKey !== configuredPlatformKeys[index],
        )
      ) {
        throw new ApprovedPublicCatalogConfigurationPersistenceError(
          "PUBLIC_CONFIGURATION_PLATFORM_UNREGISTERED",
        );
      }
      const [cause] = await allocatePublicChangeCauses(transaction, {
        organizationId: this.organizationId,
        changes: [{
          changeKind: "public_configuration",
          entityKey: `public-catalog-configuration:v1:${configuration.configurationKey}`,
          sourceKey: "packscout-public-catalog",
          sourceRevisionKey: configuration.configurationKey,
          metadata: {
            configurationKey: configuration.configurationKey,
            revision: configuration.revision,
            configurationHash,
          },
          occurredAt: approvedAt,
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: configuredPlatformKeys,
            sharedConfigurationEpoch: {
              configurationKey: configuration.configurationKey,
              revision: configuration.revision,
              configurationHash,
            },
          },
        }],
      });
      if (!cause) throw new Error("Public configuration cause was not allocated.");
      const created = await transaction.approved_public_catalog_configurations.create({
        data: {
          organization_id: this.organizationId,
          configuration_key: configuration.configurationKey,
          revision: configuration.revision,
          configuration_json: configuration as Prisma.InputJsonValue,
          configuration_hash: configurationHash,
          approved_at: approvedAt,
          public_change_sequence: cause.sequence,
          created_at: approvedAt,
        },
      });
      await identityMaterializer.materializeApprovedMappings(transaction, {
        organizationId: this.organizationId,
        approvedConfigurationKey: configuration.configurationKey,
        publicChangeSequence: cause.sequence,
        approvedAt,
        mappings: configuration.repacks,
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId: this.organizationId,
        settledAt: approvedAt,
      });
      return {
        id: created.id,
        configuration,
        configurationHash,
        publicChangeSequence: cause.sequence,
      };
    });
  }

  async loadSnapshot(input: {
    throughSequence: bigint;
    throughOccurredAt: Date;
  }): Promise<CatalogReleaseSourceSnapshot> {
    return this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`set transaction read only`);
      const configurationRows = await transaction.$queryRaw<ConfigRow[]>(Prisma.sql`
        select id, configuration_json as "configurationJson",
               configuration_hash as "configurationHash",
               public_change_sequence as "publicChangeSequence"
        from public.approved_public_catalog_configurations
        where organization_id = ${uuid(this.organizationId)}
          and public_change_sequence <= ${input.throughSequence}
        order by public_change_sequence desc, revision desc
        limit 1
      `);
      const revisions = await this.loadRevisions(
        transaction,
        input.throughSequence,
      );
      const providers = await this.loadProviders(transaction, input);
      const identities = await this.loadRepackIdentities(
        transaction,
        input.throughSequence,
      );
      const row = configurationRows[0];
      const parsed = row === undefined
        ? null : approvedPublicCatalogConfigurationV1Schema.safeParse(
          row.configurationJson,
        );
      if (parsed !== null && !parsed.success) {
        throw new ApprovedPublicCatalogConfigurationPersistenceError();
      }
      const configuration = row === undefined || parsed === null || !parsed.success
        ? null : {
            id: row.id,
            configuration: parsed.data,
            configurationHash: row.configurationHash,
            publicChangeSequence: row.publicChangeSequence,
          };
      if (configuration !== null) {
        const recomputed = await sha256CanonicalJson(
          PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN,
          configuration.configuration,
        );
        if (recomputed !== configuration.configurationHash) {
          throw new ApprovedPublicCatalogConfigurationPersistenceError();
        }
      }
      return { configuration, revisions, providers, repackIdentities: identities };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  private loadRevisions(database: PackscoutQueryClient, throughSequence: bigint) {
    return database.$queryRaw<CatalogCanonicalRevisionSnapshot[]>(Prisma.sql`
      select distinct on (entity.id)
             entity.id as "entityId", entity.platform_key as "platformKey",
             entity.record_kind::text as "recordKind", entity.external_id as "externalId",
             revision.content_json as content,
             revision.source_updated_at as "sourceUpdatedAt",
             revision.source_collected_at as "sourceCollectedAt",
             revision.accepted_at as "acceptedAt",
             revision.public_change_sequence as "publicChangeSequence"
      from public.canonical_entities entity
      join public.canonical_revisions revision on revision.entity_id = entity.id
      where entity.organization_id = ${uuid(this.organizationId)}
        and revision.organization_id = ${uuid(this.organizationId)}
        and revision.public_change_sequence <= ${throughSequence}
        and entity.record_kind in ('platform', 'pack', 'catalog_asset', 'ev_input', 'estimated_ev')
      order by entity.id, revision.public_change_sequence desc, revision.revision_number desc
    `);
  }

  private loadProviders(
    database: PackscoutQueryClient,
    input: { throughSequence: bigint; throughOccurredAt: Date },
  ) {
    return database.$queryRaw<CatalogProviderReadinessSnapshot[]>(Prisma.sql`
      with lifecycle as (
        select distinct on (cause.source_key)
               cause.source_key as "platformKey",
               cause.metadata_json->>'state' as state,
               cause.sequence as "lifecycleSequence",
               cause.metadata_json->>'configurationRevisionId' as "configurationRevisionId"
        from public.public_change_causes cause
        where cause.organization_id = ${uuid(this.organizationId)}
          and cause.sequence <= ${input.throughSequence}
          and cause.change_kind in ('provider_lifecycle', 'public_configuration')
          and cause.source_key is not null
          and cause.metadata_json ? 'platformKey'
        order by cause.source_key, cause.sequence desc
      ), backfill as (
        select provider.platform_key as "platformKey",
               lifecycle."configurationRevisionId",
               max(run.finished_at) as "completedBackfillAt"
        from public.provider_sources provider
        left join lifecycle on lifecycle."platformKey" = provider.platform_key
        left join public.import_runs run
          on run.provider_id = provider.id
         and run.organization_id = provider.organization_id
         and run.config_revision_id::text = lifecycle."configurationRevisionId"
         and run.state = 'succeeded'
         and run.reached_provider_head = true
         and run.finished_at <= ${input.throughOccurredAt}
        where provider.organization_id = ${uuid(this.organizationId)}
        group by provider.platform_key, lifecycle."configurationRevisionId"
      )
      select backfill."platformKey", lifecycle.state,
             lifecycle."lifecycleSequence", lifecycle."configurationRevisionId",
             backfill."completedBackfillAt"
      from backfill left join lifecycle
        on lifecycle."platformKey" = backfill."platformKey"
      order by backfill."platformKey"
    `);
  }

  private loadRepackIdentities(
    database: PackscoutQueryClient,
    throughSequence: bigint,
  ) {
    return database.$queryRaw<GovernedPublicRepackIdentity[]>(Prisma.sql`
      select platform_key as "platformKey", pack_external_id as "packExternalId",
             public_repack_id::text as "publicRepackId",
             approved_configuration_key as "approvedConfigurationKey",
             public_change_sequence as "publicChangeSequence",
             approved_at as "approvedAt"
      from public.public_repack_identity_mappings
      where organization_id = ${uuid(this.organizationId)}
        and public_change_sequence <= ${throughSequence}
      order by platform_key, pack_external_id
    `);
  }
}
