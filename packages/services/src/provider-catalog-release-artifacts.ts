import {
  EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH,
  MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES,
  MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT,
  MAX_PROVIDER_CATALOG_RELEASE_BATCH_RECORDS,
  MAX_ROWS_PER_REPACK_SEARCH_SHARD,
  PROVIDER_CATALOG_RELEASE_BATCH_KINDS,
  PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
  REPACK_SEARCH_VERSION,
  buildProviderCatalogSourceWatermarkV1,
  containsProtectedProviderCatalogReleaseField,
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
  repackSearchRowFromDetail,
  verifyProviderCatalogReleasePlanV1,
  type ProviderCatalogReleaseBatchKindV1,
  type ProviderCatalogReleaseBatchRecordMapV1,
  type ProviderCatalogReleaseBatchV1,
  type ProviderCatalogReleaseGoverningHashesV1,
  type ProviderCatalogReleaseIdentityInputV1,
  type ProviderCatalogReleasePublishPlanV1,
  type ProviderCatalogReleaseSearchShardV1,
  type ProviderCatalogSharedConfigurationEpochV1,
  type PublicCategory,
  type PublicCollectible,
  type PublicRepackChase,
  type PublicRepackDetail,
  type PublicVendor,
} from "@packscout/contracts";
import type {
  ProviderCatalogReleaseConfigurationSnapshot,
  ProviderCatalogReleaseSnapshotCheckpoint,
} from "./provider-catalog-release-types.ts";
import {
  compareProviderCatalogCodeUnits,
  type ProviderCatalogPublicProjection,
} from "./provider-catalog-release-public-projection.ts";

export type ProviderCatalogReleaseArtifactBlockReason =
  | "PUBLICATION_BATCH_TOO_LARGE"
  | "PUBLICATION_BATCH_LIMIT_EXCEEDED"
  | "PROTECTED_PUBLICATION_FIELD"
  | "PUBLIC_CONTRACT_INVALID";

export class ProviderCatalogReleaseArtifactError extends Error {
  constructor(readonly reason: ProviderCatalogReleaseArtifactBlockReason) {
    super(reason);
    this.name = "ProviderCatalogReleaseArtifactError";
  }
}

type RecordsByKind = {
  readonly [K in ProviderCatalogReleaseBatchKindV1]:
    readonly ProviderCatalogReleaseBatchRecordMapV1[K][];
};

function fail(reason: ProviderCatalogReleaseArtifactBlockReason): never {
  throw new ProviderCatalogReleaseArtifactError(reason);
}

function finiteIso(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("PUBLIC_CONTRACT_INVALID");
  }
  return value.toISOString();
}

function epochWire(
  checkpoint: ProviderCatalogReleaseSnapshotCheckpoint,
): ProviderCatalogSharedConfigurationEpochV1 {
  return {
    configurationKey:
      checkpoint.sharedConfigurationEpoch.configurationKey,
    revision: checkpoint.sharedConfigurationEpoch.revision,
    publicChangeSequence: String(
      checkpoint.sharedConfigurationEpoch.publicChangeSequence,
    ),
    configurationHash:
      checkpoint.sharedConfigurationEpoch.configurationHash,
  };
}

