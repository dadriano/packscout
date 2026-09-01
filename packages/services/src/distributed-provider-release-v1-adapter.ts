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
  publicCategorySchema,
  publicCollectibleSchema,
  publicRepackChaseSchema,
  publicRepackDetailSchema,
  publicVendorSchema,
  recomputeProviderCatalogReleaseBatchHashV1,
  recomputeProviderCatalogReleaseContentHashV1,
  recomputeProviderCatalogReleaseFingerprintV1,
  recomputeProviderCatalogReleaseGoverningHashV1,
  recomputeProviderCatalogReleaseOriginSetHashV1,
  recomputeProviderCatalogSearchIndexHashV1,
  recomputeProviderCatalogSearchShardHashV1,
  repackSearchRowFromDetail,
  verifyProviderCatalogReleasePlanV1,
  type ProviderCatalogCompletedReleaseProofV1,
  type ProviderCatalogReleaseBatchKindV1,
  type ProviderCatalogReleaseBatchRecordMapV1,
  type ProviderCatalogReleaseBatchV1,
  type ProviderCatalogReleaseIdentityInputV1,
  type ProviderCatalogReleasePlanV1,
  type ProviderCatalogReleasePublishPlanV1,
  type ProviderCatalogReleaseSearchShardV1,
  type ProviderReleaseBatch,
  type ProviderReleaseDescriptor,
  type PublicCategory,
  type PublicCollectible,
  type PublicRepackChase,
  type PublicRepackDetail,
  type PublicVendor,
} from "@packscout/contracts";

const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;
const ADAPTER_VERSION = "distributed-provider-release-v1-to-catalog-v1" as const;

export type DistributedProviderReleaseAdapterFailureCode =
  | "PROVIDER_RELEASE_ADAPTER_SCOPE_INVALID"
  | "PROVIDER_RELEASE_ADAPTER_BATCH_INVALID"
  | "PROVIDER_RELEASE_ADAPTER_REFERENCE_INVALID"
  | "PROVIDER_RELEASE_ADAPTER_PROTECTED_FIELD"
  | "PROVIDER_RELEASE_ADAPTER_CONTRACT_INVALID";

export class DistributedProviderReleaseAdapterError extends Error {
  constructor(readonly code: DistributedProviderReleaseAdapterFailureCode) {
    super(`Distributed provider release adaptation failed (${code}).`);
    this.name = "DistributedProviderReleaseAdapterError";
  }
}

export interface DistributedProviderReleasePublicationSource {
  readonly descriptor: ProviderReleaseDescriptor;
  readonly batches: readonly ProviderReleaseBatch[];
  /** The newly selected local ledger boundary, including unchanged-release reuse. */
  readonly selectedThroughChangeSequence: bigint;
  readonly classification: "publish" | "reuse";
}

type RecordsByKind = {
  readonly [Kind in ProviderCatalogReleaseBatchKindV1]:
    readonly ProviderCatalogReleaseBatchRecordMapV1[Kind][];
};

function fail(code: DistributedProviderReleaseAdapterFailureCode): never {
  throw new DistributedProviderReleaseAdapterError(code);
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactInstant(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail("PROVIDER_RELEASE_ADAPTER_SCOPE_INVALID");
  }
  return value;
}

function sequence(value: string): bigint {
  if (!/^[1-9][0-9]{0,18}$/u.test(value)) {
    fail("PROVIDER_RELEASE_ADAPTER_SCOPE_INVALID");
  }
  const parsed = BigInt(value);
  if (parsed > MAX_SIGNED_INT64) {
    fail("PROVIDER_RELEASE_ADAPTER_SCOPE_INVALID");
  }
  return parsed;
}

function recordsFor(
  batches: readonly ProviderReleaseBatch[],
  batchKind: string,
): readonly unknown[] {
  return batches
    .filter((batch) => String(batch.batchKind) === batchKind)
    .sort((left, right) => left.batchIndex - right.batchIndex)
    .flatMap((batch) => batch.records);
}

function parseRecords<T>(
  values: readonly unknown[],
  parse: (value: unknown) => T,
): readonly T[] {
  try {
    return values.map(parse);
  } catch {
    fail("PROVIDER_RELEASE_ADAPTER_BATCH_INVALID");
  }
}

