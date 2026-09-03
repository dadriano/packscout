import { createHash } from "node:crypto";
import {
  EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH,
  MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES,
  MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT,
  MAX_PROVIDER_CATALOG_RELEASE_BATCH_RECORDS,
  MAX_REPACK_SEARCH_SHARDS,
  MAX_ROWS_PER_REPACK_SEARCH_SHARD,
  PROVIDER_CATALOG_RELEASE_BATCH_KINDS,
  canonicalJson,
  derivePublicProviderReleaseIdV1,
  extendProviderCatalogReleaseBatchChainV1,
  extendProviderCatalogReleaseEntityHashV1,
  initializeProviderCatalogReleaseEntityHashV1,
  recomputeProviderCatalogReleaseBatchHashV1,
  recomputeProviderCatalogReleaseContentHashV1,
  recomputeProviderCatalogReleaseFingerprintV1,
  recomputeProviderCatalogReleaseOriginSetHashV1,
  recomputeProviderCatalogSearchIndexHashV1,
  recomputeProviderCatalogSearchShardHashV1,
  type ProviderCatalogReleaseBatchKindV1,
  type ProviderCatalogReleaseEntityHashesV1,
  type ProviderCatalogReleaseSearchShardDescriptorV1,
  type ProviderReleaseApplyBatchRequest,
  type ProviderReleaseFinalizeRequest,
  type ProviderReleaseStartRequest,
} from "@packscout/contracts";

const HASH_PATTERN = /^[0-9a-f]{64}$/u;

export interface ProviderPublicationBatchEvidence {
  readonly batchIndex: number;
  readonly batchKind: ProviderCatalogReleaseBatchKindV1;
  readonly batchHash: string;
  readonly recordCount: number;
  readonly byteCount: number;
  readonly releaseContextHash: string;
  readonly searchShardDescriptors: readonly ProviderCatalogReleaseSearchShardDescriptorV1[];
}

export interface StoredProviderPublicationBatchEvidence {
  readonly batch_index: unknown;
  readonly batch_kind: unknown;
  readonly batch_hash: unknown;
  readonly record_count: unknown;
  readonly byte_count: unknown;
  readonly release_context_hash: unknown;
  readonly search_shard_descriptors: unknown;
}

export class ProviderPublicationCompactProofError extends Error {
  constructor() {
    super("Provider publication compact proof is invalid.");
    this.name = "ProviderPublicationCompactProofError";
  }
}

function proofFailure(): never {
  throw new ProviderPublicationCompactProofError();
}

function isExactObject(
  value: unknown,
  keys: readonly string[],
): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

function parseSearchShardDescriptors(
  value: unknown,
): readonly ProviderCatalogReleaseSearchShardDescriptorV1[] {
  if (!Array.isArray(value) || value.length > MAX_PROVIDER_CATALOG_RELEASE_BATCH_RECORDS) {
    proofFailure();
  }
  return value.map((descriptor) => {
    if (
      !isExactObject(descriptor, [
        "shardNumber",
        "rowCount",
        "byteCount",
        "contentHash",
      ])
      || !boundedInteger(
        descriptor.shardNumber,
        0,
        MAX_REPACK_SEARCH_SHARDS - 1,
      )
      || !boundedInteger(
        descriptor.rowCount,
        1,
        MAX_ROWS_PER_REPACK_SEARCH_SHARD,
      )
      || !boundedInteger(
        descriptor.byteCount,
        1,
        MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES,
      )
      || typeof descriptor.contentHash !== "string"
      || !HASH_PATTERN.test(descriptor.contentHash)
    ) proofFailure();
    return {
      shardNumber: descriptor.shardNumber,
      rowCount: descriptor.rowCount,
      byteCount: descriptor.byteCount,
      contentHash: descriptor.contentHash,
    };
  });
}

export function providerPublicationReleaseContextHash(
  request: ProviderReleaseStartRequest
    | ProviderReleaseApplyBatchRequest
    | ProviderReleaseFinalizeRequest,
): string {
  return createHash("sha256").update(canonicalJson({
    release: request.release,
    providerCheckpoint: request.providerCheckpoint,
    sourceWatermark: request.sourceWatermark,
    observation: request.observation,
    expectedCompletedHead: request.expectedCompletedHead,
  }), "utf8").digest("hex");
}