function sortRecords<K extends ProviderCatalogReleaseBatchKindV1>(
  kind: K,
  records: readonly ProviderCatalogReleaseBatchRecordMapV1[K][],
): readonly ProviderCatalogReleaseBatchRecordMapV1[K][] {
  const copy = [...records];
  switch (kind) {
    case "vendors":
      return copy.sort((left, right) => compareProviderCatalogCodeUnits(
        (left as PublicVendor).publicVendorId,
        (right as PublicVendor).publicVendorId,
      ));
    case "categories":
      return copy.sort((left, right) => {
        const leftCategory = left as PublicCategory;
        const rightCategory = right as PublicCategory;
        return leftCategory.depth - rightCategory.depth ||
          compareProviderCatalogCodeUnits(
            leftCategory.publicCategoryId,
            rightCategory.publicCategoryId,
          );
      });
    case "collectibles":
      return copy.sort((left, right) => compareProviderCatalogCodeUnits(
        (left as PublicCollectible).publicCollectibleId,
        (right as PublicCollectible).publicCollectibleId,
      ));
    case "repacks":
      return copy.sort((left, right) => compareProviderCatalogCodeUnits(
        (left as PublicRepackDetail).publicRepackId,
        (right as PublicRepackDetail).publicRepackId,
      ));
    case "repack_chases":
      return copy.sort((left, right) => {
        const leftChase = left as PublicRepackChase;
        const rightChase = right as PublicRepackChase;
        return compareProviderCatalogCodeUnits(
          leftChase.publicRepackId,
          rightChase.publicRepackId,
        ) || leftChase.displayOrder - rightChase.displayOrder ||
          compareProviderCatalogCodeUnits(
            leftChase.publicCollectibleId,
            rightChase.publicCollectibleId,
          );
      });
    case "search_shards":
      return copy.sort((left, right) =>
        (left as ProviderCatalogReleaseSearchShardV1).shardNumber -
        (right as ProviderCatalogReleaseSearchShardV1).shardNumber);
  }
}

function partition<K extends ProviderCatalogReleaseBatchKindV1>(
  kind: K,
  records: readonly ProviderCatalogReleaseBatchRecordMapV1[K][],
): Array<readonly ProviderCatalogReleaseBatchRecordMapV1[K][]> {
  const result: Array<readonly ProviderCatalogReleaseBatchRecordMapV1[K][]> = [];
  let current: ProviderCatalogReleaseBatchRecordMapV1[K][] = [];
  for (const record of sortRecords(kind, records)) {
    const candidate = [...current, record];
    if (
      current.length > 0 &&
      (candidate.length > MAX_PROVIDER_CATALOG_RELEASE_BATCH_RECORDS ||
        providerCatalogReleaseBatchByteCount(candidate) >
          MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES)
    ) {
      result.push(current);
      current = [record];
    } else {
      current = candidate;
    }
    if (
      providerCatalogReleaseBatchByteCount(current) >
      MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES
    ) fail("PUBLICATION_BATCH_TOO_LARGE");
  }
  if (current.length > 0) result.push(current);
  return result;
}

function placeholderSearchShard(
  shardNumber: number,
  rows: readonly ReturnType<typeof repackSearchRowFromDetail>[],
): ProviderCatalogReleaseSearchShardV1 {
  return {
    shardNumber,
    rowCount: rows.length,
    byteCount: providerCatalogReleaseBatchByteCount(rows),
    contentHash: "0".repeat(64),
    rows: [...rows],
  };
}

async function searchShards(
  repacks: readonly PublicRepackDetail[],
): Promise<ProviderCatalogReleaseSearchShardV1[]> {
  const rows = repacks.map(repackSearchRowFromDetail).sort((left, right) =>
    compareProviderCatalogCodeUnits(left.publicRepackId, right.publicRepackId));
  const shards: ProviderCatalogReleaseSearchShardV1[] = [];
  let shardRows: typeof rows = [];
  const appendShard = async (): Promise<void> => {
    if (shardRows.length === 0) return;
    const shardNumber = shards.length;
    const byteCount = providerCatalogReleaseBatchByteCount(shardRows);
    shards.push({
      shardNumber,
      rowCount: shardRows.length,
      byteCount,
      contentHash: await recomputeProviderCatalogSearchShardHashV1(shardRows),
      rows: [...shardRows],
    });
    shardRows = [];
  };
  for (const row of rows) {
    const candidate = [...shardRows, row];
    const candidateRecord = placeholderSearchShard(shards.length, candidate);
    if (
      shardRows.length > 0 &&
      (candidate.length > MAX_ROWS_PER_REPACK_SEARCH_SHARD ||
        providerCatalogReleaseBatchByteCount([candidateRecord]) >
          MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES)
    ) await appendShard();
    shardRows.push(row);
    const currentRecord = placeholderSearchShard(shards.length, shardRows);
    if (
      providerCatalogReleaseBatchByteCount([currentRecord]) >
      MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES
    ) fail("PUBLICATION_BATCH_TOO_LARGE");
  }
  await appendShard();
  return shards;
}

