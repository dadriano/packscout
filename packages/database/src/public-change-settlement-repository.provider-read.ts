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
  readonly configurationRevisionId: string;
  readonly completedBackfillAt: Date | null;
  readonly lastSuccessfulObservationAt: Date | null;
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
  lifecycleDecisionSequence: bigint;
}

interface EpochConfigurationRow {
  configurationJson: unknown;
}

interface VerifiedEpochConfiguration {
  configurationKey: string;
  revision: number;
  publicChangeSequence: bigint;
  configurationHash: string;
  confidencePolicyVersion: string;
  staleAfterSeconds: number;
  configuredPlatformKeys: readonly string[];
}

const MAXIMUM_VERIFIED_EPOCH_CONFIGURATIONS = 64;
const verifiedEpochConfigurations = new Map<
  string,
  VerifiedEpochConfiguration
>();

function rememberVerifiedEpochConfiguration(
  organizationId: string,
  configuration: VerifiedEpochConfiguration,
  cache: Map<string, VerifiedEpochConfiguration>,
): void {
  cache.delete(organizationId);
  cache.set(organizationId, configuration);
  while (cache.size > MAXIMUM_VERIFIED_EPOCH_CONFIGURATIONS) {
    const oldestOrganizationId = cache.keys().next().value;
    if (oldestOrganizationId === undefined) break;
    cache.delete(oldestOrganizationId);
  }
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
  causePlatformKey: string | null;
  causeLifecycleState: string | null;
  causeProviderId: string | null;
  configurationRevisionId: string | null;
  lifecycleOccurredAt: Date;
  providerId: string | null;
  revisionProviderId: string | null;
  completedBackfillAt: Date | null;
  lastSuccessfulObservationAt: Date | null;
}

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

