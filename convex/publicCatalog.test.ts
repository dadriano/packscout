/// <reference types="vite/client" />

import {
  dashboardBundleSchema,
  encodePublicCursorStack,
  getDashboardBundleResultSchema,
  getPublicPackResultSchema,
  getPublicShellStatusResultSchema,
  listPublicPacksResultSchema,
  parseCatalogSnapshotV1,
  publicPackDetailSchema,
  type CatalogSnapshotV1,
  type PublicPackDetail,
} from "@packscout/contracts";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { queryRowFromPack } from "./publicCatalogValidation";

const modules = import.meta.glob("./**/*.ts");
type CatalogTest = TestConvex<typeof schema>;

function available<T>(value: T) {
  return { status: "available" as const, value, reason: null, nullRank: 0 as const };
}

function unavailable<TReason extends string>(reason: TReason) {
  return {
    status: "unavailable" as const,
    value: null,
    reason,
    nullRank: 1 as const,
  };
}

type PackInput = {
  readonly ordinal: number;
  readonly name: string;
  readonly platformKey: "alpha_market" | "collector" | "courtyard";
  readonly platformDisplayName: "Alpha Market" | "Collector Crypt" | "Courtyard";
  readonly category: "Magic" | "Pokemon";
  readonly availability?: "active" | "sold_out";
  readonly priceMinor: number | null;
  readonly evDollarsMinor: number;
  readonly chaseMinor: number | null;
  readonly estimateAvailable?: boolean;
  readonly buybackAvailable?: boolean;
};

function packId(ordinal: number): string {
  return `00000000-0000-5000-8000-${ordinal.toString().padStart(12, "0")}`;
}

function chaseId(ordinal: number): string {
  return `10000000-0000-5000-8000-${ordinal.toString().padStart(12, "0")}`;
}

function buildPack(input: PackInput): PublicPackDetail {
  const grossMinor = (input.priceMinor ?? 1_000) + input.evDollarsMinor;
  const grossReturnBasisPoints =
    input.priceMinor === null
      ? 12_500
      : Math.round((grossMinor * 10_000) / input.priceMinor);
  const derivedReason = input.priceMinor === null ? "PRICE_UNAVAILABLE" : null;
  const estimateAvailable = input.estimateAvailable ?? true;
  return publicPackDetailSchema.parse({
    publicPackId: packId(input.ordinal),
    platformKey: input.platformKey,
    platformDisplayName: input.platformDisplayName,
    platformLogoUrl: null,
    category: input.category,
    name: input.name,
    availability: input.availability ?? "active",
    price: {
      displayMoney:
        input.priceMinor === null
          ? null
          : { minorUnits: input.priceMinor, currency: "USD" },
      usdComparison:
        input.priceMinor === null
          ? unavailable("PRICE_UNAVAILABLE")
          : available({ minorUnits: input.priceMinor, currency: "USD" }),
    },
    estimatedEv: {
      grossEv: estimateAvailable
        ? available({ minorUnits: grossMinor, currency: "USD" })
        : unavailable("ESTIMATE_INPUT_INCOMPLETE"),
      grossReturn: estimateAvailable
        ? available({ basisPoints: grossReturnBasisPoints })
        : unavailable("ESTIMATE_INPUT_INCOMPLETE"),
      evDollars:
        derivedReason === null && estimateAvailable
          ? available({ minorUnits: input.evDollarsMinor, currency: "USD" })
          : unavailable(derivedReason ?? "ESTIMATE_INPUT_INCOMPLETE"),
      evPercent:
        derivedReason === null && estimateAvailable
          ? available({ basisPoints: grossReturnBasisPoints - 10_000 })
          : unavailable(derivedReason ?? "ESTIMATE_INPUT_INCOMPLETE"),
      calculatedAt: estimateAvailable ? "2026-08-11T12:00:00Z" : null,
      coverage: {
        evidenceCompleteness: estimateAvailable ? "complete" : "unknown",
        probabilityCoverageBasisPoints: estimateAvailable ? 10_000 : null,
      },
      limitations: ["Synthetic fixture; outcomes are not guaranteed."],
    },
    buyback:
      input.buybackAvailable === false
        ? unavailable("BUYBACK_UNAVAILABLE")
        : available({ basisPoints: 8_000, sourceKind: "derived" }),
    primaryImage: null,
    topChase:
      input.chaseMinor === null
        ? unavailable("CHASE_UNAVAILABLE")
        : available({
            publicChaseId: chaseId(input.ordinal),
            name: `${input.name} chase`,
            displayMoney: { minorUnits: input.chaseMinor, currency: "USD" },
            usdComparison: available({
              minorUnits: input.chaseMinor,
              currency: "USD",
            }),
            primaryImage: null,
            evidenceKind: "canonical_asset_value",
            observedAt: "2026-08-11T11:55:00Z",
          }),
    actionAvailability: { promo: false, packLink: false },
    sourceFirstSeenAt: "2026-08-01T00:00:00Z",
    sourceCollectedAt: "2026-08-11T11:55:00Z",
    description: `Synthetic detail for ${input.name}.`,
    actions: {},
  });
}

