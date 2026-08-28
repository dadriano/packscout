import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type {
  PackscoutPrismaClient,
  PackscoutQueryClient,
  PackscoutTransactionClient,
} from "./database.ts";
import {
  advanceCatalogImpactCheckpoints,
  assertCatalogSettlementTransaction,
  assertCatalogObligationsAheadOfSettlement,
  normalizePublicCatalogImpact,
  persistPublicChangeCatalogImpacts,
  type PublicCatalogImpact,
} from "./public-change-settlement-repository.catalog-impact.ts";

export type {
  ManifestLifecycleImpactDeclaration,
  PublicCatalogImpact,
  SharedPublicConfigurationEpochDeclaration,
} from "./public-change-settlement-repository.catalog-impact.ts";
export { canonicalCatalogPlatformKeys } from "./public-change-settlement-repository.catalog-impact.ts";

export const publicChangeKinds = [
  "provider_projection",
  "quarantine_correction",
  "relationship_resolution",
  "relationship_confirmation",
  "estimated_ev_outcome",
  "public_configuration",
  "provider_lifecycle",
  "manual_correction",
] as const;

export type PublicChangeKind = (typeof publicChangeKinds)[number];
export type PublicDerivationKind = "estimated_ev";
export type PublicDerivationState =
  | "pending"
  | "claimed"
  | "succeeded"
  | "business_unavailable"
  | "technical_failure";

export interface PublicChangeCause {
  readonly organizationId: string;
  readonly sequence: bigint;
  readonly changeKind: PublicChangeKind;
  readonly entityKey: string;
  readonly sourceKey: string | null;
  readonly sourceRevisionKey: string | null;
  readonly metadata: Record<string, unknown>;
  readonly occurredAt: Date;
  readonly authoritativeTransactionId: string;
}

export interface AllocatedPublicChangeCause extends PublicChangeCause {
  readonly catalogImpact: PublicCatalogImpact;
}

export interface PublicDerivationObligation {
  readonly id: string;
  readonly organizationId: string;
  readonly causeSequence: bigint;
  readonly derivationKind: PublicDerivationKind;
  readonly derivationKey: string;
  readonly state: PublicDerivationState;
  readonly claimedBy: string | null;
  readonly claimToken: string | null;
  readonly claimExpiresAt: Date | null;
  readonly outcomeClassification:
    | "success"
    | "business_unavailable"
    | "technical_failure"
    | null;
  readonly outcomeReasonCode: string | null;
  readonly outcomeAt: Date | null;
}

export interface PublicSourceHead {
  readonly sourceKey: string;
  readonly sourceRevisionKey: string | null;
  readonly sequence: bigint;
  readonly occurredAt: Date;
  readonly settled: boolean;
}

export interface SettledPublicWatermark {
  readonly organizationId: string;
  readonly settledSequence: bigint;
  readonly settledAt: Date | null;
  readonly sourceHeadSequence: bigint;
  readonly sourceHeadAt: Date | null;
  readonly sourceHeads: readonly PublicSourceHead[];
}

export interface AllocatePublicChangeInput {
  readonly changeKind: PublicChangeKind;
  readonly entityKey: string;
  readonly sourceKey?: string | null;
  readonly sourceRevisionKey?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly catalogImpact: PublicCatalogImpact;
}

interface WatermarkRow {
  organizationId: string;
  settledSequence: bigint;
  settledAt: Date | null;
  sourceHeadSequence: bigint;
  sourceHeadAt: Date | null;
}

const boundedKeyPattern = /^\S(?:.{0,510}\S)?$/s;
const sourceKeyPattern = /^\S(?:.{0,126}\S)?$/s;
const derivationKeyPattern = /^\S(?:.{0,254}\S)?$/s;

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

function jsonValue(value: unknown): Prisma.Sql {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Public change metadata must be JSON serializable.");
  }
  return Prisma.sql`cast(${serialized} as jsonb)`;
}

function requirePattern(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) throw new RangeError(`${label} is invalid.`);
}

function publicEntityKey(namespace: string, values: readonly string[]): string {
  const digest = createHash("sha256").update(values.join("\u0000")).digest("hex");
  return `${namespace}:v1:${digest}`;
}

export function canonicalPublicEntityKey(entityId: string): string {
  return `canonical:v1:${entityId}`;
}

export function providerPublicEntityKey(providerId: string): string {
  return `provider:v1:${providerId}`;
}

export function relationshipPublicEntityKey(input: {
  sourceEntityId: string;
  relationshipKind: string;
  targetPlatformKey: string;
  targetRecordKind: string;
  targetExternalId: string | null;
}): string {
  return publicEntityKey("relationship", [
    input.sourceEntityId,
    input.relationshipKind,
    input.targetPlatformKey,
    input.targetRecordKind,
    input.targetExternalId ?? "",
  ]);
}

export function relationshipConfirmationPublicEntityKey(input: {
  sourceRevisionId: string;
  semanticObservationId: string;
  declarationHash: string;
}): string {
  return publicEntityKey("relationship-confirmation", [
    input.sourceRevisionId,
    input.semanticObservationId,
    input.declarationHash,
  ]);
}

