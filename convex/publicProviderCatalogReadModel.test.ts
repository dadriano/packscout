/// <reference types="vite/client" />

import {
  buildPublicCollectibleSearchText,
  normalizePublicSearchText,
  publicCollectibleSchema,
  type ProviderCatalogReleaseBatchKindV1,
  type ProviderCatalogReleaseBatchRecordMapV1,
  type ProviderCatalogReleasePublishPlanV1,
  type PublicCollectible,
} from "@packscout/contracts";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { buildMockDataReleaseV2 } from "./mockDataReleaseFixture";
import { buildMockProviderCatalogReleasePlans } from "./mockProviderCatalogFixture";
import {
  loadProviderDesiredChases,
  loadProviderRepackDetails,
  loadPublicProviderCatalog,
  loadSharedCollectible,
  searchProviderCollectibles,
  type SelectedProviderRelease,
} from "./publicProviderCatalogReadModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type CatalogTest = TestConvex<typeof schema>;

function createTest(): CatalogTest {
  return convexTest({ schema, modules, transactionLimits: true });
}

function recordsFor<K extends ProviderCatalogReleaseBatchKindV1>(
  plan: ProviderCatalogReleasePublishPlanV1,
  kind: K,
): readonly ProviderCatalogReleaseBatchRecordMapV1[K][] {
  const result: unknown[] = [];
  for (const candidate of plan.batches) {
    if (candidate.kind === kind) {
      result.push(...(candidate.records as readonly unknown[]));
    }
  }
  return result as readonly ProviderCatalogReleaseBatchRecordMapV1[K][];
}

async function storeProviderPlan(
  ctx: MutationCtx,
  plan: ProviderCatalogReleasePublishPlanV1,
): Promise<SelectedProviderRelease> {
  const releaseId = await ctx.db.insert("providerCatalogReleases", {
    platformKey: plan.platformKey,
    publicProviderReleaseId: plan.publicProviderReleaseId,
    lifecycle: "complete",
    sharedConfigurationEpoch: plan.sharedConfigurationEpoch,
    dataAsOf: plan.dataAsOf,
    providerReleaseFingerprint: plan.providerReleaseFingerprint,
    contentHash: plan.contentHash,
    publicAssetOrigins: plan.publicAssetOrigins,
    governingHashes: plan.governingHashes,
    entityHashes: plan.entityHashes,
    counts: plan.counts,
    searchAlgorithmVersion: plan.searchAlgorithmVersion,
    providerSearchIndexHash: plan.providerSearchIndexHash,
    batchCount: plan.batchCount,
    batchChainHash: plan.batchChainHash,
    createdAt: plan.providerCheckpoint.settledAt!,
    completedAt: plan.providerCheckpoint.settledAt,
    completionOperationId: `mock:provider:${plan.platformKey}:finalize`,
    completionReceiptSha256: "a".repeat(64),
    retentionEligibleAt: "2026-08-23T12:01:00.000Z",
  });

  const vendorIdByPublicId = new Map<string, Id<"providerCatalogVendors">>();
  for (const detail of recordsFor(plan, "vendors")) {
    const vendorId = await ctx.db.insert("providerCatalogVendors", {
      releaseId,
      publicVendorId: detail.publicVendorId,
      vendorKey: detail.vendorKey,
      detail,
    });
    vendorIdByPublicId.set(detail.publicVendorId, vendorId);
  }
  const categoryIdByPublicId = new Map<string, Id<"providerCatalogCategories">>();
  for (const detail of recordsFor(plan, "categories")) {
    const parentCategoryId = detail.parentPublicCategoryId === null
      ? null
      : categoryIdByPublicId.get(detail.parentPublicCategoryId) ?? null;
    const categoryId = await ctx.db.insert("providerCatalogCategories", {
      releaseId,
      publicCategoryId: detail.publicCategoryId,
      categoryKey: detail.categoryKey,
      parentCategoryId,
      detail,
    });
    categoryIdByPublicId.set(detail.publicCategoryId, categoryId);
  }
  const collectibleIdByPublicId = new Map<
    string,
    Id<"providerCatalogCollectibles">
  >();
  for (const detail of recordsFor(plan, "collectibles")) {
    const collectibleId = await ctx.db.insert("providerCatalogCollectibles", {
      releaseId,
      publicCollectibleId: detail.publicCollectibleId,
      collectibleType: detail.collectibleType,
      normalizedName: detail.normalizedName,
      searchText: detail.searchText,
      detail,
    });
    collectibleIdByPublicId.set(detail.publicCollectibleId, collectibleId);
  }
  const repackIdByPublicId = new Map<string, Id<"providerCatalogRepacks">>();
  for (const detail of recordsFor(plan, "repacks")) {
    const vendorId = vendorIdByPublicId.get(detail.publicVendorId);
    if (vendorId === undefined) throw new Error("Mock vendor is missing.");
    const repackId = await ctx.db.insert("providerCatalogRepacks", {
      releaseId,
      publicRepackId: detail.publicRepackId,
      vendorId,
      detail,
    });
    repackIdByPublicId.set(detail.publicRepackId, repackId);
  }
  for (const detail of recordsFor(plan, "repack_chases")) {
    const repackId = repackIdByPublicId.get(detail.publicRepackId);
    const collectibleId = collectibleIdByPublicId.get(detail.publicCollectibleId);
    if (repackId === undefined || collectibleId === undefined) {
      throw new Error("Mock chase reference is missing.");
    }
    await ctx.db.insert("providerCatalogRepackChases", {
      releaseId,
      repackId,
      collectibleId,
      detail,
    });
  }
  for (const shard of recordsFor(plan, "search_shards")) {
    const fields = {
      releaseId,
      shardNumber: shard.shardNumber,
      rowCount: shard.rowCount,
      byteCount: shard.byteCount,
      contentHash: shard.contentHash,
    };
    await ctx.db.insert("providerCatalogSearchShards", {
      ...fields,
      rows: shard.rows,
    });
    await ctx.db.insert("providerCatalogSearchShardProofs", fields);
  }
  const release = await ctx.db.get("providerCatalogReleases", releaseId);
  if (release === null) throw new Error("Mock provider release is missing.");
  return { platformKey: plan.platformKey, release };
}

