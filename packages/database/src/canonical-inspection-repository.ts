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
   * The extrema of each timestamp for a kind.
   *
   * Collection order and acceptance order are not the same order: ingestion sets
   * an entity's `updated_at` from acceptance, so a record collected long ago can
   * be accepted late. Reading a collection time off the most-recently-accepted
   * row would therefore report the wrong oldest and newest collection times, and
   * the parity surface reuses these values. Each extremum is selected on its own
   * column instead.
   *
   * Acceptance extrema come from the inspection recency index on
   * `canonical_entities`; collection extrema are aggregated over the kind's
   * revisions, which is the only place `source_collected_at` lives.
   */
  async kindRecency(input: {
    readonly organizationId: string;
    readonly platformKey: string;
    readonly recordKind: CanonicalRecordKindRow;
    /**
     * Whether the bucket is small enough to aggregate. Nothing indexes
     * `source_collected_at` under a (tenant, platform, kind) filter, so the
     * aggregate is a scan of the bucket. On a bucket past the count bound the
     * caller passes false and the extrema come back unavailable — an honest
     * "not computed at this scale" rather than a wrong value or a hung request.
     */
    readonly collectedExtrema: boolean;
  }): Promise<{
    oldestCollectedAt: Date | null;
    newestCollectedAt: Date | null;
    oldestAcceptedAt: Date | null;
    newestAcceptedAt: Date | null;
    collectedExtremaComplete: boolean;
  }> {
    const [acceptedOldest, acceptedNewest, collected] = await Promise.all([
      this.acceptedEdge(input, "asc"),
      this.acceptedEdge(input, "desc"),
      input.collectedExtrema
        ? this.collectedExtremaFor(input)
        : Promise.resolve({ oldest: null, newest: null }),
    ]);
    return {
      oldestCollectedAt: collected.oldest,
      newestCollectedAt: collected.newest,
      oldestAcceptedAt: acceptedOldest,
      newestAcceptedAt: acceptedNewest,
      collectedExtremaComplete: input.collectedExtrema,
    };
  }

  private async acceptedEdge(
    input: {
      readonly organizationId: string;
      readonly platformKey: string;
      readonly recordKind: CanonicalRecordKindRow;
    },
    direction: "asc" | "desc",
  ): Promise<Date | null> {
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
      select: { accepted_at: true },
    });
    return revision?.accepted_at ?? null;
  }

  /**
   * True oldest and newest collection times across a kind's current revisions.
   *
   * Only called for a bucket the caller has already established is inside the
   * count bound, because this aggregate has no supporting index and therefore
   * scans the bucket.
   */
  private async collectedExtremaFor(input: {
    readonly organizationId: string;
    readonly platformKey: string;
    readonly recordKind: CanonicalRecordKindRow;
  }): Promise<{ oldest: Date | null; newest: Date | null }> {
    const rows = await this.database.$queryRaw<
      { oldest: Date | null; newest: Date | null }[]
    >(
      Prisma.sql`
        select min(revision.source_collected_at) as "oldest",
               max(revision.source_collected_at) as "newest"
          from canonical_entities entity
          join canonical_revisions revision
            on revision.id = entity.current_revision_id
           and revision.organization_id = entity.organization_id
         where entity.organization_id = ${input.organizationId}::uuid
           and entity.platform_key = ${input.platformKey}
           and entity.record_kind = ${input.recordKind}::canonical_record_kind
      `,
    );
    return {
      oldest: rows[0]?.oldest ?? null,
      newest: rows[0]?.newest ?? null,
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
    /**
     * Keyset ordering runs in either direction: descending reverses both the
     * comparison and the sort. Both stay on the stable-identity index, so a
     * reversed listing costs exactly what a forward one does.
     */
    readonly direction?: "asc" | "desc";
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
          ? (input.direction ?? "asc") === "asc"
            ? {
                OR: [
                  { external_id: { gt: input.after.externalId } },
                  {
                    external_id: input.after.externalId,
                    id: { gt: input.after.entityId },
                  },
                ],
              }
            : {
                OR: [
                  { external_id: { lt: input.after.externalId } },
                  {
                    external_id: input.after.externalId,
                    id: { lt: input.after.entityId },
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
      orderBy: [
        { external_id: input.direction ?? "asc" },
        { id: input.direction ?? "asc" },
      ],
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

/**
 * What PostgreSQL knows about a provider's promotion into the product backend.
 *
 * The lane tracks how far canonical state has settled and how far promotion has
 * carried it; the active selection records which provider release the manifest
 * was told to serve, with the fingerprint that release was published under.
 * Together they let a parity verdict be reached from cheap reads: when the
 * fingerprints on both sides agree, the payload is identical by construction.
 */
export interface ProviderPromotionFacts {
  readonly platformKey: string;
  readonly settledCheckpoint: string;
  readonly sourceHeadCheckpoint: string;
  readonly completedCheckpoint: string;
  readonly completedPublicProviderReleaseId: string | null;
  readonly completedProviderReleaseFingerprint: string | null;
  readonly completedAt: Date | null;
  readonly selectedPublicProviderReleaseId: string | null;
  readonly selectedProviderReleaseFingerprint: string | null;
  readonly selectedCheckpoint: string | null;
  readonly activatedAt: Date | null;
}

export class PrismaProviderPromotionFactsRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async readFacts(input: {
    readonly organizationId: string;
    readonly deploymentKey: string;
    readonly platformKeys: readonly string[];
  }): Promise<readonly ProviderPromotionFacts[]> {
    if (input.platformKeys.length === 0) return [];
    const [lanes, selections] = await Promise.all([
      this.database.provider_promotion_lanes.findMany({
        where: {
          organization_id: input.organizationId,
          deployment_key: input.deploymentKey,
          platform_key: { in: [...input.platformKeys] },
        },
      }),
      this.database.manifest_active_provider_selections.findMany({
        where: {
          organization_id: input.organizationId,
          deployment_key: input.deploymentKey,
          platform_key: { in: [...input.platformKeys] },
        },
      }),
    ]);

    const laneByPlatform = new Map(lanes.map((row) => [row.platform_key, row]));
    const selectionByPlatform = new Map(
      selections.map((row) => [row.platform_key, row]),
    );

    return input.platformKeys.map((platformKey) => {
      const lane = laneByPlatform.get(platformKey);
      const selection = selectionByPlatform.get(platformKey);
      return {
        platformKey,
        // Checkpoints are 64-bit sequences; they travel as strings so a large
        // value cannot lose precision on its way to a browser.
        settledCheckpoint: (lane?.settled_checkpoint ?? 0n).toString(),
        sourceHeadCheckpoint: (lane?.source_head_checkpoint ?? 0n).toString(),
        completedCheckpoint: (lane?.completed_checkpoint ?? 0n).toString(),
        completedPublicProviderReleaseId:
          lane?.completed_public_provider_release_id ?? null,
        completedProviderReleaseFingerprint:
          lane?.completed_provider_release_fingerprint ?? null,
        completedAt: lane?.completed_at ?? null,
        selectedPublicProviderReleaseId:
          selection?.provider_public_release_id ?? null,
        selectedProviderReleaseFingerprint:
          selection?.provider_release_fingerprint ?? null,
        selectedCheckpoint: selection
          ? selection.selected_checkpoint.toString()
          : null,
        activatedAt: selection?.activated_at ?? null,
      };
    });
  }
}
