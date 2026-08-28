import { Prisma } from "@prisma/client";
import type { PackscoutPrismaClient } from "./database.ts";
import {
  PrismaCatalogReleaseSourceRepository,
  type CatalogReleaseSourceSnapshot,
} from "./catalog-release-source-repository.ts";
import {
  loadProviderV1AssetPackAssociations,
  type ProviderV1AssetPackAssociationSnapshot,
} from "./provider-v1-asset-pack-association-reader.ts";
import { loadProviderV1RelationshipConfirmationReadiness } from
  "./source-relationship-confirmation-repository.ts";

/**
 * readAt-keyed canonical source read for the data_release_v3 publication
 * (task buyback-adjusted-ev/008).
 *
 * The services-side `DataReleaseV3CanonicalCatalogAdapter` projects this raw
 * snapshot into the sanitized `DataReleaseV3CanonicalCatalogPort` shape; this
 * repository owns only the PostgreSQL read.
 *
 * Repeatability contract: a read is served only for a `readAt` at or behind
 * the organization's settled public watermark. Settlement declares every
 * public change cause with `occurred_at <= settled_at` final, and causes,
 * canonical revisions, approved configurations, and identity mappings are
 * append-only, so the same `readAt` always resolves to the same
 * `throughSequence` and therefore the same rows. A `readAt` ahead of
 * settlement is refused instead of answered approximately.
 */

export type DataReleaseV3CanonicalSourceRefusalCode =
  | "CANONICAL_READ_AT_INVALID"
  | "CANONICAL_STATE_UNSETTLED";

export class DataReleaseV3CanonicalSourceError extends Error {
  constructor(readonly code: DataReleaseV3CanonicalSourceRefusalCode) {
    super("The data_release_v3 canonical source read was refused.");
    this.name = "DataReleaseV3CanonicalSourceError";
  }
}

export interface DataReleaseV3SoldOutTransition {
  readonly platformKey: string;
  readonly packExternalId: string;
  readonly soldOutAt: Date;
}

export interface DataReleaseV3CanonicalSourceSnapshot {
  readonly organizationId: string;
  readonly readAt: Date;
  readonly throughSequence: bigint;
  readonly configuration: CatalogReleaseSourceSnapshot["configuration"];
  readonly revisions: CatalogReleaseSourceSnapshot["revisions"];
  readonly providers: CatalogReleaseSourceSnapshot["providers"];
  readonly repackIdentities: CatalogReleaseSourceSnapshot["repackIdentities"];
  readonly assetPackAssociations:
    readonly ProviderV1AssetPackAssociationSnapshot[];
  readonly soldOutTransitions: readonly DataReleaseV3SoldOutTransition[];
}

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

function parseReadAt(readAt: string): Date {
  const parsed = new Date(readAt);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString() !== readAt
  ) {
    throw new DataReleaseV3CanonicalSourceError("CANONICAL_READ_AT_INVALID");
  }
  return parsed;
}

export class PrismaDataReleaseV3CanonicalCatalogSource {
  readonly #source: PrismaCatalogReleaseSourceRepository;

