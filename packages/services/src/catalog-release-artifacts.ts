import {
  DATA_RELEASE_SCHEMA_VERSION,
  EMPTY_BATCH_CHAIN_HASH,
  MAX_PRODUCTION_BATCH_BYTES,
  MAX_PRODUCTION_BATCH_RECORDS,
  MAX_ROWS_PER_REPACK_SEARCH_SHARD,
  PRODUCTION_BATCH_KINDS,
  REPACK_SEARCH_INDEX_HASH_DOMAIN,
  REPACK_SEARCH_SHARD_HASH_DOMAIN,
  REPACK_SEARCH_VERSION,
  canonicalJson,
  containsProtectedPublicationField,
  dataReleaseManifestV2Schema,
  extendProductionBatchChain,
  productionBatchByteCount,
  recomputeProductionBatchHash,
  recomputeProductionManifestFingerprint,
  recomputeProductionOriginSetHash,
  repackSearchRowFromDetail,
  sha256CanonicalJson,
  type ApprovedPublicCatalogConfigurationV1,
  type DataReleaseManifestV2,
  type ProductionBatchKind,
  type ProductionBatchRecordMap,
  type ProductionReleaseCounts,
  type ProductionSearchShard,
  type ProductionStartManifest,
} from "@packscout/contracts";
import type {
  CatalogReleasePlanBatch,
  CatalogReleasePublishPlan,
} from "./catalog-release-types.ts";

const RELEASE_CONTENT_HASH_DOMAIN = "packscout.data-release.content.v2";
const ENTITY_SET_HASH_DOMAIN = "packscout.data-release.entity-set.v2";
const RELEASE_ID_NAMESPACE = "caad5ee5-c9c0-5b1f-b66a-670f7e051bdb";

function uuidBytes(value: string): Uint8Array {
  const compact = value.replaceAll("-", "");
  return Uint8Array.from(compact.match(/.{2}/gu)!.map((pair) => parseInt(pair, 16)));
}

