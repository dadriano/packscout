import { Prisma } from "@prisma/client";
import type { PackscoutTransactionClient } from "./database.ts";

export interface SharedPublicConfigurationEpochDeclaration {
  readonly configurationKey: string;
  readonly revision: number;
  readonly configurationHash: string;
}

export interface ManifestLifecycleImpactDeclaration {
  readonly platformKey: string;
  readonly state: "active" | "disabled" | "archived";
}

export type PublicCatalogImpact =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "catalog";
      providerPlatformKeys: readonly string[];
      sharedConfigurationEpoch?: SharedPublicConfigurationEpochDeclaration;
      manifestLifecycle?: ManifestLifecycleImpactDeclaration;
    }>;

export interface CatalogImpactCause {
  readonly organizationId: string;
  readonly sequence: bigint;
  readonly occurredAt: Date;
  readonly catalogImpact: PublicCatalogImpact;
}

const platformKeyPattern = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const configurationKeyPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

function assertPlatformKey(value: string): void {
  if (value.length > 128 || !platformKeyPattern.test(value)) {
    throw new RangeError("Catalog impact platform key is invalid.");
  }
}

export function assertCatalogSettlementTransaction(
  database: PackscoutTransactionClient,
): void {
  if ("$transaction" in (database as unknown as Record<string, unknown>)) {
    throw new TypeError(
      "Public change catalog settlement requires the caller's active database transaction.",
    );
  }
}

export function canonicalCatalogPlatformKeys(
  values: readonly string[],
): readonly string[] {
  const unique = [...new Set(values)];
  for (const value of unique) assertPlatformKey(value);
  unique.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (unique.length > 8) {
    throw new RangeError("Catalog impact exceeds the launch platform bound.");
  }
  return Object.freeze(unique);
}

function normalizeProviderPlatformKeys(
  values: readonly string[],
): readonly string[] {
  if (values.length > 8) {
    throw new RangeError("Catalog impact exceeds the launch platform bound.");
  }
  const normalized = [...values];
  for (const [index, value] of normalized.entries()) {
    assertPlatformKey(value);
    if (index > 0 && normalized[index - 1]! >= value) {
      throw new RangeError(
        "Catalog impact platform keys must be strictly sorted and unique.",
      );
    }
  }
  return normalized;
}

export function normalizePublicCatalogImpact(
  impact: PublicCatalogImpact,
): PublicCatalogImpact {
  if (impact.kind === "none") return Object.freeze({ kind: "none" });
  const providerPlatformKeys = normalizeProviderPlatformKeys(
    impact.providerPlatformKeys,
  );
  const epoch = impact.sharedConfigurationEpoch;
  if (
    epoch !== undefined &&
    (!configurationKeyPattern.test(epoch.configurationKey) ||
      !Number.isSafeInteger(epoch.revision) ||
      epoch.revision < 1 ||
      !sha256Pattern.test(epoch.configurationHash))
  ) {
    throw new RangeError("Shared public configuration epoch is invalid.");
  }
  const lifecycle = impact.manifestLifecycle;
  if (lifecycle !== undefined) {
    assertPlatformKey(lifecycle.platformKey);
    const providerAffected = providerPlatformKeys.includes(
      lifecycle.platformKey,
    );
    if (
      (lifecycle.state === "active" && !providerAffected) ||
      (lifecycle.state !== "active" && providerAffected)
    ) {
      throw new RangeError("Manifest lifecycle catalog impact is inconsistent.");
    }
  }
  if (
    providerPlatformKeys.length === 0 &&
    epoch === undefined &&
    lifecycle === undefined
  ) {
    throw new RangeError("An empty catalog impact must use kind none.");
  }
  return Object.freeze({
    kind: "catalog",
    providerPlatformKeys: Object.freeze(providerPlatformKeys),
    ...(epoch === undefined
      ? {}
      : {
          sharedConfigurationEpoch: Object.freeze({ ...epoch }),
        }),
    ...(lifecycle === undefined
      ? {}
      : { manifestLifecycle: Object.freeze({ ...lifecycle }) }),
  });
}

