import { Prisma, type $Enums } from "@prisma/client";
import type { PackscoutPrismaClient } from "./database.ts";

/**
 * Reads canonical provider data for the admin's inspection surfaces.
 *
 * Every method here is org-scoped in the query itself rather than by filtering
 * afterwards, and every filter value is either an enumerated constant or a bound
 * parameter. There is no path that accepts SQL, a sort key, or a column name
 * from a caller.
 *
 * The production baseline holds roughly 14.5 million canonical records, so the
 * shape of each read matters: listings page by the stable-identity index,
 * recency reads use the inspection recency index, and counting stops at a bound
 * instead of scanning a provider's whole history.
 */

/**
 * The database's own record-kind enum. Aliased rather than restated so a new
 * kind added to the schema reaches these reads as a type error instead of
 * silently falling outside them.
 */
export type CanonicalRecordKindRow = $Enums.canonical_record_kind;

export interface CanonicalProviderRosterRow {
  readonly platformKey: string;
  readonly displayName: string;
  readonly state: string;
}

export interface CanonicalEntityListRow {
  readonly entityId: string;
  readonly platformKey: string;
  readonly recordKind: CanonicalRecordKindRow;
  readonly externalId: string;
  readonly revisionNumber: number | null;
  readonly sourceUpdatedAt: Date | null;
  readonly sourceCollectedAt: Date | null;
  readonly acceptedAt: Date | null;
}

export interface CanonicalEntityDetailRow extends CanonicalEntityListRow {
  readonly content: unknown;
  readonly contentHash: string | null;
  readonly provenance: unknown;
  readonly provenanceHash: string | null;
  readonly relationships: readonly {
    readonly relationshipKind: string;
    readonly targetPlatformKey: string;
    readonly targetRecordKind: CanonicalRecordKindRow;
    readonly targetExternalId: string | null;
    readonly resolved: boolean;
  }[];
}

export interface CanonicalKindSummaryRow {
  readonly recordKind: CanonicalRecordKindRow;
  readonly count: number;
  readonly bounded: boolean;
  readonly oldestCollectedAt: Date | null;
  readonly newestCollectedAt: Date | null;
  readonly oldestAcceptedAt: Date | null;
  readonly newestAcceptedAt: Date | null;
}

export interface CanonicalEntityCursor {
  readonly externalId: string;
  readonly entityId: string;
}

export class PrismaCanonicalInspectionRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async listProviders(
    organizationId: string,
  ): Promise<readonly CanonicalProviderRosterRow[]> {
    const rows = await this.database.provider_sources.findMany({
      where: { organization_id: organizationId },
      select: { platform_key: true, display_name: true, state: true },
      orderBy: [{ display_name: "asc" }, { platform_key: "asc" }],
    });
    return rows.map((row) => ({
      platformKey: row.platform_key,
      displayName: row.display_name,
      state: row.state,
    }));
  }

  async providerExists(input: {
    readonly organizationId: string;
    readonly platformKey: string;
  }): Promise<boolean> {
    const row = await this.database.provider_sources.findFirst({
      where: {
        organization_id: input.organizationId,
        platform_key: input.platformKey,
      },
      select: { platform_key: true },
    });
    return row !== null;
  }

  /**
   * Counts a (provider, kind) bucket, stopping at `bound`.
   *
   * The count runs over a bounded subquery so the scan reads at most
   * `bound + 1` index entries whatever the bucket holds. A result above the
   * bound is reported as bounded, and the caller presents it as a floor rather
   * than a total — an operator judging feed completeness must not be handed a
   * number that looks exact and is not.
   */
  async countBounded(input: {
    readonly organizationId: string;
    readonly platformKey: string;
    readonly recordKind: CanonicalRecordKindRow;
    readonly bound: number;
  }): Promise<{ count: number; bounded: boolean }> {
    const rows = await this.database.$queryRaw<{ counted: bigint }[]>(
      Prisma.sql`
        select count(*)::bigint as "counted"
          from (
            select 1
              from canonical_entities
             where organization_id = ${input.organizationId}::uuid
               and platform_key = ${input.platformKey}
               and record_kind = ${input.recordKind}::canonical_record_kind
             limit ${input.bound + 1}
          ) bounded
      `,
    );
    const counted = Number(rows[0]?.counted ?? 0n);
    return counted > input.bound
      ? { count: input.bound, bounded: true }
      : { count: counted, bounded: false };
  }

  /**
   * The least- and most-recently-updated entity of a kind, with the source and
   * acceptance timestamps of each one's current revision. Two index lookups
   * against the inspection recency index rather than an aggregate over the
   * bucket.
   */
  async kindRecency(input: {
    readonly organizationId: string;
    readonly platformKey: string;
    readonly recordKind: CanonicalRecordKindRow;
  }): Promise<{
    oldest: { collectedAt: Date; acceptedAt: Date } | null;
    newest: { collectedAt: Date; acceptedAt: Date } | null;
  }> {
    const [oldest, newest] = await Promise.all([
      this.edgeRevision(input, "asc"),
      this.edgeRevision(input, "desc"),
    ]);
    return { oldest, newest };
  }

  private async edgeRevision(
    input: {
      readonly organizationId: string;
      readonly platformKey: string;
      readonly recordKind: CanonicalRecordKindRow;
    },
    direction: "asc" | "desc",
  ): Promise<{ collectedAt: Date; acceptedAt: Date } | null> {
    const entity = await this.database.canonical_entities.findFirst({
      where: {
        organization_id: input.organizationId,
        platform_key: input.platformKey,
        record_kind: input.recordKind,
      },
      select: { current_revision_id: true },
      orderBy: { updated_at: direction },
    });
    if (!entity?.current_revision_id) return null;
    const revision = await this.database.canonical_revisions.findFirst({
      where: {
        organization_id: input.organizationId,
        id: entity.current_revision_id,
      },
      select: { source_collected_at: true, accepted_at: true },
    });
    if (!revision) return null;
    return {
      collectedAt: revision.source_collected_at,
      acceptedAt: revision.accepted_at,
    };
  }

  /**
   * One page of entities, ordered by the stable-identity index so a resumed
   * page cannot skip or repeat a row. `externalId` alone is unique within a
   * bucket, but the entity id is carried in the cursor as a tiebreaker so the
   * order stays total even if that ever changes.
   */
  async listEntities(input: {
    readonly organizationId: string;
    readonly platformKey: string;
    readonly recordKind: CanonicalRecordKindRow;
    readonly externalId?: string;
    readonly externalIdPrefix?: string;
    readonly after?: CanonicalEntityCursor;
    readonly limit: number;
  }): Promise<{
    items: readonly CanonicalEntityListRow[];
    nextCursor: CanonicalEntityCursor | null;
  }> {
    const rows = await this.database.canonical_entities.findMany({
      where: {
        organization_id: input.organizationId,
        platform_key: input.platformKey,
        record_kind: input.recordKind,
        ...(input.externalId ? { external_id: input.externalId } : {}),
        ...(input.externalIdPrefix
          ? { external_id: { startsWith: input.externalIdPrefix } }
          : {}),
        ...(input.after
          ? {
              OR: [
                { external_id: { gt: input.after.externalId } },
                {
                  external_id: input.after.externalId,
                  id: { gt: input.after.entityId },
                },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        platform_key: true,
        record_kind: true,
        external_id: true,
        canonical_revisions_canonical_entities_current_revision_idTocanonical_revisions:
          {
            select: {
              revision_number: true,
              source_updated_at: true,
              source_collected_at: true,
              accepted_at: true,
            },
          },
      },
      orderBy: [{ external_id: "asc" }, { id: "asc" }],
      take: input.limit + 1,
    });

    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => {
        const revision =
          row.canonical_revisions_canonical_entities_current_revision_idTocanonical_revisions;
        return {
          entityId: row.id,
          platformKey: row.platform_key,
          recordKind: row.record_kind as CanonicalRecordKindRow,
          externalId: row.external_id,
          revisionNumber: revision?.revision_number ?? null,
          sourceUpdatedAt: revision?.source_updated_at ?? null,
          sourceCollectedAt: revision?.source_collected_at ?? null,
          acceptedAt: revision?.accepted_at ?? null,
        };
      }),
      nextCursor:
        rows.length > input.limit && last
          ? { externalId: last.external_id, entityId: last.id }
          : null,
    };
  }

  /** One entity's current revision and the edges declared from it. */
  async readEntity(input: {
    readonly organizationId: string;
    readonly platformKey: string;
    readonly recordKind: CanonicalRecordKindRow;
    readonly externalId: string;
  }): Promise<CanonicalEntityDetailRow | null> {
    const entity = await this.database.canonical_entities.findFirst({
      where: {
        organization_id: input.organizationId,
        platform_key: input.platformKey,
        record_kind: input.recordKind,
        external_id: input.externalId,
      },
      select: {
        id: true,
        platform_key: true,
        record_kind: true,
        external_id: true,
        canonical_revisions_canonical_entities_current_revision_idTocanonical_revisions:
          {
            select: {
              revision_number: true,
              content_json: true,
              content_hash: true,
              provenance_json: true,
              provenance_hash: true,
              source_updated_at: true,
              source_collected_at: true,
              accepted_at: true,
            },
          },
      },
    });
    if (!entity) return null;

    const edges = await this.database.canonical_relationships.findMany({
      where: {
        organization_id: input.organizationId,
        source_entity_id: entity.id,
      },
      select: {
        relationship_kind: true,
        target_platform_key: true,
        target_record_kind: true,
        target_external_id: true,
        resolved_at: true,
      },
      orderBy: [
        { relationship_kind: "asc" },
        { target_platform_key: "asc" },
        { target_external_id: "asc" },
      ],
    });

    const revision =
      entity.canonical_revisions_canonical_entities_current_revision_idTocanonical_revisions;
    return {
      entityId: entity.id,
      platformKey: entity.platform_key,
      recordKind: entity.record_kind as CanonicalRecordKindRow,
      externalId: entity.external_id,
      revisionNumber: revision?.revision_number ?? null,
      sourceUpdatedAt: revision?.source_updated_at ?? null,
      sourceCollectedAt: revision?.source_collected_at ?? null,
      acceptedAt: revision?.accepted_at ?? null,
      content: revision?.content_json ?? null,
      contentHash: revision?.content_hash ?? null,
      provenance: revision?.provenance_json ?? null,
      provenanceHash: revision?.provenance_hash ?? null,
      relationships: edges.map((edge) => ({
        relationshipKind: edge.relationship_kind,
        targetPlatformKey: edge.target_platform_key,
        targetRecordKind: edge.target_record_kind as CanonicalRecordKindRow,
        targetExternalId: edge.target_external_id,
        resolved: edge.resolved_at !== null,
      })),
    };
  }
}