export async function allocatePublicChangeCauses(
  database: PackscoutTransactionClient,
  input: {
    organizationId: string;
    changes: readonly AllocatePublicChangeInput[];
  },
): Promise<readonly AllocatedPublicChangeCause[]> {
  assertCatalogSettlementTransaction(database);
  if (input.changes.length === 0) return [];
  if (input.changes.length > 1_000) {
    throw new RangeError("Public change allocation exceeds its transaction bound.");
  }
  for (const change of input.changes) {
    normalizePublicCatalogImpact(change.catalogImpact);
    requirePattern(change.entityKey, boundedKeyPattern, "Public entity key");
    if (change.sourceKey !== null && change.sourceKey !== undefined) {
      requirePattern(change.sourceKey, sourceKeyPattern, "Public source key");
    }
    if (
      change.sourceRevisionKey !== null &&
      change.sourceRevisionKey !== undefined
    ) {
      requirePattern(
        change.sourceRevisionKey,
        sourceKeyPattern,
        "Public source revision key",
      );
    }
  }
  const lastChange = input.changes.at(-1)!;
  await database.$executeRaw(Prisma.sql`
    insert into public.settled_public_watermarks (organization_id)
    values (${uuid(input.organizationId)})
    on conflict (organization_id) do nothing
  `);
  const heads = await database.$queryRaw<Array<{ firstSequence: bigint }>>(Prisma.sql`
    update public.settled_public_watermarks
    set next_sequence = next_sequence + ${input.changes.length},
        source_head_sequence = source_head_sequence + ${input.changes.length},
        source_head_at = ${lastChange.occurredAt},
        updated_at = ${lastChange.occurredAt}
    where organization_id = ${uuid(input.organizationId)}
    returning next_sequence - ${input.changes.length} as "firstSequence"
  `);
  const firstSequence = heads[0]?.firstSequence;
  if (firstSequence === undefined) {
    throw new Error("Public change sequence allocation failed.");
  }
  const transactions = await database.$queryRaw<
    Array<{ transactionId: string }>
  >(Prisma.sql`
    select pg_current_xact_id()::text as "transactionId"
  `);
  const transactionId = transactions[0]?.transactionId;
  if (!transactionId) throw new Error("Public change transaction identity failed.");

  const causes = input.changes.map((change, index) => ({
    organizationId: input.organizationId,
    sequence: firstSequence + BigInt(index),
    changeKind: change.changeKind,
    entityKey: change.entityKey,
    sourceKey: change.sourceKey ?? null,
    sourceRevisionKey: change.sourceRevisionKey ?? null,
    metadata: { ...(change.metadata ?? {}) },
    occurredAt: change.occurredAt,
    authoritativeTransactionId: transactionId,
    catalogImpact: normalizePublicCatalogImpact(change.catalogImpact),
  }));
  const rows = causes.map((cause) => Prisma.sql`(
    ${uuid(cause.organizationId)}, ${cause.sequence},
    cast(${cause.changeKind} as public.public_change_kind), ${cause.entityKey},
    ${cause.sourceKey}, ${cause.sourceRevisionKey}, ${jsonValue(cause.metadata)},
    ${cause.occurredAt}, ${cause.authoritativeTransactionId}, ${cause.occurredAt}
  )`);
  await database.$executeRaw(Prisma.sql`
    insert into public.public_change_causes (
      organization_id, sequence, change_kind, entity_key, source_key,
      source_revision_key, metadata_json, occurred_at,
      authoritative_transaction_id, created_at
    ) values ${Prisma.join(rows)}
  `);
  await persistPublicChangeCatalogImpacts(database, causes);
  return causes;
}

