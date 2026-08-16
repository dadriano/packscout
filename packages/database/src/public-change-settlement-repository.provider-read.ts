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
  readonly enabledPlatformKeys: readonly string[];
  readonly lifecycleDecisionSequence: bigint;
  readonly checkpoints: readonly ProviderCatalogCheckpointRecord[];
}

interface EpochContext {
  readonly epoch: SharedPublicConfigurationEpochRecord;
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
    order by checkpoint.platform_key
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
    select distinct on (impact.lifecycle_platform_key)
           impact.lifecycle_platform_key as "platformKey",
           impact.lifecycle_state::text as state
    from public.public_change_catalog_impacts as impact
    where impact.organization_id = ${uuid(input.organizationId)}
      and impact.lifecycle_platform_key = any(
        ${[...input.configuredPlatformKeys]}::text[]
      )
      and impact.cause_sequence <= ${input.throughSequence}
    order by impact.lifecycle_platform_key, impact.cause_sequence desc
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
      const context = await loadEpochContext(transaction, input.organizationId);
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
        enabledPlatformKeys,
        lifecycleDecisionSequence: context.lifecycleDecisionSequence,
        checkpoints,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}