const syntheticPacks = [
  buildPack({
    ordinal: 1,
    name: "Alpha Pack",
    platformKey: "collector",
    platformDisplayName: "Collector Crypt",
    category: "Pokemon",
    priceMinor: 1_000,
    evDollarsMinor: 400,
    chaseMinor: 50_000,
  }),
  buildPack({
    ordinal: 2,
    name: "Alpha Pack Deluxe",
    platformKey: "collector",
    platformDisplayName: "Collector Crypt",
    category: "Pokemon",
    priceMinor: 1_100,
    evDollarsMinor: 300,
    chaseMinor: 40_000,
  }),
  buildPack({
    ordinal: 3,
    name: "Pack Alpha Vault",
    platformKey: "collector",
    platformDisplayName: "Collector Crypt",
    category: "Pokemon",
    priceMinor: 1_200,
    evDollarsMinor: 200,
    chaseMinor: 30_000,
  }),
  buildPack({
    ordinal: 4,
    name: "Pack Mystery",
    platformKey: "alpha_market",
    platformDisplayName: "Alpha Market",
    category: "Pokemon",
    priceMinor: 1_300,
    evDollarsMinor: 100,
    chaseMinor: 20_000,
  }),
  buildPack({
    ordinal: 5,
    name: "No Price Pack",
    platformKey: "courtyard",
    platformDisplayName: "Courtyard",
    category: "Magic",
    priceMinor: null,
    evDollarsMinor: 500,
    chaseMinor: null,
    estimateAvailable: false,
    buybackAvailable: false,
  }),
  buildPack({
    ordinal: 6,
    name: "Sold Pack",
    platformKey: "courtyard",
    platformDisplayName: "Courtyard",
    category: "Magic",
    availability: "sold_out",
    priceMinor: 2_000,
    evDollarsMinor: 100,
    chaseMinor: 10_000,
  }),
] as const;

