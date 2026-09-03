import type { CanonicalRecordKind } from "@packscout/contracts";
import { Prisma as ProviderPrisma } from
  "../prisma/generated/provider/index.js";
import type { ProviderQueryClient } from "./provider-database.ts";

/**
 * Provider-local implementation of the established Canonical Data read model.
 *
 * The browser contract predates the typed distributed warehouse, so its seven
 * record kinds are projections over the new schema rather than compatibility
 * tables:
 *
 * - platform -> database_identity
 * - pack -> packs
 * - catalog_asset -> collectibles
 * - ev_input -> the typed EV-input fields on packs with a buyback input
 * - pull -> pulls
 * - market_event -> market_events
 * - estimated_ev -> the typed PackScout-EV fields on calculated packs
 *
 * No query in this repository references the retired generic entity, revision,
 * relationship, provider-source, or organization tables.
 */

export interface ProviderCanonicalInspectionScope {
  readonly organizationId: string;
  readonly platformKey: string;
  readonly displayName: string;
  readonly state: string;
}

interface InspectionListRow {
  readonly entityId: string;
  readonly platformKey: string;
  readonly recordKind: CanonicalRecordKind;
  readonly externalId: string;
  readonly revisionNumber: number | null;
  readonly sourceUpdatedAt: Date | null;
  readonly sourceCollectedAt: Date | null;
  readonly acceptedAt: Date | null;
}

interface InspectionDetailRow extends InspectionListRow {
  readonly content: unknown;
  readonly contentHash: string | null;
  readonly provenance: null;
  readonly provenanceHash: null;
  readonly relationships: readonly {
    readonly relationshipKind: string;
    readonly targetPlatformKey: string;
    readonly targetRecordKind: CanonicalRecordKind;
    readonly targetExternalId: string | null;
    readonly resolved: boolean;
  }[];
}

type CountRow = { readonly counted: bigint };

function boundedCount(
  rows: readonly CountRow[],
  bound: number,
): { count: number; bounded: boolean } {
  const counted = Number(rows[0]?.counted ?? 0n);
  return counted > bound
    ? { count: bound, bounded: true }
    : { count: counted, bounded: false };
}

function safeRevision(value: bigint): number | null {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function jsonSafe(value: unknown): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (ProviderPrisma.Decimal.isDecimal(value)) return value.toFixed();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, jsonSafe(item)]),
    );
  }
  return String(value);
}

function keyFilter(
  externalId: string | undefined,
  externalIdPrefix: string | undefined,
): string | { readonly startsWith: string } | undefined {
  if (externalId !== undefined) return externalId;
  if (externalIdPrefix !== undefined) return { startsWith: externalIdPrefix };
  return undefined;
}

function matchesScope(
  scope: ProviderCanonicalInspectionScope,
  input: { readonly organizationId: string; readonly platformKey: string },
): boolean {
  return input.organizationId === scope.organizationId
    && input.platformKey === scope.platformKey;
}

