import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH,
  MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT,
  PROVIDER_CATALOG_RELEASE_BATCH_KINDS,
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  REPACK_SEARCH_VERSION,
  buildProviderCatalogSourceWatermarkV1,
  canonicalJson,
  derivePublicProviderReleaseIdV1,
  extendProviderCatalogReleaseBatchChainV1,
  extendProviderCatalogReleaseEntityHashV1,
  initializeProviderCatalogReleaseEntityHashV1,
  providerCatalogReleaseBatchByteCount,
  providerReleaseApplyBatchRequestSchema,
  providerReleaseFinalizeRequestSchema,
  providerReleaseStartRequestSchema,
  recomputeProviderCatalogReleaseBatchHashV1,
  recomputeProviderCatalogReleaseContentHashV1,
  recomputeProviderCatalogReleaseFingerprintV1,
  recomputeProviderCatalogReleaseOriginSetHashV1,
  recomputeProviderCatalogSearchIndexHashV1,
  recomputeProviderCatalogSearchShardHashV1,
  type ProviderCatalogReleaseBatchKindV1,
  type ProviderReleaseApplyBatchRequest,
  type ProviderReleaseFinalizeRequest,
  type ProviderReleaseStartRequest,
} from "@packscout/contracts";
import type { ProviderTransactionClient } from "./provider-database.ts";
import {
  ProviderPublicationCompactProofError,
  buildProviderPublicationBatchEvidence,
  providerPublicationReleaseContextHash,
  type StoredProviderPublicationBatchEvidence,
} from "./provider-release-publication-proof.ts";
import {
  verifyProviderPublicationFinalizeTranscript,
} from "./provider-release-publication-transcript.ts";

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

interface MaximumCompactFixture {
  readonly startRequest: ProviderReleaseStartRequest;
  readonly terminalRequest: ProviderReleaseFinalizeRequest;
  readonly storedBatches: readonly StoredProviderPublicationBatchEvidence[];
}

async function maximumCompactFixture(): Promise<MaximumCompactFixture> {
  const batches: Array<{
    readonly batchIndex: number;
    readonly batchKind: ProviderCatalogReleaseBatchKindV1;
    readonly batchHash: string;
    readonly recordCount: 1;
    readonly byteCount: 1;
  }> = [];
  for (let index = 0; index < MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT; index += 1) {
    batches.push({
      batchIndex: index,
      batchKind: index === 0 ? "vendors" : "collectibles",
      batchHash: hash(`compact-batch:${index}`),
      recordCount: 1,
      byteCount: 1,
    });
  }

  let batchChainHash = EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH;
  const entityHashes = {} as Record<ProviderCatalogReleaseBatchKindV1, string>;
  await Promise.all(PROVIDER_CATALOG_RELEASE_BATCH_KINDS.map(async (kind) => {
    entityHashes[kind] =
      await initializeProviderCatalogReleaseEntityHashV1(kind);
  }));
  for (const batch of batches) {
    [batchChainHash, entityHashes[batch.batchKind]] = await Promise.all([
      extendProviderCatalogReleaseBatchChainV1({
        previousHash: batchChainHash,
        batchIndex: batch.batchIndex,
        kind: batch.batchKind,
        batchHash: batch.batchHash,
        recordCount: batch.recordCount,
        byteCount: batch.byteCount,
      }),
      extendProviderCatalogReleaseEntityHashV1({
        previousHash: entityHashes[batch.batchKind],
        kind: batch.batchKind,
        batchHash: batch.batchHash,
        recordCount: batch.recordCount,
        byteCount: batch.byteCount,
      }),
    ]);
  }

  const publicAssetOrigins = ["https://assets.alpha.example"];
  const counts = {
    vendors: 1 as const,
    categories: 0,
    collectibles: MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT - 1,
    repacks: 0,
    repackChases: 0,
    searchShards: 0,
  };
  const identity = {
    platformKey: "alpha",
    sharedConfigurationEpoch: {
      configurationKey: "catalog.v1",
      revision: 1,
      publicChangeSequence: "1",
      configurationHash: hash("configuration"),
    },
    dataAsOf: "2026-09-01T23:58:00.000Z",
    contentHash: await recomputeProviderCatalogReleaseContentHashV1({
      entityHashes,
    }),
    publicAssetOrigins,
    governingHashes: {
      providerConfigurationHash: hash("provider-configuration"),
      sharedCategoriesHash: hash("shared-categories"),
      identityMappingsHash: hash("identity-mappings"),
      originSetHash: await recomputeProviderCatalogReleaseOriginSetHashV1(
        publicAssetOrigins,
      ),
      confidencePolicyHash: hash("confidence-policy"),
    },
    entityHashes,
    counts,
    searchAlgorithmVersion: REPACK_SEARCH_VERSION,
    providerSearchIndexHash:
      await recomputeProviderCatalogSearchIndexHashV1([]),
    batchCount: batches.length,
    batchChainHash,
  } as const;
  const release = {
    ...identity,
    providerReleaseFingerprint:
      await recomputeProviderCatalogReleaseFingerprintV1(identity),
    publicProviderReleaseId: await derivePublicProviderReleaseIdV1(identity),
  };
  const providerCheckpoint = {
    settledSequence: "20",
    settledAt: "2026-09-02T00:00:00.000Z",
  };
  const observation = {
    sourceHeadSequence: "20",
    lastSuccessfulObservationAt: "2026-09-01T23:59:00.000Z",
    staleAt: "2026-09-02T00:15:00.000Z",
    freshness: "fresh" as const,
  };
  const context = {
    release,
    providerCheckpoint,
    sourceWatermark: buildProviderCatalogSourceWatermarkV1("alpha", "20"),
    observation,
    expectedCompletedHead: {
      platformKey: "alpha",
      publicProviderReleaseId: null,
      sharedConfigurationEpoch: null,
      providerCheckpoint: { settledSequence: "0", settledAt: null },
      observation: null,
      terminalReceiptSha256: null,
    },
  } as const;
  const startRequest = providerReleaseStartRequestSchema.parse({
    schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
    operationId: "compact:start",
    idempotencyKey: "compact:start",
    ...context,
  });
  const terminalRequest = providerReleaseFinalizeRequestSchema.parse({
    schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
    operationId: "compact:finalize",
    idempotencyKey: "compact:finalize",
    ...context,
  });
  const releaseContextHash = providerPublicationReleaseContextHash(
    terminalRequest,
  );
  return {
    startRequest,
    terminalRequest,
    storedBatches: batches.map((batch) => ({
      batch_index: batch.batchIndex,
      batch_kind: batch.batchKind,
      batch_hash: batch.batchHash,
      record_count: batch.recordCount,
      byte_count: batch.byteCount,
      release_context_hash: releaseContextHash,
      search_shard_descriptors: [],
    })),
  };
}

