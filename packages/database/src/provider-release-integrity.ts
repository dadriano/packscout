import {
  PROVIDER_RELEASE_BATCH_HASH_DOMAIN,
  PROVIDER_RELEASE_CONTENT_CHAIN_HASH_DOMAIN,
  PROVIDER_RELEASE_CONTENT_SEED_HASH_DOMAIN,
  PROVIDER_RELEASE_INDEX_HASH_DOMAIN,
  PROVIDER_RELEASE_MAX_BATCH_BYTES,
  PROVIDER_RELEASE_MAX_BATCHES,
  PROVIDER_RELEASE_MAX_BATCH_RECORDS,
  PROVIDER_RELEASE_PUBLIC_EQUIVALENCE_HASH_DOMAIN,
  canonicalJsonBytes,
  containsProtectedProviderCatalogReleaseField,
  packscoutPublicIdentityUuid,
  sha256CanonicalJson,
  type ProviderReleaseBatch,
  type ProviderReleaseBatchKind,
  type ProviderReleaseDescriptor,
  type ProviderReleaseRecord,
  type ProviderReleaseSearchRecord,
} from "@packscout/contracts";

const BATCH_KINDS: readonly ProviderReleaseBatchKind[] = [
  "provider",
  "category",
  "collectible",
  "repack",
  "chase",
  "retired-repack",
  "search-index",
];
const BATCH_KIND_ORDER = new Map(BATCH_KINDS.map((kind, index) => [kind, index]));

export class ProviderReleaseIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderReleaseIntegrityError";
  }
}

function descriptorContentSeed(descriptor: ProviderReleaseDescriptor) {
  return {
    predecessorCompleteReleaseId: descriptor.predecessorCompleteReleaseId,
    providerId: descriptor.providerId,
    providerKey: descriptor.providerKey,
    publicProviderId: descriptor.publicProviderId,
    throughChangeSequence: descriptor.throughChangeSequence,
    catalogVersionId: descriptor.catalogVersionId,
    catalogContentHash: descriptor.catalogContentHash,
    centralSchemaVersion: descriptor.centralSchemaVersion,
    correlationEventSequence: descriptor.correlationEventSequence,
    correlationSnapshotHash: descriptor.correlationSnapshotHash,
    publicProfileVersionId: descriptor.publicProfileVersionId,
    publicProfileHash: descriptor.publicProfileHash,
    providerSchemaVersion: descriptor.providerSchemaVersion,
    publicSchemaVersion: descriptor.publicSchemaVersion,
    categoryCount: descriptor.categoryCount,
    repackCount: descriptor.repackCount,
    collectibleReferenceCount: descriptor.collectibleReferenceCount,
    chaseCount: descriptor.chaseCount,
    retiredRepackCount: descriptor.retiredRepackCount,
    batchCount: descriptor.batchCount,
    indexHash: descriptor.indexHash,
    dataAsOf: descriptor.dataAsOf,
    lastSuccessfulObservationAt: descriptor.lastSuccessfulObservationAt,
    staleAt: descriptor.staleAt,
    freshness: descriptor.freshness,
  };
}

function orderedBatches(
  batches: readonly ProviderReleaseBatch[],
): readonly ProviderReleaseBatch[] {
  return [...batches].sort((left, right) => {
    const leftKind = BATCH_KIND_ORDER.get(left.batchKind);
    const rightKind = BATCH_KIND_ORDER.get(right.batchKind);
    if (leftKind === undefined || rightKind === undefined) {
      throw new ProviderReleaseIntegrityError("A provider release batch kind is invalid.");
    }
    return leftKind - rightKind || left.batchIndex - right.batchIndex;
  });
}

export async function providerReleaseContentHash(input: {
  readonly descriptor: ProviderReleaseDescriptor;
  readonly batches: readonly ProviderReleaseBatch[];
  readonly checkpoint?: () => void;
}): Promise<string> {
  input.checkpoint?.();
  let hash = await sha256CanonicalJson(
    PROVIDER_RELEASE_CONTENT_SEED_HASH_DOMAIN,
    descriptorContentSeed(input.descriptor),
  );
  for (const batch of orderedBatches(input.batches)) {
    input.checkpoint?.();
    hash = await sha256CanonicalJson(
      PROVIDER_RELEASE_CONTENT_CHAIN_HASH_DOMAIN,
      {
        previousHash: hash,
        batchOrdinal: batch.batchOrdinal,
        batchKind: batch.batchKind,
        batchIndex: batch.batchIndex,
        recordCount: batch.recordCount,
        byteCount: batch.byteCount,
        bodyHash: batch.bodyHash,
      },
    );
  }
  input.checkpoint?.();
  return hash;
}

export async function providerReleasePublicEquivalenceHash(input: {
  readonly descriptor: ProviderReleaseDescriptor;
  readonly batches: readonly ProviderReleaseBatch[];
  readonly checkpoint?: () => void;
}): Promise<string> {
  input.checkpoint?.();
  const {
    throughChangeSequence: selectedBoundary,
    predecessorCompleteReleaseId: privateLineage,
    ...publicDescriptor
  } = descriptorContentSeed(input.descriptor);
  void selectedBoundary;
  void privateLineage;
  return sha256CanonicalJson(
    PROVIDER_RELEASE_PUBLIC_EQUIVALENCE_HASH_DOMAIN,
    {
      // Artifact identity, private lineage, and the content hash are derived
      // metadata. The selected ledger boundary is also excluded here.
      publicDescriptor,
      batches: orderedBatches(input.batches).map((batch) => {
        input.checkpoint?.();
        return {
          batchOrdinal: batch.batchOrdinal,
          batchKind: batch.batchKind,
          batchIndex: batch.batchIndex,
          recordCount: batch.recordCount,
          byteCount: batch.byteCount,
          bodyHash: batch.bodyHash,
          records: batch.records,
        };
      }),
    },
  );
}