async function loadEpochContext(
  database: PackscoutTransactionClient,
  organizationId: string,
  verifiedConfigurations = verifiedEpochConfigurations,
): Promise<EpochContext | null> {
  const rows = await database.$queryRaw<EpochRow[]>(Prisma.sql`
    select configuration.configuration_key as "configurationKey",
           configuration.revision,
           configuration.public_change_sequence as "publicChangeSequence",
           configuration.configuration_hash as "configurationHash",
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
  let verified = verifiedConfigurations?.get(organizationId);
  if (
    verified === undefined ||
    verified.configurationKey !== row.configurationKey ||
    verified.revision !== row.revision ||
    verified.publicChangeSequence !== row.publicChangeSequence ||
    verified.configurationHash !== row.configurationHash
  ) {
    const configurationRows = await database.$queryRaw<
      EpochConfigurationRow[]
    >(Prisma.sql`
      select configuration_json as "configurationJson"
      from public.approved_public_catalog_configurations
      where organization_id = ${uuid(organizationId)}
        and configuration_key = ${row.configurationKey}
        and revision = ${row.revision}
        and public_change_sequence = ${row.publicChangeSequence}
        and configuration_hash = ${row.configurationHash}
    `);
    const configuration = configurationRows[0];
    const parsed = approvedPublicCatalogConfigurationV1Schema.safeParse(
      configuration?.configurationJson,
    );
    if (
      configurationRows.length !== 1 ||
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
    verified = {
      configurationKey: row.configurationKey,
      revision: row.revision,
      publicChangeSequence: row.publicChangeSequence,
      configurationHash: row.configurationHash,
      confidencePolicyVersion: parsed.data.confidencePolicy.version,
      staleAfterSeconds: parsed.data.staleAfterSeconds,
      configuredPlatformKeys: parsed.data.platforms.map(
        ({ platformKey }) => platformKey,
      ),
    };
    rememberVerifiedEpochConfiguration(
      organizationId,
      verified,
      verifiedConfigurations,
    );
  }
  return {
    epoch: {
      configurationKey: row.configurationKey,
      revision: row.revision,
      publicChangeSequence: row.publicChangeSequence,
      configurationHash: row.configurationHash,
    },
    confidencePolicyVersion: verified.confidencePolicyVersion,
    staleAfterSeconds: verified.staleAfterSeconds,
    configuredPlatformKeys: verified.configuredPlatformKeys,
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
): Promise<readonly string[]> {
  if (input.configuredPlatformKeys.length === 0) return [];
  const rows = await database.$queryRaw<Array<{
    platformKey: string;
    state: "active" | "disabled" | "archived";
  }>>(Prisma.sql`
    select distinct on (impact.lifecycle_platform_key collate "C")
           impact.lifecycle_platform_key as "platformKey",
           impact.lifecycle_state::text as state
    from public.public_change_catalog_impacts as impact
    where impact.organization_id = ${uuid(input.organizationId)}
      and impact.lifecycle_platform_key = any(
        ${[...input.configuredPlatformKeys]}::text[]
      )
      and impact.cause_sequence <= ${input.throughSequence}
    order by impact.lifecycle_platform_key collate "C",
             impact.cause_sequence desc
  `);
  return canonicalCatalogPlatformKeys(
    rows
      .filter(({ state }) => state === "active")
      .map(({ platformKey }) => platformKey),
  );
}

export class PrismaProviderCatalogSettlementRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async loadProviderCatalogCheckpoint(input: {
    organizationId: string;
    platformKey: string;
  }): Promise<ProviderCatalogCheckpointRecord | null> {
    return this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`set transaction read only`);
      const context = await loadEpochContext(
        transaction,
        input.organizationId,
      );
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
      return loadManifestEligibilitySnapshotInTransaction(
        transaction,
        input,
      );
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async loadProviderPromotionCheckpoint(input: {
    organizationId: string;
    platformKey: string;
  }): Promise<ProviderPromotionCheckpointProjectionRecord | null> {
    return this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`set transaction read only`);
      const context = await loadEpochContext(
        transaction,
        input.organizationId,
      );
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
        { organizationId: input.organizationId, checkpoints: [checkpoint] },
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

/** Exact Task 007 lifecycle/config-revision readiness, transaction-bound. */
export async function loadProviderCausalReadinessInTransaction(
  transaction: PackscoutTransactionClient,
  input: Readonly<{
    organizationId: string;
    checkpoints: readonly ProviderCatalogCheckpointRecord[];
  }>,
): Promise<readonly ProviderCausalReadinessRecord[]> {
  if (input.checkpoints.length === 0) return [];
  const platformKeys = input.checkpoints.map(({ platformKey }) => platformKey);
  const rows = await transaction.$queryRaw<CausalReadinessRow[]>(Prisma.sql`
    with latest_lifecycle as (
      select distinct on (impact.lifecycle_platform_key collate "C")
             impact.lifecycle_platform_key as "platformKey",
             impact.lifecycle_state::text as "lifecycleState",
             impact.cause_sequence as "lifecycleSequence",
             cause.metadata_json->>'platformKey' as "causePlatformKey",
             cause.metadata_json->>'state' as "causeLifecycleState",
             cause.metadata_json->>'providerId' as "causeProviderId",
             cause.metadata_json->>'configurationRevisionId'
               as "configurationRevisionId",
             cause.occurred_at as "lifecycleOccurredAt"
      from public.public_change_catalog_impacts as impact
      join public.public_change_causes as cause
        on cause.organization_id = impact.organization_id
       and cause.sequence = impact.cause_sequence
      where impact.organization_id = ${uuid(input.organizationId)}
        and impact.lifecycle_platform_key = any(${platformKeys}::text[])
        and impact.cause_sequence <= (
          select settled_sequence
          from public.catalog_manifest_lifecycle_checkpoints
          where organization_id = ${uuid(input.organizationId)}
        )
      order by impact.lifecycle_platform_key collate "C",
               impact.cause_sequence desc
    )
    select lifecycle.*, provider.id::text as "providerId",
           revision.provider_id::text as "revisionProviderId",
           backfill."completedBackfillAt",
           observation."lastSuccessfulObservationAt"
    from latest_lifecycle as lifecycle
    left join public.provider_sources as provider
      on provider.organization_id = ${uuid(input.organizationId)}
     and provider.platform_key = lifecycle."platformKey"
    left join public.provider_config_revisions as revision
      on revision.organization_id = provider.organization_id
     and revision.provider_id = provider.id
     and revision.id::text = lifecycle."configurationRevisionId"
     and revision.source_mode = 'http'
    left join public.provider_catalog_checkpoints as checkpoint
      on checkpoint.organization_id = provider.organization_id
     and checkpoint.platform_key = lifecycle."platformKey"
    left join lateral (
      select min(run.finished_at) as "completedBackfillAt"
      from public.import_runs as run
      where run.organization_id = provider.organization_id
        and run.provider_id = provider.id
        and run.config_revision_id = revision.id
        and run.trigger in ('scheduled', 'manual', 'recovery')
        and run.state = 'succeeded' and run.reached_provider_head = true
        and checkpoint.settled_at is not null
        and checkpoint.settled_sequence = checkpoint.source_head_sequence
        and checkpoint.settled_sequence >= lifecycle."lifecycleSequence"
        and run.created_at >= lifecycle."lifecycleOccurredAt"
        and run.finished_at >= lifecycle."lifecycleOccurredAt"
    ) as backfill on true
    left join lateral (
      select max(run.finished_at) as "lastSuccessfulObservationAt"
      from public.import_runs as run
      where run.organization_id = provider.organization_id
        and run.provider_id = provider.id
        and run.config_revision_id = revision.id
        and run.trigger in ('scheduled', 'manual', 'recovery')
        and run.state = 'succeeded' and run.reached_provider_head = true
        and run.created_at >= lifecycle."lifecycleOccurredAt"
        and run.finished_at >= lifecycle."lifecycleOccurredAt"
    ) as observation on true
    order by lifecycle."platformKey" collate "C"
  `);
  const byPlatform = new Map(rows.map((row) => [row.platformKey, row]));
  return input.checkpoints.map(({ platformKey }) => {
    const row = byPlatform.get(platformKey);
    if (!row || row.lifecycleState !== "active" ||
      row.causePlatformKey !== platformKey ||
      row.causeLifecycleState !== "active" ||
      row.configurationRevisionId === null ||
      row.causeProviderId !== row.providerId ||
      row.revisionProviderId !== row.providerId) {
      throw new Error("Provider causal readiness is invalid.");
    }
    return {
      platformKey,
      lifecycleSequence: row.lifecycleSequence,
      configurationRevisionId: row.configurationRevisionId,
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
  const context = await loadEpochContext(
    transaction,
    input.organizationId,
  );
  if (!context) return null;
  const enabledPlatformKeys = await loadEnabledPlatformKeys(transaction, {
    organizationId: input.organizationId,
    configuredPlatformKeys: context.configuredPlatformKeys,
    throughSequence: context.lifecycleDecisionSequence,
  });
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