function transcriptTransaction(input: {
  readonly fixture: MaximumCompactFixture;
  readonly storedBatches?: readonly StoredProviderPublicationBatchEvidence[];
  readonly observeOperationQuery?: (query: unknown) => void;
  readonly observeBatchQuery?: (query: unknown) => void;
}): ProviderTransactionClient {
  const startBody = canonicalJson(input.fixture.startRequest);
  return {
    provider_publication_operations: {
      findMany(query: unknown) {
        input.observeOperationQuery?.(query);
        return Promise.resolve([{
          idempotency_key: input.fixture.startRequest.idempotencyKey,
          request_digest: hash(startBody),
          request_bytes: Buffer.from(startBody, "utf8"),
        }]);
      },
    },
    provider_publication_batch_evidence: {
      findMany(query: unknown) {
        input.observeBatchQuery?.(query);
        return Promise.resolve(
          input.storedBatches ?? input.fixture.storedBatches,
        );
      },
    },
  } as unknown as ProviderTransactionClient;
}

test("finalize reads bounded compact evidence at the maximum batch count", async () => {
  const fixture = await maximumCompactFixture();
  let operationQuery: unknown;
  let batchQuery: unknown;
  await verifyProviderPublicationFinalizeTranscript({
    transaction: transcriptTransaction({
      fixture,
      observeOperationQuery: (query) => {
        operationQuery = query;
      },
      observeBatchQuery: (query) => {
        batchQuery = query;
      },
    }),
    providerReleaseId: "30000000-0000-5000-8000-000000000001",
    terminalRequest: fixture.terminalRequest,
    parseStartRequest: ({ canonicalRequestBody }) =>
      providerReleaseStartRequestSchema.parse(
        JSON.parse(canonicalRequestBody) as unknown,
      ),
  });

  assert.deepEqual(operationQuery, {
    where: {
      provider_release_id: "30000000-0000-5000-8000-000000000001",
      operation_kind: "start",
      state: "accepted",
      receipt: { is: { outcome: "accepted" } },
    },
    take: 2,
    select: {
      idempotency_key: true,
      request_digest: true,
      request_bytes: true,
    },
  });
  assert.equal(
    (batchQuery as { take?: unknown }).take,
    MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT + 1,
  );
  assert.doesNotMatch(
    JSON.stringify(batchQuery),
    /request_bytes|response_bytes/u,
  );
  assert.deepEqual(
    Object.keys((batchQuery as { select: object }).select).sort(),
    [
      "batch_hash",
      "batch_index",
      "batch_kind",
      "byte_count",
      "record_count",
      "release_context_hash",
      "search_shard_descriptors",
    ],
  );
});