function batchBody(batch: ProviderReleaseBatch) {
  return {
    batchKind: batch.batchKind,
    batchIndex: batch.batchIndex,
    records: batch.records,
  };
}

function expectedRecordCounts(descriptor: ProviderReleaseDescriptor) {
  return new Map<ProviderReleaseBatchKind, number>([
    ["provider", 1],
    ["category", descriptor.categoryCount],
    ["collectible", descriptor.collectibleReferenceCount],
    ["repack", descriptor.repackCount],
    ["chase", descriptor.chaseCount],
    ["retired-repack", descriptor.retiredRepackCount],
    ["search-index", descriptor.repackCount],
  ]);
}

export async function assertProviderReleaseIntegrity(input: {
  readonly descriptor: ProviderReleaseDescriptor;
  readonly batches: readonly ProviderReleaseBatch[];
  readonly checkpoint?: () => void;
}): Promise<string> {
  input.checkpoint?.();
  const ordered = orderedBatches(input.batches);
  if (
    ordered.length !== input.descriptor.batchCount
    || ordered.length > PROVIDER_RELEASE_MAX_BATCHES
  ) {
    throw new ProviderReleaseIntegrityError("A provider release batch count is inconsistent.");
  }
  if (containsProtectedProviderCatalogReleaseField(ordered)) {
    throw new ProviderReleaseIntegrityError("A provider release contains a protected field.");
  }
  input.checkpoint?.();
  const kindCounts = new Map<ProviderReleaseBatchKind, number>();
  const recordCounts = new Map<ProviderReleaseBatchKind, number>();
  const searchRecords: ProviderReleaseSearchRecord[] = [];
  for (const [ordinal, batch] of ordered.entries()) {
    input.checkpoint?.();
    if (batch.batchOrdinal !== ordinal || batch.batchIndex !== (kindCounts.get(batch.batchKind) ?? 0)) {
      throw new ProviderReleaseIntegrityError("A provider release batch order is inconsistent.");
    }
    kindCounts.set(batch.batchKind, batch.batchIndex + 1);
    if (
      !Array.isArray(batch.records)
      || batch.recordCount !== batch.records.length
      || batch.recordCount > PROVIDER_RELEASE_MAX_BATCH_RECORDS
    ) {
      throw new ProviderReleaseIntegrityError("A provider release batch record count is inconsistent.");
    }
    const body = batchBody(batch);
    const byteCount = canonicalJsonBytes(body).byteLength;
    const bodyHash = await sha256CanonicalJson(PROVIDER_RELEASE_BATCH_HASH_DOMAIN, body);
    input.checkpoint?.();
    if (
      batch.byteCount !== byteCount
      || batch.byteCount > PROVIDER_RELEASE_MAX_BATCH_BYTES
      || batch.bodyHash !== bodyHash
    ) {
      throw new ProviderReleaseIntegrityError("A provider release batch hash is inconsistent.");
    }
    recordCounts.set(
      batch.batchKind,
      (recordCounts.get(batch.batchKind) ?? 0) + batch.recordCount,
    );
    if (batch.batchKind === "search-index") {
      searchRecords.push(...batch.records as readonly ProviderReleaseSearchRecord[]);
    }
  }
  for (const kind of BATCH_KINDS) {
    input.checkpoint?.();
    if ((kindCounts.get(kind) ?? 0) === 0) {
      throw new ProviderReleaseIntegrityError("A provider release batch kind is missing.");
    }
  }
  for (const [kind, expected] of expectedRecordCounts(input.descriptor)) {
    input.checkpoint?.();
    if ((recordCounts.get(kind) ?? 0) !== expected) {
      throw new ProviderReleaseIntegrityError("A provider release descriptor count is inconsistent.");
    }
  }
  const indexHash = await sha256CanonicalJson(
    PROVIDER_RELEASE_INDEX_HASH_DOMAIN,
    searchRecords,
  );
  input.checkpoint?.();
  if (indexHash !== input.descriptor.indexHash) {
    throw new ProviderReleaseIntegrityError("A provider release index hash is inconsistent.");
  }
  const contentHash = await providerReleaseContentHash(input);
  if (contentHash !== input.descriptor.contentHash) {
    throw new ProviderReleaseIntegrityError("A provider release content hash is inconsistent.");
  }
  const expectedReleaseId = packscoutPublicIdentityUuid(
    `provider-release:${input.descriptor.providerId}:${contentHash}:${indexHash}`,
  );
  if (expectedReleaseId !== input.descriptor.providerReleaseId) {
    throw new ProviderReleaseIntegrityError("A provider release identity is inconsistent.");
  }
  input.checkpoint?.();
  return providerReleasePublicEquivalenceHash(input);
}

export function releaseBatchRecords(
  value: unknown,
): readonly ProviderReleaseRecord[] {
  if (!Array.isArray(value)) {
    throw new ProviderReleaseIntegrityError("A provider release batch payload is invalid.");
  }
  return value as readonly ProviderReleaseRecord[];
}
