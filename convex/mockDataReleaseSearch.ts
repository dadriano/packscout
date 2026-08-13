import type { DataReleaseManifestV2 } from "@packscout/contracts";
import {
  REPACK_SEARCH_INDEX_HASH_DOMAIN,
  REPACK_SEARCH_SHARD_HASH_DOMAIN,
  canonicalJson,
  sha256CanonicalJson,
} from "./dataReleaseCanonicalHash";
import {
  MOCK_DATA_RELEASE_FIXTURE_VERSION,
  buildMockDataReleaseV2,
} from "./mockDataReleaseFixture";
import {
  searchRowFromRepackDetail,
  type RepackSearchRow,
} from "./publicRepackValidation";

export const MOCK_DATA_RELEASE_HASH_DOMAINS = Object.freeze({
  publicConfig: "packscout.mock.data-release.public-config.v2",
  originSet: "packscout.mock.data-release.origin-set.v2",
  manifest: "packscout.mock.data-release.manifest.v2",
  releaseContent: "packscout.mock.data-release.content.v2",
  repackSearchShard: REPACK_SEARCH_SHARD_HASH_DOMAIN,
  repackSearchIndex: REPACK_SEARCH_INDEX_HASH_DOMAIN,
});

export function buildMockRepackSearchRows(
  manifest = buildMockDataReleaseV2(),
): RepackSearchRow[] {
  return manifest.repacks.map(searchRowFromRepackDetail);
}

export async function recomputeMockDataReleaseHashes(
  manifest: DataReleaseManifestV2 = buildMockDataReleaseV2(),
  searchRows: readonly RepackSearchRow[] = buildMockRepackSearchRows(manifest),
) {
  const publicConfig = {
    publicConfigRevision: manifest.metadata.publicConfigRevision,
    vendors: manifest.vendors,
    categories: manifest.categories,
  };
  const fingerprintBody = {
    fixtureVersion: MOCK_DATA_RELEASE_FIXTURE_VERSION,
    publicReleaseId: manifest.metadata.publicReleaseId,
    vendorIds: manifest.vendors.map(({ publicVendorId }) => publicVendorId),
    categoryIds: manifest.categories.map(
      ({ publicCategoryId }) => publicCategoryId,
    ),
    repackIds: manifest.repacks.map(({ publicRepackId }) => publicRepackId),
    collectibleIds: manifest.collectibles.map(
      ({ publicCollectibleId }) => publicCollectibleId,
    ),
  };
  const releaseContent = {
    schemaVersion: manifest.metadata.schemaVersion,
    dataSource: manifest.metadata.dataSource,
    publicAssetOrigins: manifest.publicAssetOrigins,
    vendors: manifest.vendors,
    categories: manifest.categories,
    repacks: manifest.repacks,
    collectibles: manifest.collectibles,
    repackChases: manifest.repackChases,
  };
  const searchShardHash = await sha256CanonicalJson(
    MOCK_DATA_RELEASE_HASH_DOMAINS.repackSearchShard,
    searchRows,
  );
  const searchShardByteCount = new TextEncoder().encode(
    canonicalJson(searchRows),
  ).byteLength;
  return {
    publicConfigHash: await sha256CanonicalJson(
      MOCK_DATA_RELEASE_HASH_DOMAINS.publicConfig,
      publicConfig,
    ),
    originSetHash: await sha256CanonicalJson(
      MOCK_DATA_RELEASE_HASH_DOMAINS.originSet,
      manifest.publicAssetOrigins,
    ),
    manifestFingerprint: await sha256CanonicalJson(
      MOCK_DATA_RELEASE_HASH_DOMAINS.manifest,
      fingerprintBody,
    ),
    contentHash: await sha256CanonicalJson(
      MOCK_DATA_RELEASE_HASH_DOMAINS.releaseContent,
      releaseContent,
    ),
    searchShardHash,
    searchIndexHash: await sha256CanonicalJson(
      MOCK_DATA_RELEASE_HASH_DOMAINS.repackSearchIndex,
      [{
        shardNumber: 0,
        rowCount: searchRows.length,
        byteCount: searchShardByteCount,
        contentHash: searchShardHash,
      }],
    ),
  };
}
