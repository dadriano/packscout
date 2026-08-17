import {
  EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH,
  PROVIDER_CATALOG_RELEASE_BATCH_KINDS,
  REPACK_SEARCH_VERSION,
  buildProviderCatalogSourceWatermarkV1,
  derivePublicProviderReleaseIdV1,
  extendProviderCatalogReleaseBatchChainV1,
  extendProviderCatalogReleaseEntityHashV1,
  initializeProviderCatalogReleaseEntityHashV1,
  providerCatalogReleaseBatchByteCount,
  recomputeProviderCatalogReleaseBatchHashV1,
  recomputeProviderCatalogReleaseContentHashV1,
  recomputeProviderCatalogReleaseFingerprintV1,
  recomputeProviderCatalogReleaseGoverningHashV1,
  recomputeProviderCatalogReleaseOriginSetHashV1,
  recomputeProviderCatalogSearchIndexHashV1,
  recomputeProviderCatalogSearchShardHashV1,
  verifyProviderCatalogReleasePlanV1,
  type ProviderCatalogReleaseBatchKindV1,
  type ProviderCatalogReleaseBatchV1,
  type ProviderCatalogReleaseEntityHashesV1,
  type ProviderCatalogReleasePublishPlanV1,
  type ProviderCatalogReleaseSearchShardV1,
  type PublicCategory,
} from "@packscout/contracts";
import {
  MOCK_DATA_RELEASE_CONFIDENCE_POLICY_VERSION,
  MOCK_DATA_RELEASE_PUBLIC_CONFIG_HASH,
  buildMockDataReleaseV2,
} from "./mockDataReleaseFixture";
import { buildMockRepackSearchRows } from "./mockDataReleaseSearch";

export const MOCK_PROVIDER_PLATFORM_KEYS = [
  "collector_crypt",
  "courtyard",
] as const;

export const MOCK_PROVIDER_SHARED_CONFIGURATION_EPOCH = Object.freeze({
  configurationKey: "packscout-mock-public-catalog-v1",
  revision: 1,
  publicChangeSequence: "1",
  configurationHash: MOCK_DATA_RELEASE_PUBLIC_CONFIG_HASH,
});

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function categoryClosure(
  categories: readonly PublicCategory[],
  referencedIds: ReadonlySet<string>,
): PublicCategory[] {
  const byId = new Map(
    categories.map((category) => [category.publicCategoryId, category]),
  );
  const selected = new Set(referencedIds);
  for (const categoryId of [...selected]) {
    let category = byId.get(categoryId);
    while (category !== undefined && category.parentPublicCategoryId !== null) {
      const parentId = category.parentPublicCategoryId;
      selected.add(parentId);
      category = byId.get(parentId);
    }
  }
  return categories
    .filter(({ publicCategoryId }) => selected.has(publicCategoryId))
    .sort(
      (left, right) =>
        left.depth - right.depth ||
        compareText(left.publicCategoryId, right.publicCategoryId),
    );
}

async function batch(
  kind: ProviderCatalogReleaseBatchKindV1,
  records: readonly unknown[],
  batchIndex: number,
): Promise<ProviderCatalogReleaseBatchV1> {
  const base = {
    kind,
    batchIndex,
    batchHash: await recomputeProviderCatalogReleaseBatchHashV1({
      kind,
      records,
    }),
    byteCount: providerCatalogReleaseBatchByteCount(records),
    records,
  };
  return base as ProviderCatalogReleaseBatchV1;
}