  constructor(
    private readonly database: PackscoutPrismaClient,
    private readonly organizationId: string,
  ) {
    this.#source = new PrismaCatalogReleaseSourceRepository(
      database,
      organizationId,
    );
  }

  async loadSourceSnapshot(input: {
    readonly readAt: string;
  }): Promise<DataReleaseV3CanonicalSourceSnapshot> {
    const readAt = parseReadAt(input.readAt);
    const watermarks = await this.database.$queryRaw<
      Array<{ settledSequence: bigint; settledAt: Date | null }>
    >(Prisma.sql`
      select settled_sequence as "settledSequence",
             settled_at as "settledAt"
      from public.settled_public_watermarks
      where organization_id = ${uuid(this.organizationId)}
    `);
    const watermark = watermarks[0];
    if (
      watermark === undefined ||
      watermark.settledAt === null ||
      watermark.settledSequence <= 0n ||
      readAt.getTime() > watermark.settledAt.getTime()
    ) {
      throw new DataReleaseV3CanonicalSourceError("CANONICAL_STATE_UNSETTLED");
    }
    const throughRows = await this.database.$queryRaw<
      Array<{ throughSequence: bigint | null }>
    >(Prisma.sql`
      select max(sequence) as "throughSequence"
      from public.public_change_causes
      where organization_id = ${uuid(this.organizationId)}
        and occurred_at <= ${readAt}
        and sequence <= ${watermark.settledSequence}
    `);
    const throughSequence = throughRows[0]?.throughSequence ?? 0n;
    const snapshot = await this.#source.loadSnapshot({
      throughSequence,
      throughOccurredAt: readAt,
    });
    const soldOutTransitions = await this.loadSoldOutTransitions(
      throughSequence,
    );
    const assetPackAssociations = await this.loadAssetPackAssociations(
      snapshot,
      throughSequence,
      readAt,
    );
    return {
      organizationId: this.organizationId,
      readAt,
      throughSequence,
      configuration: snapshot.configuration,
      revisions: snapshot.revisions,
      providers: snapshot.providers,
      repackIdentities: snapshot.repackIdentities,
      assetPackAssociations,
      soldOutTransitions,
    };
  }

  private async loadAssetPackAssociations(
    snapshot: CatalogReleaseSourceSnapshot,
    throughSequence: bigint,
    throughOccurredAt: Date,
  ): Promise<ProviderV1AssetPackAssociationSnapshot[]> {
    const activeProviders = snapshot.providers.filter(
      (provider) => provider.state === "active",
    );
    const associations = await Promise.all(activeProviders.map(
      async (provider) => {
        if (
          provider.providerId === null ||
          provider.sourceInstanceId === null ||
          provider.sourceRevisionId === null
        ) {
          return [];
        }
        const readiness = await loadProviderV1RelationshipConfirmationReadiness(
          this.database,
          {
            organizationId: this.organizationId,
            providerId: provider.providerId,
            sourceInstanceId: provider.sourceInstanceId,
            sourceRevisionId: provider.sourceRevisionId,
          },
        );
        if (!readiness.ready) {
          throw new DataReleaseV3CanonicalSourceError(
            "CANONICAL_STATE_UNSETTLED",
          );
        }
        return loadProviderV1AssetPackAssociations(this.database, {
          organizationId: this.organizationId,
          platformKey: provider.platformKey,
          sourceRevisionId: provider.sourceRevisionId,
          throughSequence,
          throughOccurredAt,
        });
      },
    ));
    return associations.flat().sort((left, right) =>
      left.platformKey.localeCompare(right.platformKey) ||
      left.assetExternalId.localeCompare(right.assetExternalId) ||
      left.packExternalId.localeCompare(right.packExternalId) ||
      left.sourceEntityId.localeCompare(right.sourceEntityId)
    );
  }

  /**
   * For every pack whose latest governed revision is sold_out, the start of
   * that trailing sold_out run: the earliest revision after which the pack
   * never returned to another availability inside the governed range.
   */
  private loadSoldOutTransitions(
    throughSequence: bigint,
  ): Promise<DataReleaseV3SoldOutTransition[]> {
    return this.database.$queryRaw<DataReleaseV3SoldOutTransition[]>(Prisma.sql`
      with pack_history as (
        select entity.id as entity_id,
               entity.platform_key as "platformKey",
               entity.external_id as "packExternalId",
               revision.public_change_sequence as sequence,
               revision.revision_number,
               revision.source_updated_at as "sourceUpdatedAt",
               revision.content_json->>'availability' as availability,
               lag(revision.content_json->>'availability') over (
                 partition by entity.id
                 order by revision.public_change_sequence, revision.revision_number
               ) as previous_availability,
               row_number() over (
                 partition by entity.id
                 order by revision.public_change_sequence desc,
                          revision.revision_number desc
               ) as recency
        from public.canonical_entities entity
        join public.canonical_revisions revision
          on revision.entity_id = entity.id
        where entity.organization_id = ${uuid(this.organizationId)}
          and revision.organization_id = ${uuid(this.organizationId)}
          and entity.record_kind = 'pack'
          and revision.public_change_sequence <= ${throughSequence}
      ), currently_sold_out as (
        select entity_id
        from pack_history
        where recency = 1 and availability = 'sold_out'
      )
      select distinct on (history.entity_id)
             history."platformKey",
             history."packExternalId",
             history."sourceUpdatedAt" as "soldOutAt"
      from pack_history history
      join currently_sold_out sold_out
        on sold_out.entity_id = history.entity_id
      where history.availability = 'sold_out'
        and history.previous_availability is distinct from 'sold_out'
      order by history.entity_id, history.sequence desc, history.revision_number desc
    `);
  }
}