function page<T>(rows: readonly T[], limit: number): {
  readonly rows: readonly T[];
  readonly hasMore: boolean;
} {
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

/** Read-only typed-schema adapter used only after central route authorization. */
export class ProviderCanonicalInspectionRepository {
  constructor(
    private readonly database: ProviderQueryClient,
    private readonly scope: ProviderCanonicalInspectionScope,
  ) {}

  async listProviders(
    organizationId: string,
  ): Promise<readonly ProviderCanonicalInspectionScope[]> {
    return organizationId === this.scope.organizationId ? [this.scope] : [];
  }

  async providerExists(input: {
    readonly organizationId: string;
    readonly platformKey: string;
  }): Promise<boolean> {
    return matchesScope(this.scope, input);
  }

  async countBounded(input: {
    readonly organizationId: string;
    readonly platformKey: string;
    readonly recordKind: CanonicalRecordKind;
    readonly bound: number;
  }): Promise<{ readonly count: number; readonly bounded: boolean }> {
    if (!matchesScope(this.scope, input)) return { count: 0, bounded: false };
    let rows: readonly CountRow[];
    switch (input.recordKind) {
      case "platform":
        rows = await this.database.$queryRaw<CountRow[]>(ProviderPrisma.sql`
          select count(*)::bigint as counted
            from (select 1 from public.database_identity limit ${input.bound + 1}) bounded
        `);
        break;
      case "pack":
        rows = await this.database.$queryRaw<CountRow[]>(ProviderPrisma.sql`
          select count(*)::bigint as counted
            from (select 1 from public.packs limit ${input.bound + 1}) bounded
        `);
        break;
      case "catalog_asset":
        rows = await this.database.$queryRaw<CountRow[]>(ProviderPrisma.sql`
          select count(*)::bigint as counted
            from (select 1 from public.collectibles limit ${input.bound + 1}) bounded
        `);
        break;
      case "ev_input":
        rows = await this.database.$queryRaw<CountRow[]>(ProviderPrisma.sql`
          select count(*)::bigint as counted
            from (
              select 1 from public.packs
               where buyback_rate is not null
               limit ${input.bound + 1}
            ) bounded
        `);
        break;
      case "pull":
        rows = await this.database.$queryRaw<CountRow[]>(ProviderPrisma.sql`
          select count(*)::bigint as counted
            from (select 1 from public.pulls limit ${input.bound + 1}) bounded
        `);
        break;
      case "market_event":
        rows = await this.database.$queryRaw<CountRow[]>(ProviderPrisma.sql`
          select count(*)::bigint as counted
            from (select 1 from public.market_events limit ${input.bound + 1}) bounded
        `);
        break;
      case "estimated_ev":
        rows = await this.database.$queryRaw<CountRow[]>(ProviderPrisma.sql`
          select count(*)::bigint as counted
            from (
              select 1 from public.packs
               where packscout_ev_calculated_at is not null
               limit ${input.bound + 1}
            ) bounded
        `);
        break;
    }
    return boundedCount(rows, input.bound);
  }

  async kindRecency(input: {
    readonly organizationId: string;
    readonly platformKey: string;
    readonly recordKind: CanonicalRecordKind;
    readonly collectedExtrema: boolean;
  }): Promise<{
    readonly oldestCollectedAt: Date | null;
    readonly newestCollectedAt: Date | null;
    readonly oldestAcceptedAt: Date | null;
    readonly newestAcceptedAt: Date | null;
    readonly collectedExtremaComplete: boolean;
  }> {
    if (!matchesScope(this.scope, input)) {
      return {
        oldestCollectedAt: null,
        newestCollectedAt: null,
        oldestAcceptedAt: null,
        newestAcceptedAt: null,
        collectedExtremaComplete: false,
      };
    }
    const [oldestAcceptedAt, newestAcceptedAt] = await Promise.all([
      this.acceptedEdge(input.recordKind, "asc"),
      this.acceptedEdge(input.recordKind, "desc"),
    ]);
    // The distributed typed schema intentionally carries neither the retired
    // revision graph nor its collection timestamp. Do not relabel source time
    // or row creation time as collection evidence merely to fill this field.
    void input.collectedExtrema;
    return {
      oldestCollectedAt: null,
      newestCollectedAt: null,
      oldestAcceptedAt,
      newestAcceptedAt,
      collectedExtremaComplete: false,
    };
  }

  async listEntities(input: {
    readonly organizationId: string;
    readonly platformKey: string;
    readonly recordKind: CanonicalRecordKind;
    readonly externalId?: string;
    readonly externalIdPrefix?: string;
    readonly offset: number;
    readonly limit: number;
    readonly direction?: "asc" | "desc";
  }): Promise<{
    readonly items: readonly InspectionListRow[];
    readonly hasMore: boolean;
  }> {
    if (!matchesScope(this.scope, input)) return { items: [], hasMore: false };
    const direction = input.direction ?? "asc";
    const selectedKey = keyFilter(input.externalId, input.externalIdPrefix);
    switch (input.recordKind) {
      case "platform": {
        const rows = await this.database.database_identity.findMany({
          where: selectedKey === undefined ? undefined : {
            provider_key: selectedKey,
          },
          select: {
            provider_id: true,
            provider_key: true,
            created_at: true,
          },
          orderBy: [{ provider_key: direction }, { provider_id: direction }],
          skip: input.offset,
          take: input.limit + 1,
        });
        const result = page(rows, input.limit);
        return {
          items: result.rows.map((row) => ({
            entityId: row.provider_id,
            platformKey: this.scope.platformKey,
            recordKind: "platform",
            externalId: row.provider_key,
            revisionNumber: null,
            sourceUpdatedAt: null,
            sourceCollectedAt: null,
            acceptedAt: row.created_at,
          })),
          hasMore: result.hasMore,
        };
      }
      case "pack":
        return await this.listPacks(input, selectedKey, direction, "pack");
      case "catalog_asset": {
        const rows = await this.database.collectibles.findMany({
          where: selectedKey === undefined ? undefined : {
            collectible_key: selectedKey,
          },
          select: {
            id: true,
            collectible_key: true,
            row_version: true,
            data_as_of: true,
            updated_at: true,
          },
          orderBy: [
            { collectible_key: direction },
            { id: direction },
          ],
          skip: input.offset,
          take: input.limit + 1,
        });
        const result = page(rows, input.limit);
        return {
          items: result.rows.map((row) => ({
            entityId: row.id,
            platformKey: this.scope.platformKey,
            recordKind: "catalog_asset",
            externalId: row.collectible_key,
            revisionNumber: safeRevision(row.row_version),
            sourceUpdatedAt: row.data_as_of,
            sourceCollectedAt: null,
            acceptedAt: row.updated_at,
          })),
          hasMore: result.hasMore,
        };
      }
      case "ev_input":
        return await this.listPacks(input, selectedKey, direction, "ev_input");
      case "pull": {
        const rows = await this.database.pulls.findMany({
          where: selectedKey === undefined ? undefined : { pull_key: selectedKey },
          select: {
            id: true,
            pull_key: true,
            row_version: true,
            occurred_at: true,
            updated_at: true,
          },
          orderBy: [{ pull_key: direction }, { id: direction }],
          skip: input.offset,
          take: input.limit + 1,
        });
        const result = page(rows, input.limit);
        return {
          items: result.rows.map((row) => ({
            entityId: row.id,
            platformKey: this.scope.platformKey,
            recordKind: "pull",
            externalId: row.pull_key,
            revisionNumber: safeRevision(row.row_version),
            sourceUpdatedAt: row.occurred_at,
            sourceCollectedAt: null,
            acceptedAt: row.updated_at,
          })),
          hasMore: result.hasMore,
        };
      }
      case "market_event": {
        const rows = await this.database.market_events.findMany({
          where: selectedKey === undefined ? undefined : { event_key: selectedKey },
          select: {
            id: true,
            event_key: true,
            row_version: true,
            occurred_at: true,
            updated_at: true,
          },
          orderBy: [{ event_key: direction }, { id: direction }],
          skip: input.offset,
          take: input.limit + 1,
        });
        const result = page(rows, input.limit);
        return {
          items: result.rows.map((row) => ({
            entityId: row.id,
            platformKey: this.scope.platformKey,
            recordKind: "market_event",
            externalId: row.event_key,
            revisionNumber: safeRevision(row.row_version),
            sourceUpdatedAt: row.occurred_at,
            sourceCollectedAt: null,
            acceptedAt: row.updated_at,
          })),
          hasMore: result.hasMore,
        };
      }
      case "estimated_ev":
        return await this.listPacks(
          input,
          selectedKey,
          direction,
          "estimated_ev",
        );
    }
  }

  async readEntity(input: {
    readonly organizationId: string;
    readonly platformKey: string;
    readonly recordKind: CanonicalRecordKind;
    readonly externalId: string;
  }): Promise<InspectionDetailRow | null> {
    if (!matchesScope(this.scope, input)) return null;
    switch (input.recordKind) {
      case "platform": {
        const row = await this.database.database_identity.findFirst({
          where: { provider_key: input.externalId },
        });
        return row === null ? null : this.detail({
          entityId: row.provider_id,
          recordKind: "platform",
          externalId: row.provider_key,
          revisionNumber: null,
          sourceUpdatedAt: null,
          acceptedAt: row.created_at,
          content: row,
        });
      }
      case "pack": {
        const row = await this.database.packs.findUnique({
          where: { pack_key: input.externalId },
        });
        return row === null ? null : this.packDetail(row, "pack");
      }
      case "catalog_asset": {
        const row = await this.database.collectibles.findUnique({
          where: { collectible_key: input.externalId },
        });
        return row === null ? null : this.detail({
          entityId: row.id,
          recordKind: "catalog_asset",
          externalId: row.collectible_key,
          revisionNumber: safeRevision(row.row_version),
          sourceUpdatedAt: row.data_as_of,
          acceptedAt: row.updated_at,
          content: row,
        });
      }
      case "ev_input": {
        const row = await this.database.packs.findFirst({
          where: { pack_key: input.externalId, buyback_rate: { not: null } },
        });
        return row === null ? null : this.packDetail(row, "ev_input");
      }
      case "pull": {
        const row = await this.database.pulls.findUnique({
          where: { pull_key: input.externalId },
          include: { items: { orderBy: { ordinal: "asc" } } },
        });
        if (row === null) return null;
        const relationships: InspectionDetailRow["relationships"] = [
          ...(row.pack_key === null ? [] : [{
            relationshipKind: "pull_pack",
            targetPlatformKey: this.scope.platformKey,
            targetRecordKind: "pack" as const,
            targetExternalId: row.pack_key,
            resolved: row.pack_id !== null,
          }]),
          ...row.items
            .filter((item) => item.collectible_key !== null)
            .map((item) => ({
              relationshipKind: "pull_item",
              targetPlatformKey: this.scope.platformKey,
              targetRecordKind: "catalog_asset" as const,
              targetExternalId: item.collectible_key,
              resolved: item.collectible_id !== null,
            })),
        ];
        return this.detail({
          entityId: row.id,
          recordKind: "pull",
          externalId: row.pull_key,
          revisionNumber: safeRevision(row.row_version),
          sourceUpdatedAt: row.occurred_at,
          acceptedAt: row.updated_at,
          content: row,
          contentHash: row.fact_digest,
          relationships,
        });
      }
      case "market_event": {
        const row = await this.database.market_events.findUnique({
          where: { event_key: input.externalId },
        });
        if (row === null) return null;
        const relationships: InspectionDetailRow["relationships"] = [
          ...(row.pack_key === null ? [] : [{
            relationshipKind: "market_event_pack",
            targetPlatformKey: this.scope.platformKey,
            targetRecordKind: "pack" as const,
            targetExternalId: row.pack_key,
            resolved: row.pack_id !== null,
          }]),
          ...(row.collectible_key === null ? [] : [{
            relationshipKind: "market_event_collectible",
            targetPlatformKey: this.scope.platformKey,
            targetRecordKind: "catalog_asset" as const,
            targetExternalId: row.collectible_key,
            resolved: row.collectible_id !== null,
          }]),
        ];
        return this.detail({
          entityId: row.id,
          recordKind: "market_event",
          externalId: row.event_key,
          revisionNumber: safeRevision(row.row_version),
          sourceUpdatedAt: row.occurred_at,
          acceptedAt: row.updated_at,
          content: row,
          contentHash: row.fact_digest,
          relationships,
        });
      }
      case "estimated_ev": {
        const row = await this.database.packs.findFirst({
          where: {
            pack_key: input.externalId,
            packscout_ev_calculated_at: { not: null },
          },
        });
        return row === null ? null : this.packDetail(row, "estimated_ev");
      }
    }
  }

  private async acceptedEdge(
    recordKind: CanonicalRecordKind,
    direction: "asc" | "desc",
  ): Promise<Date | null> {
    if (recordKind === "platform") {
      const row = await this.database.database_identity.findFirst({
        select: { created_at: true },
      });
      return row?.created_at ?? null;
    }
    if (recordKind === "ev_input") {
      const row = await this.database.packs.findFirst({
        where: { buyback_rate: { not: null } },
        select: { updated_at: true },
        orderBy: { updated_at: direction },
      });
      return row?.updated_at ?? null;
    }
    if (recordKind === "estimated_ev") {
      const row = await this.database.packs.findFirst({
        where: { packscout_ev_calculated_at: { not: null } },
        select: { updated_at: true },
        orderBy: { updated_at: direction },
      });
      return row?.updated_at ?? null;
    }
    const entityType = recordKind === "catalog_asset"
      ? "collectible"
      : recordKind;
    const row = await this.database.promotion_changes.findFirst({
      where: { entity_type: entityType },
      select: { changed_at: true },
      orderBy: { sequence: direction },
    });
    return row?.changed_at ?? null;
  }

  private async listPacks(
    input: {
      readonly offset: number;
      readonly limit: number;
    },
    selectedKey: ReturnType<typeof keyFilter>,
    direction: "asc" | "desc",
    recordKind: "pack" | "ev_input" | "estimated_ev",
  ): Promise<{
    readonly items: readonly InspectionListRow[];
    readonly hasMore: boolean;
  }> {
    const rows = await this.database.packs.findMany({
      where: {
        ...(selectedKey === undefined ? {} : { pack_key: selectedKey }),
        ...(recordKind === "ev_input"
          ? { buyback_rate: { not: null } }
          : {}),
        ...(recordKind === "estimated_ev"
          ? { packscout_ev_calculated_at: { not: null } }
          : {}),
      },
      select: {
        id: true,
        pack_key: true,
        row_version: true,
        source_updated_at: true,
        packscout_ev_data_as_of: true,
        updated_at: true,
      },
      orderBy: [{ pack_key: direction }, { id: direction }],
      skip: input.offset,
      take: input.limit + 1,
    });
    const result = page(rows, input.limit);
    return {
      items: result.rows.map((row) => ({
        entityId: row.id,
        platformKey: this.scope.platformKey,
        recordKind,
        externalId: row.pack_key,
        revisionNumber: safeRevision(row.row_version),
        sourceUpdatedAt: recordKind === "estimated_ev"
          ? row.packscout_ev_data_as_of
          : row.source_updated_at,
        sourceCollectedAt: null,
        acceptedAt: row.updated_at,
      })),
      hasMore: result.hasMore,
    };
  }

  private packDetail(
    row: Awaited<ReturnType<ProviderQueryClient["packs"]["findFirst"]>> & {},
    recordKind: "pack" | "ev_input" | "estimated_ev",
  ): InspectionDetailRow {
    const content = recordKind === "ev_input"
      ? {
          pack_key: row.pack_key,
          price_amount: row.price_amount,
          price_currency: row.price_currency,
          price_usd_amount: row.price_usd_amount,
          buyback_rate: row.buyback_rate,
          buyback_source_kind: row.buyback_source_kind,
          vendor_ev_amount: row.vendor_ev_amount,
          vendor_ev_currency: row.vendor_ev_currency,
          vendor_ev_observed_at: row.vendor_ev_observed_at,
          vendor_ev_unavailable_reason: row.vendor_ev_unavailable_reason,
          source_updated_at: row.source_updated_at,
        }
      : recordKind === "estimated_ev"
        ? {
            pack_key: row.pack_key,
            packscout_ev_amount: row.packscout_ev_amount,
            packscout_ev_currency: row.packscout_ev_currency,
            packscout_ev_model_version: row.packscout_ev_model_version,
            packscout_ev_confidence_policy_version:
              row.packscout_ev_confidence_policy_version,
            packscout_ev_confidence: row.packscout_ev_confidence,
            packscout_ev_data_as_of: row.packscout_ev_data_as_of,
            packscout_ev_calculated_at: row.packscout_ev_calculated_at,
            packscout_ev_unavailable_reason:
              row.packscout_ev_unavailable_reason,
          }
        : row;
    return this.detail({
      entityId: row.id,
      recordKind,
      externalId: row.pack_key,
      revisionNumber: safeRevision(row.row_version),
      sourceUpdatedAt: recordKind === "estimated_ev"
        ? row.packscout_ev_data_as_of
        : row.source_updated_at,
      acceptedAt: row.updated_at,
      content,
      relationships: recordKind === "pack" ? [] : [{
        relationshipKind: `${recordKind}_pack`,
        targetPlatformKey: this.scope.platformKey,
        targetRecordKind: "pack",
        targetExternalId: row.pack_key,
        resolved: true,
      }],
    });
  }

  private detail(input: {
    readonly entityId: string;
    readonly recordKind: CanonicalRecordKind;
    readonly externalId: string;
    readonly revisionNumber: number | null;
    readonly sourceUpdatedAt: Date | null;
    readonly acceptedAt: Date | null;
    readonly content: unknown;
    readonly contentHash?: string | null;
    readonly relationships?: InspectionDetailRow["relationships"];
  }): InspectionDetailRow {
    return {
      entityId: input.entityId,
      platformKey: this.scope.platformKey,
      recordKind: input.recordKind,
      externalId: input.externalId,
      revisionNumber: input.revisionNumber,
      sourceUpdatedAt: input.sourceUpdatedAt,
      sourceCollectedAt: null,
      acceptedAt: input.acceptedAt,
      content: jsonSafe(input.content),
      contentHash: input.contentHash ?? null,
      provenance: null,
      provenanceHash: null,
      relationships: input.relationships ?? [],
    };
  }
}