async function governingHashes(input: {
  configuration: ProviderCatalogReleaseConfigurationSnapshot;
  projection: ProviderCatalogPublicProjection;
}): Promise<ProviderCatalogReleaseGoverningHashesV1> {
  return {
    providerConfigurationHash:
      await recomputeProviderCatalogReleaseGoverningHashV1({
        kind: "provider_configuration",
        value: {
          schemaVersion: input.configuration.schemaVersion,
          platform: input.configuration.platform,
          verifiedUsdStablecoins:
            input.configuration.verifiedUsdStablecoins,
        },
      }),
    sharedCategoriesHash:
      await recomputeProviderCatalogReleaseGoverningHashV1({
        kind: "shared_categories",
        value: input.projection.categories,
      }),
    identityMappingsHash:
      await recomputeProviderCatalogReleaseGoverningHashV1({
        kind: "identity_mappings",
        value: {
          repacks: input.configuration.repacks,
          collectibles: input.configuration.collectibles,
        },
      }),
    originSetHash: await recomputeProviderCatalogReleaseOriginSetHashV1(
      input.configuration.publicAssetOrigins,
    ),
    confidencePolicyHash:
      await recomputeProviderCatalogReleaseGoverningHashV1({
        kind: "confidence_policy",
        value: input.configuration.confidencePolicy,
      }),
  };
}

async function buildBatches(
  records: RecordsByKind,
): Promise<Readonly<{
  batches: ProviderCatalogReleaseBatchV1[];
  batchChainHash: string;
  entityHashes: Record<ProviderCatalogReleaseBatchKindV1, string>;
}>> {
  const batches: ProviderCatalogReleaseBatchV1[] = [];
  let batchChainHash = EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH;
  const entityHashes = {} as Record<
    ProviderCatalogReleaseBatchKindV1,
    string
  >;
  for (const kind of PROVIDER_CATALOG_RELEASE_BATCH_KINDS) {
    entityHashes[kind] =
      await initializeProviderCatalogReleaseEntityHashV1(kind);
  }
  for (const kind of PROVIDER_CATALOG_RELEASE_BATCH_KINDS) {
    for (const part of partition(kind, records[kind])) {
      if (batches.length >= MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT) {
        fail("PUBLICATION_BATCH_LIMIT_EXCEEDED");
      }
      const batchIndex = batches.length;
      const batchHash = await recomputeProviderCatalogReleaseBatchHashV1({
        kind,
        records: part,
      });
      const byteCount = providerCatalogReleaseBatchByteCount(part);
      entityHashes[kind] = await extendProviderCatalogReleaseEntityHashV1({
        previousHash: entityHashes[kind],
        kind,
        batchHash,
        recordCount: part.length,
        byteCount,
      });
      batchChainHash = await extendProviderCatalogReleaseBatchChainV1({
        previousHash: batchChainHash,
        batchIndex,
        kind,
        batchHash,
        recordCount: part.length,
        byteCount,
      });
      batches.push({
        batchIndex,
        kind,
        batchHash,
        byteCount,
        records: [...part],
      } as ProviderCatalogReleaseBatchV1);
    }
  }
  return { batches, batchChainHash, entityHashes };
}

