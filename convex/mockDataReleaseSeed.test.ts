/// <reference types="vite/client" />

import {
  findRepacksByDesiredCollectibleResultSchema,
  getDashboardBundleResultSchema,
  listPublicRepacksResultSchema,
  parseDataReleaseManifestV2,
  searchPublicCollectiblesResultSchema,
} from "@packscout/contracts";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { canonicalJson, sha256CanonicalJson } from "./dataReleaseCanonicalHash";
import {
  MOCK_DATA_RELEASE_CONTENT_HASH,
  MOCK_DATA_RELEASE_MANIFEST_FINGERPRINT,
  MOCK_DATA_RELEASE_ORIGIN_SET_HASH,
  MOCK_DATA_RELEASE_PUBLIC_CONFIG_HASH,
  MOCK_DATA_RELEASE_PUBLIC_ID,
  MOCK_REPACK_SEARCH_SHARD_HASH,
  MOCK_REPACK_SEARCH_INDEX_HASH,
  MOCK_PUBLIC_ASSET_ORIGINS,
  buildMockDataReleaseV2,
} from "./mockDataReleaseFixture";
import {
  buildMockRepackSearchRows,
  recomputeMockDataReleaseHashes,
} from "./mockDataReleaseSearch";
import { isValidRepackSearchRow } from "./publicRepackValidation";

const modules = import.meta.glob("./**/*.ts");
type DataReleaseTest = TestConvex<typeof schema>;

const EXPECTED_REPACK_SEARCH_ROW_KEYS = [
  "availability",
  "buybackBasisPoints",
  "buybackNullRank",
  "categoryLabels",
  "collectibleTypes",
  "contentMode",
  "name",
  "normalizedCategories",
  "normalizedName",
  "normalizedVendor",
  "packScoutConfidenceBand",
  "packScoutConfidenceBasisPoints",
  "packScoutConfidenceNullRank",
  "packScoutEvDollarsMinor",
  "packScoutEvDollarsNullRank",
  "packScoutEvPercentBasisPoints",
  "packScoutEvPercentNullRank",
  "packScoutGrossEvMinor",
  "packScoutGrossEvNullRank",
  "priceMinor",
  "priceNullRank",
  "publicCategoryIds",
  "publicRepackId",
  "publicVendorId",
  "topChaseNullRank",
  "topChaseReason",
  "topChaseValueMinor",
  "vendorDisplayName",
  "vendorKey",
  "vendorReportedEvDollarsMinor",
  "vendorReportedEvDollarsNullRank",
  "vendorReportedEvPercentBasisPoints",
  "vendorReportedEvPercentNullRank",
  "vendorReportedGrossEvMinor",
  "vendorReportedGrossEvNullRank",
] as const;

function createTest() {
  return convexTest({ schema, modules, transactionLimits: true });
}

