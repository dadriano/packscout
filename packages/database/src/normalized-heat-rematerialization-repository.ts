import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
} from "./database.ts";
import {
  persistRematerializedNormalizedHeatObservations,
  type CanonicalHeatSourceRevision,
  type NormalizedHeatRematerializationPersistenceResult,
} from "./normalized-heat-observation-repository.ts";

const maximumBatchSize = 1_000;
const defaultBatchSize = 250;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/;

export interface NormalizedHeatRematerializationCursor {
  readonly publicChangeSequence: bigint;
  readonly sourceCandidateKey: string;
}

export interface NormalizedHeatRematerializationBatchResult
  extends NormalizedHeatRematerializationPersistenceResult {
  readonly claimed: number;
  readonly claimedSourceCandidateKeys: readonly string[];
  readonly nextCursor: NormalizedHeatRematerializationCursor | null;
  readonly scanExhausted: boolean;
}

interface DeferredCandidateRow {
  sourceCandidateKey: string;
  revisionId: string;
  entityId: string;
  platformKey: string;
  recordKind: string;
  externalId: string;
  content: unknown;
  publicChangeSequence: bigint;
  occurredAt: Date;
}

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

function requireUuid(value: string, field: string): string {
  if (!uuidPattern.test(value)) throw new RangeError(`${field} is invalid.`);
  return value.toLowerCase();
}

function requireCanonicalDate(value: Date, field: string): void {
  if (!Number.isFinite(value.getTime())) throw new RangeError(`${field} is invalid.`);
  if (new Date(value.toISOString()).getTime() !== value.getTime()) {
    throw new RangeError(`${field} must use canonical millisecond precision.`);
  }
}

function requireCursor(
  cursor: NormalizedHeatRematerializationCursor | null | undefined,
): NormalizedHeatRematerializationCursor | null {
  if (cursor === null || cursor === undefined) return null;
  if (
    cursor.publicChangeSequence < 1n
    || !sha256Pattern.test(cursor.sourceCandidateKey)
  ) {
    throw new RangeError("Heat rematerialization cursor is invalid.");
  }
  return cursor;
}

function canonicalContent(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Canonical Heat revision content is unavailable.");
  }
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Explicit post-approval operation for the deferred Heat queue.
 *
 * Trigger it after `approveConfiguration` commits, using that call's returned
 * `publicChangeSequence`. Continue with `nextCursor` until `scanExhausted` is
 * true. Each transaction claims at most `limit` retained source outcomes, and
 * concurrent workers use row locks with `SKIP LOCKED` so their claims do not
 * overlap. A final sweep from a null cursor is safe and idempotent.
 */
export class PrismaNormalizedHeatRematerializationRepository {
  readonly #organizationId: string;