function sourceRecords(
  source: DistributedProviderReleasePublicationSource,
): RecordsByKind {
  const vendors = parseRecords(
    recordsFor(source.batches, "provider"),
    (value) => publicVendorSchema.parse(value),
  );
  const categories = parseRecords(
    recordsFor(source.batches, "category"),
    (value) => publicCategorySchema.parse(value),
  );
  const collectibles = parseRecords(
    recordsFor(source.batches, "collectible"),
    (value) => publicCollectibleSchema.parse(value),
  );
  const repacks = parseRecords(
    recordsFor(source.batches, "repack"),
    (value) => publicRepackDetailSchema.parse(value),
  );
  const repackChases = parseRecords(
    recordsFor(source.batches, "chase"),
    (value) => publicRepackChaseSchema.parse(value),
  );
  const descriptor = source.descriptor;
  if (
    vendors.length !== 1
    || vendors[0]!.vendorKey !== descriptor.providerKey
    || vendors[0]!.publicVendorId !== descriptor.publicProviderId
    || categories.length !== descriptor.categoryCount
    || collectibles.length !== descriptor.collectibleReferenceCount
    || repacks.length !== descriptor.repackCount
    || repackChases.length !== descriptor.chaseCount
  ) fail("PROVIDER_RELEASE_ADAPTER_REFERENCE_INVALID");
  return {
    vendors,
    categories,
    collectibles,
    repacks,
    repack_chases: repackChases,
    search_shards: [],
  };
}

function sortRecords<Kind extends ProviderCatalogReleaseBatchKindV1>(
  kind: Kind,
  records: readonly ProviderCatalogReleaseBatchRecordMapV1[Kind][],
): readonly ProviderCatalogReleaseBatchRecordMapV1[Kind][] {
  const copy = [...records];
  switch (kind) {
    case "vendors":
      return copy.sort((left, right) => codeUnitCompare(
        (left as PublicVendor).publicVendorId,
        (right as PublicVendor).publicVendorId,
      ));
    case "categories":
      return copy.sort((left, right) => {
        const leftCategory = left as PublicCategory;
        const rightCategory = right as PublicCategory;
        return leftCategory.depth - rightCategory.depth
          || codeUnitCompare(
            leftCategory.publicCategoryId,
            rightCategory.publicCategoryId,
          );
      });
    case "collectibles":
      return copy.sort((left, right) => codeUnitCompare(
        (left as PublicCollectible).publicCollectibleId,
        (right as PublicCollectible).publicCollectibleId,
      ));
    case "repacks":
      return copy.sort((left, right) => codeUnitCompare(
        (left as PublicRepackDetail).publicRepackId,
        (right as PublicRepackDetail).publicRepackId,
      ));
    case "repack_chases":
      return copy.sort((left, right) => {
        const leftChase = left as PublicRepackChase;
        const rightChase = right as PublicRepackChase;
        return codeUnitCompare(leftChase.publicRepackId, rightChase.publicRepackId)
          || leftChase.displayOrder - rightChase.displayOrder
          || codeUnitCompare(
            leftChase.publicCollectibleId,
            rightChase.publicCollectibleId,
          );
      });
    case "search_shards":
      return copy.sort((left, right) =>
        (left as ProviderCatalogReleaseSearchShardV1).shardNumber
        - (right as ProviderCatalogReleaseSearchShardV1).shardNumber);
  }
}