export async function buildMockProviderCatalogReleasePlans(input: {
  readonly observedAt?: string;
  readonly staleAt?: string;
} = {}): Promise<readonly ProviderCatalogReleasePublishPlanV1[]> {
  const fixture = buildMockDataReleaseV2();
  const allRows = buildMockRepackSearchRows(fixture);
  const observedAt = input.observedAt ?? fixture.metadata.lastSuccessfulObservationAt;
  const staleAt = input.staleAt ?? fixture.metadata.staleAt;
  const plans: ProviderCatalogReleasePublishPlanV1[] = [];

  for (const [providerIndex, platformKey] of MOCK_PROVIDER_PLATFORM_KEYS.entries()) {
    const vendor = fixture.vendors.find(({ vendorKey }) => vendorKey === platformKey);
    if (vendor === undefined) throw new Error("Mock provider vendor is missing.");
    const repacks = fixture.repacks
      .filter(({ publicVendorId }) => publicVendorId === vendor.publicVendorId)
      .sort((left, right) => compareText(left.publicRepackId, right.publicRepackId));
    const repackIds = new Set(repacks.map(({ publicRepackId }) => publicRepackId));
    const repackChases = fixture.repackChases
      .filter(({ publicRepackId }) => repackIds.has(publicRepackId))
      .sort(
        (left, right) =>
          compareText(left.publicRepackId, right.publicRepackId) ||
          left.displayOrder - right.displayOrder ||
          compareText(left.publicCollectibleId, right.publicCollectibleId),
      );
    const collectibleIds = new Set(
      repackChases.map(({ publicCollectibleId }) => publicCollectibleId),
    );
    const collectibles = fixture.collectibles
      .filter(({ publicCollectibleId }) => collectibleIds.has(publicCollectibleId))
      .sort((left, right) =>
        compareText(left.publicCollectibleId, right.publicCollectibleId),
      );
    const referencedCategoryIds = new Set([
      ...repacks.flatMap(({ categories }) =>
        categories.map(({ publicCategoryId }) => publicCategoryId),
      ),
      ...collectibles.flatMap(({ publicCategoryIds }) => publicCategoryIds),
    ]);
    const categories = categoryClosure(
      fixture.categories,
      referencedCategoryIds,
    );
    const rows = allRows.filter(({ publicRepackId }) =>
      repackIds.has(publicRepackId),
    );
    const searchShard: ProviderCatalogReleaseSearchShardV1 = {
      shardNumber: 0,
      rowCount: rows.length,
      byteCount: providerCatalogReleaseBatchByteCount(rows),
      contentHash: await recomputeProviderCatalogSearchShardHashV1(rows),
      rows,
    };
    const records = {
      vendors: [vendor],
      categories,
      collectibles,
      repacks,
      repack_chases: repackChases,
      search_shards: [searchShard],
    } as const;
    const batches: ProviderCatalogReleaseBatchV1[] = [];
    for (const [batchIndex, kind] of PROVIDER_CATALOG_RELEASE_BATCH_KINDS.entries()) {
      batches.push(await batch(kind, records[kind], batchIndex));
    }

    const entityHashes = {} as Record<
      ProviderCatalogReleaseBatchKindV1,
      string
    >;
    for (const kind of PROVIDER_CATALOG_RELEASE_BATCH_KINDS) {
      entityHashes[kind] = await initializeProviderCatalogReleaseEntityHashV1(kind);
    }
    let batchChainHash = EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH;
    for (const accepted of batches) {
      batchChainHash = await extendProviderCatalogReleaseBatchChainV1({
        previousHash: batchChainHash,
        batchIndex: accepted.batchIndex,
        kind: accepted.kind,
        batchHash: accepted.batchHash,
        recordCount: accepted.records.length,
        byteCount: accepted.byteCount,
      });
      entityHashes[accepted.kind] = await extendProviderCatalogReleaseEntityHashV1({
        previousHash: entityHashes[accepted.kind],
        kind: accepted.kind,
        batchHash: accepted.batchHash,
        recordCount: accepted.records.length,
        byteCount: accepted.byteCount,
      });
    }

    const publicAssetOrigins: string[] = [];
    const governingHashes = {
      providerConfigurationHash:
        await recomputeProviderCatalogReleaseGoverningHashV1({
          kind: "provider_configuration",
          value: { platformKey, vendor },
        }),
      sharedCategoriesHash:
        await recomputeProviderCatalogReleaseGoverningHashV1({
          kind: "shared_categories",
          value: fixture.categories,
        }),
      identityMappingsHash:
        await recomputeProviderCatalogReleaseGoverningHashV1({
          kind: "identity_mappings",
          value: {
            collectibles: fixture.collectibles.map(({ publicCollectibleId }) =>
              publicCollectibleId,
            ),
            repacks: fixture.repacks.map(({ publicRepackId }) => publicRepackId),
          },
        }),
      originSetHash:
        await recomputeProviderCatalogReleaseOriginSetHashV1(publicAssetOrigins),
      confidencePolicyHash:
        await recomputeProviderCatalogReleaseGoverningHashV1({
          kind: "confidence_policy",
          value: MOCK_DATA_RELEASE_CONFIDENCE_POLICY_VERSION,
        }),
    };
    const counts = {
      vendors: 1 as const,
      categories: categories.length,
      collectibles: collectibles.length,
      repacks: repacks.length,
      repackChases: repackChases.length,
      searchShards: 1,
    };
    const immutable = {
      platformKey,
      sharedConfigurationEpoch: MOCK_PROVIDER_SHARED_CONFIGURATION_EPOCH,
      dataAsOf: fixture.metadata.dataAsOf,
      contentHash: await recomputeProviderCatalogReleaseContentHashV1({
        entityHashes: entityHashes as ProviderCatalogReleaseEntityHashesV1,
      }),
      publicAssetOrigins,
      governingHashes,
      entityHashes: entityHashes as ProviderCatalogReleaseEntityHashesV1,
      counts,
      searchAlgorithmVersion: REPACK_SEARCH_VERSION,
      providerSearchIndexHash:
        await recomputeProviderCatalogSearchIndexHashV1([searchShard]),
      batchCount: batches.length,
      batchChainHash,
    };
    const providerReleaseFingerprint =
      await recomputeProviderCatalogReleaseFingerprintV1(immutable);
    const publicProviderReleaseId =
      await derivePublicProviderReleaseIdV1(immutable);
    const settledSequence = String(providerIndex + 1);
    const plan: ProviderCatalogReleasePublishPlanV1 = {
      schemaVersion: "provider_catalog_release_v1",
      classification: "publish",
      platformKey,
      sharedConfigurationEpoch: MOCK_PROVIDER_SHARED_CONFIGURATION_EPOCH,
      providerCheckpoint: {
        settledSequence,
        settledAt: fixture.metadata.completedAt,
      },
      sourceWatermark: buildProviderCatalogSourceWatermarkV1(
        platformKey,
        settledSequence,
      ),
      observation: {
        sourceHeadSequence: settledSequence,
        lastSuccessfulObservationAt: observedAt,
        staleAt,
        freshness: "fresh",
      },
      dataAsOf: fixture.metadata.dataAsOf,
      publicProviderReleaseId,
      providerReleaseFingerprint,
      contentHash: immutable.contentHash,
      publicAssetOrigins,
      governingHashes,
      entityHashes: immutable.entityHashes,
      counts,
      searchAlgorithmVersion: REPACK_SEARCH_VERSION,
      providerSearchIndexHash: immutable.providerSearchIndexHash,
      batchCount: batches.length,
      batchChainHash,
      batches,
    };
    const verified = await verifyProviderCatalogReleasePlanV1(plan);
    if (verified.classification !== "publish") {
      throw new Error("Mock provider plan did not verify as publishable.");
    }
    plans.push(verified);
  }
  return plans;
}