async function seedProviders(t: CatalogTest) {
  const plans = await buildMockProviderCatalogReleasePlans();
  return await t.run(async (ctx) => {
    const providers: SelectedProviderRelease[] = [];
    for (const plan of plans) providers.push(await storeProviderPlan(ctx, plan));
    return providers;
  });
}

const expectedCounts = {
  vendorCount: 2,
  categoryCount: 6,
  repackCount: 6,
} as const;

describe("public provider catalog composition", () => {
  test("composes provider rows, shared references, details, and desired chases", async () => {
    const t = createTest();
    const providers = await seedProviders(t);
    const fixture = buildMockDataReleaseV2();
    const charizard = fixture.collectibles[0]!;

    const result = await t.run(async (ctx) => {
      const catalog = await loadPublicProviderCatalog(
        ctx,
        providers,
        expectedCounts,
      );
      if (catalog === null) return null;
      const details = await loadProviderRepackDetails(
        ctx,
        catalog,
        catalog.rows,
      );
      const collectible = await loadSharedCollectible(
        ctx,
        catalog,
        charizard.publicCollectibleId,
      );
      const chases = collectible.status !== "found"
        ? null
        : await loadProviderDesiredChases(
            ctx,
            catalog,
            collectible.collectible,
          );
      const search = await searchProviderCollectibles(ctx, catalog, {
        search: "charizard",
        collectibleTypes: [],
        candidateLimit: 20,
      });
      return {
        rowIds: catalog.rows.map(({ publicRepackId }) => publicRepackId),
        detailIds: details?.map(({ publicRepackId }) => publicRepackId) ?? null,
        categoryCount: catalog.categoryByPublicId.size,
        collectibleOccurrences: collectible.status === "found"
          ? collectible.collectible.occurrences.length
          : null,
        chaseCount: chases?.size ?? null,
        searchIds: search?.map(({ publicCollectibleId }) => publicCollectibleId) ?? null,
      };
    });

    expect(result).not.toBeNull();
    expect(result?.rowIds).toEqual(
      [...result!.rowIds].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0
      ),
    );
    expect(result?.detailIds).toEqual(result?.rowIds);
    expect(result?.categoryCount).toBe(6);
    expect(result?.collectibleOccurrences).toBe(2);
    expect(result?.chaseCount).toBe(4);
    expect(result?.searchIds).toEqual([charizard.publicCollectibleId]);
  });

  test("fails closed on conflicting shared bytes and tampered search proof", async () => {
    const t = createTest();
    const providers = await seedProviders(t);
    await t.run(async (ctx) => {
      const duplicateCategories = await Promise.all(
        providers.map(({ release }) =>
          ctx.db
            .query("providerCatalogCategories")
            .withIndex("by_release_id_and_public_category_id", (index) =>
              index.eq("releaseId", release._id),
            )
            .first(),
        ),
      );
      const shared = duplicateCategories.find(
        (candidate) =>
          candidate !== null &&
          duplicateCategories.filter(
            (other) => other?.publicCategoryId === candidate.publicCategoryId,
          ).length > 1,
      );
      if (shared === undefined || shared === null) {
        throw new Error("Expected a shared category.");
      }
      const conflicting = duplicateCategories.find(
        (candidate) =>
          candidate !== null &&
          candidate._id !== shared._id &&
          candidate.publicCategoryId === shared.publicCategoryId,
      );
      if (conflicting === undefined || conflicting === null) {
        throw new Error("Expected the second shared category.");
      }
      await ctx.db.patch("providerCatalogCategories", conflicting._id, {
        detail: { ...conflicting.detail, name: `${conflicting.detail.name} conflict` },
      });
    });
    await expect(
      t.run((ctx) => loadPublicProviderCatalog(ctx, providers, expectedCounts)),
    ).resolves.toBeNull();

    const searchTamper = createTest();
    const searchProviders = await seedProviders(searchTamper);
    await searchTamper.run(async (ctx) => {
      const shard = await ctx.db.query("providerCatalogSearchShards").first();
      const row = shard?.rows[0];
      if (shard === null || row === undefined) throw new Error("Expected shard.");
      await ctx.db.patch("providerCatalogSearchShards", shard._id, {
        rows: [{ ...row, name: `${row.name} tampered` }, ...shard.rows.slice(1)],
      });
    });
    await expect(
      searchTamper.run((ctx) =>
        loadPublicProviderCatalog(ctx, searchProviders, expectedCounts),
      ),
    ).resolves.toBeNull();
  });

  test("rejects a ninth selected provider and conflicting shared collectible bytes", async () => {
    const t = createTest();
    const providers = await seedProviders(t);
    await expect(
      t.run((ctx) =>
        loadPublicProviderCatalog(
          ctx,
          Array.from({ length: 9 }, (_, index) => ({
            platformKey: `provider_${index}`,
            release: providers[0]!.release,
          })),
          expectedCounts,
        ),
      ),
    ).resolves.toBeNull();

    const charizardId = buildMockDataReleaseV2().collectibles[0]!
      .publicCollectibleId;
    await t.run(async (ctx) => {
      const duplicates = await Promise.all(
        providers.map(({ release }) =>
          ctx.db
            .query("providerCatalogCollectibles")
            .withIndex("by_release_id_and_public_collectible_id", (index) =>
              index
                .eq("releaseId", release._id)
                .eq("publicCollectibleId", charizardId),
            )
            .unique(),
        ),
      );
      const conflicting = duplicates[1];
      const comparison = conflicting?.detail.valuation?.usdComparison;
      if (
        conflicting === null ||
        conflicting === undefined ||
        conflicting.detail.valuation === null ||
        comparison?.status !== "available"
      ) {
        throw new Error("Expected a duplicated valued collectible.");
      }
      const minorUnits = comparison.value.minorUnits + 1;
      await ctx.db.patch("providerCatalogCollectibles", conflicting._id, {
        detail: {
          ...conflicting.detail,
          valuation: {
            ...conflicting.detail.valuation,
            displayMoney: { minorUnits, currency: "USD" },
            usdComparison: {
              status: "available",
              value: { minorUnits, currency: "USD" },
            },
          },
        },
      });
    });
    const conflict = await t.run(async (ctx) => {
      const catalog = await loadPublicProviderCatalog(
        ctx,
        providers,
        expectedCounts,
      );
      return catalog === null
        ? "catalog_invalid"
        : await searchProviderCollectibles(ctx, catalog, {
            search: "charizard",
            collectibleTypes: [],
            candidateLimit: 20,
          });
    });
    expect(conflict).toBeNull();
  });

  test("filters collectible full-text search by each selected release before bounding", async () => {
    const t = createTest();
    const plans = await buildMockProviderCatalogReleasePlans();
    const fixture = buildMockDataReleaseV2();
    const charizard = fixture.collectibles[0]!;
    const result = await t.run(async (ctx) => {
      const historicalReleaseId = await ctx.db.insert("providerCatalogReleases", {
        platformKey: "historical",
        publicProviderReleaseId: "50000000-0000-5000-8000-000000000999",
        lifecycle: "complete",
        sharedConfigurationEpoch: plans[0]!.sharedConfigurationEpoch,
        dataAsOf: plans[0]!.dataAsOf,
        providerReleaseFingerprint: "b".repeat(64),
        contentHash: "c".repeat(64),
        publicAssetOrigins: [],
        governingHashes: plans[0]!.governingHashes,
        entityHashes: plans[0]!.entityHashes,
        counts: plans[0]!.counts,
        searchAlgorithmVersion: plans[0]!.searchAlgorithmVersion,
        providerSearchIndexHash: plans[0]!.providerSearchIndexHash,
        batchCount: plans[0]!.batchCount,
        batchChainHash: plans[0]!.batchChainHash,
        createdAt: plans[0]!.providerCheckpoint.settledAt!,
        completedAt: plans[0]!.providerCheckpoint.settledAt,
        completionOperationId: "historical:finalize",
        completionReceiptSha256: "d".repeat(64),
        retentionEligibleAt: "2026-08-23T12:01:00.000Z",
      });
      const historical: PublicCollectible = publicCollectibleSchema.parse({
        ...charizard,
        publicCollectibleId: "50000000-0000-5000-8000-000000000000",
        name: "Charizard",
        normalizedName: normalizePublicSearchText("Charizard"),
        aliases: [],
        normalizedAliases: [],
        year: null,
        brand: null,
        setOrSeries: null,
        cardNumber: null,
        subject: null,
        grade: null,
        grader: null,
        valuation: null,
        searchText: "charizard",
      });
      for (let index = 0; index < 100; index += 1) {
        const publicCollectibleId =
          `50000000-0000-5000-8000-${String(index).padStart(12, "0")}`;
        const detail = { ...historical, publicCollectibleId };
        await ctx.db.insert("providerCatalogCollectibles", {
          releaseId: historicalReleaseId,
          publicCollectibleId,
          collectibleType: detail.collectibleType,
          normalizedName: detail.normalizedName,
          searchText: detail.searchText,
          detail,
        });
      }
      const providers: SelectedProviderRelease[] = [];
      for (const plan of plans) providers.push(await storeProviderPlan(ctx, plan));
      const catalog = await loadPublicProviderCatalog(
        ctx,
        providers,
        expectedCounts,
      );
      if (catalog === null) return null;
      const unfiltered = await ctx.db
        .query("providerCatalogCollectibles")
        .withSearchIndex("search_search_text", (search) =>
          search.search("searchText", "charizard"),
        )
        .take(100);
      const filtered = await searchProviderCollectibles(ctx, catalog, {
        search: "charizard",
        collectibleTypes: [],
        candidateLimit: 100,
      });
      return {
        unfilteredHasActive: unfiltered.some(
          ({ publicCollectibleId }) =>
            publicCollectibleId === charizard.publicCollectibleId,
        ),
        filteredIds: filtered?.map(({ publicCollectibleId }) =>
          publicCollectibleId,
        ) ?? null,
      };
    });
    expect(result?.unfilteredHasActive).toBe(false);
    expect(result?.filteredIds).toContain(charizard.publicCollectibleId);
  });

  test("filters requested collectible types in each release index before bounding", async () => {
    const t = createTest();
    const providers = await seedProviders(t);
    const fixture = buildMockDataReleaseV2();
    const card = fixture.collectibles.find(
      ({ collectibleType }) => collectibleType === "card",
    );
    const watch = fixture.collectibles.find(
      ({ collectibleType }) => collectibleType === "watch",
    );
    if (card === undefined || watch === undefined) {
      throw new Error("Expected card and watch fixtures.");
    }

    const result = await t.run(async (ctx) => {
      const release = providers[0]!.release;
      const catalog = await loadPublicProviderCatalog(
        ctx,
        providers,
        expectedCounts,
      );
      if (catalog === null) return null;
      for (let index = 0; index < 30; index += 1) {
        const name = `Omega card ${String(index).padStart(2, "0")}`;
        const identity = {
          ...card,
          publicCollectibleId:
            `60000000-0000-5000-8000-${String(index).padStart(12, "0")}`,
          name,
          normalizedName: normalizePublicSearchText(name),
          aliases: [],
          normalizedAliases: [],
        };
        const detail = publicCollectibleSchema.parse({
          ...identity,
          searchText: buildPublicCollectibleSearchText(identity),
        });
        await ctx.db.insert("providerCatalogCollectibles", {
          releaseId: release._id,
          publicCollectibleId: detail.publicCollectibleId,
          collectibleType: detail.collectibleType,
          normalizedName: detail.normalizedName,
          searchText: detail.searchText,
          detail,
        });
      }
      const targetName = "Omega hidden watch";
      const targetIdentity = {
        ...watch,
        publicCollectibleId: "60000000-0000-5000-8000-999999999999",
        name: targetName,
        normalizedName: normalizePublicSearchText(targetName),
        aliases: [],
        normalizedAliases: [],
      };
      const target = publicCollectibleSchema.parse({
        ...targetIdentity,
        searchText: buildPublicCollectibleSearchText(targetIdentity),
      });
      await ctx.db.insert("providerCatalogCollectibles", {
        releaseId: release._id,
        publicCollectibleId: target.publicCollectibleId,
        collectibleType: target.collectibleType,
        normalizedName: target.normalizedName,
        searchText: target.searchText,
        detail: target,
      });

      const unfiltered = await ctx.db
        .query("providerCatalogCollectibles")
        .withSearchIndex("search_search_text", (search) =>
          search
            .search("searchText", "omega")
            .eq("releaseId", release._id),
        )
        .take(20);
      const filtered = await searchProviderCollectibles(ctx, catalog, {
        search: "omega",
        collectibleTypes: ["watch"],
        candidateLimit: 20,
      });
      return {
        targetId: target.publicCollectibleId,
        unfilteredIds: unfiltered.map(({ publicCollectibleId }) =>
          publicCollectibleId,
        ),
        filteredIds: filtered?.map(({ publicCollectibleId }) =>
          publicCollectibleId,
        ) ?? null,
      };
    });
    expect(result?.unfilteredIds).not.toContain(result?.targetId);
    expect(result?.filteredIds).toContain(result?.targetId);
  });

  test("stores and searches art as a first-class collectible type", async () => {
    const t = createTest();
    const providers = await seedProviders(t);
    const fixture = buildMockDataReleaseV2();
    const collectible = fixture.collectibles[0];
    if (collectible === undefined) {
      throw new Error("Expected a collectible fixture.");
    }

    const result = await t.run(async (ctx) => {
      const release = providers[0]!.release;
      const catalog = await loadPublicProviderCatalog(
        ctx,
        providers,
        expectedCounts,
      );
      if (catalog === null) return null;
      const name = "Packscout gallery study";
      const identity = {
        ...collectible,
        publicCollectibleId: "70000000-0000-5000-8000-000000000001",
        name,
        normalizedName: normalizePublicSearchText(name),
        aliases: [],
        normalizedAliases: [],
        collectibleType: "art" as const,
      };
      const detail = publicCollectibleSchema.parse({
        ...identity,
        searchText: buildPublicCollectibleSearchText(identity),
      });
      await ctx.db.insert("providerCatalogCollectibles", {
        releaseId: release._id,
        publicCollectibleId: detail.publicCollectibleId,
        collectibleType: detail.collectibleType,
        normalizedName: detail.normalizedName,
        searchText: detail.searchText,
        detail,
      });

      const matches = await searchProviderCollectibles(ctx, catalog, {
        search: "gallery",
        collectibleTypes: ["art"],
        candidateLimit: 20,
      });
      return matches?.map(({ publicCollectibleId, collectibleType }) => ({
        publicCollectibleId,
        collectibleType,
      })) ?? null;
    });

    expect(result).toEqual([
      {
        publicCollectibleId: "70000000-0000-5000-8000-000000000001",
        collectibleType: "art",
      },
    ]);
  });
});
