/// <reference types="vite/client" />

import {
  EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH,
  REPACK_SEARCH_VERSION,
  buildProviderCatalogSourceWatermarkV1,
  derivePublicProviderReleaseIdV1,
  extendProviderCatalogReleaseBatchChainV1,
  extendProviderCatalogReleaseEntityHashV1,
  getDashboardBundleResultSchema,
  initializeProviderCatalogReleaseEntityHashV1,
  listPublicRepacksResultSchema,
  providerCatalogReleaseBatchByteCount,
  recomputeProviderCatalogReleaseBatchHashV1,
  recomputeProviderCatalogReleaseContentHashV1,
  recomputeProviderCatalogReleaseFingerprintV1,
  recomputeProviderCatalogReleaseGoverningHashV1,
  recomputeProviderCatalogSearchIndexHashV1,
  searchPublicCollectiblesResultSchema,
  verifyProviderCatalogReleasePlanV1,
  type ProviderCatalogReleaseEntityHashesV1,
  type ProviderCatalogReleasePublishPlanV1,
  type PublicVendor,
} from "@packscout/contracts";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import {
  MOCK_DATA_RELEASE_CONFIDENCE_POLICY_VERSION,
  buildMockDataReleaseV2,
} from "./mockDataReleaseFixture";
import {
  buildMockProviderCatalogReleasePlans,
} from "./mockProviderCatalogFixture";
import { seedMockCatalogManifestGraph } from "./mockCatalogManifestSeed";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const EXTRA_PROVIDERS = [
  ["beezie", "10000000-0000-5000-8000-000000000003", "Beezie"],
  ["clutchpacks", "10000000-0000-5000-8000-000000000004", "Clutch Packs"],
  ["gamestop", "10000000-0000-5000-8000-000000000005", "GameStop"],
  ["phygitals", "10000000-0000-5000-8000-000000000006", "Phygitals"],
  ["stadium_vault", "10000000-0000-5000-8000-000000000007", "Stadium Vault"],
  ["trove", "10000000-0000-5000-8000-000000000008", "Trove"],
] as const;

async function vendorOnlyPlan(
  base: ProviderCatalogReleasePublishPlanV1,
  provider: (typeof EXTRA_PROVIDERS)[number],
  providerIndex: number,
): Promise<ProviderCatalogReleasePublishPlanV1> {
  const [platformKey, publicVendorId, displayName] = provider;
  const vendor: PublicVendor = {
    publicVendorId,
    vendorKey: platformKey,
    displayName,
    logoUrl: null,
    websiteUrl: `https://${platformKey.replaceAll("_", "-")}.example`,
    listingHosts: [`${platformKey.replaceAll("_", "-")}.example`],
    imageOrigins: [],
    referralParameters: [],
    publicPromo: null,
  };
  const vendorBatch = {
    kind: "vendors" as const,
    batchIndex: 0,
    batchHash: await recomputeProviderCatalogReleaseBatchHashV1({
      kind: "vendors",
      records: [vendor],
    }),
    byteCount: providerCatalogReleaseBatchByteCount([vendor]),
    records: [vendor],
  };
  const entityHashes = {
    vendors: await initializeProviderCatalogReleaseEntityHashV1("vendors"),
    categories: await initializeProviderCatalogReleaseEntityHashV1("categories"),
    collectibles:
      await initializeProviderCatalogReleaseEntityHashV1("collectibles"),
    repacks: await initializeProviderCatalogReleaseEntityHashV1("repacks"),
    repack_chases:
      await initializeProviderCatalogReleaseEntityHashV1("repack_chases"),
    search_shards:
      await initializeProviderCatalogReleaseEntityHashV1("search_shards"),
  } satisfies ProviderCatalogReleaseEntityHashesV1;
  entityHashes.vendors = await extendProviderCatalogReleaseEntityHashV1({
    previousHash: entityHashes.vendors,
    kind: "vendors",
    batchHash: vendorBatch.batchHash,
    recordCount: 1,
    byteCount: vendorBatch.byteCount,
  });
  const batchChainHash = await extendProviderCatalogReleaseBatchChainV1({
    previousHash: EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH,
    batchIndex: 0,
    kind: "vendors",
    batchHash: vendorBatch.batchHash,
    recordCount: 1,
    byteCount: vendorBatch.byteCount,
  });
  const governingHashes = {
    ...base.governingHashes,
    providerConfigurationHash:
      await recomputeProviderCatalogReleaseGoverningHashV1({
        kind: "provider_configuration",
        value: { platformKey, vendor },
      }),
  };
  const counts = {
    vendors: 1 as const,
    categories: 0,
    collectibles: 0,
    repacks: 0,
    repackChases: 0,
    searchShards: 0,
  };
  const contentHash = await recomputeProviderCatalogReleaseContentHashV1({
    entityHashes,
  });
  const providerSearchIndexHash =
    await recomputeProviderCatalogSearchIndexHashV1([]);
  const immutable = {
    platformKey,
    sharedConfigurationEpoch: base.sharedConfigurationEpoch,
    dataAsOf: base.dataAsOf,
    contentHash,
    publicAssetOrigins: base.publicAssetOrigins,
    governingHashes,
    entityHashes,
    counts,
    searchAlgorithmVersion: REPACK_SEARCH_VERSION,
    providerSearchIndexHash,
    batchCount: 1,
    batchChainHash,
  };
  const [publicProviderReleaseId, providerReleaseFingerprint] =
    await Promise.all([
      derivePublicProviderReleaseIdV1(immutable),
      recomputeProviderCatalogReleaseFingerprintV1(immutable),
    ]);
  const settledSequence = String(providerIndex + 1);
  const plan: ProviderCatalogReleasePublishPlanV1 = {
    schemaVersion: "provider_catalog_release_v1",
    classification: "publish",
    platformKey,
    sharedConfigurationEpoch: base.sharedConfigurationEpoch,
    providerCheckpoint: {
      settledSequence,
      settledAt: base.providerCheckpoint.settledAt,
    },
    sourceWatermark: buildProviderCatalogSourceWatermarkV1(
      platformKey,
      settledSequence,
    ),
    observation: {
      ...base.observation,
      sourceHeadSequence: settledSequence,
    },
    dataAsOf: base.dataAsOf,
    publicProviderReleaseId,
    providerReleaseFingerprint,
    contentHash,
    publicAssetOrigins: base.publicAssetOrigins,
    governingHashes,
    entityHashes,
    counts,
    searchAlgorithmVersion: REPACK_SEARCH_VERSION,
    providerSearchIndexHash,
    batchCount: 1,
    batchChainHash,
    batches: [vendorBatch],
  };
  const verified = await verifyProviderCatalogReleasePlanV1(plan);
  if (verified.classification !== "publish") {
    throw new Error("Expected a publishable provider fixture.");
  }
  return verified;
}

