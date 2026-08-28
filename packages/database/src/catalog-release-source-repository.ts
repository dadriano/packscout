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
import { PACKSCOUT_TRANSACTION_OPTIONS } from "./database.ts";
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
      | "PUBLIC_CONFIGURATION_PREDECESSOR_MISMATCH"
      | "PUBLIC_CONFIGURATION_SOURCE_PRECONDITION_MISMATCH"
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
  readonly providerId: string | null;
  readonly sourceInstanceId: string | null;
  readonly sourceRevisionId: string | null;
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

export interface ApprovedPublicCatalogConfigurationPredecessor {
  readonly configurationKey: string;
  readonly revision: number;
  readonly configurationHash: string;
  readonly publicChangeSequence: bigint;
}

export interface ApprovedPublicCatalogConfigurationSourcePrecondition {
  readonly platformKey: string;
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  readonly cursorGeneration: bigint;
  readonly latestRunId: string;
  readonly settledSequence: bigint;
  readonly sourceHeadSequence: bigint;
  readonly nextSequence: bigint;
  readonly providerSettledSequence: bigint;
  readonly providerSourceHeadSequence: bigint;
}

export interface CatalogReleaseSourceSnapshot {
  readonly configuration: ApprovedPublicCatalogConfigurationRecord | null;
  readonly revisions: readonly CatalogCanonicalRevisionSnapshot[];
  readonly providers: readonly CatalogProviderReadinessSnapshot[];
  readonly repackIdentities: readonly GovernedPublicRepackIdentity[];
}

export interface CatalogReleaseSourceLoadInput {
  /**
   * Inclusive public-change sequence ceiling. On its own this selects a
   * sequence prefix, which is a point-in-time snapshot only when `occurred_at`
   * is monotonic with `sequence`.
   */
  throughSequence: bigint;
  /** Bounds the backfill `import_runs.finished_at` join. */
  throughOccurredAt: Date;
  /**
   * Opt-in point-in-time bound on every member of the snapshot.
   *
   * Nothing orders `public_change_causes.occurred_at` by `sequence`: causes
   * take their time from three unsynchronized clocks (the PostgreSQL clock read
   * when an ingestion transaction takes its page lock, the admin service clock,
   * and an operator-supplied approval time) while `sequence` is allocated later
   * inside the committing transaction, so a higher-sequenced cause can carry an
   * earlier time. A caller that has a read clock rather than a settled prefix
   * must therefore filter each row on its own authoritative cause row instead of
   * collapsing the clock into a maximum sequence.
   *
   * Omitting it emits exactly the sequence-prefix SQL, which is what the v2
   * catalog release assembler needs: it passes the settled watermark, a genuine
   * complete prefix, and never converts a time into a sequence.
   */
  occurredAtBound?: Date;
}

