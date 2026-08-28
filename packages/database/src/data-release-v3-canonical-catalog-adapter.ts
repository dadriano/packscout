import { Prisma } from "@prisma/client";
import type { PackscoutPrismaClient } from "./database.ts";
import {
  PrismaCatalogReleaseSourceRepository,
  type CatalogReleaseSourceSnapshot,
} from "./catalog-release-source-repository.ts";

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
 * append-only, so the set of causes with `occurred_at <= readAt` is fixed once
 * the read is admitted. A `readAt` ahead of settlement is refused instead of
 * answered approximately.
 *
 * That set is selected as a predicate on each row and never collapsed into a
 * maximum sequence. `occurred_at` is not monotonic with `sequence` and nothing
 * enforces that it is: no constraint or trigger orders it, cause allocation
 * inserts the caller's `occurredAt` verbatim, writers read three
 * unsynchronized clocks (the PostgreSQL clock taken when an ingestion
 * transaction locks its page, the admin service clock, and an operator-supplied
 * approval time that is only format-validated), and settlement applies
 * `greatest()` to `settled_sequence` but not to `settled_at`. So
 * `max(sequence) where occurred_at <= readAt` is not the boundary of a
 * time-bounded prefix: a cause dated after `readAt` can sit below it and leak
 * into the release, and the same `readAt` can answer differently as later
 * writes land. The read instead keeps `sequence <= settledSequence` -- a
 * genuine prefix, and what makes it settled -- and bounds every member on its
 * own authoritative cause row's `occurred_at`.
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

/**
 * The snapshot deliberately carries no sequence ceiling. The ceiling this read
 * applies is the *live* settled watermark, re-read on every call, so it grows
 * between two reads at the same `readAt` — publishing it from a structure whose
 * contract is byte-for-byte repeatability would invite it into a fingerprint or
 * a hash and silently break that contract. Membership is fully determined by
 * `readAt`: the ceiling only ever admits more of an already-settled prefix, and
 * every member is still bounded by `occurred_at <= readAt`.
 */
export interface DataReleaseV3CanonicalSourceSnapshot {
  readonly organizationId: string;
  readonly readAt: Date;
  readonly configuration: CatalogReleaseSourceSnapshot["configuration"];
  readonly revisions: CatalogReleaseSourceSnapshot["revisions"];
  readonly providers: CatalogReleaseSourceSnapshot["providers"];
  readonly repackIdentities: CatalogReleaseSourceSnapshot["repackIdentities"];
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
    const throughSequence = watermark.settledSequence;
    const snapshot = await this.#source.loadSnapshot({
      throughSequence,
      throughOccurredAt: readAt,
      occurredAtBound: readAt,
    });
    const soldOutTransitions = await this.loadSoldOutTransitions(
      throughSequence,
      readAt,
    );
    return {
      organizationId: this.organizationId,
      readAt,
      configuration: snapshot.configuration,
      revisions: snapshot.revisions,
      providers: snapshot.providers,
      repackIdentities: snapshot.repackIdentities,
      soldOutTransitions,
    };
  }

  /**
   * For every pack whose latest governed revision is sold_out, the start of
   * that trailing sold_out run: the earliest revision after which the pack
   * never returned to another availability inside the governed range.
   *
   * The governed range is the same one every other member of the snapshot uses:
   * the settled sequence prefix, narrowed to the revisions whose authoritative
   * cause occurred at or before the read clock. A future-dated revision inside
   * the prefix would otherwise take over `recency = 1` and move -- or invent --
   * the frozen sold-out timestamp.
   */
  private loadSoldOutTransitions(
    throughSequence: bigint,
    readAt: Date,
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
          and exists (
            select 1
            from public.public_change_causes cause
            where cause.organization_id = revision.organization_id
              and cause.sequence = revision.public_change_sequence
              and cause.occurred_at <= ${readAt}
          )
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