export async function buildProviderPublicationBatchEvidence(
  request: ProviderReleaseApplyBatchRequest,
): Promise<ProviderPublicationBatchEvidence> {
  if (
    await recomputeProviderCatalogReleaseBatchHashV1(request.batch) !==
      request.batch.batchHash
  ) proofFailure();

  const searchShardDescriptors: ProviderCatalogReleaseSearchShardDescriptorV1[] = [];
  if (request.batch.kind === "search_shards") {
    for (const shard of request.batch.records) {
      if (
        await recomputeProviderCatalogSearchShardHashV1(shard.rows) !==
          shard.contentHash
      ) proofFailure();
      searchShardDescriptors.push({
        shardNumber: shard.shardNumber,
        rowCount: shard.rowCount,
        byteCount: shard.byteCount,
        contentHash: shard.contentHash,
      });
    }
  }

  return {
    batchIndex: request.batch.batchIndex,
    batchKind: request.batch.kind,
    batchHash: request.batch.batchHash,
    recordCount: request.batch.records.length,
    byteCount: request.batch.byteCount,
    releaseContextHash: providerPublicationReleaseContextHash(request),
    searchShardDescriptors,
  };
}

export function parseStoredProviderPublicationBatchEvidence(
  row: StoredProviderPublicationBatchEvidence,
): ProviderPublicationBatchEvidence {
  if (
    !boundedInteger(
      row.batch_index,
      0,
      MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT - 1,
    )
    || typeof row.batch_kind !== "string"
    || !PROVIDER_CATALOG_RELEASE_BATCH_KINDS.includes(
      row.batch_kind as ProviderCatalogReleaseBatchKindV1,
    )
    || typeof row.batch_hash !== "string"
    || !HASH_PATTERN.test(row.batch_hash)
    || !boundedInteger(
      row.record_count,
      1,
      MAX_PROVIDER_CATALOG_RELEASE_BATCH_RECORDS,
    )
    || !boundedInteger(
      row.byte_count,
      1,
      MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES,
    )
    || typeof row.release_context_hash !== "string"
    || !HASH_PATTERN.test(row.release_context_hash)
  ) proofFailure();

  const searchShardDescriptors = parseSearchShardDescriptors(
    row.search_shard_descriptors,
  );
  if (
    (row.batch_kind === "search_shards"
      && searchShardDescriptors.length !== row.record_count)
    || (row.batch_kind !== "search_shards"
      && searchShardDescriptors.length !== 0)
  ) proofFailure();

  return {
    batchIndex: row.batch_index,
    batchKind: row.batch_kind as ProviderCatalogReleaseBatchKindV1,
    batchHash: row.batch_hash,
    recordCount: row.record_count,
    byteCount: row.byte_count,
    releaseContextHash: row.release_context_hash,
    searchShardDescriptors,
  };
}

export function storedProviderPublicationBatchEvidenceMatches(
  row: StoredProviderPublicationBatchEvidence,
  expected: ProviderPublicationBatchEvidence,
): boolean {
  try {
    return canonicalJson(parseStoredProviderPublicationBatchEvidence(row)) ===
      canonicalJson(expected);
  } catch (error) {
    if (error instanceof ProviderPublicationCompactProofError) return false;
    throw error;
  }
}