function buildSnapshot(
  publicationId = "20000000-0000-4000-8000-000000000001",
  contentCharacter = "5",
): CatalogSnapshotV1 {
  return parseCatalogSnapshotV1({
    metadata: {
      schemaVersion: "catalog_snapshot_v1",
      dataSource: "canonical",
      publicationId,
      sourceWatermark: "synthetic.catalog.42",
      manifestFingerprint: "4".repeat(64),
      contentHash: contentCharacter.repeat(64),
      publicConfigRevision: 1,
      publicConfigHash: "6".repeat(64),
      originSetHash: "7".repeat(64),
      createdAt: "2026-08-11T11:57:00Z",
      completedAt: "2026-08-11T11:58:00Z",
      dataAsOf: "2026-08-11T11:55:00Z",
      lastSuccessfulObservationAt: "2026-08-11T12:00:00Z",
      staleAt: "2026-08-11T12:15:00Z",
      freshness: "fresh",
      delayedSourceCount: 0,
      platformConfigCount: 3,
      packCount: syntheticPacks.length,
      searchAlgorithmVersion: "packscout_relevance_v1",
    },
    platformConfigs: [
      {
        platformKey: "alpha_market",
        revision: 1,
        contentHash: "a".repeat(64),
        displayName: "Alpha Market",
        logoUrl: null,
        listingHosts: [],
        imageOrigins: [],
        referralParameters: [],
        publicPromo: null,
      },
      {
        platformKey: "collector",
        revision: 1,
        contentHash: "b".repeat(64),
        displayName: "Collector Crypt",
        logoUrl: null,
        listingHosts: [],
        imageOrigins: [],
        referralParameters: [],
        publicPromo: null,
      },
      {
        platformKey: "courtyard",
        revision: 1,
        contentHash: "c".repeat(64),
        displayName: "Courtyard",
        logoUrl: null,
        listingHosts: [],
        imageOrigins: [],
        referralParameters: [],
        publicPromo: null,
      },
    ],
    packs: syntheticPacks,
    facets: {
      platforms: [
        { key: "alpha_market", label: "Alpha Market", packCount: 1 },
        { key: "collector", label: "Collector Crypt", packCount: 3 },
        { key: "courtyard", label: "Courtyard", packCount: 2 },
      ],
      categories: [
        { key: "magic", label: "Magic", packCount: 2 },
        { key: "pokemon", label: "Pokemon", packCount: 4 },
      ],
    },
  });
}

function queryRow(pack: PublicPackDetail) {
  return queryRowFromPack({
    publicPackId: pack.publicPackId,
    platformKey: pack.platformKey,
    platformDisplayName: pack.platformDisplayName,
    category: pack.category,
    name: pack.name,
    availability: pack.availability,
    priceMinor:
      pack.price.usdComparison.status === "available"
        ? pack.price.usdComparison.value.minorUnits
        : null,
    grossEvMinor:
      pack.estimatedEv.grossEv.status === "available"
        ? pack.estimatedEv.grossEv.value.minorUnits
        : null,
    evDollarsMinor:
      pack.estimatedEv.evDollars.status === "available"
        ? pack.estimatedEv.evDollars.value.minorUnits
        : null,
    evPercentBasisPoints:
      pack.estimatedEv.evPercent.status === "available"
        ? pack.estimatedEv.evPercent.value.basisPoints
        : null,
    buybackBasisPoints:
      pack.buyback.status === "available" ? pack.buyback.value.basisPoints : null,
    topChaseValueMinor:
      pack.topChase.status === "available" &&
      pack.topChase.value.usdComparison.status === "available"
        ? pack.topChase.value.usdComparison.value.minorUnits
        : null,
    topChaseReason:
      pack.topChase.status === "unavailable"
        ? pack.topChase.reason
        : pack.topChase.value.usdComparison.status === "unavailable"
          ? pack.topChase.value.usdComparison.reason
          : null,
  });
}