function enableSeed(environment = "local") {
  vi.stubEnv("PACKSCOUT_RUNTIME_ENVIRONMENT", environment);
  vi.stubEnv("PACKSCOUT_MOCK_DATA_RELEASE_SEED_ENABLED", "1");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function databaseCounts(t: DataReleaseTest) {
  return await t.run(async (ctx) => ({
    states: (await ctx.db.query("dataReleaseState").take(3)).length,
    releases: (await ctx.db.query("dataReleases").take(3)).length,
    vendors: (await ctx.db.query("vendors").take(10)).length,
    categories: (await ctx.db.query("categories").take(10)).length,
    repacks: (await ctx.db.query("repacks").take(10)).length,
    collectibles: (await ctx.db.query("collectibles").take(10)).length,
    chases: (await ctx.db.query("repackChases").take(20)).length,
    shards: (await ctx.db.query("repackSearchShards").take(3)).length,
    batches: (await ctx.db.query("dataReleaseBatches").take(10)).length,
    operations: (await ctx.db.query("dataReleaseOperations").take(3)).length,
  }));
}

describe("mock V2 data release", () => {
  test("is deterministic and covers mixed content, dual EV, confidence, and shared chases", () => {
    const first = buildMockDataReleaseV2();
    expect(first).toEqual(buildMockDataReleaseV2());
    expect(first.metadata).toMatchObject({
      publicReleaseId: MOCK_DATA_RELEASE_PUBLIC_ID,
      dataSource: "mock",
      repackCount: 6,
      collectibleCount: 6,
      repackChaseCount: 9,
    });
    expect(first.repacks.some(({ contentMode }) => contentMode === "mixed")).toBe(
      true,
    );
    expect(
      first.repacks.some(
        ({ collectibleTypes }) =>
          collectibleTypes.includes("card") && collectibleTypes.includes("watch"),
      ),
    ).toBe(true);
    expect(
      new Set(
        first.repacks.flatMap(({ evEstimates }) =>
          evEstimates.packScout.status === "available"
            ? [evEstimates.packScout.confidence.band]
            : [],
        ),
      ),
    ).toEqual(new Set(["low", "medium", "high"]));
    expect(
      first.repacks.some(
        ({ evEstimates }) =>
          evEstimates.vendorReported.status === "available" &&
          evEstimates.packScout.status === "available" &&
          Math.sign(evEstimates.vendorReported.metrics.evDollars.minorUnits) !==
            Math.sign(evEstimates.packScout.metrics.evDollars.minorUnits),
      ),
    ).toBe(true);
    const sharedCollectible = first.collectibles[0]!.publicCollectibleId;
    expect(
      new Set(
        first.repackChases
          .filter(({ publicCollectibleId }) => publicCollectibleId === sharedCollectible)
          .map(({ publicRepackId }) => publicRepackId),
      ).size,
    ).toBeGreaterThan(1);
    const nba = first.categories.find(({ categoryKey }) => categoryKey === "nba");
    expect(nba).toMatchObject({
      kind: "league",
      depth: 3,
      parentPublicCategoryId: first.categories.find(
        ({ categoryKey }) => categoryKey === "basketball",
      )?.publicCategoryId,
    });
    expect(nba?.pathPublicCategoryIds).toEqual(
      first.categories
        .filter(({ categoryKey }) =>
          ["trading_cards", "sports", "basketball", "nba"].includes(
            categoryKey,
          ),
        )
        .sort((left, right) => left.depth - right.depth)
        .map(({ publicCategoryId }) => publicCategoryId),
    );
    expect(
      first.repacks
        .filter(({ name }) => name.includes("Basketball"))
        .every(({ categories }) => categories.some(({ label }) => label === "NBA")),
    ).toBe(true);
  });

  test("keeps canonical hash domains deterministic and search rows exact", async () => {
    const fixture = buildMockDataReleaseV2();
    const rows = buildMockRepackSearchRows(fixture);
    const hashes = await recomputeMockDataReleaseHashes(fixture, rows);
    expect(hashes).toEqual({
      publicConfigHash: MOCK_DATA_RELEASE_PUBLIC_CONFIG_HASH,
      originSetHash: MOCK_DATA_RELEASE_ORIGIN_SET_HASH,
      manifestFingerprint: MOCK_DATA_RELEASE_MANIFEST_FINGERPRINT,
      contentHash: MOCK_DATA_RELEASE_CONTENT_HASH,
      searchShardHash: MOCK_REPACK_SEARCH_SHARD_HASH,
      searchIndexHash: MOCK_REPACK_SEARCH_INDEX_HASH,
    });
    expect(Object.keys(rows[0]!).sort()).toEqual(EXPECTED_REPACK_SEARCH_ROW_KEYS);
    expect(
      isValidRepackSearchRow({
        ...rows[0]!,
        packScoutConfidenceBand: "low",
      }),
    ).toBe(false);
    expect(
      isValidRepackSearchRow({
        ...rows[2]!,
        publicCategoryIds: [...rows[2]!.publicCategoryIds].reverse(),
      }),
    ).toBe(false);
    await expect(
      sha256CanonicalJson("packscout.test.domain", { b: 2, a: 1 }),
    ).resolves.toBe(
      await sha256CanonicalJson("packscout.test.domain", { a: 1, b: 2 }),
    );
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  test("seeds all V2 entities once and returns unchanged on replay", async () => {
    enableSeed();
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-12T12:00:00Z");
    const t = createTest();
    await expect(t.mutation(internal.mockDataReleaseSeed.seed, {})).resolves.toEqual({
      status: "created",
      publicReleaseId: MOCK_DATA_RELEASE_PUBLIC_ID,
      repackCount: 6,
    });
    const storedManifest = await t.run(async (ctx) => {
      const release = await ctx.db.query("dataReleases").first();
      if (release === null) throw new Error("Expected the seeded data release.");
      return {
        metadata: release.metadata,
        publicAssetOrigins: [...MOCK_PUBLIC_ASSET_ORIGINS],
        vendors: (await ctx.db.query("vendors").collect()).map(
          ({ detail }) => detail,
        ),
        categories: (await ctx.db.query("categories").collect()).map(
          ({ detail }) => detail,
        ),
        repacks: (await ctx.db.query("repacks").collect()).map(
          ({ detail }) => detail,
        ),
        collectibles: (await ctx.db.query("collectibles").collect()).map(
          ({ detail }) => detail,
        ),
        repackChases: (await ctx.db.query("repackChases").collect()).map(
          ({ detail }) => detail,
        ),
      };
    });
    expect(() => parseDataReleaseManifestV2(storedManifest)).not.toThrow();
    const beforeReplay = await t.run(async (ctx) => ({
      state: (await ctx.db.query("dataReleaseState").first())!,
      release: (await ctx.db.query("dataReleases").first())!,
      vendorIds: (await ctx.db.query("vendors").collect()).map(({ _id }) => _id),
      categoryIds: (await ctx.db.query("categories").collect()).map(({ _id }) => _id),
      repackIds: (await ctx.db.query("repacks").collect()).map(({ _id }) => _id),
      collectibleIds: (await ctx.db.query("collectibles").collect()).map(
        ({ _id }) => _id,
      ),
      chaseIds: (await ctx.db.query("repackChases").collect()).map(({ _id }) => _id),
      shard: (await ctx.db.query("repackSearchShards").first())!,
      operation: (await ctx.db.query("dataReleaseOperations").first())!,
    }));
    vi.setSystemTime("2026-08-12T12:01:00Z");
    await expect(t.mutation(internal.mockDataReleaseSeed.seed, {})).resolves.toEqual({
      status: "unchanged",
      publicReleaseId: MOCK_DATA_RELEASE_PUBLIC_ID,
      repackCount: 6,
    });
    const afterReplay = await t.run(async (ctx) => ({
      state: (await ctx.db.query("dataReleaseState").first())!,
      release: (await ctx.db.query("dataReleases").first())!,
      vendorIds: (await ctx.db.query("vendors").collect()).map(({ _id }) => _id),
      categoryIds: (await ctx.db.query("categories").collect()).map(({ _id }) => _id),
      repackIds: (await ctx.db.query("repacks").collect()).map(({ _id }) => _id),
      collectibleIds: (await ctx.db.query("collectibles").collect()).map(
        ({ _id }) => _id,
      ),
      chaseIds: (await ctx.db.query("repackChases").collect()).map(({ _id }) => _id),
      shard: (await ctx.db.query("repackSearchShards").first())!,
      operation: (await ctx.db.query("dataReleaseOperations").first())!,
    }));
    const { state: beforeState, ...beforeImmutable } = beforeReplay;
    const { state: afterState, ...afterImmutable } = afterReplay;
    expect(afterImmutable).toEqual(beforeImmutable);
    expect(afterState._id).toBe(beforeState._id);
    expect(afterState.latestObservationSequence).toBe(
      beforeState.latestObservationSequence,
    );
    expect(afterState.lastSuccessfulObservationAt).toBe(
      "2026-08-12T12:01:00.000Z",
    );
    expect(afterState.staleAt).toBe("2026-08-12T12:16:00.000Z");
    await expect(databaseCounts(t)).resolves.toEqual({
      states: 1,
      releases: 1,
      vendors: 2,
      categories: 6,
      repacks: 6,
      collectibles: 6,
      chases: 9,
      shards: 1,
      batches: 6,
      operations: 1,
    });
  });

  test("refuses disabled and production seeds without writing any entity", async () => {
    const disabled = createTest();
    await expect(
      disabled.mutation(internal.mockDataReleaseSeed.seed, {}),
    ).rejects.toThrow("MOCK_SEED_DISABLED");
    await expect(databaseCounts(disabled)).resolves.toEqual({
      states: 0,
      releases: 0,
      vendors: 0,
      categories: 0,
      repacks: 0,
      collectibles: 0,
      chases: 0,
      shards: 0,
      batches: 0,
      operations: 0,
    });

    enableSeed("production");
    const production = createTest();
    await expect(
      production.mutation(internal.mockDataReleaseSeed.seed, {}),
    ).rejects.toThrow("MOCK_SEED_ENVIRONMENT_UNSAFE");
    await expect(databaseCounts(production)).resolves.toEqual({
      states: 0,
      releases: 0,
      vendors: 0,
      categories: 0,
      repacks: 0,
      collectibles: 0,
      chases: 0,
      shards: 0,
      batches: 0,
      operations: 0,
    });
  });

  test("serves dashboard/list and finds every repack for a desired chase", async () => {
    enableSeed();
    const t = createTest();
    await t.mutation(internal.mockDataReleaseSeed.seed, {});

    const dashboard = await t.query(api.publicRepacks.getDashboardBundle, {});
    expect(getDashboardBundleResultSchema.parse(dashboard).ok).toBe(true);
    if (!dashboard.ok) throw new Error("Expected dashboard success.");
    expect(dashboard.data.kpis.totalRepacks).toBe(5);
    expect(dashboard.data.selectedRepack).not.toBeNull();

    const list = await t.query(api.publicRepacks.listPublicRepacks, {
      search: "pokemon",
      pageSize: 2,
    });
    expect(listPublicRepacksResultSchema.parse(list).ok).toBe(true);
    if (!list.ok) throw new Error("Expected list success.");
    expect(list.data.rows).toHaveLength(2);
    expect(list.data.queryFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const fixture = buildMockDataReleaseV2();
    const sportsCategory = fixture.categories.find(
      ({ categoryKey }) => categoryKey === "sports",
    );
    if (sportsCategory === undefined) throw new Error("Expected Sports category.");
    const hierarchyResults = await t.query(api.publicRepacks.listPublicRepacks, {
      filters: { categories: [sportsCategory.publicCategoryId] },
    });
    expect(listPublicRepacksResultSchema.parse(hierarchyResults).ok).toBe(true);
    if (!hierarchyResults.ok) throw new Error("Expected hierarchy results.");
    expect(hierarchyResults.data.range.total).toBe(2);
    expect(
      hierarchyResults.data.rows.every(({ categories }) =>
        ["Sports", "Basketball", "NBA"].every((label) =>
          categories.some((category) => category.label === label),
        )
      ),
    ).toBe(true);

    const desiredCollectible = fixture.collectibles[0]!;
    const desiredPage = await t.query(api.publicRepacks.listPublicRepacks, {
      desiredPublicCollectibleId: desiredCollectible.publicCollectibleId,
      pageSize: 2,
    });
    expect(listPublicRepacksResultSchema.parse(desiredPage).ok).toBe(true);
    if (!desiredPage.ok) throw new Error("Expected desired page success.");
    expect(desiredPage.data.desiredCollectible?.publicCollectibleId).toBe(
      desiredCollectible.publicCollectibleId,
    );
    expect(desiredPage.data.range.total).toBeGreaterThan(2);
    expect(desiredPage.data.desiredChaseMatches).toHaveLength(
      desiredPage.data.rows.length,
    );
    expect(
      desiredPage.data.rows.map(({ publicRepackId }) => publicRepackId).sort(),
    ).toEqual(
      desiredPage.data.desiredChaseMatches
        .map(({ publicRepackId }) => publicRepackId)
        .sort(),
    );
    expect(desiredPage.data.queryFingerprint).not.toBe(
      list.data.queryFingerprint,
    );

    const desired = await t.query(
      api.publicRepacks.findRepacksByDesiredCollectible,
      { publicCollectibleId: desiredCollectible.publicCollectibleId },
    );
    expect(findRepacksByDesiredCollectibleResultSchema.parse(desired).ok).toBe(
      true,
    );
    if (!desired.ok) throw new Error("Expected desired chase success.");
    expect(desired.data.total).toBeGreaterThan(1);
    expect(
      desired.data.matches.every(
        ({ chase }) =>
          chase.publicCollectibleId === desiredCollectible.publicCollectibleId,
      ),
    ).toBe(true);

    const collectibleSearch = await t.query(
      api.publicRepacks.searchPublicCollectibles,
      { search: "charizard" },
    );
    expect(searchPublicCollectiblesResultSchema.parse(collectibleSearch).ok).toBe(
      true,
    );
    if (!collectibleSearch.ok) throw new Error("Expected search success.");
    expect(collectibleSearch.data.matches[0]?.name).toContain("Charizard");

    const aliasSearch = await t.query(api.publicRepacks.searchPublicCollectibles, {
      search: "moonbreon",
    });
    expect(searchPublicCollectiblesResultSchema.parse(aliasSearch).ok).toBe(true);
    if (!aliasSearch.ok) throw new Error("Expected alias search success.");
    expect(aliasSearch.data.matches).toHaveLength(1);
    expect(aliasSearch.data.matches[0]?.name).toContain("Umbreon");
  });

  test("fails closed when an off-page materialized repack row is tampered", async () => {
    enableSeed();
    const t = createTest();
    await t.mutation(internal.mockDataReleaseSeed.seed, {});
    await t.run(async (ctx) => {
      const shard = await ctx.db.query("repackSearchShards").first();
      const offPageIndex = (shard?.rows.length ?? 0) - 1;
      const offPageRow = shard?.rows[offPageIndex];
      if (
        shard === null ||
        offPageRow === undefined ||
        offPageRow.packScoutEvDollarsMinor === null
      ) {
        throw new Error("Expected the seeded search row.");
      }
      await ctx.db.patch("repackSearchShards", shard._id, {
        rows: shard.rows.map((row, index) =>
          index === offPageIndex
            ? {
                ...row,
                packScoutEvDollarsMinor: row.packScoutEvDollarsMinor! + 1,
              }
            : row,
        ),
      });
    });

    const result = await t.query(api.publicRepacks.getDashboardBundle, {});
    expect(getDashboardBundleResultSchema.parse(result)).toMatchObject({
      ok: false,
      code: "RELEASE_UNAVAILABLE",
    });
  });

  test("fails closed when a collectible search projection diverges from detail", async () => {
    enableSeed();
    const t = createTest();
    await t.mutation(internal.mockDataReleaseSeed.seed, {});
    await t.run(async (ctx) => {
      const collectible = await ctx.db
        .query("collectibles")
        .filter((query) => query.eq(query.field("detail.name"), "1999 Pokemon Base Set Charizard Holo PSA 10"))
        .first();
      if (collectible === null) throw new Error("Expected seeded collectible.");
      await ctx.db.patch("collectibles", collectible._id, {
        normalizedName: `${collectible.normalizedName} tampered`,
      });
    });

    const result = await t.query(api.publicRepacks.searchPublicCollectibles, {
      search: "charizard",
    });
    expect(searchPublicCollectiblesResultSchema.parse(result)).toMatchObject({
      ok: false,
      code: "RELEASE_UNAVAILABLE",
    });
  });

  test("fails closed when desired-chase display evidence diverges from collectible detail", async () => {
    enableSeed();
    const fixture = buildMockDataReleaseV2();
    const desiredCollectible = fixture.collectibles[0]!;
    const t = createTest();
    await t.mutation(internal.mockDataReleaseSeed.seed, {});
    await t.run(async (ctx) => {
      const relation = await ctx.db
        .query("repackChases")
        .filter((query) =>
          query.eq(
            query.field("detail.publicCollectibleId"),
            desiredCollectible.publicCollectibleId,
          ),
        )
        .first();
      if (relation === null) throw new Error("Expected seeded chase relation.");
      await ctx.db.patch("repackChases", relation._id, {
        detail: {
          ...relation.detail,
          collectible: {
            ...relation.detail.collectible,
            name: `${relation.detail.collectible.name} tampered`,
          },
        },
      });
    });

    const result = await t.query(api.publicRepacks.listPublicRepacks, {
      desiredPublicCollectibleId: desiredCollectible.publicCollectibleId,
    });
    expect(listPublicRepacksResultSchema.parse(result)).toMatchObject({
      ok: false,
      code: "RELEASE_UNAVAILABLE",
    });
  });
});