  constructor(
    private readonly database: PackscoutPrismaClient,
    configuration: { organizationId: string },
  ) {
    this.#organizationId = requireUuid(
      configuration.organizationId,
      "organizationId",
    );
  }

  replayMissingMappingsBatch(input: {
    mappingPublicChangeSequence: bigint;
    replayedAt: Date;
    limit?: number;
    after?: NormalizedHeatRematerializationCursor | null;
  }): Promise<NormalizedHeatRematerializationBatchResult> {
    if (input.mappingPublicChangeSequence < 1n) {
      throw new RangeError("mappingPublicChangeSequence is invalid.");
    }
    requireCanonicalDate(input.replayedAt, "replayedAt");
    const limit = input.limit ?? defaultBatchSize;
    if (
      !Number.isSafeInteger(limit)
      || limit < 1
      || limit > maximumBatchSize
    ) {
      throw new RangeError("Heat rematerialization limit is invalid.");
    }
    const after = requireCursor(input.after);

    return this.database.$transaction(async (transaction) => {
      const approval = await transaction.$queryRaw<Array<{
        approvedAt: Date | null;
      }>>(
        Prisma.sql`
          select max(approved_at) as "approvedAt"
          from public.public_repack_identity_mappings
          where organization_id = ${uuid(this.#organizationId)}
            and public_change_sequence = ${input.mappingPublicChangeSequence}
        `,
      );
      const approvedAt = approval[0]?.approvedAt ?? null;
      if (approvedAt === null) {
        throw new RangeError(
          "Heat rematerialization mapping approval is not registered for this organization.",
        );
      }
      if (input.replayedAt < approvedAt) {
        throw new RangeError("Heat rematerialization cannot precede mapping approval.");
      }

      const cursorPredicate = after === null
        ? Prisma.sql`true`
        : Prisma.sql`(
            outcome.public_change_sequence > ${after.publicChangeSequence}
            or (
              outcome.public_change_sequence = ${after.publicChangeSequence}
              and outcome.candidate_key > ${after.sourceCandidateKey}
            )
          )`;
      const rows = await transaction.$queryRaw<DeferredCandidateRow[]>(Prisma.sql`
        select outcome.candidate_key as "sourceCandidateKey",
               revision.id::text as "revisionId",
               entity.id::text as "entityId",
               entity.platform_key as "platformKey",
               entity.record_kind::text as "recordKind",
               entity.external_id as "externalId",
               revision.content_json as content,
               revision.public_change_sequence as "publicChangeSequence",
               revision.source_updated_at as "occurredAt"
        from public.normalized_heat_observation_outcomes as outcome
        join public.canonical_revisions as revision
          on revision.id = outcome.canonical_revision_id
         and revision.organization_id = outcome.organization_id
         and revision.public_change_sequence = outcome.public_change_sequence
        join public.canonical_entities as entity
          on entity.id = revision.entity_id
         and entity.organization_id = revision.organization_id
        where outcome.organization_id = ${uuid(this.#organizationId)}
          and outcome.status = 'deferred'
          and outcome.reason_code = 'MAPPING_MISSING'
          and outcome.retained_until > ${input.replayedAt}
          and outcome.retained_until > current_timestamp
          and ${cursorPredicate}
          and exists (
            select 1
            from public.public_repack_identity_mappings as mapping
            where mapping.organization_id = outcome.organization_id
              and mapping.public_change_sequence = ${input.mappingPublicChangeSequence}
              and mapping.platform_key = entity.platform_key
              and (
                (
                  entity.record_kind = 'pack'
                  and mapping.pack_external_id = entity.external_id
                )
                or (
                  entity.record_kind = 'pull'
                  and mapping.pack_external_id = revision.content_json ->> 'packExternalId'
                )
                or (
                  entity.record_kind = 'catalog_asset'
                  and (
                    mapping.pack_external_id =
                      revision.content_json ->> 'relatedPackExternalId'
                    or mapping.pack_external_id = (
                      select prior.content_json ->> 'relatedPackExternalId'
                      from public.canonical_revisions as prior
                      where prior.organization_id = revision.organization_id
                        and prior.entity_id = revision.entity_id
                        and prior.public_change_sequence
                          < revision.public_change_sequence
                      order by prior.public_change_sequence desc,
                               prior.revision_number desc
                      limit 1
                    )
                  )
                )
              )
              and not exists (
                select 1
                from public.normalized_heat_observation_outcomes as completed
                where completed.organization_id = outcome.organization_id
                  and completed.canonical_revision_id = outcome.canonical_revision_id
                  and completed.mapping_public_change_sequence =
                    mapping.public_change_sequence
                  and completed.public_repack_id = mapping.public_repack_id
              )
          )
        order by outcome.public_change_sequence, outcome.candidate_key
        for update of outcome skip locked
        limit ${limit}
      `);
      const candidates = rows.map((row) => ({
        sourceCandidateKey: row.sourceCandidateKey,
        revision: {
          revisionId: row.revisionId,
          entityId: row.entityId,
          platformKey: row.platformKey,
          recordKind: row.recordKind,
          externalId: row.externalId,
          content: canonicalContent(row.content),
          publicChangeSequence: row.publicChangeSequence,
          occurredAt: row.occurredAt,
        } satisfies CanonicalHeatSourceRevision,
      }));
      const persistence = await persistRematerializedNormalizedHeatObservations(
        transaction,
        {
          organizationId: this.#organizationId,
          mappingPublicChangeSequence: input.mappingPublicChangeSequence,
          candidates,
          replayedAt: input.replayedAt,
        },
      );
      const last = rows.at(-1);
      return {
        ...persistence,
        claimed: rows.length,
        claimedSourceCandidateKeys: rows.map(
          ({ sourceCandidateKey }) => sourceCandidateKey,
        ),
        nextCursor: rows.length === limit && last
          ? {
              publicChangeSequence: last.publicChangeSequence,
              sourceCandidateKey: last.sourceCandidateKey,
            }
          : null,
        scanExhausted: rows.length < limit,
      };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }
}
