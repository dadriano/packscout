import { createHash } from "node:crypto";
import {
  MAX_PUBLIC_REPACKS_PER_RELEASE,
  REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_BYTES_TOTAL,
  REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_KEYS_PER_SNAPSHOT,
  REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_KEYS_TOTAL,
  REPACK_HEAT_MAXIMUM_CATALOG_SEQUENCE,
  REPACK_HEAT_MAXIMUM_OBSERVATIONS,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import type { PackscoutQueryClient } from "./database.ts";

const sevenDaysInMilliseconds = 7 * 24 * 60 * 60 * 1_000;
const maximumObservedBasisPoints = 10_000_000;
const maximumAvailableChaseCount = 10_000;
const maximumWriteCandidates = 1_000;
const canonicalAvailabilities = new Set([
  "active",
  "disabled",
  "sold_out",
  "unknown",
]);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuidV5Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type NormalizedHeatOutcomeReason =
  | "NORMALIZED"
  | "MAPPING_MISSING"
  | "EVIDENCE_UNSUPPORTED"
  | "EVIDENCE_MALFORMED"
  | "WINDOW_CLOSED"
  | "CATALOG_LIMIT_EXCEEDED"
  | "DUPLICATE_SOURCE_EVENT";

export type NormalizedHeatObservation =
  | Readonly<{
      schemaVersion: "normalized_heat_observation_v1";
      kind: "pull";
      observationKey: string;
      publicRepackId: string;
      occurredAt: string;
      causalSequence: bigint;
      realizedReturnBasisPoints: number | null;
      valueMultipleBasisPoints: number | null;
    }>
  | Readonly<{
      schemaVersion: "normalized_heat_observation_v1";
      kind: "catalog_snapshot";
      observationKey: string;
      publicRepackId: string;
      occurredAt: string;
      causalSequence: bigint;
      /** Int32 calculator tie-break derived from the tenant's causal sequence. */
      catalogSequence: number;
      availableChaseCount: number;
      outcomeKeys: readonly string[];
    }>;

export type NormalizedHeatObservationWindowResult =
  | Readonly<{
      status: "ready";
      throughSettledSequence: bigint;
      sourceCoverageComplete: boolean;
      sourceCoverageEvidence: readonly NormalizedHeatOutcomeReason[];
      observations: readonly NormalizedHeatObservation[];
    }>
  | Readonly<{
      status: "overflow";
      throughSettledSequence: bigint;
      sourceCoverageComplete: false;
      sourceCoverageEvidence: readonly [
        | "OBSERVATION_LIMIT_EXCEEDED"
        | "CATALOG_KEY_LIMIT_EXCEEDED"
        | "CATALOG_BYTE_LIMIT_EXCEEDED",
      ];
      observations: readonly [];
    }>;

export interface NormalizedHeatObservationReadPort {
  listSettledNormalizedHeatObservations(input: {
    organizationId: string;
    publicRepackIds: readonly string[];
    occurredAtGte: string;
    occurredAtLt: string;
    causalSequenceLte: bigint;
    limit: number;
  }): Promise<Readonly<{
    observations: readonly NormalizedHeatObservation[];
    sourceCoverageComplete: boolean;
    truncated: boolean;
  }>>;
}

export interface CanonicalHeatSourceRevision {
  readonly revisionId: string;
  readonly entityId: string;
  readonly platformKey: string;
  readonly recordKind: string;
  readonly externalId: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly publicChangeSequence: bigint;
  readonly occurredAt: Date;
}

export interface RegisterApprovedPublicRepackIdentityInput {
  readonly organizationId: string;
  readonly platformKey: string;
  readonly packExternalId: string;
  readonly publicRepackId: string;
  readonly approvedConfigurationKey: string;
  readonly publicChangeSequence: bigint;
  readonly approvedAt: Date;
}

export interface RegisterApprovedPublicRepackIdentityBatchInput {
  readonly organizationId: string;
  readonly approvedConfigurationKey: string;
  readonly publicChangeSequence: bigint;
  readonly approvedAt: Date;
  readonly mappings: readonly Readonly<{
    platformKey: string;
    packExternalId: string;
    publicRepackId: string;
  }>[];
}

interface MappingRow {
  platformKey: string;
  packExternalId: string;
  publicRepackId: string;
  approvedConfigurationKey: string;
  publicChangeSequence: bigint;
  approvedAt: Date;
}

interface ObservationRow {
  observationId: string;
  observationKey: string;
  publicRepackId: string;
  observationKind: "pull" | "catalog_snapshot";
  occurredAt: Date;
  publicChangeSequence: bigint;
  catalogSequence: number | null;
  realizedReturnBasisPoints: number | null;
  valueMultipleBasisPoints: number | null;
  availableChaseCount: number | null;
  outcomeKeys: string[];
}

interface ObservationBoundsRow {
  observationCount: bigint;
  catalogKeyCount: bigint;
  catalogKeyBytes: bigint;
}

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

function requireUuid(value: string, field: string): string {
  if (!uuidPattern.test(value)) throw new RangeError(`${field} is invalid.`);
  return value.toLowerCase();
}

function requireUuidV5(value: string, field: string): string {
  if (!uuidV5Pattern.test(value)) throw new RangeError(`${field} must be UUIDv5.`);
  return value.toLowerCase();
}

function requireBoundedText(
  value: string,
  field: string,
  maximumLength: number,
): string {
  if (value !== value.trim() || value.length < 1 || value.length > maximumLength) {
    throw new RangeError(`${field} is invalid.`);
  }
  return value;
}

function requireCanonicalDate(value: Date, field: string): void {
  if (!Number.isFinite(value.getTime())) throw new RangeError(`${field} is invalid.`);
  // JavaScript Dates and calculator timestamps share millisecond precision.
  if (new Date(value.toISOString()).getTime() !== value.getTime()) {
    throw new RangeError(`${field} must use canonical millisecond precision.`);
  }
}

function requireCanonicalTimestamp(value: string, field: string): Date {
  const parsed = new Date(value);
  if (
    typeof value !== "string"
    || !Number.isFinite(parsed.getTime())
    || parsed.toISOString() !== value
  ) {
    throw new RangeError(`${field} must be a canonical UTC timestamp.`);
  }
  return parsed;
}

function retainedUntil(occurredAt: Date): Date {
  return new Date(occurredAt.getTime() + sevenDaysInMilliseconds);
}

function mappingKey(platformKey: string, packExternalId: string): string {
  return `${platformKey}\u0000${packExternalId}`;
}

function stablePublicEvidenceKey(
  domain: "observation:pull" | "observation:catalog" | "catalog:outcome",
  values: readonly string[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(["normalized-heat-v1", domain, ...values]))
    .digest("hex");
}

function normalizeObservationRow(row: ObservationRow): NormalizedHeatObservation {
  const common = {
    schemaVersion: "normalized_heat_observation_v1" as const,
    observationKey: row.observationKey,
    publicRepackId: row.publicRepackId,
    occurredAt: row.occurredAt.toISOString(),
    causalSequence: row.publicChangeSequence,
  };
  if (row.observationKind === "pull") {
    return {
      kind: "pull",
      ...common,
      realizedReturnBasisPoints: row.realizedReturnBasisPoints,
      valueMultipleBasisPoints: row.valueMultipleBasisPoints,
    };
  }
  if (row.availableChaseCount === null) {
    throw new Error("Catalog Heat observation has an invalid persisted shape.");
  }
  if (row.catalogSequence === null) {
    throw new Error("Catalog Heat observation has no deterministic sequence.");
  }
  return {
    kind: "catalog_snapshot",
    ...common,
    catalogSequence: row.catalogSequence,
    availableChaseCount: row.availableChaseCount,
    outcomeKeys: Object.freeze([...row.outcomeKeys]),
  };
}

export class PublicRepackIdentityMappingConflictError extends Error {
  readonly code = "PUBLIC_REPACK_IDENTITY_MAPPING_CONFLICT" as const;

  constructor() {
    super("Approved public repack identity conflicts with an immutable mapping.");
    this.name = "PublicRepackIdentityMappingConflictError";
  }
}

export class PrismaPublicRepackIdentityMappingRepository {
  constructor(private readonly database: PackscoutQueryClient) {}

  async registerApprovedMapping(
    input: RegisterApprovedPublicRepackIdentityInput,
  ): Promise<Readonly<{ status: "created" | "existing" }>> {
    const result = await this.registerApprovedMappings({
      organizationId: input.organizationId,
      approvedConfigurationKey: input.approvedConfigurationKey,
      publicChangeSequence: input.publicChangeSequence,
      approvedAt: input.approvedAt,
      mappings: [{
        platformKey: input.platformKey,
        packExternalId: input.packExternalId,
        publicRepackId: input.publicRepackId,
      }],
    });
    return { status: result.created === 1 ? "created" : "existing" };
  }

  /**
   * Registers a complete approved mapping set in the caller's configuration
   * approval transaction. A thrown conflict must abort that outer transaction.
   * Later configurations may re-declare an identical stable identity; the
   * immutable row intentionally retains its first-approval provenance.
   */
  async registerApprovedMappings(
    input: RegisterApprovedPublicRepackIdentityBatchInput,
  ): Promise<Readonly<{ created: number; existing: number }>> {
    const organizationId = requireUuid(input.organizationId, "organizationId");
    const approvedConfigurationKey = requireBoundedText(
      input.approvedConfigurationKey,
      "approvedConfigurationKey",
      128,
    );
    if (input.publicChangeSequence < 1n) {
      throw new RangeError("publicChangeSequence is invalid.");
    }
    requireCanonicalDate(input.approvedAt, "approvedAt");
    if (
      input.mappings.length < 1
      || input.mappings.length > MAX_PUBLIC_REPACKS_PER_RELEASE
    ) {
      throw new RangeError("Approved public repack mapping batch is invalid.");
    }
    const mappings = input.mappings.map((mapping) => ({
      platformKey: requireBoundedText(mapping.platformKey, "platformKey", 128),
      packExternalId: requireBoundedText(
        mapping.packExternalId,
        "packExternalId",
        512,
      ),
      publicRepackId: requireUuidV5(mapping.publicRepackId, "publicRepackId"),
    }));
    if (
      new Set(mappings.map(({ platformKey, packExternalId }) =>
        mappingKey(platformKey, packExternalId))).size !== mappings.length
      || new Set(mappings.map(({ publicRepackId }) => publicRepackId)).size
        !== mappings.length
    ) {
      throw new PublicRepackIdentityMappingConflictError();
    }

    const causes = await this.database.$queryRaw<Array<{ valid: boolean }>>(Prisma.sql`
      select (change_kind = 'public_configuration') as valid
      from public.public_change_causes
      where organization_id = ${uuid(organizationId)}
        and sequence = ${input.publicChangeSequence}
      limit 1
    `);
    if (causes[0]?.valid !== true) {
      throw new RangeError("Mapping approval must reference a public configuration cause.");
    }

    const requested = mappings.map((mapping) => Prisma.sql`(
      ${mapping.platformKey}, ${mapping.packExternalId},
      ${uuid(mapping.publicRepackId)}
    )`);
    const existingRows = await this.database.$queryRaw<MappingRow[]>(Prisma.sql`
      select distinct mapping.platform_key as "platformKey",
             mapping.pack_external_id as "packExternalId",
             mapping.public_repack_id::text as "publicRepackId",
             mapping.approved_configuration_key as "approvedConfigurationKey",
             mapping.public_change_sequence as "publicChangeSequence",
             mapping.approved_at as "approvedAt"
      from public.public_repack_identity_mappings as mapping
      join (values ${Prisma.join(requested)})
        as requested(platform_key, pack_external_id, public_repack_id)
        on (
          requested.platform_key = mapping.platform_key
          and requested.pack_external_id = mapping.pack_external_id
        ) or requested.public_repack_id = mapping.public_repack_id
      where mapping.organization_id = ${uuid(organizationId)}
    `);
    const requestedByIdentity = new Map(
      mappings.map((mapping) => [
        mappingKey(mapping.platformKey, mapping.packExternalId),
        mapping,
      ]),
    );
    const requestedByPublicId = new Map(
      mappings.map((mapping) => [mapping.publicRepackId, mapping]),
    );
    for (const existing of existingRows) {
      const byIdentity = requestedByIdentity.get(
        mappingKey(existing.platformKey, existing.packExternalId),
      );
      const byPublicId = requestedByPublicId.get(existing.publicRepackId);
      if (
        !byIdentity
        || !byPublicId
        || byIdentity !== byPublicId
        || byIdentity.publicRepackId !== existing.publicRepackId
      ) {
        throw new PublicRepackIdentityMappingConflictError();
      }
    }
    const existingIdentityKeys = new Set(
      existingRows.map(({ platformKey, packExternalId }) =>
        mappingKey(platformKey, packExternalId)),
    );
    const newMappings = mappings.filter(({ platformKey, packExternalId }) =>
      !existingIdentityKeys.has(mappingKey(platformKey, packExternalId)),
    );
    if (newMappings.length > 0) {
      const values = newMappings.map((mapping) => Prisma.sql`(
        ${uuid(organizationId)}, ${mapping.platformKey}, ${mapping.packExternalId},
        ${uuid(mapping.publicRepackId)}, ${approvedConfigurationKey},
        ${input.publicChangeSequence}, ${input.approvedAt}, ${input.approvedAt}
      )`);
      const inserted = await this.database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        insert into public.public_repack_identity_mappings (
          organization_id, platform_key, pack_external_id, public_repack_id,
          approved_configuration_key, public_change_sequence, approved_at,
          created_at
        ) values ${Prisma.join(values)}
        on conflict do nothing
        returning public_repack_id::text as id
      `);
      if (inserted.length !== newMappings.length) {
        throw new PublicRepackIdentityMappingConflictError();
      }
    }
    return {
      created: newMappings.length,
      existing: mappings.length - newMappings.length,
    };
  }
}

/** Transaction-scoped adapter used by governed catalog configuration approval. */
export const prismaApprovedPublicRepackIdentityMaterializer = Object.freeze({
  async materializeApprovedMappings(
    database: PackscoutQueryClient,
    input: RegisterApprovedPublicRepackIdentityBatchInput,
  ): Promise<void> {
    await new PrismaPublicRepackIdentityMappingRepository(
      database,
    ).registerApprovedMappings(input);
  },
});

export class PrismaNormalizedHeatObservationRepository
implements NormalizedHeatObservationReadPort {
  readonly #organizationId: string;

  constructor(
    private readonly database: PackscoutQueryClient,
    configuration: { organizationId: string },
  ) {
    this.#organizationId = requireUuid(
      configuration.organizationId,
      "organizationId",
    );
  }

  async listSettledNormalizedHeatObservations(input: {
    organizationId: string;
    publicRepackIds: readonly string[];
    occurredAtGte: string;
    occurredAtLt: string;
    causalSequenceLte: bigint;
    limit: number;
  }): Promise<Readonly<{
    observations: readonly NormalizedHeatObservation[];
    sourceCoverageComplete: boolean;
    truncated: boolean;
  }>> {
    if (requireUuid(input.organizationId, "organizationId") !== this.#organizationId) {
      throw new RangeError("Heat observation organization is not approved.");
    }
    const occurredAtGte = requireCanonicalTimestamp(
      input.occurredAtGte,
      "occurredAtGte",
    );
    const occurredAtLt = requireCanonicalTimestamp(
      input.occurredAtLt,
      "occurredAtLt",
    );
    const result = await this.listSettledWindow({
      startAtInclusive: occurredAtGte,
      endAtExclusive: occurredAtLt,
      throughSettledSequence: input.causalSequenceLte,
      publicRepackIds: input.publicRepackIds,
      limit: input.limit,
    });
    return result.status === "overflow"
      ? {
          observations: [],
          sourceCoverageComplete: false,
          truncated: true,
        }
      : {
          observations: result.observations,
          sourceCoverageComplete: result.sourceCoverageComplete,
          truncated: false,
        };
  }

  async listSettledWindow(input: {
    startAtInclusive: Date;
    endAtExclusive: Date;
    throughSettledSequence: bigint;
    publicRepackIds: readonly string[];
    limit?: number;
  }): Promise<NormalizedHeatObservationWindowResult> {
    requireCanonicalDate(input.startAtInclusive, "startAtInclusive");
    requireCanonicalDate(input.endAtExclusive, "endAtExclusive");
    if (input.startAtInclusive >= input.endAtExclusive) {
      throw new RangeError("Heat observation window is invalid.");
    }
    if (input.throughSettledSequence < 0n) {
      throw new RangeError("throughSettledSequence is invalid.");
    }
    const limit = input.limit ?? REPACK_HEAT_MAXIMUM_OBSERVATIONS;
    if (
      !Number.isSafeInteger(limit)
      || limit < 1
      || limit > REPACK_HEAT_MAXIMUM_OBSERVATIONS
    ) {
      throw new RangeError("Heat observation limit is invalid.");
    }
    if (
      input.publicRepackIds.length > MAX_PUBLIC_REPACKS_PER_RELEASE
      || new Set(input.publicRepackIds).size !== input.publicRepackIds.length
    ) {
      throw new RangeError("Public repack filter is invalid.");
    }
    const publicRepackIds = input.publicRepackIds.map((value) =>
      requireUuidV5(value, "publicRepackIds"),
    );
    const watermarks = await this.database.$queryRaw<
      Array<{ settledSequence: bigint }>
    >(Prisma.sql`
      select settled_sequence as "settledSequence"
      from public.settled_public_watermarks
      where organization_id = ${uuid(this.#organizationId)}
      limit 1
    `);
    const settledSequence = watermarks[0]?.settledSequence ?? 0n;
    if (input.throughSettledSequence > settledSequence) {
      throw new RangeError("Heat observations cannot be read beyond settlement.");
    }
    if (publicRepackIds.length === 0) {
      return {
        status: "ready",
        throughSettledSequence: input.throughSettledSequence,
        sourceCoverageComplete: true,
        sourceCoverageEvidence: [],
        observations: [],
      };
    }

    const bounds = await this.database.$queryRaw<ObservationBoundsRow[]>(Prisma.sql`
      select count(*)::bigint as "observationCount",
             coalesce(
               sum(cardinality(outcome_keys))
                 filter (where observation_kind = 'catalog_snapshot'),
               0
             )::bigint as "catalogKeyCount",
             coalesce(
               sum(octet_length(array_to_string(outcome_keys, '')))
                 filter (where observation_kind = 'catalog_snapshot'),
               0
             )::bigint as "catalogKeyBytes"
      from public.normalized_heat_observations
      where organization_id = ${uuid(this.#organizationId)}
        and occurred_at >= ${input.startAtInclusive}
        and occurred_at < ${input.endAtExclusive}
        and public_change_sequence <= ${input.throughSettledSequence}
        and mapping_public_change_sequence <= ${input.throughSettledSequence}
        and public_repack_id in (${Prisma.join(publicRepackIds.map(uuid))})
    `);
    const observationBounds = bounds[0] ?? {
      observationCount: 0n,
      catalogKeyCount: 0n,
      catalogKeyBytes: 0n,
    };
    if (observationBounds.observationCount > BigInt(limit)) {
      return {
        status: "overflow",
        throughSettledSequence: input.throughSettledSequence,
        sourceCoverageComplete: false,
        sourceCoverageEvidence: ["OBSERVATION_LIMIT_EXCEEDED"],
        observations: [],
      };
    }
    if (
      observationBounds.catalogKeyCount
      > BigInt(REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_KEYS_TOTAL)
    ) {
      return {
        status: "overflow",
        throughSettledSequence: input.throughSettledSequence,
        sourceCoverageComplete: false,
        sourceCoverageEvidence: ["CATALOG_KEY_LIMIT_EXCEEDED"],
        observations: [],
      };
    }
    if (
      observationBounds.catalogKeyBytes
      > BigInt(REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_BYTES_TOTAL)
    ) {
      return {
        status: "overflow",
        throughSettledSequence: input.throughSettledSequence,
        sourceCoverageComplete: false,
        sourceCoverageEvidence: ["CATALOG_BYTE_LIMIT_EXCEEDED"],
        observations: [],
      };
    }

    const rows = await this.database.$queryRaw<ObservationRow[]>(Prisma.sql`
      select id::text as "observationId",
             observation_key as "observationKey",
             public_repack_id::text as "publicRepackId",
             observation_kind as "observationKind",
             occurred_at as "occurredAt",
             public_change_sequence as "publicChangeSequence",
             catalog_sequence as "catalogSequence",
             realized_return_basis_points as "realizedReturnBasisPoints",
             value_multiple_basis_points as "valueMultipleBasisPoints",
             available_chase_count as "availableChaseCount",
             outcome_keys as "outcomeKeys"
      from public.normalized_heat_observations
      where organization_id = ${uuid(this.#organizationId)}
        and occurred_at >= ${input.startAtInclusive}
        and occurred_at < ${input.endAtExclusive}
        and public_change_sequence <= ${input.throughSettledSequence}
        and mapping_public_change_sequence <= ${input.throughSettledSequence}
        and public_repack_id in (${Prisma.join(publicRepackIds.map(uuid))})
      order by occurred_at asc,
               public_change_sequence asc,
               catalog_sequence asc nulls first,
               observation_key asc
      limit ${limit}
    `);

    const incomplete = await this.database.$queryRaw<
      Array<{ reasonCode: NormalizedHeatOutcomeReason }>
    >(Prisma.sql`
      select distinct reason_code as "reasonCode"
      from public.normalized_heat_observation_outcomes
      where organization_id = ${uuid(this.#organizationId)}
        and occurred_at >= ${input.startAtInclusive}
        and occurred_at < ${input.endAtExclusive}
        and public_change_sequence <= ${input.throughSettledSequence}
        and status in ('deferred', 'rejected')
      order by reason_code asc
    `);
    const sourceCoverageEvidence = incomplete.map(({ reasonCode }) => reasonCode);
    return {
      status: "ready",
      throughSettledSequence: input.throughSettledSequence,
      sourceCoverageComplete: sourceCoverageEvidence.length === 0,
      sourceCoverageEvidence,
      observations: rows.map(normalizeObservationRow),
    };
  }

  async closeSettledWindow(input: {
    closedBefore: Date;
    throughSettledSequence: bigint;
    updatedAt: Date;
  }): Promise<void> {
    requireCanonicalDate(input.closedBefore, "closedBefore");
    requireCanonicalDate(input.updatedAt, "updatedAt");
    if (input.throughSettledSequence < 0n) {
      throw new RangeError("throughSettledSequence is invalid.");
    }
    const checkpoints = await this.database.$queryRaw<
      Array<{ settledSequence: bigint }>
    >(Prisma.sql`
      select settled_sequence as "settledSequence"
      from public.settled_public_watermarks
      where organization_id = ${uuid(this.#organizationId)}
      limit 1
    `);
    if (input.throughSettledSequence > (checkpoints[0]?.settledSequence ?? 0n)) {
      throw new RangeError("A Heat window cannot close beyond settlement.");
    }
    const closed = await this.database.$queryRaw<Array<{ organizationId: string }>>(
      Prisma.sql`
        insert into public.normalized_heat_window_checkpoints (
          organization_id, closed_before, through_settled_sequence, updated_at
        ) values (
          ${uuid(this.#organizationId)}, ${input.closedBefore},
          ${input.throughSettledSequence}, ${input.updatedAt}
        )
        on conflict (organization_id) do update
        set closed_before = excluded.closed_before,
            through_settled_sequence = excluded.through_settled_sequence,
            updated_at = excluded.updated_at
        where excluded.closed_before >= normalized_heat_window_checkpoints.closed_before
          and excluded.through_settled_sequence >= normalized_heat_window_checkpoints.through_settled_sequence
        returning organization_id::text as "organizationId"
      `,
    );
    if (closed.length === 0) {
      throw new RangeError("Heat window checkpoints are monotonic.");
    }
  }
}

interface PreparedCandidate {
  revision: CanonicalHeatSourceRevision;
  kind: "pull" | "catalog_snapshot";
  packExternalId: string;
}

interface PreparedObservation {
  revision: CanonicalHeatSourceRevision;
  observationKey: string;
  mapping: MappingRow;
  kind: "pull" | "catalog_snapshot";
  catalogSequence: number | null;
  realizedReturnBasisPoints: number | null;
  valueMultipleBasisPoints: number | null;
  availableChaseCount: number | null;
  outcomeKeys: readonly string[];
}

interface PreparedOutcome {
  revision: CanonicalHeatSourceRevision;
  status: "normalized" | "deferred" | "rejected" | "duplicate";
  reasonCode: NormalizedHeatOutcomeReason;
  observationId: string | null;
}

interface PackEvidenceRow {
  revisionId: string;
  content: unknown | null;
}

interface CatalogAssetRow {
  revisionId: string;
  platformKey: string;
  packExternalId: string;
  externalId: string;
  content: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) return null;
  return value;
}

function optionalMoney(value: unknown): Readonly<{
  amountMinor: number;
  currency: string;
}> | null | "malformed" {
  if (value === null) return null;
  if (!isObject(value)) return "malformed";
  const amountMinor = value.amountMinor;
  const currency = value.currency;
  if (
    !Number.isSafeInteger(amountMinor)
    || (amountMinor as number) < 0
    || typeof currency !== "string"
    || !/^[A-Z]{3}$/.test(currency)
  ) {
    return "malformed";
  }
  return { amountMinor: amountMinor as number, currency };
}

function boundedBasisPoints(value: number): number | null {
  const rounded = Math.round(value);
  return Number.isSafeInteger(rounded)
      && rounded >= 0
      && rounded <= maximumObservedBasisPoints
    ? rounded
    : null;
}

function textArray(values: readonly string[]): Prisma.Sql {
  if (values.length === 0) return Prisma.sql`array[]::text[]`;
  return Prisma.sql`array[${Prisma.join(values)}]::text[]`;
}

function classifyHeatCandidate(
  revision: CanonicalHeatSourceRevision,
): PreparedCandidate | NormalizedHeatOutcomeReason | null {
  if (revision.recordKind === "pull") {
    if (
      revision.content.eventKind !== "pull"
      || canonicalTimestamp(revision.content.occurredAt)
        !== revision.occurredAt.toISOString()
    ) {
      return "EVIDENCE_MALFORMED";
    }
    if (revision.content.packExternalId === null) {
      return "EVIDENCE_UNSUPPORTED";
    }
    if (
      typeof revision.content.packExternalId !== "string"
      || revision.content.packExternalId !== revision.content.packExternalId.trim()
      || revision.content.packExternalId.length < 1
      || revision.content.packExternalId.length > 512
    ) {
      return "EVIDENCE_MALFORMED";
    }
    if (optionalMoney(revision.content.value) === "malformed") {
      return "EVIDENCE_MALFORMED";
    }
    return {
      revision,
      kind: "pull",
      packExternalId: revision.content.packExternalId,
    };
  }
  if (revision.recordKind === "pack") {
    if (
      revision.content.entityType !== "pack"
      || typeof revision.content.availability !== "string"
      || !canonicalAvailabilities.has(revision.content.availability)
    ) {
      return "EVIDENCE_MALFORMED";
    }
    return {
      revision,
      kind: "catalog_snapshot",
      packExternalId: revision.externalId,
    };
  }
  if (revision.recordKind === "catalog_asset") {
    if (revision.content.entityType !== "catalog_asset") {
      return "EVIDENCE_MALFORMED";
    }
    if (revision.content.relatedPackExternalId === null) {
      return "EVIDENCE_UNSUPPORTED";
    }
    if (
      typeof revision.content.relatedPackExternalId !== "string"
      || revision.content.relatedPackExternalId
        !== revision.content.relatedPackExternalId.trim()
      || revision.content.relatedPackExternalId.length < 1
      || revision.content.relatedPackExternalId.length > 512
      || typeof revision.content.availability !== "string"
      || !canonicalAvailabilities.has(revision.content.availability)
    ) {
      return "EVIDENCE_MALFORMED";
    }
    return {
      revision,
      kind: "catalog_snapshot",
      packExternalId: revision.content.relatedPackExternalId,
    };
  }
  return null;
}

function catalogContentIsActive(content: unknown): boolean {
  return isObject(content)
    && content.entityType === "catalog_asset"
    && content.availability === "active";
}

function packContentIsActive(content: unknown): boolean {
  return isObject(content)
    && content.entityType === "pack"
    && content.availability === "active";
}

function pullValues(
  pullContent: Readonly<Record<string, unknown>>,
  packContent: unknown,
): Readonly<{
  realizedReturnBasisPoints: number | null;
  valueMultipleBasisPoints: number | null;
}> {
  const pullValue = optionalMoney(pullContent.value);
  if (pullValue === null || pullValue === "malformed" || !isObject(packContent)) {
    return { realizedReturnBasisPoints: null, valueMultipleBasisPoints: null };
  }
  const priceValueMinor = packContent.priceValueMinor;
  const priceCurrency = packContent.priceCurrency;
  if (
    !Number.isSafeInteger(priceValueMinor)
    || (priceValueMinor as number) <= 0
    || typeof priceCurrency !== "string"
    || priceCurrency !== pullValue.currency
  ) {
    return { realizedReturnBasisPoints: null, valueMultipleBasisPoints: null };
  }
  const valueMultipleBasisPoints = boundedBasisPoints(
    (pullValue.amountMinor * 10_000) / (priceValueMinor as number),
  );
  if (valueMultipleBasisPoints === null) {
    return { realizedReturnBasisPoints: null, valueMultipleBasisPoints: null };
  }
  const buybackPercent = packContent.buybackPercent;
  const realizedReturnBasisPoints =
    typeof buybackPercent === "number"
      && Number.isFinite(buybackPercent)
      && buybackPercent >= 0
      && buybackPercent <= 100
      ? boundedBasisPoints((valueMultipleBasisPoints * buybackPercent) / 100)
      : null;
  return { realizedReturnBasisPoints, valueMultipleBasisPoints };
}

async function loadMappings(
  database: PackscoutQueryClient,
  organizationId: string,
  candidates: readonly PreparedCandidate[],
): Promise<ReadonlyMap<string, MappingRow>> {
  const unique = new Map<string, { platformKey: string; packExternalId: string }>();
  for (const candidate of candidates) {
    unique.set(mappingKey(candidate.revision.platformKey, candidate.packExternalId), {
      platformKey: candidate.revision.platformKey,
      packExternalId: candidate.packExternalId,
    });
  }
  if (unique.size === 0) return new Map();
  const values = [...unique.values()].map(({ platformKey, packExternalId }) =>
    Prisma.sql`(${platformKey}, ${packExternalId})`,
  );
  const rows = await database.$queryRaw<MappingRow[]>(Prisma.sql`
    select mapping.platform_key as "platformKey",
           mapping.pack_external_id as "packExternalId",
           mapping.public_repack_id::text as "publicRepackId",
           mapping.approved_configuration_key as "approvedConfigurationKey",
           mapping.public_change_sequence as "publicChangeSequence",
           mapping.approved_at as "approvedAt"
    from public.public_repack_identity_mappings as mapping
    join (values ${Prisma.join(values)}) as requested(platform_key, pack_external_id)
      on requested.platform_key = mapping.platform_key
     and requested.pack_external_id = mapping.pack_external_id
    where mapping.organization_id = ${uuid(organizationId)}
  `);
  return new Map(
    rows.map((mapping) => [
      mappingKey(mapping.platformKey, mapping.packExternalId),
      mapping,
    ]),
  );
}

async function loadPackEvidence(
  database: PackscoutQueryClient,
  organizationId: string,
  candidates: readonly PreparedCandidate[],
): Promise<ReadonlyMap<string, unknown | null>> {
  if (candidates.length === 0) return new Map();
  const requests = candidates.map(({ revision, packExternalId }) => Prisma.sql`(
    ${uuid(revision.revisionId)}, ${revision.platformKey}, ${packExternalId},
    ${revision.publicChangeSequence}
  )`);
  const rows = await database.$queryRaw<PackEvidenceRow[]>(Prisma.sql`
    select request.revision_id::text as "revisionId",
           pack_revision.content_json as content
    from (values ${Prisma.join(requests)})
      as request(revision_id, platform_key, pack_external_id, causal_sequence)
    left join lateral (
      select revision.content_json
      from public.canonical_entities as entity
      join public.canonical_revisions as revision
        on revision.entity_id = entity.id
       and revision.organization_id = entity.organization_id
      where entity.organization_id = ${uuid(organizationId)}
        and entity.platform_key = request.platform_key
        and entity.record_kind = 'pack'
        and entity.external_id = request.pack_external_id
        and revision.public_change_sequence <= request.causal_sequence
      order by revision.public_change_sequence desc, revision.revision_number desc
      limit 1
    ) as pack_revision on true
  `);
  return new Map(rows.map(({ revisionId, content }) => [revisionId, content]));
}

async function loadCatalogAssetsAsOfCauses(
  database: PackscoutQueryClient,
  organizationId: string,
  candidates: readonly PreparedCandidate[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const catalogCandidates = candidates.filter(
    (candidate) => candidate.kind === "catalog_snapshot",
  );
  const result = new Map<string, string[]>();
  for (const candidate of catalogCandidates) {
    result.set(candidate.revision.revisionId, []);
  }
  for (let offset = 0; offset < catalogCandidates.length; offset += 20) {
    const batch = catalogCandidates.slice(offset, offset + 20);
    const requests = batch.map(({ revision, packExternalId }) => Prisma.sql`(
      ${uuid(revision.revisionId)}, ${revision.platformKey}, ${packExternalId},
      ${revision.publicChangeSequence}
    )`);
    const rows = await database.$queryRaw<CatalogAssetRow[]>(Prisma.sql`
      with requested(revision_id, platform_key, pack_external_id, causal_sequence)
        as (values ${Prisma.join(requests)}),
      bounded_assets as (
        select requested.revision_id,
               requested.platform_key,
               requested.pack_external_id,
               entity.external_id,
               asset_revision.content_json,
               row_number() over (
                 partition by requested.revision_id
                 order by entity.external_id
               ) as asset_rank
        from requested
        join public.canonical_entities as entity
          on entity.organization_id = ${uuid(organizationId)}
         and entity.platform_key = requested.platform_key
         and entity.record_kind = 'catalog_asset'
        join lateral (
          select revision.content_json
          from public.canonical_revisions as revision
          where revision.entity_id = entity.id
            and revision.organization_id = entity.organization_id
            and revision.public_change_sequence <= requested.causal_sequence
          order by revision.public_change_sequence desc, revision.revision_number desc
          limit 1
        ) as asset_revision on true
        where asset_revision.content_json ->> 'relatedPackExternalId'
          = requested.pack_external_id
          and asset_revision.content_json ->> 'entityType' = 'catalog_asset'
          and asset_revision.content_json ->> 'availability' = 'active'
      )
      select revision_id::text as "revisionId",
             platform_key as "platformKey",
             pack_external_id as "packExternalId",
             external_id as "externalId",
             content_json as content
      from bounded_assets
      where asset_rank <= ${REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_KEYS_PER_SNAPSHOT + 1}
      order by revision_id, external_id
    `);
    for (const row of rows) {
      if (!catalogContentIsActive(row.content)) continue;
      result.get(row.revisionId)?.push(
        stablePublicEvidenceKey("catalog:outcome", [
          row.platformKey,
          "catalog_asset",
          row.externalId,
        ]),
      );
    }
  }
  for (const values of result.values()) values.sort();
  return result;
}

export interface NormalizedHeatPersistenceResult {
  readonly normalized: number;
  readonly deferred: number;
  readonly rejected: number;
  readonly duplicate: number;
}

/**
 * Persists public-safe Heat evidence inside the canonical writer transaction.
 * Inputs are new canonical revisions only; the durable observation key provides
 * a second idempotency boundary for retries and corrected pull revisions.
 */
export async function persistNormalizedHeatObservationsForCanonicalWrites(
  database: PackscoutQueryClient,
  input: {
    organizationId: string;
    revisions: readonly CanonicalHeatSourceRevision[];
    createdAt: Date;
  },
): Promise<NormalizedHeatPersistenceResult> {
  const organizationId = requireUuid(input.organizationId, "organizationId");
  requireCanonicalDate(input.createdAt, "createdAt");
  if (input.revisions.length > maximumWriteCandidates) {
    throw new RangeError("Heat normalization write exceeds its transaction bound.");
  }
  for (const revision of input.revisions) {
    requireUuid(revision.revisionId, "revisionId");
    requireUuid(revision.entityId, "entityId");
    requireCanonicalDate(revision.occurredAt, "occurredAt");
    if (revision.publicChangeSequence < 1n) {
      throw new RangeError("Canonical Heat source sequence is invalid.");
    }
  }

  const outcomes: PreparedOutcome[] = [];
  const candidates: PreparedCandidate[] = [];
  for (const revision of input.revisions) {
    const candidate = classifyHeatCandidate(revision);
    if (candidate === null) continue;
    if (typeof candidate === "string") {
      outcomes.push({
        revision,
        status: "rejected",
        reasonCode: candidate,
        observationId: null,
      });
    } else {
      candidates.push(candidate);
    }
  }
  if (candidates.length === 0 && outcomes.length === 0) {
    return { normalized: 0, deferred: 0, rejected: 0, duplicate: 0 };
  }

  await database.$executeRaw(Prisma.sql`
    insert into public.normalized_heat_window_checkpoints (organization_id, updated_at)
    values (${uuid(organizationId)}, ${input.createdAt})
    on conflict (organization_id) do nothing
  `);
  const checkpoints = await database.$queryRaw<Array<{
    closedBefore: Date | null;
    nextCatalogSequence: bigint;
  }>>(
    Prisma.sql`
      select case
               when closed_before = '-infinity'::timestamp with time zone then null
               else closed_before
             end as "closedBefore",
             next_catalog_sequence as "nextCatalogSequence"
      from public.normalized_heat_window_checkpoints
      where organization_id = ${uuid(organizationId)}
      for update
    `,
  );
  const closedBefore = checkpoints[0]?.closedBefore ?? null;
  const openCandidates: PreparedCandidate[] = [];
  for (const candidate of candidates) {
    if (closedBefore && candidate.revision.occurredAt < closedBefore) {
      outcomes.push({
        revision: candidate.revision,
        status: "rejected",
        reasonCode: "WINDOW_CLOSED",
        observationId: null,
      });
    } else {
      openCandidates.push(candidate);
    }
  }

  const mappings = await loadMappings(database, organizationId, openCandidates);
  const mappedCandidates: Array<PreparedCandidate & { mapping: MappingRow }> = [];
  for (const candidate of openCandidates) {
    const mapping = mappings.get(
      mappingKey(candidate.revision.platformKey, candidate.packExternalId),
    );
    if (!mapping || mapping.publicChangeSequence > candidate.revision.publicChangeSequence) {
      outcomes.push({
        revision: candidate.revision,
        status: "deferred",
        reasonCode: "MAPPING_MISSING",
        observationId: null,
      });
    } else {
      mappedCandidates.push({ ...candidate, mapping });
    }
  }

  const packEvidence = await loadPackEvidence(
    database,
    organizationId,
    mappedCandidates,
  );
  const catalogAssets = await loadCatalogAssetsAsOfCauses(
    database,
    organizationId,
    mappedCandidates,
  );
  let observations: PreparedObservation[] = [];
  for (const candidate of mappedCandidates) {
    if (candidate.kind === "pull") {
      const values = pullValues(
        candidate.revision.content,
        packEvidence.get(candidate.revision.revisionId) ?? null,
      );
      observations.push({
        revision: candidate.revision,
        observationKey: stablePublicEvidenceKey("observation:pull", [
          organizationId,
          candidate.revision.platformKey,
          candidate.revision.recordKind,
          candidate.revision.externalId,
        ]),
        mapping: candidate.mapping,
        kind: "pull",
        catalogSequence: null,
        ...values,
        availableChaseCount: null,
        outcomeKeys: [],
      });
      continue;
    }
    const packContent = packEvidence.get(candidate.revision.revisionId) ?? null;
    if (packContent === null) {
      outcomes.push({
        revision: candidate.revision,
        status: "rejected",
        reasonCode: "EVIDENCE_UNSUPPORTED",
        observationId: null,
      });
      continue;
    }
    if (
      !isObject(packContent)
      || packContent.entityType !== "pack"
      || typeof packContent.availability !== "string"
      || !canonicalAvailabilities.has(packContent.availability)
    ) {
      outcomes.push({
        revision: candidate.revision,
        status: "rejected",
        reasonCode: "EVIDENCE_MALFORMED",
        observationId: null,
      });
      continue;
    }
    const outcomeKeys = packContentIsActive(packContent)
      ? catalogAssets.get(candidate.revision.revisionId) ?? []
      : [];
    const outcomeBytes = outcomeKeys.reduce(
      (total, value) => total + Buffer.byteLength(value, "utf8"),
      0,
    );
    if (
      outcomeKeys.length > REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_KEYS_PER_SNAPSHOT
      || outcomeKeys.length > maximumAvailableChaseCount
      || outcomeBytes > REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_BYTES_TOTAL
    ) {
      outcomes.push({
        revision: candidate.revision,
        status: "rejected",
        reasonCode: "CATALOG_LIMIT_EXCEEDED",
        observationId: null,
      });
      continue;
    }
    observations.push({
      revision: candidate.revision,
      observationKey: stablePublicEvidenceKey("observation:catalog", [
        organizationId,
        candidate.revision.platformKey,
        candidate.revision.recordKind,
        candidate.revision.externalId,
        candidate.revision.revisionId,
      ]),
      mapping: candidate.mapping,
      kind: "catalog_snapshot",
      catalogSequence: null,
      realizedReturnBasisPoints: null,
      valueMultipleBasisPoints: null,
      availableChaseCount: outcomeKeys.length,
      outcomeKeys,
    });
  }

  observations.sort((left, right) =>
    left.revision.publicChangeSequence < right.revision.publicChangeSequence
      ? -1
      : left.revision.publicChangeSequence > right.revision.publicChangeSequence
        ? 1
        : left.observationKey.localeCompare(right.observationKey),
  );
  const catalogObservations = observations.filter(
    (observation) => observation.kind === "catalog_snapshot",
  );
  const nextCatalogSequence = checkpoints[0]?.nextCatalogSequence ?? 1n;
  const lastCatalogSequence = nextCatalogSequence
    + BigInt(catalogObservations.length) - 1n;
  if (
    catalogObservations.length > 0
    && lastCatalogSequence > BigInt(REPACK_HEAT_MAXIMUM_CATALOG_SEQUENCE)
  ) {
    const rejectedKeys = new Set(
      catalogObservations.map(({ observationKey }) => observationKey),
    );
    for (const observation of catalogObservations) {
      outcomes.push({
        revision: observation.revision,
        status: "rejected",
        reasonCode: "CATALOG_LIMIT_EXCEEDED",
        observationId: null,
      });
    }
    observations = observations.filter(
      ({ observationKey }) => !rejectedKeys.has(observationKey),
    );
  } else if (catalogObservations.length > 0) {
    catalogObservations.forEach((observation, index) => {
      observation.catalogSequence = Number(nextCatalogSequence + BigInt(index));
    });
    await database.$executeRaw(Prisma.sql`
      update public.normalized_heat_window_checkpoints
      set next_catalog_sequence = next_catalog_sequence + ${catalogObservations.length},
          updated_at = ${input.createdAt}
      where organization_id = ${uuid(organizationId)}
    `);
  }
  const insertedByKey = new Map<string, string>();
  if (observations.length > 0) {
    const values = observations.map((observation) => Prisma.sql`(
      ${uuid(organizationId)}, ${observation.observationKey},
      ${uuid(observation.revision.revisionId)},
      ${observation.revision.publicChangeSequence},
      ${observation.mapping.publicChangeSequence},
      ${uuid(observation.mapping.publicRepackId)}, ${observation.kind},
      ${observation.revision.occurredAt}, ${observation.catalogSequence},
      ${observation.realizedReturnBasisPoints},
      ${observation.valueMultipleBasisPoints},
      ${observation.availableChaseCount}, ${textArray(observation.outcomeKeys)},
      ${retainedUntil(observation.revision.occurredAt)}, ${input.createdAt}
    )`);
    const inserted = await database.$queryRaw<
      Array<{ observationId: string; observationKey: string }>
    >(Prisma.sql`
      insert into public.normalized_heat_observations (
        organization_id, observation_key, canonical_revision_id,
        public_change_sequence, mapping_public_change_sequence,
        public_repack_id, observation_kind, occurred_at,
        catalog_sequence, realized_return_basis_points,
        value_multiple_basis_points, available_chase_count, outcome_keys,
        retained_until, created_at
      ) values ${Prisma.join(values)}
      on conflict (organization_id, observation_key) do nothing
      returning id::text as "observationId", observation_key as "observationKey"
    `);
    for (const row of inserted) insertedByKey.set(row.observationKey, row.observationId);
  }
  for (const observation of observations) {
    const observationId = insertedByKey.get(observation.observationKey) ?? null;
    outcomes.push({
      revision: observation.revision,
      status: observationId ? "normalized" : "duplicate",
      reasonCode: observationId ? "NORMALIZED" : "DUPLICATE_SOURCE_EVENT",
      observationId,
    });
  }

  if (outcomes.length > 0) {
    const values = outcomes.map((outcome) => Prisma.sql`(
      ${uuid(organizationId)}, ${uuid(outcome.revision.revisionId)},
      ${outcome.revision.publicChangeSequence}, ${outcome.revision.occurredAt},
      ${outcome.status}, ${outcome.reasonCode},
      ${outcome.observationId ? uuid(outcome.observationId) : Prisma.sql`null::uuid`},
      ${retainedUntil(outcome.revision.occurredAt)}, ${input.createdAt}
    )`);
    await database.$executeRaw(Prisma.sql`
      insert into public.normalized_heat_observation_outcomes (
        organization_id, canonical_revision_id, public_change_sequence,
        occurred_at, status, reason_code, observation_id, retained_until,
        created_at
      ) values ${Prisma.join(values)}
      on conflict (organization_id, canonical_revision_id) do nothing
    `);
  }

  return outcomes.reduce<NormalizedHeatPersistenceResult>(
    (counts, outcome) => ({ ...counts, [outcome.status]: counts[outcome.status] + 1 }),
    { normalized: 0, deferred: 0, rejected: 0, duplicate: 0 },
  );
}