export async function persistPublicChangeCatalogImpacts(
  database: PackscoutTransactionClient,
  causes: readonly CatalogImpactCause[],
): Promise<void> {
  assertCatalogSettlementTransaction(database);
  if (causes.length === 0) return;
  const normalized = causes.map((cause) => ({
    ...cause,
    catalogImpact: normalizePublicCatalogImpact(cause.catalogImpact),
  }));
  const impactRows = normalized.map((cause) => {
    const impact = cause.catalogImpact;
    const providerPlatformKeys =
      impact.kind === "catalog" ? [...impact.providerPlatformKeys] : [];
    const epoch =
      impact.kind === "catalog" ? impact.sharedConfigurationEpoch : undefined;
    const lifecycle =
      impact.kind === "catalog" ? impact.manifestLifecycle : undefined;
    return Prisma.sql`(
      ${uuid(cause.organizationId)}, ${cause.sequence},
      ${providerPlatformKeys}::text[], ${epoch?.configurationKey ?? null},
      ${epoch?.revision ?? null}, ${epoch?.configurationHash ?? null},
      ${lifecycle?.platformKey ?? null},
      ${lifecycle?.state ?? null}::public.provider_state,
      ${cause.occurredAt}
    )`;
  });
  await database.$executeRaw(Prisma.sql`
    insert into public.public_change_catalog_impacts (
      organization_id, cause_sequence, provider_platform_keys,
      shared_configuration_key, shared_configuration_revision,
      shared_configuration_hash, lifecycle_platform_key, lifecycle_state,
      created_at
    ) values ${Prisma.join(impactRows)}
  `);

  const providerHeads = new Map<
    string,
    { organizationId: string; platformKey: string; sequence: bigint; occurredAt: Date }
  >();
  for (const cause of normalized) {
    if (cause.catalogImpact.kind !== "catalog") continue;
    for (const platformKey of cause.catalogImpact.providerPlatformKeys) {
      const identity = `${cause.organizationId}\u0000${platformKey}`;
      const current = providerHeads.get(identity);
      if (!current || cause.sequence > current.sequence) {
        providerHeads.set(identity, {
          organizationId: cause.organizationId,
          platformKey,
          sequence: cause.sequence,
          occurredAt: cause.occurredAt,
        });
      }
    }
  }
  if (providerHeads.size > 0) {
    const rows = [...providerHeads.values()].map((head) => Prisma.sql`(
      ${uuid(head.organizationId)}, ${head.platformKey}, ${head.sequence},
      ${head.occurredAt}, ${head.occurredAt}
    )`);
    await database.$executeRaw(Prisma.sql`
      insert into public.provider_catalog_checkpoints (
        organization_id, platform_key, source_head_sequence,
        source_head_at, updated_at
      ) values ${Prisma.join(rows)}
      on conflict (organization_id, platform_key) do update
      set source_head_sequence = greatest(
            public.provider_catalog_checkpoints.source_head_sequence,
            excluded.source_head_sequence
          ),
          source_head_at = case
            when excluded.source_head_sequence >
              public.provider_catalog_checkpoints.source_head_sequence
              then excluded.source_head_at
            else public.provider_catalog_checkpoints.source_head_at
          end,
          updated_at = greatest(
            public.provider_catalog_checkpoints.updated_at,
            excluded.updated_at
          )
    `);
  }

  const manifestHeads = new Map<
    string,
    { sequence: bigint; occurredAt: Date }
  >();
  for (const cause of normalized) {
    const impact = cause.catalogImpact;
    if (
      impact.kind !== "catalog" ||
      (impact.sharedConfigurationEpoch === undefined &&
        impact.manifestLifecycle === undefined)
    ) {
      continue;
    }
    const current = manifestHeads.get(cause.organizationId);
    if (!current || cause.sequence > current.sequence) {
      manifestHeads.set(cause.organizationId, {
        sequence: cause.sequence,
        occurredAt: cause.occurredAt,
      });
    }
  }
  if (manifestHeads.size > 0) {
    const rows = [...manifestHeads].map(([organizationId, head]) => Prisma.sql`(
      ${uuid(organizationId)}, ${head.sequence}, ${head.occurredAt},
      ${head.occurredAt}
    )`);
    await database.$executeRaw(Prisma.sql`
      insert into public.catalog_manifest_lifecycle_checkpoints (
        organization_id, source_head_sequence, source_head_at, updated_at
      ) values ${Prisma.join(rows)}
      on conflict (organization_id) do update
      set source_head_sequence = greatest(
            public.catalog_manifest_lifecycle_checkpoints.source_head_sequence,
            excluded.source_head_sequence
          ),
          source_head_at = case
            when excluded.source_head_sequence >
              public.catalog_manifest_lifecycle_checkpoints.source_head_sequence
              then excluded.source_head_at
            else public.catalog_manifest_lifecycle_checkpoints.source_head_at
          end,
          updated_at = greatest(
            public.catalog_manifest_lifecycle_checkpoints.updated_at,
            excluded.updated_at
          )
    `);
  }
}

export async function assertCatalogObligationsAheadOfSettlement(
  database: PackscoutTransactionClient,
  input: { organizationId: string; causeSequences: readonly bigint[] },
): Promise<void> {
  assertCatalogSettlementTransaction(database);
  const rows = await database.$queryRaw<Array<{ behind: boolean }>>(Prisma.sql`
    select exists (
      select 1
      from public.public_change_catalog_impacts as impact
      where impact.organization_id = ${uuid(input.organizationId)}
        and impact.cause_sequence in (${Prisma.join(input.causeSequences)})
        and (
          exists (
            select 1
            from public.provider_catalog_checkpoints as checkpoint
            where checkpoint.organization_id = impact.organization_id
              and checkpoint.platform_key = any(impact.provider_platform_keys)
              and checkpoint.settled_sequence >= impact.cause_sequence
          )
          or (
            (impact.shared_configuration_hash is not null
              or impact.lifecycle_platform_key is not null)
            and exists (
              select 1
              from public.catalog_manifest_lifecycle_checkpoints as checkpoint
              where checkpoint.organization_id = impact.organization_id
                and checkpoint.settled_sequence >= impact.cause_sequence
            )
          )
        )
    ) as behind
  `);
  if (rows[0]?.behind) {
    throw new Error("A derivation obligation cannot be added behind catalog settlement.");
  }
}