test("finalize fails closed when a pre-cutover batch lacks compact evidence", async () => {
  const fixture = await maximumCompactFixture();
  await assert.rejects(
    () => verifyProviderPublicationFinalizeTranscript({
      transaction: transcriptTransaction({
        fixture,
        storedBatches: fixture.storedBatches.slice(0, -1),
      }),
      providerReleaseId: "30000000-0000-5000-8000-000000000001",
      terminalRequest: fixture.terminalRequest,
      parseStartRequest: ({ canonicalRequestBody }) =>
        providerReleaseStartRequestSchema.parse(
          JSON.parse(canonicalRequestBody) as unknown,
        ),
    }),
    ProviderPublicationCompactProofError,
  );
});

test("apply-batch evidence hashes the in-memory body before persistence", async () => {
  const fixture = await maximumCompactFixture();
  const vendor = {
    publicVendorId: "11111111-1111-5111-8111-111111111111",
    vendorKey: "alpha",
    displayName: "Alpha",
    logoUrl: null,
    websiteUrl: "https://alpha.example",
    listingHosts: ["alpha.example"],
    imageOrigins: [],
    referralParameters: [],
    publicPromo: null,
  };
  const records = [vendor];
  const batch = {
    batchIndex: 0,
    kind: "vendors" as const,
    batchHash: await recomputeProviderCatalogReleaseBatchHashV1({
      kind: "vendors",
      records,
    }),
    byteCount: providerCatalogReleaseBatchByteCount(records),
    records,
  };
  const request = providerReleaseApplyBatchRequestSchema.parse({
    ...fixture.startRequest,
    operationId: "compact:batch:0",
    idempotencyKey: "compact:batch:0",
    batch,
  });
  const evidence = await buildProviderPublicationBatchEvidence(request);
  assert.deepEqual(evidence, {
    batchIndex: 0,
    batchKind: "vendors",
    batchHash: batch.batchHash,
    recordCount: 1,
    byteCount: batch.byteCount,
    releaseContextHash: providerPublicationReleaseContextHash(request),
    searchShardDescriptors: [],
  });

  const tampered: ProviderReleaseApplyBatchRequest = {
    ...request,
    batch: { ...request.batch, batchHash: hash("tampered") },
  };
  await assert.rejects(
    () => buildProviderPublicationBatchEvidence(tampered),
    ProviderPublicationCompactProofError,
  );

  const searchRow = {
    publicRepackId: "22222222-2222-5222-8222-222222222222",
    publicVendorId: vendor.publicVendorId,
    vendorKey: "alpha",
    vendorDisplayName: "Alpha",
    publicCategoryIds: [],
    categoryLabels: [],
    collectibleTypes: [],
    contentMode: "unknown" as const,
    name: "Alpha Repack",
    normalizedName: "alpha repack",
    normalizedVendor: "alpha",
    normalizedCategories: "",
    availability: "unknown" as const,
    priceMinor: null,
    priceNullRank: 1 as const,
    vendorReportedGrossEvMinor: null,
    vendorReportedGrossEvNullRank: 1 as const,
    vendorReportedEvDollarsMinor: null,
    vendorReportedEvDollarsNullRank: 1 as const,
    vendorReportedEvPercentBasisPoints: null,
    vendorReportedEvPercentNullRank: 1 as const,
    packScoutGrossEvMinor: null,
    packScoutGrossEvNullRank: 1 as const,
    packScoutEvDollarsMinor: null,
    packScoutEvDollarsNullRank: 1 as const,
    packScoutEvPercentBasisPoints: null,
    packScoutEvPercentNullRank: 1 as const,
    packScoutConfidenceBasisPoints: null,
    packScoutConfidenceNullRank: 1 as const,
    packScoutConfidenceBand: null,
    buybackBasisPoints: null,
    buybackNullRank: 1 as const,
    topChaseValueMinor: null,
    topChaseNullRank: 1 as const,
    topChaseReason: "CHASE_UNAVAILABLE" as const,
  };
  const shardRows = [searchRow];
  const shard = {
    shardNumber: 0,
    rowCount: 1,
    byteCount: providerCatalogReleaseBatchByteCount(shardRows),
    contentHash: await recomputeProviderCatalogSearchShardHashV1(shardRows),
    rows: shardRows,
  };
  const tamperedShard = { ...shard, contentHash: hash("tampered-shard") };
  const searchBatch = {
    batchIndex: 0,
    kind: "search_shards" as const,
    batchHash: await recomputeProviderCatalogReleaseBatchHashV1({
      kind: "search_shards",
      records: [tamperedShard],
    }),
    byteCount: providerCatalogReleaseBatchByteCount([tamperedShard]),
    records: [tamperedShard],
  };
  const tamperedSearchRequest = providerReleaseApplyBatchRequestSchema.parse({
    ...fixture.startRequest,
    operationId: "compact:search-batch:0",
    idempotencyKey: "compact:search-batch:0",
    batch: searchBatch,
  });
  await assert.rejects(
    () => buildProviderPublicationBatchEvidence(tamperedSearchRequest),
    ProviderPublicationCompactProofError,
  );
});