export async function verifyProviderPublicationCompactFinalizeProof(input: {
  readonly startRequest: ProviderReleaseStartRequest;
  readonly terminalRequest: ProviderReleaseFinalizeRequest;
  readonly storedBatches: readonly StoredProviderPublicationBatchEvidence[];
}): Promise<void> {
  const expectedContextHash = providerPublicationReleaseContextHash(
    input.terminalRequest,
  );
  if (
    providerPublicationReleaseContextHash(input.startRequest) !==
      expectedContextHash
    || input.storedBatches.length !== input.terminalRequest.release.batchCount
    || input.storedBatches.length > MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT
  ) proofFailure();

  const batches: ProviderPublicationBatchEvidence[] = [];
  let totalSearchShardDescriptors = 0;
  for (const stored of input.storedBatches) {
    const batch = parseStoredProviderPublicationBatchEvidence(stored);
    totalSearchShardDescriptors += batch.searchShardDescriptors.length;
    if (totalSearchShardDescriptors > MAX_REPACK_SEARCH_SHARDS) proofFailure();
    batches.push(batch);
  }
  const counts = {
    vendors: 0,
    categories: 0,
    collectibles: 0,
    repacks: 0,
    repackChases: 0,
    searchShards: 0,
  };
  const entityHashes = {} as Record<ProviderCatalogReleaseBatchKindV1, string>;
  for (const kind of PROVIDER_CATALOG_RELEASE_BATCH_KINDS) {
    entityHashes[kind] =
      await initializeProviderCatalogReleaseEntityHashV1(kind);
  }
  let batchChainHash = EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH;
  let previousKindIndex = -1;
  const searchShardDescriptors: ProviderCatalogReleaseSearchShardDescriptorV1[] = [];

  for (const [batchOffset, batch] of batches.entries()) {
    const kindIndex = PROVIDER_CATALOG_RELEASE_BATCH_KINDS.indexOf(
      batch.batchKind,
    );
    if (
      batch.batchIndex !== batchOffset
      || batch.releaseContextHash !== expectedContextHash
      || kindIndex < previousKindIndex
    ) proofFailure();
    previousKindIndex = kindIndex;
    batchChainHash = await extendProviderCatalogReleaseBatchChainV1({
      previousHash: batchChainHash,
      batchIndex: batch.batchIndex,
      kind: batch.batchKind,
      batchHash: batch.batchHash,
      recordCount: batch.recordCount,
      byteCount: batch.byteCount,
    });
    entityHashes[batch.batchKind] =
      await extendProviderCatalogReleaseEntityHashV1({
        previousHash: entityHashes[batch.batchKind],
        kind: batch.batchKind,
        batchHash: batch.batchHash,
        recordCount: batch.recordCount,
        byteCount: batch.byteCount,
      });
    switch (batch.batchKind) {
      case "vendors":
        counts.vendors += batch.recordCount;
        break;
      case "categories":
        counts.categories += batch.recordCount;
        break;
      case "collectibles":
        counts.collectibles += batch.recordCount;
        break;
      case "repacks":
        counts.repacks += batch.recordCount;
        break;
      case "repack_chases":
        counts.repackChases += batch.recordCount;
        break;
      case "search_shards":
        counts.searchShards += batch.recordCount;
        searchShardDescriptors.push(...batch.searchShardDescriptors);
        break;
    }
  }

  if (
    batchChainHash !== input.terminalRequest.release.batchChainHash
    || canonicalJson(counts) !== canonicalJson(input.terminalRequest.release.counts)
    || searchShardDescriptors.some(
      (descriptor, index) => descriptor.shardNumber !== index,
    )
    || searchShardDescriptors.reduce(
      (total, descriptor) => total + descriptor.rowCount,
      0,
    ) !== input.terminalRequest.release.counts.repacks
  ) proofFailure();

  for (const kind of PROVIDER_CATALOG_RELEASE_BATCH_KINDS) {
    if (entityHashes[kind] !== input.terminalRequest.release.entityHashes[kind]) {
      proofFailure();
    }
  }
  if (
    await recomputeProviderCatalogSearchIndexHashV1(searchShardDescriptors) !==
      input.terminalRequest.release.providerSearchIndexHash
    || await recomputeProviderCatalogReleaseOriginSetHashV1(
      input.terminalRequest.release.publicAssetOrigins,
    ) !== input.terminalRequest.release.governingHashes.originSetHash
    || await recomputeProviderCatalogReleaseContentHashV1({
      entityHashes: entityHashes as ProviderCatalogReleaseEntityHashesV1,
    }) !== input.terminalRequest.release.contentHash
    || await recomputeProviderCatalogReleaseFingerprintV1(
      input.terminalRequest.release,
    ) !== input.terminalRequest.release.providerReleaseFingerprint
    || await derivePublicProviderReleaseIdV1(input.terminalRequest.release) !==
      input.terminalRequest.release.publicProviderReleaseId
  ) proofFailure();
}