async function seedSnapshot(
  t: CatalogTest,
  snapshot: CatalogSnapshotV1,
): Promise<Id<"catalogSnapshots">> {
  return await t.run(async (ctx) => {
    const rows = snapshot.packs.map(queryRow);
    const snapshotId = await ctx.db.insert("catalogSnapshots", {
      publicationId: snapshot.metadata.publicationId,
      lifecycle: "complete",
      metadata: snapshot.metadata,
      platformConfigs: snapshot.platformConfigs,
      facets: snapshot.facets,
      shardCount: rows.length === 0 ? 0 : 1,
    });
    for (const pack of snapshot.packs) {
      await ctx.db.insert("publicPacks", {
        snapshotId,
        publicPackId: pack.publicPackId,
        detail: pack,
      });
    }
    if (rows.length > 0) {
      await ctx.db.insert("catalogQueryShards", {
        snapshotId,
        shardNumber: 0,
        rowCount: rows.length,
        byteCount: new TextEncoder().encode(JSON.stringify(rows)).byteLength,
        contentHash: "d".repeat(64),
        rows,
      });
    }
    const states = await ctx.db
      .query("catalogState")
      .withIndex("by_key", (index) => index.eq("key", "singleton"))
      .take(1);
    if (states.length === 0) {
      await ctx.db.insert("catalogState", {
        key: "singleton",
        activeSnapshotId: snapshotId,
        previousSnapshotId: null,
        latestObservationSequence: 1,
        dataAsOf: snapshot.metadata.dataAsOf,
        lastSuccessfulObservationAt:
          snapshot.metadata.lastSuccessfulObservationAt,
        staleAt: snapshot.metadata.staleAt,
        freshness: snapshot.metadata.freshness,
        delayedSourceCount: snapshot.metadata.delayedSourceCount,
        updatedAt: snapshot.metadata.completedAt,
      });
    } else {
      await ctx.db.patch("catalogState", states[0]!._id, {
        previousSnapshotId: states[0]!.activeSnapshotId,
        activeSnapshotId: snapshotId,
        latestObservationSequence: states[0]!.latestObservationSequence + 1,
        dataAsOf: snapshot.metadata.dataAsOf,
        lastSuccessfulObservationAt:
          snapshot.metadata.lastSuccessfulObservationAt,
        staleAt: snapshot.metadata.staleAt,
        freshness: snapshot.metadata.freshness,
        delayedSourceCount: snapshot.metadata.delayedSourceCount,
        updatedAt: snapshot.metadata.completedAt,
      });
    }
    return snapshotId;
  });
}

function createTest() {
  return convexTest({ schema, modules, transactionLimits: true });
}

