import {
  approvedPublicCatalogConfigurationV1Schema,
  sha256CanonicalJson,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import { PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN } from "./catalog-release-source-repository.ts";
import { canonicalCatalogPlatformKeys } from "./public-change-settlement-repository.catalog-impact.ts";
import type {
  PackscoutPrismaClient,
  PackscoutTransactionClient,
} from "./database.ts";

export interface SharedPublicConfigurationEpochRecord {
  readonly configurationKey: string;
  readonly revision: number;
  readonly publicChangeSequence: bigint;
  readonly configurationHash: string;
}

export type ProviderCatalogBlockedStateRecord =
  | Readonly<{ kind: "ready" }>
  | Readonly<{
      kind: "blocked";
      reason: "pending_derivation" | "technical_failure";
      causeSequence: bigint;
    }>;

export interface ProviderCatalogCheckpointRecord {
  readonly organizationId: string;
  readonly platformKey: string;
  readonly sharedConfigurationEpoch: SharedPublicConfigurationEpochRecord;
  readonly settledSequence: bigint;
  readonly sourceHeadSequence: bigint;
  readonly settledAt: Date | null;
  readonly sourceHeadAt: Date;
  readonly blockedState: ProviderCatalogBlockedStateRecord;
}

export interface ManifestEligibilitySnapshotRecord {
  readonly organizationId: string;
  readonly sharedConfigurationEpoch: SharedPublicConfigurationEpochRecord;
  readonly confidencePolicyVersion: string;
  readonly staleAfterSeconds: number;
  readonly configuredPlatformKeys: readonly string[];
  readonly enabledPlatformKeys: readonly string[];
  readonly lifecycleDecisionSequence: bigint;
  readonly checkpoints: readonly ProviderCatalogCheckpointRecord[];
}

export interface ProviderPromotionCheckpointProjectionRecord
  extends ProviderCatalogCheckpointRecord {
  readonly lastSuccessfulObservationAt: Date;
  readonly staleAt: Date;
  readonly freshness: "fresh" | "delayed";
}

export interface ProviderCausalReadinessRecord {
  readonly platformKey: string;
  readonly lifecycleSequence: bigint;
  readonly providerId: string;
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  readonly completedBackfillAt: Date | null;
  readonly lastSuccessfulObservationAt: Date | null;
}

export class ProviderCausalReadinessPersistenceError extends Error {
  constructor(readonly code: "LIFECYCLE_INELIGIBLE" | "SOURCE_INVALID") {
    super("Provider causal readiness is unavailable or invalid.");
    this.name = "ProviderCausalReadinessPersistenceError";
  }
}

interface EpochContext {
  readonly epoch: SharedPublicConfigurationEpochRecord;
  readonly confidencePolicyVersion: string;
  readonly staleAfterSeconds: number;
  readonly configuredPlatformKeys: readonly string[];
  readonly lifecycleDecisionSequence: bigint;
}

interface EpochRow {
  configurationKey: string;
  revision: number;
  publicChangeSequence: bigint;
  configurationHash: string;
  configurationJson: unknown;
  lifecycleDecisionSequence: bigint;
}

interface CheckpointRow {
  organizationId: string;
  platformKey: string;
  settledSequence: bigint;
  sourceHeadSequence: bigint;
  settledAt: Date | null;
  sourceHeadAt: Date | null;
  blockedCauseSequence: bigint | null;
  technicalFailure: boolean | null;
}

interface CausalReadinessRow {
  platformKey: string;
  lifecycleState: "active" | "disabled" | "archived";
  lifecycleSequence: bigint;
  lifecycleCatalogAffected: boolean;
  causeChangeKind: string;
  causeEntityKey: string;
  causeSourceKey: string | null;
  causeSourceRevisionKey: string | null;
  causePlatformKey: string | null;
  causeLifecycleState: string | null;
  causeProviderId: string | null;
  causeSourceInstanceId: string | null;
  causeSourceRevisionId: string | null;
  providerId: string | null;
  sourceInstanceId: string | null;
  sourceProviderId: string | null;
  sourceState: string | null;
  activeSourceRevisionId: string | null;
  sourceRevisionId: string | null;
  revisionProviderId: string | null;
  revisionSourceInstanceId: string | null;
  checkpointMatches: boolean;
  completedBackfillAt: Date | null;
  lastSuccessfulObservationAt: Date | null;
}

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

async function loadEpochContext(
  database: PackscoutTransactionClient,
  organizationId: string,
): Promise<EpochContext | null> {
  const rows = await database.$queryRaw<EpochRow[]>(Prisma.sql`
    select configuration.configuration_key as "configurationKey",
           configuration.revision,
           configuration.public_change_sequence as "publicChangeSequence",
           configuration.configuration_hash as "configurationHash",
           configuration.configuration_json as "configurationJson",
           lifecycle.settled_sequence as "lifecycleDecisionSequence"
    from public.catalog_manifest_lifecycle_checkpoints as lifecycle
    join lateral (
      select approved.*
      from public.public_change_catalog_impacts as impact
      join public.approved_public_catalog_configurations as approved
        on approved.organization_id = impact.organization_id
       and approved.public_change_sequence = impact.cause_sequence
       and approved.configuration_key = impact.shared_configuration_key
       and approved.revision = impact.shared_configuration_revision
       and approved.configuration_hash = impact.shared_configuration_hash
      where impact.organization_id = lifecycle.organization_id
        and impact.shared_configuration_hash is not null
        and impact.cause_sequence <= lifecycle.settled_sequence
      order by impact.cause_sequence desc
      limit 1
    ) as configuration on true
    where lifecycle.organization_id = ${uuid(organizationId)}
  `);
  const row = rows[0];
  if (!row) return null;
  const parsed = approvedPublicCatalogConfigurationV1Schema.safeParse(
    row.configurationJson,
  );
  if (
    !parsed.success ||
    parsed.data.configurationKey !== row.configurationKey ||
    parsed.data.revision !== row.revision
  ) {
    throw new Error("Approved public configuration epoch is invalid.");
  }
  const recomputedHash = await sha256CanonicalJson(
    PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN,
    parsed.data,
  );
  if (recomputedHash !== row.configurationHash) {
    throw new Error("Approved public configuration epoch is invalid.");
  }
  return {
    epoch: {
      configurationKey: row.configurationKey,
      revision: row.revision,
      publicChangeSequence: row.publicChangeSequence,
      configurationHash: row.configurationHash,
    },
    confidencePolicyVersion: parsed.data.confidencePolicy.version,
    staleAfterSeconds: parsed.data.staleAfterSeconds,
    configuredPlatformKeys: parsed.data.platforms.map(
      ({ platformKey }) => platformKey,
    ),
    lifecycleDecisionSequence: row.lifecycleDecisionSequence,
  };
}

async function loadCheckpointRows(
  database: PackscoutTransactionClient,
  input: {
    organizationId: string;
    platformKeys: readonly string[];
    epoch: SharedPublicConfigurationEpochRecord;
  },
): Promise<readonly ProviderCatalogCheckpointRecord[] | null> {
  if (input.platformKeys.length === 0) return [];
  const rows = await database.$queryRaw<CheckpointRow[]>(Prisma.sql`
    select checkpoint.organization_id as "organizationId",
           checkpoint.platform_key as "platformKey",
           checkpoint.settled_sequence as "settledSequence",
           checkpoint.source_head_sequence as "sourceHeadSequence",
           checkpoint.settled_at as "settledAt",
           checkpoint.source_head_at as "sourceHeadAt",
           blocker.cause_sequence as "blockedCauseSequence",
           blocker.technical_failure as "technicalFailure"
    from public.provider_catalog_checkpoints as checkpoint
    left join lateral (
      select impact.cause_sequence,
             exists (
               select 1
               from public.public_derivation_obligations as obligation
               where obligation.organization_id = impact.organization_id
                 and obligation.cause_sequence = impact.cause_sequence
                 and obligation.state = 'technical_failure'
             ) as technical_failure
      from public.public_change_catalog_impacts as impact
      where impact.organization_id = checkpoint.organization_id
        and checkpoint.platform_key = any(impact.provider_platform_keys)
        and impact.cause_sequence > checkpoint.settled_sequence
        and exists (
          select 1
          from public.public_derivation_obligations as obligation
          where obligation.organization_id = impact.organization_id
            and obligation.cause_sequence = impact.cause_sequence
            and obligation.state not in ('succeeded', 'business_unavailable')
        )
      order by impact.cause_sequence
      limit 1
    ) as blocker on true
    where checkpoint.organization_id = ${uuid(input.organizationId)}
      and checkpoint.platform_key = any(${[...input.platformKeys]}::text[])
    order by checkpoint.platform_key collate "C"
  `);
  if (rows.length !== input.platformKeys.length) return null;
  const byPlatform = new Map(rows.map((row) => [row.platformKey, row]));
  const checkpoints: ProviderCatalogCheckpointRecord[] = [];
  for (const platformKey of input.platformKeys) {
    const row = byPlatform.get(platformKey);
    if (
      !row ||
      row.organizationId !== input.organizationId ||
      row.sourceHeadAt === null ||
      (row.settledSequence === 0n) !== (row.settledAt === null) ||
      row.sourceHeadSequence < input.epoch.publicChangeSequence
    ) {
      return null;
    }
    let blockedState: ProviderCatalogBlockedStateRecord = { kind: "ready" };
    if (row.settledSequence < row.sourceHeadSequence) {
      if (row.blockedCauseSequence === null) {
        throw new Error("Provider catalog checkpoint is not causally settled.");
      }
      blockedState = {
        kind: "blocked",
        reason: row.technicalFailure
          ? "technical_failure"
          : "pending_derivation",
        causeSequence: row.blockedCauseSequence,
      };
    }
    checkpoints.push({
      organizationId: row.organizationId,
      platformKey: row.platformKey,
      sharedConfigurationEpoch: { ...input.epoch },
      settledSequence: row.settledSequence,
      sourceHeadSequence: row.sourceHeadSequence,
      settledAt: row.settledAt,
      sourceHeadAt: row.sourceHeadAt,
      blockedState,
    });
  }
  return checkpoints;
}

async function loadEnabledPlatformKeys(
  database: PackscoutTransactionClient,
  input: {
    organizationId: string;
    configuredPlatformKeys: readonly string[];
    throughSequence: bigint;
  },
): Promise<readonly string[] | null> {
  if (input.configuredPlatformKeys.length === 0) return [];
  const rows = await database.$queryRaw<Array<{
    platformKey: string;
    state: "active" | "disabled" | "archived";
  }>>(Prisma.sql`
    select distinct on (impact.lifecycle_platform_key collate "C")
           impact.lifecycle_platform_key as "platformKey",
           impact.lifecycle_state::text as state
    from public.public_change_catalog_impacts as impact
    join public.public_change_causes as cause
      on cause.organization_id = impact.organization_id
     and cause.sequence = impact.cause_sequence
    join public.provider_sources as provider
      on provider.organization_id = impact.organization_id
     and provider.platform_key = impact.lifecycle_platform_key
    join public.provider_source_instances as source
      on source.organization_id = provider.organization_id
     and source.provider_id = provider.id
     and source.id::text = cause.metadata_json->>'sourceInstanceId'
    join public.provider_source_revisions as revision
      on revision.organization_id = source.organization_id
     and revision.provider_id = source.provider_id
     and revision.source_instance_id = source.id
     and revision.id::text = cause.metadata_json->>'sourceRevisionId'
     and source.active_revision_id = revision.id
    where impact.organization_id = ${uuid(input.organizationId)}
      and impact.lifecycle_platform_key = any(
        ${[...input.configuredPlatformKeys]}::text[]
      )
      and impact.cause_sequence <= ${input.throughSequence}
      and cause.change_kind in ('provider_lifecycle', 'public_configuration')
      and cause.entity_key = 'provider:v1:' || provider.id::text
      and cause.source_key = impact.lifecycle_platform_key
      and cause.source_revision_key = revision.id::text
      and cause.metadata_json->>'providerId' = provider.id::text
      and cause.metadata_json->>'platformKey' = impact.lifecycle_platform_key
      and cause.metadata_json->>'state' = impact.lifecycle_state::text
      and (
        impact.lifecycle_state = 'active'
          and source.state in ('active', 'paused')
        or impact.lifecycle_state = 'disabled'
          and source.state = 'disabled'
      )
    order by impact.lifecycle_platform_key collate "C",
             impact.cause_sequence desc
  `);
  const enabledPlatformKeys = canonicalCatalogPlatformKeys(
    rows
      .filter(({ state }) => state === "active")
      .map(({ platformKey }) => platformKey),
  );
  const activeSources = await database.$queryRaw<Array<{
    platformKey: string;
    sourceCount: number;
  }>>(Prisma.sql`
    select provider.platform_key as "platformKey",
           count(*)::integer as "sourceCount"
    from public.provider_sources as provider
    join public.provider_source_instances as source
      on source.organization_id = provider.organization_id
     and source.provider_id = provider.id
    join public.provider_source_revisions as revision
      on revision.organization_id = source.organization_id
     and revision.provider_id = source.provider_id
     and revision.source_instance_id = source.id
     and revision.id = source.active_revision_id
    where provider.organization_id = ${uuid(input.organizationId)}
      and provider.platform_key = any(
        ${[...input.configuredPlatformKeys]}::text[]
      )
      and source.state in ('active', 'paused')
    group by provider.platform_key
    order by provider.platform_key collate "C"
  `);
  // A current V1 source without an exact source-native lifecycle decision is
  // an incomplete cutover, not a disabled provider. Treating it as disabled
  // could publish an empty manifest before the operator reasserts the source.
  if (activeSources.some(({ platformKey, sourceCount }) =>
    sourceCount !== 1 || !enabledPlatformKeys.includes(platformKey)
  )) return null;
  return enabledPlatformKeys;
}

export class PrismaProviderCatalogSettlementRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async loadProviderCatalogCheckpoint(input: {
    organizationId: string;
    platformKey: string;
  }): Promise<ProviderCatalogCheckpointRecord | null> {
    return this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`set transaction read only`);
      const context = await loadEpochContext(transaction, input.organizationId);
      if (
        !context ||
        !context.configuredPlatformKeys.includes(input.platformKey)
      ) {
        return null;
      }
      const checkpoints = await loadCheckpointRows(transaction, {
        organizationId: input.organizationId,
        platformKeys: [input.platformKey],
        epoch: context.epoch,
      });
      return checkpoints?.[0] ?? null;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async loadManifestEligibilitySnapshot(input: {
    organizationId: string;
  }): Promise<ManifestEligibilitySnapshotRecord | null> {
    return this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`set transaction read only`);
      return loadManifestEligibilitySnapshotInTransaction(transaction, input);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async loadProviderPromotionCheckpoint(input: {
    organizationId: string;
    platformKey: string;
  }): Promise<ProviderPromotionCheckpointProjectionRecord | null> {
    return this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`set transaction read only`);
      const context = await loadEpochContext(transaction, input.organizationId);
      if (!context || !context.configuredPlatformKeys.includes(input.platformKey)) {
        return null;
      }
      const checkpoints = await loadCheckpointRows(transaction, {
        organizationId: input.organizationId,
        platformKeys: [input.platformKey],
        epoch: context.epoch,
      });
      const checkpoint = checkpoints?.[0];
      if (!checkpoint) return null;
      const readiness = (await loadProviderCausalReadinessInTransaction(
        transaction,
        {
          organizationId: input.organizationId,
          checkpoints: [checkpoint],
          lifecycleDecisionSequence: context.lifecycleDecisionSequence,
        },
      ))[0];
      if (!readiness?.completedBackfillAt ||
        !readiness.lastSuccessfulObservationAt) return null;
      const staleAt = new Date(
        readiness.lastSuccessfulObservationAt.getTime() +
          context.staleAfterSeconds * 1_000,
      );
      if (!Number.isFinite(staleAt.getTime())) {
        throw new Error("Provider promotion observation is invalid.");
      }
      return {
        ...checkpoint,
        lastSuccessfulObservationAt: readiness.lastSuccessfulObservationAt,
        staleAt,
        freshness: readiness.lastSuccessfulObservationAt >= checkpoint.sourceHeadAt
          ? "fresh" : "delayed",
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}

/** Exact source-native lifecycle/revision readiness, transaction-bound. */
export async function loadProviderCausalReadinessInTransaction(
  transaction: PackscoutTransactionClient,
  input: Readonly<{
    organizationId: string;
    checkpoints: readonly ProviderCatalogCheckpointRecord[];
    lifecycleDecisionSequence: bigint;
  }>,
): Promise<readonly ProviderCausalReadinessRecord[]> {
  if (input.checkpoints.length === 0) return [];
  if (input.checkpoints.some((checkpoint) =>
    checkpoint.organizationId !== input.organizationId
  ) || new Set(input.checkpoints.map(({ platformKey }) => platformKey)).size !==
      input.checkpoints.length) {
    throw new ProviderCausalReadinessPersistenceError("SOURCE_INVALID");
  }
  const platformKeys = input.checkpoints.map(({ platformKey }) => platformKey);
  const checkpointValues = Prisma.join(input.checkpoints.map((checkpoint) =>
    Prisma.sql`(
      ${checkpoint.platformKey}::text,
      ${checkpoint.settledSequence}::bigint,
      ${checkpoint.sourceHeadSequence}::bigint,
      ${checkpoint.settledAt}::timestamptz,
      ${checkpoint.sourceHeadAt}::timestamptz
    )`));
  const rows = await transaction.$queryRaw<CausalReadinessRow[]>(Prisma.sql`
    with requested_checkpoint(
      "platformKey", "settledSequence", "sourceHeadSequence",
      "settledAt", "sourceHeadAt"
    ) as (values ${checkpointValues}),
    requested_lifecycle as (
      select settled_sequence as "lifecycleDecisionSequence"
      from public.catalog_manifest_lifecycle_checkpoints
      where organization_id = ${uuid(input.organizationId)}
        and settled_sequence = ${input.lifecycleDecisionSequence}
    ),
    latest_lifecycle as (
      select distinct on (impact.lifecycle_platform_key collate "C")
             impact.lifecycle_platform_key as "platformKey",
             impact.lifecycle_state::text as "lifecycleState",
             impact.cause_sequence as "lifecycleSequence",
             impact.lifecycle_platform_key = any(impact.provider_platform_keys)
               as "lifecycleCatalogAffected",
             cause.change_kind::text as "causeChangeKind",
             cause.entity_key as "causeEntityKey",
             cause.source_key as "causeSourceKey",
             cause.source_revision_key as "causeSourceRevisionKey",
             cause.metadata_json->>'platformKey' as "causePlatformKey",
             cause.metadata_json->>'state' as "causeLifecycleState",
             cause.metadata_json->>'providerId' as "causeProviderId",
             cause.metadata_json->>'sourceInstanceId'
               as "causeSourceInstanceId",
             cause.metadata_json->>'sourceRevisionId'
               as "causeSourceRevisionId"
      from public.public_change_catalog_impacts as impact
      join public.public_change_causes as cause
        on cause.organization_id = impact.organization_id
       and cause.sequence = impact.cause_sequence
      join requested_checkpoint as requested
        on requested."platformKey" = impact.lifecycle_platform_key
      cross join requested_lifecycle
      join public.provider_sources as provider
        on provider.organization_id = impact.organization_id
       and provider.platform_key = impact.lifecycle_platform_key
      join public.provider_source_instances as source
        on source.organization_id = provider.organization_id
       and source.provider_id = provider.id
       and source.id::text = cause.metadata_json->>'sourceInstanceId'
      join public.provider_source_revisions as revision
        on revision.organization_id = source.organization_id
       and revision.provider_id = source.provider_id
       and revision.source_instance_id = source.id
       and revision.id::text = cause.metadata_json->>'sourceRevisionId'
       and source.active_revision_id = revision.id
      where impact.organization_id = ${uuid(input.organizationId)}
        and impact.lifecycle_platform_key = any(${platformKeys}::text[])
        and impact.cause_sequence <=
          requested_lifecycle."lifecycleDecisionSequence"
        and cause.change_kind in (
          'provider_lifecycle', 'public_configuration'
        )
        and cause.entity_key = 'provider:v1:' || provider.id::text
        and cause.source_key = impact.lifecycle_platform_key
        and cause.source_revision_key = revision.id::text
        and cause.metadata_json->>'providerId' = provider.id::text
        and cause.metadata_json->>'platformKey' =
          impact.lifecycle_platform_key
        and cause.metadata_json->>'state' = impact.lifecycle_state::text
        and (
          impact.lifecycle_state = 'active'
            and source.state in ('active', 'paused')
          or impact.lifecycle_state = 'disabled'
            and source.state = 'disabled'
        )
      order by impact.lifecycle_platform_key collate "C",
               impact.cause_sequence desc
    )
    select lifecycle.*, provider.id::text as "providerId",
           source.id::text as "sourceInstanceId",
           source.provider_id::text as "sourceProviderId",
           source.state::text as "sourceState",
           source.active_revision_id::text as "activeSourceRevisionId",
           revision.id::text as "sourceRevisionId",
           revision.provider_id::text as "revisionProviderId",
           revision.source_instance_id::text as "revisionSourceInstanceId",
           checkpoint.organization_id is not null as "checkpointMatches",
           backfill."completedBackfillAt",
           observation."lastSuccessfulObservationAt"
    from latest_lifecycle as lifecycle
    join requested_checkpoint as requested
      on requested."platformKey" = lifecycle."platformKey"
    left join public.provider_sources as provider
     on provider.organization_id = ${uuid(input.organizationId)}
     and provider.platform_key = lifecycle."platformKey"
    left join public.provider_source_instances as source
      on source.organization_id = provider.organization_id
     and source.provider_id = provider.id
     and source.id::text = lifecycle."causeSourceInstanceId"
    left join public.provider_source_revisions as revision
      on revision.organization_id = source.organization_id
     and revision.provider_id = source.provider_id
     and revision.source_instance_id = source.id
     and revision.id::text = lifecycle."causeSourceRevisionId"
    left join public.provider_catalog_checkpoints as checkpoint
      on checkpoint.organization_id = provider.organization_id
     and checkpoint.platform_key = lifecycle."platformKey"
     and checkpoint.settled_sequence = requested."settledSequence"
     and checkpoint.source_head_sequence = requested."sourceHeadSequence"
     and checkpoint.settled_at is not distinct from requested."settledAt"
     and checkpoint.source_head_at = requested."sourceHeadAt"
    left join lateral (
      select min(run.finished_at) as "completedBackfillAt"
      from public.import_runs as run
      where run.organization_id = provider.organization_id
        and run.provider_id = provider.id
        and run.config_revision_id is null
        and run.source_instance_id = source.id
        and run.source_revision_id = revision.id
        and run.state = 'succeeded' and run.reached_provider_head = true
        -- Reaching the provider head is supervisor state, not a public catalog
        -- mutation. The supervisor records it after the last page settlement,
        -- so bounding finished_at by settledAt would permanently reject the
        -- production ordering even though every canonical page is settled.
        and requested."settledAt" is not null
    ) as backfill on true
    left join lateral (
      select max(run.finished_at) as "lastSuccessfulObservationAt"
      from public.import_runs as run
      where run.organization_id = provider.organization_id
        and run.provider_id = provider.id
        and run.config_revision_id is null
        and run.source_instance_id = source.id
        and run.source_revision_id = revision.id
        and run.state = 'succeeded' and run.reached_provider_head = true
    ) as observation on true
    order by lifecycle."platformKey" collate "C"
  `);
  const byPlatform = new Map(rows.map((row) => [row.platformKey, row]));
  return input.checkpoints.map(({ platformKey }) => {
    const row = byPlatform.get(platformKey);
    if (!row || row.lifecycleState !== "active" ||
      row.causePlatformKey !== platformKey ||
      row.causeLifecycleState !== "active") {
      throw new ProviderCausalReadinessPersistenceError(
        "LIFECYCLE_INELIGIBLE",
      );
    }
    if ((row.causeChangeKind !== "provider_lifecycle" &&
        row.causeChangeKind !== "public_configuration") ||
      row.causeEntityKey !== `provider:v1:${row.providerId}` ||
      row.causeSourceKey !== platformKey ||
      row.causeSourceRevisionKey !== row.causeSourceRevisionId ||
      !row.lifecycleCatalogAffected ||
      !row.checkpointMatches ||
      row.providerId === null ||
      row.sourceInstanceId === null ||
      row.causeSourceInstanceId === null ||
      row.causeSourceRevisionId === null ||
      row.causeProviderId !== row.providerId ||
      row.sourceInstanceId !== row.causeSourceInstanceId ||
      row.sourceProviderId !== row.providerId ||
      !["active", "paused"].includes(row.sourceState ?? "") ||
      row.activeSourceRevisionId !== row.causeSourceRevisionId ||
      row.sourceRevisionId === null ||
      row.sourceRevisionId !== row.causeSourceRevisionId ||
      row.revisionProviderId !== row.providerId ||
      row.revisionSourceInstanceId !== row.sourceInstanceId) {
      throw new ProviderCausalReadinessPersistenceError("SOURCE_INVALID");
    }
    return {
      platformKey,
      lifecycleSequence: row.lifecycleSequence,
      providerId: row.providerId,
      sourceInstanceId: row.sourceInstanceId,
      sourceRevisionId: row.sourceRevisionId,
      completedBackfillAt: row.completedBackfillAt,
      lastSuccessfulObservationAt: row.lastSuccessfulObservationAt,
    };
  });
}

/** Task 011 atomic projection hook; callers must already own the transaction. */
export async function loadManifestEligibilitySnapshotInTransaction(
  transaction: PackscoutTransactionClient,
  input: { organizationId: string },
): Promise<ManifestEligibilitySnapshotRecord | null> {
  const context = await loadEpochContext(transaction, input.organizationId);
  if (!context) return null;
  const enabledPlatformKeys = await loadEnabledPlatformKeys(transaction, {
    organizationId: input.organizationId,
    configuredPlatformKeys: context.configuredPlatformKeys,
    throughSequence: context.lifecycleDecisionSequence,
  });
  if (enabledPlatformKeys === null) return null;
  const checkpoints = await loadCheckpointRows(transaction, {
    organizationId: input.organizationId,
    platformKeys: enabledPlatformKeys,
    epoch: context.epoch,
  });
  if (checkpoints === null) return null;
  return {
    organizationId: input.organizationId,
    sharedConfigurationEpoch: context.epoch,
    confidencePolicyVersion: context.confidencePolicyVersion,
    staleAfterSeconds: context.staleAfterSeconds,
    configuredPlatformKeys: context.configuredPlatformKeys,
    enabledPlatformKeys,
    lifecycleDecisionSequence: context.lifecycleDecisionSequence,
    checkpoints,
  };
}
