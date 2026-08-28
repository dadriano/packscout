import { createHash } from "node:crypto";
import {
  MAX_PUBLIC_REPACKS_PER_RELEASE,
  REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_BYTES_TOTAL,
  REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_KEYS_TOTAL,
  REPACK_HEAT_MAXIMUM_OBSERVATIONS,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import type {
  PackscoutQueryClient,
} from "./database.ts";

export const maximumAvailableChaseCount = 10_000;
// Historical canonical rows used active/disabled before the public vocabulary
// standardized on available/unavailable. Writes remain on the current contract,
// while Heat must continue to read both retained vocabularies.
export const canonicalAvailabilities = new Set([
  "active",
  "available",
  "disabled",
  "unavailable",
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

export type NormalizedHeatSourceCoverageEvidence =
  | NormalizedHeatOutcomeReason
  | "RELATIONSHIP_BACKFILL_INCOMPLETE";

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
      sourceCoverageEvidence: readonly NormalizedHeatSourceCoverageEvidence[];
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

export class NormalizedHeatRelationshipBackfillIncompleteError extends Error {
  readonly code = "NORMALIZED_HEAT_RELATIONSHIP_BACKFILL_INCOMPLETE";

  constructor() {
    super("Normalized Heat relationship backfill is incomplete.");
    this.name = "NormalizedHeatRelationshipBackfillIncompleteError";
  }
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

export interface CanonicalHeatSourceEvidence {
  readonly revision: CanonicalHeatSourceRevision;
  readonly sourceRelationshipId: string | null;
  readonly sourceConfirmationSetId: string | null;
  readonly sourceConfirmationSequence: bigint | null;
  readonly causalSequence: bigint;
  readonly causeOccurredAt: Date;
}

export interface ResolvedRelationshipSourceRow {
  relationshipId: string;
  confirmationSetId: string;
  confirmationPublicChangeSequence: bigint;
  relationshipKind: "pack" | "card";
  targetPlatformKey: string;
  targetRecordKind: "pack" | "catalog_asset";
  targetExternalId: string;
  effectivePublicChangeSequence: bigint;
  causeOccurredAt: Date;
  revisionId: string;
  entityId: string;
  platformKey: string;
  externalId: string;
  content: Readonly<Record<string, unknown>>;
  revisionPublicChangeSequence: bigint;
  revisionOccurredAt: Date;
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

interface HeatBackfillReadinessRow {
  ready: boolean;
}

export async function normalizedHeatRelationshipBackfillIsReady(
  database: PackscoutQueryClient,
  organizationId: string,
): Promise<boolean> {
  const rows = await database.$queryRaw<HeatBackfillReadinessRow[]>(Prisma.sql`
    select (
      backfill.phase = 'complete'
      and backfill.failure_code is null
      and not exists (
        select 1
        from public.provider_source_revisions as source_revision
        left join public.source_relationship_confirmation_backfills
          as confirmation_backfill
          on confirmation_backfill.organization_id =
               source_revision.organization_id
         and confirmation_backfill.source_revision_id = source_revision.id
        where source_revision.organization_id = backfill.organization_id
          and (
            confirmation_backfill.source_revision_id is null
            or confirmation_backfill.provider_id <>
              source_revision.provider_id
            or confirmation_backfill.source_instance_id <>
              source_revision.source_instance_id
            or
            confirmation_backfill.phase <> 'complete'
            or confirmation_backfill.failure_code is not null
            or confirmation_backfill.confirmed_semantic_set_count <>
              confirmation_backfill.target_semantic_set_count
          )
      )
      and not exists (
        select 1
        from public.normalized_heat_observations as observation
        where observation.organization_id = backfill.organization_id
          and observation.observation_kind = 'catalog_snapshot'
          and observation.catalog_order_sequence is null
      )
      and coalesce(checkpoint.next_catalog_sequence, 1) >=
        backfill.next_catalog_order_sequence
      and not exists (
        select 1
        from public.normalized_heat_observations as observation
        where observation.organization_id = backfill.organization_id
          and observation.catalog_order_sequence >=
            coalesce(checkpoint.next_catalog_sequence, 1)
      )
    ) as ready
    from public.normalized_heat_relationship_backfills as backfill
    left join public.normalized_heat_window_checkpoints as checkpoint
      on checkpoint.organization_id = backfill.organization_id
    where backfill.organization_id = ${uuid(organizationId)}
  `);
  return rows[0]?.ready === true;
}

export function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

export function requireUuid(value: string, field: string): string {
  if (!uuidPattern.test(value)) throw new RangeError(`${field} is invalid.`);
  return value.toLowerCase();
}

function requireUuidV5(value: string, field: string): string {
  if (!uuidV5Pattern.test(value)) throw new RangeError(`${field} must be UUIDv5.`);
  return value.toLowerCase();
}

export function requireCanonicalDate(value: Date, field: string): void {
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

export function normalizedHeatRetainedUntilSql(occurredAt: Date): Prisma.Sql {
  // The schema defines retention as seven PostgreSQL calendar days. Compute
  // the value in the same database session so daylight-saving boundaries do
  // not disagree with the table check constraint.
  return Prisma.sql`${occurredAt} + interval '7 days'`;
}

export function mappingKey(platformKey: string, packExternalId: string): string {
  return `${platformKey}\u0000${packExternalId}`;
}

export function normalizedHeatSourceRequestKey(
  source: CanonicalHeatSourceEvidence,
): string {
  return source.sourceRelationshipId === null
    ? source.revision.revisionId
    : [source.sourceConfirmationSetId, source.sourceRelationshipId].join(":");
}

export function stablePublicEvidenceKey(
  domain:
    | "observation:pull"
    | "observation:catalog"
    | "catalog:outcome"
    | "normalization:outcome",
  values: readonly string[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(["normalized-heat-v1", domain, ...values]))
    .digest("hex");
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareNormalizedHeatCatalogOrder(
  left: Readonly<{
    source: Readonly<{ causalSequence: bigint }>;
    observationKey: string;
  }>,
  right: Readonly<{
    source: Readonly<{ causalSequence: bigint }>;
    observationKey: string;
  }>,
): number {
  if (left.source.causalSequence < right.source.causalSequence) return -1;
  if (left.source.causalSequence > right.source.causalSequence) return 1;
  return compareCodeUnits(left.observationKey, right.observationKey);
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
    if (!await normalizedHeatRelationshipBackfillIsReady(
      this.database,
      this.#organizationId,
    )) {
      return {
        status: "ready",
        throughSettledSequence: input.throughSettledSequence,
        sourceCoverageComplete: false,
        sourceCoverageEvidence: ["RELATIONSHIP_BACKFILL_INCOMPLETE"],
        observations: [],
      };
    }
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
             catalog_order_sequence as "catalogSequence",
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
               catalog_order_sequence asc nulls first,
               observation_key asc
      limit ${limit}
    `);

    const incomplete = await this.database.$queryRaw<
      Array<{ reasonCode: NormalizedHeatOutcomeReason }>
    >(Prisma.sql`
      select distinct outcome.reason_code as "reasonCode"
      from public.normalized_heat_observation_outcomes as outcome
      where outcome.organization_id = ${uuid(this.#organizationId)}
        and outcome.occurred_at >= ${input.startAtInclusive}
        and outcome.occurred_at < ${input.endAtExclusive}
        and outcome.public_change_sequence <= ${input.throughSettledSequence}
        and outcome.status in ('deferred', 'rejected')
        and outcome.public_repack_id in (${Prisma.join(publicRepackIds.map(uuid))})
      order by outcome.reason_code asc
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
    if (!await normalizedHeatRelationshipBackfillIsReady(
      this.database,
      this.#organizationId,
    )) {
      throw new NormalizedHeatRelationshipBackfillIncompleteError();
    }
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