export async function createPublicDerivationObligations(
  database: PackscoutTransactionClient,
  input: {
    organizationId: string;
    causeSequences: readonly bigint[];
    derivationKind: PublicDerivationKind;
    derivationKey: string;
    createdAt: Date;
  },
): Promise<void> {
  assertCatalogSettlementTransaction(database);
  if (input.causeSequences.length === 0) return;
  requirePattern(
    input.derivationKey,
    derivationKeyPattern,
    "Public derivation key",
  );
  const uniqueSequences = [...new Set(input.causeSequences)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const watermarks = await database.$queryRaw<
    Array<{ settledSequence: bigint }>
  >(Prisma.sql`
    select settled_sequence as "settledSequence"
    from public.settled_public_watermarks
    where organization_id = ${uuid(input.organizationId)}
    for update
  `);
  const watermark = watermarks[0];
  if (
    !watermark ||
    uniqueSequences.some((sequence) => sequence <= watermark.settledSequence)
  ) {
    throw new Error("A derivation obligation cannot be added behind settlement.");
  }
  await assertCatalogObligationsAheadOfSettlement(database, {
    organizationId: input.organizationId,
    causeSequences: uniqueSequences,
  });
  const rows = uniqueSequences.map((sequence) => Prisma.sql`(
    ${uuid(input.organizationId)}, ${sequence},
    cast(${input.derivationKind} as public.public_derivation_kind),
    ${input.derivationKey}, ${input.createdAt}, ${input.createdAt}
  )`);
  await database.$executeRaw(Prisma.sql`
    insert into public.public_derivation_obligations (
      organization_id, cause_sequence, derivation_kind, derivation_key,
      created_at, updated_at
    ) values ${Prisma.join(rows)}
    on conflict (
      organization_id, cause_sequence, derivation_kind, derivation_key
    ) do nothing
  `);
}

export async function advanceSettledPublicWatermark(
  database: PackscoutTransactionClient,
  input: { organizationId: string; settledAt: Date },
): Promise<void> {
  assertCatalogSettlementTransaction(database);
  await database.$queryRaw(Prisma.sql`
    select organization_id
    from public.settled_public_watermarks
    where organization_id = ${uuid(input.organizationId)}
    for update
  `);
  await database.$executeRaw(Prisma.sql`
    with candidate as (
      select
        watermark.organization_id,
        coalesce(
          min(obligation.cause_sequence) filter (
            where obligation.state not in (
              'succeeded'::public.public_derivation_state,
              'business_unavailable'::public.public_derivation_state
            )
          ) - 1,
          watermark.source_head_sequence
        ) as settled_sequence
      from public.settled_public_watermarks as watermark
      left join public.public_derivation_obligations as obligation
        on obligation.organization_id = watermark.organization_id
       and obligation.cause_sequence > watermark.settled_sequence
      where watermark.organization_id = ${uuid(input.organizationId)}
      group by watermark.organization_id, watermark.source_head_sequence
    )
    update public.settled_public_watermarks as watermark
    set settled_sequence = greatest(
          watermark.settled_sequence,
          candidate.settled_sequence
        ),
        settled_at = case
          when candidate.settled_sequence > watermark.settled_sequence
            then ${input.settledAt}
          else watermark.settled_at
        end,
        updated_at = ${input.settledAt}
    from candidate
    where watermark.organization_id = candidate.organization_id
  `);
  await advanceCatalogImpactCheckpoints(database, input);
}

async function loadSettledPublicWatermark(
  database: PackscoutQueryClient,
  organizationId: string,
): Promise<SettledPublicWatermark> {
  const rows = await database.$queryRaw<WatermarkRow[]>(Prisma.sql`
    select organization_id as "organizationId",
           settled_sequence as "settledSequence",
           settled_at as "settledAt",
           source_head_sequence as "sourceHeadSequence",
           source_head_at as "sourceHeadAt"
    from public.settled_public_watermarks
    where organization_id = ${uuid(organizationId)}
  `);
  const row = rows[0] ?? {
    organizationId,
    settledSequence: 0n,
    settledAt: null,
    sourceHeadSequence: 0n,
    sourceHeadAt: null,
  };
  const heads = await database.$queryRaw<Array<{
    sourceKey: string;
    sourceRevisionKey: string | null;
    sequence: bigint;
    occurredAt: Date;
  }>>(Prisma.sql`
    select distinct on (source_key)
           source_key as "sourceKey",
           source_revision_key as "sourceRevisionKey",
           sequence,
           occurred_at as "occurredAt"
    from public.public_change_causes
    where organization_id = ${uuid(organizationId)}
      and source_key is not null
    order by source_key, sequence desc
  `);
  return {
    ...row,
    sourceHeads: heads.map((head) => ({
      ...head,
      settled: head.sequence <= row.settledSequence,
    })),
  };
}

export class PrismaPublicChangeSettlementRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  getSettledWatermark(organizationId: string): Promise<SettledPublicWatermark> {
    return loadSettledPublicWatermark(this.database, organizationId);
  }

  async listSettledCauses(input: {
    organizationId: string;
    afterSequence: bigint;
    throughSequence: bigint;
    limit: number;
  }): Promise<readonly PublicChangeCause[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new RangeError("Settled public change page size is invalid.");
    }
    if (input.afterSequence < 0n || input.throughSequence < input.afterSequence) {
      throw new RangeError("Settled public change range is invalid.");
    }
    const watermark = await loadSettledPublicWatermark(
      this.database,
      input.organizationId,
    );
    if (input.throughSequence > watermark.settledSequence) {
      throw new RangeError("Public changes cannot be read beyond settlement.");
    }
    const rows = await this.database.$queryRaw<Array<{
      organizationId: string;
      sequence: bigint;
      changeKind: PublicChangeKind;
      entityKey: string;
      sourceKey: string | null;
      sourceRevisionKey: string | null;
      metadata: Record<string, unknown>;
      occurredAt: Date;
      authoritativeTransactionId: string;
    }>>(Prisma.sql`
      select organization_id as "organizationId",
             sequence,
             change_kind::text as "changeKind",
             entity_key as "entityKey",
             source_key as "sourceKey",
             source_revision_key as "sourceRevisionKey",
             metadata_json as metadata,
             occurred_at as "occurredAt",
             authoritative_transaction_id as "authoritativeTransactionId"
      from public.public_change_causes
      where organization_id = ${uuid(input.organizationId)}
        and sequence > ${input.afterSequence}
        and sequence <= ${input.throughSequence}
      order by sequence
      limit ${input.limit}
    `);
    return rows;
  }
}