describe("public catalog read model", () => {
  test("returns a stable unavailable result before the first snapshot", async () => {
    const t = createTest();
    const result = await t.query(api.publicCatalog.getPublicShellStatus, {});
    expect(getPublicShellStatusResultSchema.parse(result)).toEqual({
      ok: false,
      code: "SNAPSHOT_UNAVAILABLE",
      error: "Pack data is temporarily unavailable.",
      retryable: true,
    });
  });

  test("returns one coherent active-only Overview bundle", async () => {
    const t = createTest();
    await seedSnapshot(t, buildSnapshot());
    const result = await t.query(api.publicCatalog.getDashboardBundle, {});
    const parsed = getDashboardBundleResultSchema.parse(result);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(dashboardBundleSchema.parse(parsed.data).kpis).toMatchObject({
      totalPacks: 5,
      positiveEvPacks: 4,
      highestChaseValue: {
        status: "available",
        value: { minorUnits: 50_000, currency: "USD" },
      },
    });
    expect(parsed.data.opportunities.map((pack) => pack.publicPackId)).toEqual([
      packId(1),
      packId(2),
      packId(3),
      packId(4),
    ]);
    expect(parsed.data.details.map((pack) => pack.publicPackId)).toEqual(
      parsed.data.opportunities.map((pack) => pack.publicPackId),
    );
    expect(parsed.data.selectedPack?.publicPackId).toBe(packId(1));
    expect(parsed.data.opportunities).not.toContainEqual(
      expect.objectContaining({ availability: "sold_out" }),
    );
  });

  test("uses deterministic relevance tiers without a metric tie break", async () => {
    const t = createTest();
    await seedSnapshot(t, buildSnapshot());
    const result = await t.query(api.publicCatalog.listPublicPacks, {
      search: "  ALPHA, pack! ",
      sort: "top_chase_value",
      direction: "asc",
      pageSize: 50,
    });
    const parsed = listPublicPacksResultSchema.parse(result);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.activeQuery.search).toBe("alpha pack");
    expect(parsed.data.rows.map((pack) => pack.publicPackId)).toEqual([
      packId(1),
      packId(2),
      packId(3),
      packId(4),
    ]);
  });

  test("keeps unavailable values last and applies narrowed price semantics", async () => {
    const t = createTest();
    await seedSnapshot(t, buildSnapshot());
    for (const sort of [
      "pack_price",
      "ev_dollars",
      "ev_percent",
      "buyback_percent",
      "gross_ev",
      "top_chase_value",
    ] as const) {
      for (const direction of ["asc", "desc"] as const) {
        const result = await t.query(api.publicCatalog.listPublicPacks, {
          sort,
          direction,
          pageSize: 50,
        });
        const parsed = listPublicPacksResultSchema.parse(result);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) {
          expect(parsed.data.range.total).toBe(6);
          expect(parsed.data.rows.at(-1)?.publicPackId).toBe(packId(5));
        }
      }
    }
    const narrowed = await t.query(api.publicCatalog.listPublicPacks, {
      filters: {
        platforms: [],
        categories: [],
        price: { mode: "narrowed", minMinor: 1_000, maxMinor: 3_000 },
      },
      pageSize: 50,
    });
    const parsed = listPublicPacksResultSchema.parse(narrowed);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.range.total).toBe(5);
      expect(parsed.data.details.map((pack) => pack.publicPackId)).toEqual(
        parsed.data.rows.map((pack) => pack.publicPackId),
      );
      expect(parsed.data.rows.map((pack) => pack.publicPackId)).not.toContain(
        packId(5),
      );
    }
  });

  test("returns contextual opposite-group facets and selected zero counts", async () => {
    const t = createTest();
    await seedSnapshot(t, buildSnapshot());
    const result = await t.query(api.publicCatalog.listPublicPacks, {
      filters: {
        platforms: ["collector"],
        categories: ["magic"],
        price: { mode: "full", minMinor: 1_000, maxMinor: 1_200_000 },
      },
      pageSize: 50,
    });
    const parsed = listPublicPacksResultSchema.parse(result);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.rows).toEqual([]);
    expect(parsed.data.facets.platforms).toContainEqual({
      key: "collector",
      label: "Collector Crypt",
      packCount: 0,
      selected: true,
    });
    expect(parsed.data.facets.categories).toContainEqual({
      key: "magic",
      label: "Magic",
      packCount: 0,
      selected: true,
    });
  });

  test("binds cursors to query and resets retained old snapshots coherently", async () => {
    const t = createTest();
    const oldSnapshotId = await seedSnapshot(t, buildSnapshot());
    const first = listPublicPacksResultSchema.parse(
      await t.query(api.publicCatalog.listPublicPacks, { pageSize: 2 }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok || first.data.nextCursor === null) return;

    const second = listPublicPacksResultSchema.parse(
      await t.query(api.publicCatalog.listPublicPacks, {
        pageSize: 2,
        cursor: first.data.nextCursor,
        queryFingerprint: first.data.queryFingerprint,
      }),
    );
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.data.hasPrevious).toBe(true);
      expect(second.data.range.start).toBe(3);
      expect(second.data.nextCursor).not.toBeNull();
      if (second.data.nextCursor !== null) {
        const third = listPublicPacksResultSchema.parse(
          await t.query(api.publicCatalog.listPublicPacks, {
            pageSize: 2,
            cursor: second.data.nextCursor,
            cursorStack: encodePublicCursorStack([first.data.nextCursor]),
            queryFingerprint: first.data.queryFingerprint,
          }),
        );
        expect(third).toMatchObject({
          ok: true,
          data: { hasPrevious: true, range: { start: 5, end: 6, total: 6 } },
        });
      }
    }

    await seedSnapshot(
      t,
      buildSnapshot("20000000-0000-4000-8000-000000000002", "8"),
    );
    const reset = listPublicPacksResultSchema.parse(
      await t.query(api.publicCatalog.listPublicPacks, {
        pageSize: 2,
        cursor: first.data.nextCursor,
        queryFingerprint: first.data.queryFingerprint,
      }),
    );
    expect(reset.ok).toBe(true);
    if (reset.ok) {
      expect(reset.data.paginationReset).toBe("snapshot_changed");
      expect(reset.data.hasPrevious).toBe(false);
      expect(reset.data.range.start).toBe(1);
    }

    await t.run(async (ctx) => {
      await ctx.db.delete("catalogSnapshots", oldSnapshotId);
    });
    const expired = listPublicPacksResultSchema.parse(
      await t.query(api.publicCatalog.listPublicPacks, {
        pageSize: 2,
        cursor: first.data.nextCursor,
        queryFingerprint: first.data.queryFingerprint,
      }),
    );
    expect(expired).toMatchObject({ ok: false, code: "CURSOR_EXPIRED" });
  });

  test("rejects malformed cursor stacks and invalid catalog fragments", async () => {
    const t = createTest();
    await seedSnapshot(t, buildSnapshot());
    const invalidInputs = [
      { sort: "net_ev" },
      { pageSize: 51 },
      {
        filters: {
          platforms: [],
          categories: [],
          price: { mode: "narrowed", minMinor: 3_000, maxMinor: 1_000 },
        },
      },
      {
        cursorStack: encodePublicCursorStack(["not_a_real_cursor"]),
        queryFingerprint: "a".repeat(64),
      },
      {
        filters: {
          platforms: ["unknown_platform"],
          categories: [],
          price: { mode: "full", minMinor: 1_000, maxMinor: 1_200_000 },
        },
      },
    ];
    for (const input of invalidInputs) {
      const result = listPublicPacksResultSchema.parse(
        await t.query(api.publicCatalog.listPublicPacks, input),
      );
      expect(result).toMatchObject({ ok: false, code: "INVALID_QUERY" });
    }
  });

  test("returns delayed metadata without hiding the last complete snapshot", async () => {
    const t = createTest();
    await seedSnapshot(t, buildSnapshot());
    await t.run(async (ctx) => {
      const state = await ctx.db
        .query("catalogState")
        .withIndex("by_key", (index) => index.eq("key", "singleton"))
        .unique();
      if (state !== null) {
        await ctx.db.patch("catalogState", state._id, {
          freshness: "delayed",
          delayedSourceCount: 1,
        });
      }
    });
    const result = getPublicShellStatusResultSchema.parse(
      await t.query(api.publicCatalog.getPublicShellStatus, {}),
    );
    expect(result).toMatchObject({
      ok: true,
      data: { metadata: { freshness: "delayed", delayedSourceCount: 1 } },
    });
  });

  test("returns stable pack outcomes and validates stored public detail", async () => {
    const t = createTest();
    const snapshot = buildSnapshot();
    await seedSnapshot(t, snapshot);
    const found = getPublicPackResultSchema.parse(
      await t.query(api.publicCatalog.getPublicPack, {
        publicPackId: packId(1),
        snapshotPublicationId: snapshot.metadata.publicationId,
      }),
    );
    expect(found).toMatchObject({
      ok: true,
      data: { publicPackId: packId(1) },
    });
    const missing = getPublicPackResultSchema.parse(
      await t.query(api.publicCatalog.getPublicPack, {
        publicPackId: "00000000-0000-5000-8000-999999999999",
        snapshotPublicationId: snapshot.metadata.publicationId,
      }),
    );
    expect(missing).toMatchObject({ ok: false, code: "PACK_NOT_FOUND" });

    await t.run(async (ctx) => {
      const active = await ctx.db
        .query("catalogState")
        .withIndex("by_key", (index) => index.eq("key", "singleton"))
        .unique();
      if (active === null || active.activeSnapshotId === null) return;
      const activeSnapshotId = active.activeSnapshotId;
      const pack = await ctx.db
        .query("publicPacks")
        .withIndex("by_snapshot_id_and_public_pack_id", (index) =>
          index
            .eq("snapshotId", activeSnapshotId)
            .eq("publicPackId", packId(1)),
        )
        .unique();
      if (pack !== null) {
        await ctx.db.patch("publicPacks", pack._id, {
          detail: { ...pack.detail, name: "" },
        });
      }
    });
    const invalidStoredDetail = await t.query(api.publicCatalog.getPublicPack, {
      publicPackId: packId(1),
      snapshotPublicationId: snapshot.metadata.publicationId,
    });
    expect(invalidStoredDetail).toMatchObject({
      ok: false,
      code: "PACK_NOT_FOUND",
    });
  });
});