export interface CatalogReleaseSourceRepository {
  loadSnapshot(
    input: CatalogReleaseSourceLoadInput,
  ): Promise<CatalogReleaseSourceSnapshot>;
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
    options: Readonly<{
      expectedPrevious?: ApprovedPublicCatalogConfigurationPredecessor;
      expectedSource?: ApprovedPublicCatalogConfigurationSourcePrecondition;
    }> = {},
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
      if (options.expectedPrevious !== undefined) {
        const lockedOrganizations = await transaction.$queryRaw<
          Array<{ id: string }>
        >(Prisma.sql`
          select id::text as id
          from public.organizations
          where id = ${uuid(this.organizationId)}
          for update
        `);
        if (lockedOrganizations.length !== 1) {
          throw new ApprovedPublicCatalogConfigurationPersistenceError();
        }
        const previousRows = await transaction.$queryRaw<Array<{
          configurationKey: string;
          revision: number;
          configurationHash: string;
          approvedAt: Date;
          publicChangeSequence: bigint;
        }>>(Prisma.sql`
          select configuration_key as "configurationKey",
                 revision,
                 configuration_hash as "configurationHash",
                 approved_at as "approvedAt",
                 public_change_sequence as "publicChangeSequence"
          from public.approved_public_catalog_configurations
          where organization_id = ${uuid(this.organizationId)}
          order by public_change_sequence desc, revision desc
          limit 1
          for update
        `);
        const previous = previousRows[0];
        const expected = options.expectedPrevious;
        if (
          previous === undefined ||
          previous.configurationKey !== expected.configurationKey ||
          previous.revision !== expected.revision ||
          previous.configurationHash !== expected.configurationHash ||
          previous.publicChangeSequence !== expected.publicChangeSequence ||
          configuration.revision !== previous.revision + 1 ||
          configuration.configurationKey === previous.configurationKey ||
          approvedAt.getTime() <= previous.approvedAt.getTime()
        ) {
          throw new ApprovedPublicCatalogConfigurationPersistenceError(
            "PUBLIC_CONFIGURATION_PREDECESSOR_MISMATCH",
          );
        }
      }
      if (options.expectedSource !== undefined) {
        const expected = options.expectedSource;
        const guardedRows = await transaction.$queryRaw<Array<{
          qualified: boolean;
        }>>(Prisma.sql`
          select (
            watermark.settled_sequence = ${expected.settledSequence}
            and watermark.source_head_sequence = ${expected.sourceHeadSequence}
            and watermark.next_sequence = ${expected.nextSequence}
            and checkpoint.settled_sequence =
              ${expected.providerSettledSequence}
            and checkpoint.source_head_sequence =
              ${expected.providerSourceHeadSequence}
            and provider.state = 'active'
            and source.state = 'paused'
            and source.pause_requested_at is null
            and source.active_revision_id =
              cast(${expected.sourceRevisionId} as uuid)
            and cursor.source_revision_id =
              cast(${expected.sourceRevisionId} as uuid)
            and cursor.cursor_generation = ${expected.cursorGeneration}
            and run.state = 'succeeded'
            and run.reached_provider_head = true
            and run.finished_at is not null
            and run.failure_code is null
            and run.source_instance_id = source.id
            and run.source_revision_id = source.active_revision_id
            and run.cursor_generation = cursor.cursor_generation
            and not exists (
              select 1
              from public.import_runs newer
              where newer.organization_id = run.organization_id
                and newer.provider_id = run.provider_id
                and newer.source_instance_id = run.source_instance_id
                and newer.source_revision_id = run.source_revision_id
                and newer.cursor_generation = run.cursor_generation
                and (
                  newer.created_at > run.created_at
                  or (
                    newer.created_at = run.created_at
                    and newer.id > run.id
                  )
                )
            )
            and not exists (
              select 1 from public.import_runs active_run
              where active_run.organization_id = provider.organization_id
                and active_run.state in ('queued', 'running')
            )
            and not exists (
              select 1 from public.source_supervisor_epochs epoch
              where epoch.state in ('active', 'fenced_draining')
                and epoch.lease_expires_at > clock_timestamp()
            )
            and not exists (
              select 1 from public.provider_promotion_attempts attempt
              where attempt.organization_id = provider.organization_id
                and attempt.state in (
                  'assembling', 'ready', 'in_progress', 'retry_wait'
                )
            )
            and not exists (
              select 1 from public.manifest_promotion_attempts attempt
              where attempt.organization_id = provider.organization_id
                and attempt.state in (
                  'assembling', 'ready', 'in_progress', 'retry_wait'
                )
            )
            and not exists (
              select 1 from public.public_derivation_obligations obligation
              where obligation.organization_id = provider.organization_id
                and obligation.state in ('pending', 'claimed')
            )
            and not exists (
              select 1 from public.quarantine_records quarantine
              where quarantine.organization_id = provider.organization_id
            )
            and not exists (
              select 1 from public.provider_health_states health
              where health.organization_id = provider.organization_id
                and (
                  health.consecutive_failures > 0
                  or health.latest_failure_code is not null
                  or health.mapping_warning_active = true
                  or health.calculation_warning_active = true
                )
            )
            and not exists (
              select 1 from public.provider_source_health_states health
              where health.organization_id = provider.organization_id
                and (
                  health.consecutive_failures > 0
                  or health.latest_failure_code is not null
                )
            )
            and not exists (
              select 1 from public.source_connection_health_episodes episode
              where episode.organization_id = provider.organization_id
                and episode.closed_at is null
            )
            and not exists (
              select 1
              from public.source_processor_diagnostic_events diagnostic
              left join public.import_runs diagnostic_run
                on diagnostic_run.organization_id = diagnostic.organization_id
               and diagnostic_run.id = diagnostic.run_id
              where diagnostic.organization_id = provider.organization_id
                and diagnostic.connection_profile_id =
                  source.connection_profile_id
                and diagnostic.severity in ('warning', 'critical')
                and (
                  (
                    diagnostic.run_id is not null
                    and diagnostic_run.cursor_generation =
                      cursor.cursor_generation
                    and (
                      diagnostic.severity = 'critical'
                      or diagnostic_run.state <> 'succeeded'
                      or diagnostic_run.reached_provider_head is distinct
                        from true
                      or diagnostic_run.finished_at is null
                      or diagnostic_run.failure_code is not null
                      or diagnostic_run.source_instance_id is distinct
                        from source.id
                      or diagnostic_run.source_revision_id is distinct
                        from source.active_revision_id
                    )
                  )
                  or (
                    diagnostic.run_id is null
                    and diagnostic.occurred_at >= (
                      select min(generation_run.created_at)
                      from public.import_runs generation_run
                      where generation_run.organization_id =
                          provider.organization_id
                        and generation_run.provider_id = provider.id
                        and generation_run.source_instance_id = source.id
                        and generation_run.source_revision_id =
                          source.active_revision_id
                        and generation_run.cursor_generation =
                          cursor.cursor_generation
                    )
                  )
                )
            )
            and not exists (
              select 1
              from public.operational_events event
              left join public.import_runs event_run
                on event_run.organization_id = event.organization_id
               and event_run.id = event.run_id
              where event.organization_id = provider.organization_id
                and event.provider_id = provider.id
                and event.severity in ('warning', 'critical')
                and (
                  (
                    event.run_id is not null
                    and event_run.cursor_generation = cursor.cursor_generation
                    and (
                      event.severity = 'critical'
                      or event_run.state <> 'succeeded'
                      or event_run.reached_provider_head is distinct from true
                      or event_run.finished_at is null
                      or event_run.failure_code is not null
                      or event_run.source_instance_id is distinct from source.id
                      or event_run.source_revision_id is distinct
                        from source.active_revision_id
                    )
                  )
                  or (
                    event.run_id is null
                    and event.occurred_at >= (
                      select min(generation_run.created_at)
                      from public.import_runs generation_run
                      where generation_run.organization_id =
                          provider.organization_id
                        and generation_run.provider_id = provider.id
                        and generation_run.source_instance_id = source.id
                        and generation_run.source_revision_id =
                          source.active_revision_id
                        and generation_run.cursor_generation =
                          cursor.cursor_generation
                    )
                  )
                )
            )
          ) as qualified
          from public.organizations organization
          join public.settled_public_watermarks watermark
            on watermark.organization_id = organization.id
          join public.provider_catalog_checkpoints checkpoint
            on checkpoint.organization_id = organization.id
           and checkpoint.platform_key = ${expected.platformKey}
          join public.provider_sources provider
            on provider.organization_id = organization.id
           and provider.platform_key = ${expected.platformKey}
          join public.provider_source_instances source
            on source.organization_id = provider.organization_id
           and source.provider_id = provider.id
           and source.id = cast(${expected.sourceInstanceId} as uuid)
          join public.provider_source_cursors cursor
            on cursor.organization_id = source.organization_id
           and cursor.provider_id = source.provider_id
           and cursor.source_instance_id = source.id
          join public.import_runs run
            on run.organization_id = source.organization_id
           and run.provider_id = source.provider_id
           and run.id = cast(${expected.latestRunId} as uuid)
          where organization.id = ${uuid(this.organizationId)}
          for update of organization, watermark, checkpoint, provider, source,
            cursor, run
        `);
        if (guardedRows.length !== 1 || guardedRows[0]?.qualified !== true) {
          throw new ApprovedPublicCatalogConfigurationPersistenceError(
            "PUBLIC_CONFIGURATION_SOURCE_PRECONDITION_MISMATCH",
          );
        }
      }
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
    }, options.expectedSource === undefined
      ? PACKSCOUT_TRANSACTION_OPTIONS
      : {
          ...PACKSCOUT_TRANSACTION_OPTIONS,
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
  }

  /**
   * The `occurred_at` predicate for one snapshot member, expressed against the
   * authoritative cause row the member's `public_change_sequence` points at.
   *
   * Every table this repository reads carries a foreign key onto
   * `public.public_change_causes (organization_id, sequence)`, whose primary key
   * makes the match exactly one row, so this is the declared join written as a
   * semi-join: it can neither drop a governed row nor duplicate one, and it
   * leaves the surrounding `distinct on` and window frames untouched.
   *
   * Returns `Prisma.empty` when no bound was requested, so the emitted SQL is
   * byte for byte the prior sequence-prefix query.
   */
  private causeOccurredAtBound(
    owner: string,
    occurredAtBound: Date | undefined,
  ): Prisma.Sql {
    if (occurredAtBound === undefined) return Prisma.empty;
    return Prisma.sql`
        and exists (
          select 1
          from public.public_change_causes cause
          where cause.organization_id = ${Prisma.raw(`${owner}.organization_id`)}
            and cause.sequence = ${Prisma.raw(`${owner}.public_change_sequence`)}
            and cause.occurred_at <= ${occurredAtBound}
        )`;
  }

  async loadSnapshot(
    input: CatalogReleaseSourceLoadInput,
  ): Promise<CatalogReleaseSourceSnapshot> {
    return this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`set transaction read only`);
      const configurationRows = await transaction.$queryRaw<ConfigRow[]>(Prisma.sql`
        select id, configuration_json as "configurationJson",
               configuration_hash as "configurationHash",
               public_change_sequence as "publicChangeSequence"
        from public.approved_public_catalog_configurations
        where organization_id = ${uuid(this.organizationId)}
          and public_change_sequence <= ${input.throughSequence}${
            this.causeOccurredAtBound(
              "approved_public_catalog_configurations",
              input.occurredAtBound,
            )
          }
        order by public_change_sequence desc, revision desc
        limit 1
      `);
      const revisions = await this.loadRevisions(transaction, input);
      const providers = await this.loadProviders(transaction, input);
      const identities = await this.loadRepackIdentities(transaction, input);
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

  private loadRevisions(
    database: PackscoutQueryClient,
    input: CatalogReleaseSourceLoadInput,
  ) {
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
        and revision.public_change_sequence <= ${input.throughSequence}${
          this.causeOccurredAtBound("revision", input.occurredAtBound)
        }
        and entity.record_kind in ('platform', 'pack', 'catalog_asset', 'ev_input', 'estimated_ev')
      order by entity.id, revision.public_change_sequence desc, revision.revision_number desc
    `);
  }

  private loadProviders(
    database: PackscoutQueryClient,
    input: CatalogReleaseSourceLoadInput,
  ) {
    return database.$queryRaw<CatalogProviderReadinessSnapshot[]>(Prisma.sql`
      with lifecycle as (
        select distinct on (provider.platform_key collate "C")
               provider.platform_key as "platformKey",
               cause.metadata_json->>'state' as state,
               cause.sequence as "lifecycleSequence",
               provider.id::text as "providerId",
               source.id::text as "sourceInstanceId",
               revision.id::text as "sourceRevisionId"
        from public.provider_sources provider
        join public.public_change_catalog_impacts impact
          on impact.organization_id = provider.organization_id
         and impact.lifecycle_platform_key = provider.platform_key
        join public.public_change_causes cause
          on cause.organization_id = impact.organization_id
         and cause.sequence = impact.cause_sequence
        join public.provider_source_instances source
          on source.organization_id = provider.organization_id
         and source.provider_id = provider.id
         and source.id::text = cause.metadata_json->>'sourceInstanceId'
        join public.provider_source_revisions revision
          on revision.organization_id = source.organization_id
         and revision.provider_id = source.provider_id
         and revision.source_instance_id = source.id
         and revision.id::text = cause.metadata_json->>'sourceRevisionId'
        where cause.organization_id = ${uuid(this.organizationId)}
          and cause.sequence <= ${input.throughSequence}${
            // The lifecycle read already drives off the authoritative cause
            // row, so the point-in-time bound is a direct predicate here.
            input.occurredAtBound === undefined
              ? Prisma.empty
              : Prisma.sql`
          and cause.occurred_at <= ${input.occurredAtBound}`
          }
          and cause.change_kind in ('provider_lifecycle', 'public_configuration')
          and cause.entity_key = 'provider:v1:' || provider.id::text
          and cause.source_key = provider.platform_key
          and cause.source_revision_key = revision.id::text
          and cause.metadata_json->>'providerId' = provider.id::text
          and cause.metadata_json->>'platformKey' = provider.platform_key
          and cause.metadata_json->>'sourceRevisionId' = revision.id::text
          and cause.metadata_json->>'state' = impact.lifecycle_state::text
        order by provider.platform_key collate "C", cause.sequence desc
      )
      select provider.platform_key as "platformKey", lifecycle.state,
             lifecycle."lifecycleSequence", lifecycle."providerId",
             lifecycle."sourceInstanceId", lifecycle."sourceRevisionId",
             backfill."completedBackfillAt"
      from public.provider_sources provider
      left join lifecycle on lifecycle."platformKey" = provider.platform_key
      left join lateral (
        select min(run.finished_at) as "completedBackfillAt"
        from public.import_runs run
        where run.organization_id = provider.organization_id
          and run.provider_id = provider.id
          and run.config_revision_id is null
          and run.source_instance_id::text = lifecycle."sourceInstanceId"
          and run.source_revision_id::text = lifecycle."sourceRevisionId"
          and run.state = 'succeeded'
          and run.reached_provider_head = true
          -- Reaching provider head is source-supervisor state, not a public
          -- catalog mutation. It can be recorded after the final page cause
          -- has settled, so the causal source/revision pins are the boundary.
      ) backfill on true
      where provider.organization_id = ${uuid(this.organizationId)}
      order by provider.platform_key collate "C"
    `);
  }

  private loadRepackIdentities(
    database: PackscoutQueryClient,
    input: CatalogReleaseSourceLoadInput,
  ) {
    return database.$queryRaw<GovernedPublicRepackIdentity[]>(Prisma.sql`
      select platform_key as "platformKey", pack_external_id as "packExternalId",
             public_repack_id::text as "publicRepackId",
             approved_configuration_key as "approvedConfigurationKey",
             public_change_sequence as "publicChangeSequence",
             approved_at as "approvedAt"
      from public.public_repack_identity_mappings
      where organization_id = ${uuid(this.organizationId)}
        and public_change_sequence <= ${input.throughSequence}${
          this.causeOccurredAtBound(
            "public_repack_identity_mappings",
            input.occurredAtBound,
          )
        }
      order by platform_key, pack_external_id
    `);
  }
}