function partition<Kind extends ProviderCatalogReleaseBatchKindV1>(
  kind: Kind,
  records: readonly ProviderCatalogReleaseBatchRecordMapV1[Kind][],
): Array<readonly ProviderCatalogReleaseBatchRecordMapV1[Kind][]> {
  const parts: Array<readonly ProviderCatalogReleaseBatchRecordMapV1[Kind][]> = [];
  let current: ProviderCatalogReleaseBatchRecordMapV1[Kind][] = [];
  for (const record of sortRecords(kind, records)) {
    const candidate = [...current, record];
    if (
      current.length > 0
      && (candidate.length > MAX_PROVIDER_CATALOG_RELEASE_BATCH_RECORDS
        || providerCatalogReleaseBatchByteCount(candidate)
          > MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES)
    ) {
      parts.push(current);
      current = [record];
    } else {
      current = candidate;
    }
    if (
      providerCatalogReleaseBatchByteCount(current)
      > MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES
    ) fail("PROVIDER_RELEASE_ADAPTER_BATCH_INVALID");
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

function placeholderShard(
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
): Promise<readonly ProviderCatalogReleaseSearchShardV1[]> {
  const rows = repacks.map(repackSearchRowFromDetail).sort((left, right) =>
    codeUnitCompare(left.publicRepackId, right.publicRepackId));
  const shards: ProviderCatalogReleaseSearchShardV1[] = [];
  let current: typeof rows = [];
  const flush = async (): Promise<void> => {
    if (current.length === 0) return;
    shards.push({
      shardNumber: shards.length,
      rowCount: current.length,
      byteCount: providerCatalogReleaseBatchByteCount(current),
      contentHash: await recomputeProviderCatalogSearchShardHashV1(current),
      rows: [...current],
    });
    current = [];
  };
  for (const row of rows) {
    const candidate = [...current, row];
    if (
      current.length > 0
      && (candidate.length > MAX_ROWS_PER_REPACK_SEARCH_SHARD
        || providerCatalogReleaseBatchByteCount([
          placeholderShard(shards.length, candidate),
        ]) > MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES)
    ) await flush();
    current.push(row);
    if (
      providerCatalogReleaseBatchByteCount([
        placeholderShard(shards.length, current),
      ]) > MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES
    ) fail("PROVIDER_RELEASE_ADAPTER_BATCH_INVALID");
  }
  await flush();
  return shards;
}

async function wireBatches(records: RecordsByKind): Promise<Readonly<{
  batches: readonly ProviderCatalogReleaseBatchV1[];
  batchChainHash: string;
  entityHashes: Readonly<Record<ProviderCatalogReleaseBatchKindV1, string>>;
}>> {
  const batches: ProviderCatalogReleaseBatchV1[] = [];
  let batchChainHash = EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH;
  const entityHashes = {} as Record<ProviderCatalogReleaseBatchKindV1, string>;
  for (const kind of PROVIDER_CATALOG_RELEASE_BATCH_KINDS) {
    entityHashes[kind] = await initializeProviderCatalogReleaseEntityHashV1(kind);
  }
  for (const kind of PROVIDER_CATALOG_RELEASE_BATCH_KINDS) {
    for (const part of partition(kind, records[kind])) {
      if (batches.length >= MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT) {
        fail("PROVIDER_RELEASE_ADAPTER_BATCH_INVALID");
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

function compatibilityEpoch(descriptor: ProviderReleaseDescriptor) {
  return {
    // Intentionally per catalog version. This is compatibility metadata for
    // the active V1 transport, never a cross-provider coordination epoch.
    configurationKey: `catalog-version:${descriptor.catalogVersionId}`,
    revision: 1,
    publicChangeSequence: descriptor.throughChangeSequence,
    configurationHash: descriptor.catalogContentHash,
  } as const;
}

function immutableProof(
  plan: ProviderCatalogReleasePublishPlanV1,
): ProviderCatalogCompletedReleaseProofV1 {
  return {
    state: "complete",
    platformKey: plan.platformKey,
    sharedConfigurationEpoch: plan.sharedConfigurationEpoch,
    dataAsOf: plan.dataAsOf,
    publicProviderReleaseId: plan.publicProviderReleaseId,
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
  };
}

/**
 * Narrow compatibility adapter from the provider-owned immutable release to
 * the currently deployed ProviderCatalogRelease V1 finalizer. Canonical
 * provider/release IDs remain local; the public V1 identity is derived only
 * from verified public records and pinned hashes.
 */
export async function adaptDistributedProviderReleaseToCatalogV1(
  source: DistributedProviderReleasePublicationSource,
): Promise<ProviderCatalogReleasePlanV1> {
  const descriptorSequence = sequence(source.descriptor.throughChangeSequence);
  if (
    source.selectedThroughChangeSequence < descriptorSequence
    || source.selectedThroughChangeSequence > MAX_SIGNED_INT64
    || (source.classification === "publish"
      && source.selectedThroughChangeSequence !== descriptorSequence)
    || (source.classification === "reuse"
      && source.selectedThroughChangeSequence <= descriptorSequence)
  ) fail("PROVIDER_RELEASE_ADAPTER_SCOPE_INVALID");
  const publicRecords = sourceRecords(source);
  const records: RecordsByKind = {
    ...publicRecords,
    search_shards: await searchShards(publicRecords.repacks),
  };
  const { batches, batchChainHash, entityHashes } = await wireBatches(records);
  const provider = records.vendors[0]!;
  const publicAssetOrigins = [...provider.imageOrigins].sort(codeUnitCompare);
  const governingHashes = {
    providerConfigurationHash: source.descriptor.publicProfileHash,
    sharedCategoriesHash: source.descriptor.catalogContentHash,
    identityMappingsHash: source.descriptor.correlationSnapshotHash,
    originSetHash: await recomputeProviderCatalogReleaseOriginSetHashV1(
      publicAssetOrigins,
    ),
    confidencePolicyHash:
      await recomputeProviderCatalogReleaseGoverningHashV1({
        kind: "confidence_policy",
        value: {
          adapterVersion: ADAPTER_VERSION,
          centralSchemaVersion: source.descriptor.centralSchemaVersion,
          providerSchemaVersion: source.descriptor.providerSchemaVersion,
          publicSchemaVersion: source.descriptor.publicSchemaVersion,
        },
      }),
  };
  const contentHash = await recomputeProviderCatalogReleaseContentHashV1({
    entityHashes,
  });
  const counts = {
    vendors: 1 as const,
    categories: records.categories.length,
    collectibles: records.collectibles.length,
    repacks: records.repacks.length,
    repackChases: records.repack_chases.length,
    searchShards: records.search_shards.length,
  };
  const identity: ProviderCatalogReleaseIdentityInputV1 = {
    platformKey: source.descriptor.providerKey,
    sharedConfigurationEpoch: compatibilityEpoch(source.descriptor),
    dataAsOf: exactInstant(source.descriptor.dataAsOf),
    contentHash,
    publicAssetOrigins,
    governingHashes,
    entityHashes,
    counts,
    searchAlgorithmVersion: REPACK_SEARCH_VERSION,
    providerSearchIndexHash:
      await recomputeProviderCatalogSearchIndexHashV1(records.search_shards),
    batchCount: batches.length,
    batchChainHash,
  };
  const settledSequence = source.selectedThroughChangeSequence.toString();
  const publish: ProviderCatalogReleasePublishPlanV1 = {
    schemaVersion: PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
    classification: "publish",
    ...identity,
    publicAssetOrigins: [...identity.publicAssetOrigins],
    providerCheckpoint: {
      settledSequence,
      settledAt: exactInstant(source.descriptor.lastSuccessfulObservationAt),
    },
    sourceWatermark: buildProviderCatalogSourceWatermarkV1(
      source.descriptor.providerKey,
      settledSequence,
    ),
    publicProviderReleaseId: await derivePublicProviderReleaseIdV1(identity),
    providerReleaseFingerprint:
      await recomputeProviderCatalogReleaseFingerprintV1(identity),
    batches: [...batches],
    observation: {
      sourceHeadSequence: settledSequence,
      lastSuccessfulObservationAt:
        exactInstant(source.descriptor.lastSuccessfulObservationAt),
      staleAt: exactInstant(source.descriptor.staleAt),
      freshness: source.descriptor.freshness,
    },
  };
  const candidate: ProviderCatalogReleasePlanV1 =
    source.classification === "publish"
      ? publish
      : {
          ...publish,
          classification: "reuse",
          batches: [],
          reuseProof: immutableProof(publish),
        };
  if (containsProtectedProviderCatalogReleaseField(candidate)) {
    fail("PROVIDER_RELEASE_ADAPTER_PROTECTED_FIELD");
  }
  try {
    return await verifyProviderCatalogReleasePlanV1(candidate);
  } catch {
    fail("PROVIDER_RELEASE_ADAPTER_CONTRACT_INVALID");
  }
}