async function eightProviderPlans(): Promise<ProviderCatalogReleasePublishPlanV1[]> {
  const base = [...await buildMockProviderCatalogReleasePlans()];
  for (const [index, provider] of EXTRA_PROVIDERS.entries()) {
    base.push(await vendorOnlyPlan(base[0]!, provider, index + 2));
  }
  return base.sort((left, right) =>
    left.platformKey < right.platformKey
      ? -1
      : left.platformKey > right.platformKey
      ? 1
      : 0
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("eight-provider public catalog certification", () => {
  test("preserves dashboard, facets, sorting, details, desired matches, search, and cursors at the launch bound", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-18T12:00:00.000Z");
    vi.stubEnv("PACKSCOUT_RUNTIME_ENVIRONMENT", "local");
    const t = convexTest({ schema, modules, transactionLimits: true });
    const plans = await eightProviderPlans();
    expect(plans.map(({ platformKey }) => platformKey)).toHaveLength(8);

    const seeded = await t.run((ctx) =>
      seedMockCatalogManifestGraph(ctx, {
        plans,
        confidencePolicyVersion: MOCK_DATA_RELEASE_CONFIDENCE_POLICY_VERSION,
        serverTime: "2026-08-18T12:00:00.000Z",
      })
    );
    expect(seeded.manifest.enabledPlatformKeys).toHaveLength(8);
    expect(seeded.manifest.providerReferences).toHaveLength(8);

    const dashboard = await t.query(api.publicRepacks.getDashboardBundle, {});
    if (!dashboard.ok) {
      throw new Error(`Expected dashboard success: ${dashboard.code}`);
    }
    expect(getDashboardBundleResultSchema.parse(dashboard)).toMatchObject({
      ok: true,
      data: {
        metadata: { publicReleaseId: seeded.publicReleaseId },
        kpis: { totalRepacks: 5 },
      },
    });
    expect(dashboard.data.facets.vendors.length).toBeGreaterThan(1);
    expect(dashboard.data.selectedRepack).not.toBeNull();

    const fixture = buildMockDataReleaseV2();
    const desiredCollectible = fixture.collectibles[0]!;
    const firstPage = await t.query(api.publicRepacks.listPublicRepacks, {
      search: "pokemon",
      sort: "repack_price",
      direction: "asc",
      pageSize: 2,
      desiredPublicCollectibleId: desiredCollectible.publicCollectibleId,
    });
    expect(listPublicRepacksResultSchema.parse(firstPage).ok).toBe(true);
    if (!firstPage.ok || firstPage.data.nextCursor === null) {
      throw new Error("Expected a paginated list result.");
    }
    expect(firstPage.data.rows).toHaveLength(2);
    expect(firstPage.data.desiredChaseMatches).toHaveLength(2);

    const secondPage = await t.query(api.publicRepacks.listPublicRepacks, {
      search: "pokemon",
      sort: "repack_price",
      direction: "asc",
      pageSize: 2,
      desiredPublicCollectibleId: desiredCollectible.publicCollectibleId,
      cursor: firstPage.data.nextCursor,
      queryFingerprint: firstPage.data.queryFingerprint,
    });
    expect(listPublicRepacksResultSchema.parse(secondPage)).toMatchObject({
      ok: true,
      data: { paginationReset: null, range: { start: 3 } },
    });

    const search = await t.query(api.publicRepacks.searchPublicCollectibles, {
      search: "charizard",
    });
    expect(searchPublicCollectiblesResultSchema.parse(search)).toMatchObject({
      ok: true,
    });
    if (!search.ok) throw new Error("Expected collectible search success.");
    expect(search.data.matches[0]?.name).toContain("Charizard");

    const stored = await t.run(async (ctx) => ({
      releases: await ctx.db.query("providerCatalogReleases").collect(),
      heads: await ctx.db.query("providerCatalogCompletedHeads").collect(),
    }));
    expect(stored.releases).toHaveLength(8);
    expect(stored.heads).toHaveLength(8);
    expect(new Set(stored.releases.map(({ platformKey }) => platformKey)).size)
      .toBe(8);
  });
});