async function uuidV5(namespace: string, name: string): Promise<string> {
  const nameBytes = new TextEncoder().encode(name);
  const source = new Uint8Array(16 + nameBytes.length);
  source.set(uuidBytes(namespace));
  source.set(nameBytes, 16);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", source));
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function batchOrder<K extends ProductionBatchKind>(
  kind: K,
  records: readonly ProductionBatchRecordMap[K][],
): readonly ProductionBatchRecordMap[K][] {
  const copy = [...records];
  if (kind === "categories") {
    return copy.sort((left, right) => {
      const l = left as ProductionBatchRecordMap["categories"];
      const r = right as ProductionBatchRecordMap["categories"];
      return l.depth - r.depth || l.publicCategoryId.localeCompare(r.publicCategoryId);
    });
  }
  return copy;
}

function partition<K extends ProductionBatchKind>(
  kind: K,
  records: readonly ProductionBatchRecordMap[K][],
): Array<readonly ProductionBatchRecordMap[K][]> {
  const result: Array<readonly ProductionBatchRecordMap[K][]> = [];
  let current: ProductionBatchRecordMap[K][] = [];
  for (const record of batchOrder(kind, records)) {
    const candidate = [...current, record];
    const candidateBytes = productionBatchByteCount(candidate);
    if (current.length > 0 &&
        (candidate.length > MAX_PRODUCTION_BATCH_RECORDS || candidateBytes > MAX_PRODUCTION_BATCH_BYTES)) {
      result.push(current);
      current = [record];
    } else {
      current = candidate;
    }
    if (productionBatchByteCount(current) > MAX_PRODUCTION_BATCH_BYTES) {
      throw new RangeError("PUBLICATION_BATCH_TOO_LARGE");
    }
  }
  if (current.length > 0) result.push(current);
  return result;
}

async function searchShards(
  repacks: readonly DataReleaseManifestV2["repacks"][number][],
): Promise<{ shards: ProductionSearchShard[]; indexHash: string }> {
  const rows = repacks.map(repackSearchRowFromDetail);
  const shards: ProductionSearchShard[] = [];
  let shardRows: typeof rows = [];
  const appendShard = async () => {
    const byteCount = productionBatchByteCount(shardRows);
    shards.push({
      shardNumber: shards.length,
      rowCount: shardRows.length,
      byteCount,
      contentHash: await sha256CanonicalJson(REPACK_SEARCH_SHARD_HASH_DOMAIN, shardRows),
      rows: shardRows,
    });
    shardRows = [];
  };
  for (const row of rows) {
    const candidate = [...shardRows, row];
    if (shardRows.length > 0 &&
        (candidate.length > MAX_ROWS_PER_REPACK_SEARCH_SHARD ||
          productionBatchByteCount(candidate) > MAX_PRODUCTION_BATCH_BYTES)) {
      await appendShard();
    }
    shardRows.push(row);
    if (productionBatchByteCount(shardRows) > MAX_PRODUCTION_BATCH_BYTES) {
      throw new RangeError("PUBLICATION_BATCH_TOO_LARGE");
    }
  }
  if (shardRows.length > 0) await appendShard();
  const descriptors = shards.map((shard) => ({
    shardNumber: shard.shardNumber,
    rowCount: shard.rowCount,
    byteCount: shard.byteCount,
    contentHash: shard.contentHash,
  }));
  return {
    shards,
    indexHash: await sha256CanonicalJson(REPACK_SEARCH_INDEX_HASH_DOMAIN, descriptors),
  };
}

export async function buildCatalogReleasePublishPlan(input: {
  requestedWatermark: bigint;
  observationSequence: number;
  expectedPredecessorPublicReleaseId: string | null;
  configuration: ApprovedPublicCatalogConfigurationV1;
  configurationHash: string;
  vendors: readonly DataReleaseManifestV2["vendors"][number][];
  categories: readonly DataReleaseManifestV2["categories"][number][];
  collectibles: readonly DataReleaseManifestV2["collectibles"][number][];
  repacks: readonly DataReleaseManifestV2["repacks"][number][];
  repackChases: readonly DataReleaseManifestV2["repackChases"][number][];
  dataAsOf: Date;
  settledAt: Date;
  delayedVendorCount: number;
}): Promise<CatalogReleasePublishPlan> {
  const search = await searchShards(input.repacks);
  const records: { [K in ProductionBatchKind]: readonly ProductionBatchRecordMap[K][] } = {
    vendors: input.vendors,
    categories: input.categories,
    collectibles: input.collectibles,
    repacks: input.repacks,
    repack_chases: input.repackChases,
    search_shards: search.shards,
  };
  const contentHash = await sha256CanonicalJson(RELEASE_CONTENT_HASH_DOMAIN, {
    schemaVersion: DATA_RELEASE_SCHEMA_VERSION,
    publicConfigHash: input.configurationHash,
    searchAlgorithmVersion: REPACK_SEARCH_VERSION,
    repackSearchIndexHash: search.indexHash,
    publicAssetOrigins: input.configuration.publicAssetOrigins,
    vendors: input.vendors,
    categories: input.categories,
    collectibles: input.collectibles,
    repacks: input.repacks,
    repackChases: input.repackChases,
  });
  const publicReleaseId = await uuidV5(RELEASE_ID_NAMESPACE, canonicalJson({
    contentHash,
    requestedWatermark: String(input.requestedWatermark),
    publicConfigHash: input.configurationHash,
  }));
  const batches: CatalogReleasePlanBatch[] = [];
  const entityHashes = {} as Record<ProductionBatchKind, string>;
  let batchChainHash = EMPTY_BATCH_CHAIN_HASH;
  for (const kind of PRODUCTION_BATCH_KINDS) {
    const kindRecords = records[kind];
    entityHashes[kind] = await sha256CanonicalJson(ENTITY_SET_HASH_DOMAIN, {
      kind,
      records: kindRecords,
    });
    for (const part of partition(kind, kindRecords)) {
      const batchHash = await recomputeProductionBatchHash({ kind, records: part });
      const byteCount = productionBatchByteCount(part);
      const batchIndex = batches.length;
      batchChainHash = await extendProductionBatchChain({
        previousHash: batchChainHash,
        batchIndex,
        kind,
        batchHash,
        recordCount: part.length,
        byteCount,
      });
      batches.push({ batchIndex, kind, batchHash, byteCount, records: part });
    }
  }
  const counts: ProductionReleaseCounts = {
    vendors: input.vendors.length,
    categories: input.categories.length,
    collectibles: input.collectibles.length,
    repacks: input.repacks.length,
    repackChases: input.repackChases.length,
    searchShards: search.shards.length,
  };
  const timestamp = input.settledAt.toISOString();
  const dataAsOf = input.dataAsOf.toISOString();
  const staleAt = new Date(
    input.settledAt.getTime() + input.configuration.staleAfterSeconds * 1_000,
  ).toISOString();
  let startManifest: ProductionStartManifest = {
    publicReleaseId,
    sourceWatermark: `public-change:${input.requestedWatermark}`,
    observationSequence: input.observationSequence,
    manifestFingerprint: "0".repeat(64),
    contentHash,
    publicConfigRevision: input.configuration.revision,
    publicConfigHash: input.configurationHash,
    originSetHash: await recomputeProductionOriginSetHash(input.configuration.publicAssetOrigins),
    searchAlgorithmVersion: REPACK_SEARCH_VERSION,
    repackSearchIndexHash: search.indexHash,
    confidencePolicyVersion: input.configuration.confidencePolicy.version,
    createdAt: timestamp,
    dataAsOf,
    lastSuccessfulObservationAt: timestamp,
    staleAt,
    freshness: input.delayedVendorCount === 0 ? "fresh" : "delayed",
    delayedVendorCount: input.delayedVendorCount,
    counts,
    batchCount: batches.length,
    batchChainHash,
    publicAssetOrigins: input.configuration.publicAssetOrigins,
  };
  startManifest = {
    ...startManifest,
    manifestFingerprint: await recomputeProductionManifestFingerprint(startManifest),
  };
  const manifest = dataReleaseManifestV2Schema.parse({
    metadata: {
      schemaVersion: DATA_RELEASE_SCHEMA_VERSION,
      dataSource: "canonical",
      publicReleaseId: startManifest.publicReleaseId,
      sourceWatermark: startManifest.sourceWatermark,
      manifestFingerprint: startManifest.manifestFingerprint,
      contentHash: startManifest.contentHash,
      publicConfigRevision: startManifest.publicConfigRevision,
      publicConfigHash: startManifest.publicConfigHash,
      originSetHash: startManifest.originSetHash,
      searchAlgorithmVersion: startManifest.searchAlgorithmVersion,
      repackSearchIndexHash: startManifest.repackSearchIndexHash,
      confidencePolicyVersion: startManifest.confidencePolicyVersion,
      createdAt: startManifest.createdAt,
      completedAt: timestamp,
      dataAsOf: startManifest.dataAsOf,
      lastSuccessfulObservationAt: startManifest.lastSuccessfulObservationAt,
      staleAt: startManifest.staleAt,
      freshness: startManifest.freshness,
      delayedVendorCount: startManifest.delayedVendorCount,
      vendorCount: counts.vendors,
      categoryCount: counts.categories,
      collectibleCount: counts.collectibles,
      repackCount: counts.repacks,
      repackChaseCount: counts.repackChases,
    },
    publicAssetOrigins: input.configuration.publicAssetOrigins,
    vendors: input.vendors,
    categories: input.categories,
    repacks: input.repacks,
    collectibles: input.collectibles,
    repackChases: input.repackChases,
  });
  const startRequest = {
    schemaVersion: DATA_RELEASE_SCHEMA_VERSION,
    operationId: `start:${publicReleaseId}`,
    idempotencyKey: `start:${publicReleaseId}`,
    publicationId: publicReleaseId,
    expectedPredecessorPublicReleaseId: input.expectedPredecessorPublicReleaseId,
    manifest: startManifest,
  } as const;
  const finalizeRequest = {
    schemaVersion: DATA_RELEASE_SCHEMA_VERSION,
    operationId: `finalize:${publicReleaseId}`,
    idempotencyKey: `finalize:${publicReleaseId}`,
    publicationId: publicReleaseId,
    expectedPredecessorPublicReleaseId: input.expectedPredecessorPublicReleaseId,
    expectedCounts: counts,
    expectedBatchCount: batches.length,
    expectedBatchChainHash: batchChainHash,
  } as const;
  const plan: CatalogReleasePublishPlan = {
    classification: "publish",
    requestedWatermark: input.requestedWatermark,
    expectedActivePublicReleaseId: input.expectedPredecessorPublicReleaseId,
    expectedPredecessorPublicReleaseId: input.expectedPredecessorPublicReleaseId,
    publicReleaseId,
    observationSequence: input.observationSequence,
    contentHash,
    manifest,
    counts,
    entityHashes,
    publicVendorKeys: input.vendors.map(({ vendorKey }) => vendorKey).sort(),
    batches,
    startRequest,
    finalizeRequest,
  };
  if (containsProtectedPublicationField(plan)) {
    throw new TypeError("PROTECTED_PUBLICATION_FIELD");
  }
  return plan;
}