export async function advanceCatalogImpactCheckpoints(
  database: PackscoutTransactionClient,
  input: { organizationId: string; settledAt: Date },
): Promise<void> {
  assertCatalogSettlementTransaction(database);
  await database.$queryRaw(Prisma.sql`
    select platform_key
    from public.provider_catalog_checkpoints
    where organization_id = ${uuid(input.organizationId)}
    order by platform_key collate "C"
    for update
  `);
  await database.$executeRaw(Prisma.sql`
    with candidates as (
      select checkpoint.organization_id, checkpoint.platform_key,
             coalesce((
               select max(impact.cause_sequence)
               from public.public_change_catalog_impacts as impact
               where impact.organization_id = checkpoint.organization_id
                 and checkpoint.platform_key = any(impact.provider_platform_keys)
                 and impact.cause_sequence > checkpoint.settled_sequence
                 and impact.cause_sequence < coalesce((
                   select min(blocked.cause_sequence)
                   from public.public_change_catalog_impacts as blocked
                   where blocked.organization_id = checkpoint.organization_id
                     and checkpoint.platform_key = any(blocked.provider_platform_keys)
                     and blocked.cause_sequence > checkpoint.settled_sequence
                     and exists (
                       select 1
                       from public.public_derivation_obligations as obligation
                       where obligation.organization_id = blocked.organization_id
                         and obligation.cause_sequence = blocked.cause_sequence
                         and obligation.state not in ('succeeded', 'business_unavailable')
                     )
                 ), checkpoint.source_head_sequence + 1)
             ), checkpoint.settled_sequence) as settled_sequence
      from public.provider_catalog_checkpoints as checkpoint
      where checkpoint.organization_id = ${uuid(input.organizationId)}
    )
    update public.provider_catalog_checkpoints as checkpoint
    set settled_sequence = candidate.settled_sequence,
        settled_at = case
          when candidate.settled_sequence > checkpoint.settled_sequence
            then greatest(checkpoint.settled_at, ${input.settledAt})
          else checkpoint.settled_at
        end,
        updated_at = greatest(checkpoint.updated_at, ${input.settledAt})
    from candidates as candidate
    where checkpoint.organization_id = candidate.organization_id
      and checkpoint.platform_key = candidate.platform_key
  `);

  await database.$queryRaw(Prisma.sql`
    select organization_id
    from public.catalog_manifest_lifecycle_checkpoints
    where organization_id = ${uuid(input.organizationId)}
    for update
  `);
  await database.$executeRaw(Prisma.sql`
    with candidates as (
      select checkpoint.organization_id,
             coalesce((
               select max(impact.cause_sequence)
               from public.public_change_catalog_impacts as impact
               where impact.organization_id = checkpoint.organization_id
                 and (impact.shared_configuration_hash is not null
                   or impact.lifecycle_platform_key is not null)
                 and impact.cause_sequence > checkpoint.settled_sequence
                 and impact.cause_sequence < coalesce((
                   select min(blocked.cause_sequence)
                   from public.public_change_catalog_impacts as blocked
                   where blocked.organization_id = checkpoint.organization_id
                     and (blocked.shared_configuration_hash is not null
                       or blocked.lifecycle_platform_key is not null)
                     and blocked.cause_sequence > checkpoint.settled_sequence
                     and exists (
                       select 1
                       from public.public_derivation_obligations as obligation
                       where obligation.organization_id = blocked.organization_id
                         and obligation.cause_sequence = blocked.cause_sequence
                         and obligation.state not in ('succeeded', 'business_unavailable')
                     )
                 ), checkpoint.source_head_sequence + 1)
             ), checkpoint.settled_sequence) as settled_sequence
      from public.catalog_manifest_lifecycle_checkpoints as checkpoint
      where checkpoint.organization_id = ${uuid(input.organizationId)}
    )
    update public.catalog_manifest_lifecycle_checkpoints as checkpoint
    set settled_sequence = candidate.settled_sequence,
        settled_at = case
          when candidate.settled_sequence > checkpoint.settled_sequence
            then greatest(checkpoint.settled_at, ${input.settledAt})
          else checkpoint.settled_at
        end,
        updated_at = greatest(checkpoint.updated_at, ${input.settledAt})
    from candidates as candidate
    where checkpoint.organization_id = candidate.organization_id
  `);
}