export async function buildProviderCatalogReleasePublishPlan(input: {
  readonly checkpoint: ProviderCatalogReleaseSnapshotCheckpoint;
  readonly configuration: ProviderCatalogReleaseConfigurationSnapshot;
  readonly projection: ProviderCatalogPublicProjection;
  readonly lastSuccessfulObservationAt: Date;
}): Promise<ProviderCatalogReleasePublishPlanV1> {
  const shards = await searchShards(input.projection.repacks);
  const records: RecordsByKind = {
    vendors: sortRecords("vendors", input.projection.vendors),
    categories: sortRecords("categories", input.projection.categories),
    collectibles: sortRecords("collectibles", input.projection.collectibles),
    repacks: sortRecords("repacks", input.projection.repacks),
    repack_chases: sortRecords("repack_chases", input.projection.repackChases),
    search_shards: sortRecords("search_shards", shards),
  };
  const { batches, batchChainHash, entityHashes } = await buildBatches(records);
  const contentHash = await recomputeProviderCatalogReleaseContentHashV1({
    entityHashes,
  });
  const governed = await governingHashes(input);
  const counts = {
    vendors: 1 as const,
    categories: records.categories.length,
    collectibles: records.collectibles.length,
    repacks: records.repacks.length,
    repackChases: records.repack_chases.length,
    searchShards: records.search_shards.length,
  };
  const dataAsOf = finiteIso(input.projection.dataAsOf);
  const identity: ProviderCatalogReleaseIdentityInputV1 = {
    platformKey: input.checkpoint.platformKey,
    sharedConfigurationEpoch: epochWire(input.checkpoint),
    dataAsOf,
    contentHash,
    publicAssetOrigins: input.configuration.publicAssetOrigins,
    governingHashes: governed,
    entityHashes,
    counts,
    searchAlgorithmVersion: REPACK_SEARCH_VERSION,
    providerSearchIndexHash:
      await recomputeProviderCatalogSearchIndexHashV1(shards),
    batchCount: batches.length,
    batchChainHash,
  };
  const publicProviderReleaseId =
    await derivePublicProviderReleaseIdV1(identity);
  const providerReleaseFingerprint =
    await recomputeProviderCatalogReleaseFingerprintV1(identity);
  const lastSuccessfulObservationAt = finiteIso(
    input.lastSuccessfulObservationAt,
  );
  const staleAt = finiteIso(new Date(
    input.lastSuccessfulObservationAt.getTime() +
      input.configuration.staleAfterSeconds * 1_000,
  ));
  const plan: ProviderCatalogReleasePublishPlanV1 = {
    schemaVersion: PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
    classification: "publish",
    platformKey: input.checkpoint.platformKey,
    sharedConfigurationEpoch: identity.sharedConfigurationEpoch,
    providerCheckpoint: {
      settledSequence: String(input.checkpoint.settledSequence),
      settledAt: finiteIso(input.checkpoint.settledAt),
    },
    sourceWatermark: buildProviderCatalogSourceWatermarkV1(
      input.checkpoint.platformKey,
      String(input.checkpoint.settledSequence),
    ),
    publicProviderReleaseId,
    providerReleaseFingerprint,
    contentHash,
    publicAssetOrigins: [...input.configuration.publicAssetOrigins],
    governingHashes: governed,
    entityHashes,
    counts,
    searchAlgorithmVersion: REPACK_SEARCH_VERSION,
    providerSearchIndexHash: identity.providerSearchIndexHash,
    batchCount: batches.length,
    batchChainHash,
    batches,
    dataAsOf,
    observation: {
      sourceHeadSequence: String(input.checkpoint.sourceHeadSequence),
      lastSuccessfulObservationAt,
      staleAt,
      freshness: input.lastSuccessfulObservationAt.getTime() >=
          input.checkpoint.sourceHeadAt.getTime()
        ? "fresh"
        : "delayed",
    },
  };
  if (containsProtectedProviderCatalogReleaseField(plan)) {
    fail("PROTECTED_PUBLICATION_FIELD");
  }
  try {
    return await verifyProviderCatalogReleasePlanV1(plan) as
      ProviderCatalogReleasePublishPlanV1;
  } catch (error) {
    if (error instanceof ProviderCatalogReleaseArtifactError) throw error;
    fail("PUBLIC_CONTRACT_INVALID");
  }
}
