import {
  EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH,
  PROVIDER_CATALOG_RELEASE_BATCH_KINDS,
  PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
  buildProviderCatalogSourceWatermarkV1,
  derivePublicProviderReleaseIdV1,
  extendProviderCatalogReleaseBatchChainV1,
  providerCatalogReleaseBatchByteCount,
  recomputeProviderCatalogReleaseBatchHashV1,
  recomputeProviderCatalogReleaseContentHashV1,
  recomputeProviderCatalogReleaseEntityHashV1,
  recomputeProviderCatalogReleaseFingerprintV1,
  recomputeProviderCatalogSearchIndexHashV1,
  recomputeProviderCatalogSearchShardHashV1,
  repackSearchRowFromDetail,
  type ProviderCatalogReleaseBatchKindV1,
  type ProviderCatalogReleaseBatchRecordMapV1,
  type ProviderCatalogReleaseBatchV1,
  type ProviderCatalogReleasePublishPlanV1,
  type ProviderCatalogReleaseSearchShardV1,
  type PublicRepackChase,
  type PublicRepackDetail,
} from "@packscout/contracts";
import { buildMockDataReleaseV2 } from "./mockDataReleaseFixture";
import {
  buildProviderPublishPlan,
  emptyProviderHead,
  providerOperationEnvelope,
  providerReleaseContext,
} from "./providerReleaseSecurity.test-support";

function withCalculation(
  detail: PublicRepackDetail,
  calculatedAt: string,
): PublicRepackDetail {
  if (detail.evEstimates.packScout.status !== "available") {
    throw new Error("Expected an available PackScout fixture estimate.");
  }
  return {
    ...detail,
    evEstimates: {
      ...detail.evEstimates,
      packScout: {
        ...detail.evEstimates.packScout,
        dataAsOf: "2026-08-15T02:00:00.000Z",
        calculatedAt,
      },
    },
  };
}

function withoutChases(
  detail: PublicRepackDetail,
  calculatedAt: string,
): PublicRepackDetail {
  const calculated = withCalculation(detail, calculatedAt);
  return {
    ...calculated,
    topChase: null,
    contentSummary: { ...calculated.contentSummary, chaseCount: 0 },
  };
}

async function searchShard(
  shardNumber: number,
  rows: ReturnType<typeof repackSearchRowFromDetail>[],
): Promise<ProviderCatalogReleaseSearchShardV1> {
  return {
    shardNumber,
    rowCount: rows.length,
    byteCount: providerCatalogReleaseBatchByteCount(rows),
    contentHash: await recomputeProviderCatalogSearchShardHashV1(rows),
    rows,
  };
}

export async function buildProviderRepackPlan(input: {
  calculatedAt: string;
  repackCount: 1 | 2;
  searchMode: "complete" | "omitted" | "early_split";
  chaseMode?: "none" | "valid" | "duplicate_top" | "insufficient_known";
}): Promise<ProviderCatalogReleasePublishPlanV1> {
  const base = await buildProviderPublishPlan({ checkpointSequence: "40" });
  const fixture = buildMockDataReleaseV2();
  const vendor = fixture.vendors.find(({ vendorKey }) =>
    vendorKey === "collector_crypt"
  )!;
  const requiredCategoryIds = new Set([
    "20000000-0000-5000-8000-000000000001",
    "20000000-0000-5000-8000-000000000002",
  ]);
  const categories = [...fixture.categories]
    .filter(({ publicCategoryId }) => requiredCategoryIds.has(publicCategoryId))
    .sort((left, right) =>
      left.depth - right.depth ||
      left.publicCategoryId.localeCompare(right.publicCategoryId)
    );
  const selectedRepacks = fixture.repacks
    .filter(({ vendorKey, publicRepackId }) =>
      vendorKey === "collector_crypt" &&
      (publicRepackId.endsWith("0001") || publicRepackId.endsWith("0005"))
    )
    .sort((left, right) => left.publicRepackId.localeCompare(right.publicRepackId))
    .slice(0, input.repackCount);
  const chaseMode = input.chaseMode ?? "none";
  if (chaseMode !== "none" && selectedRepacks.length !== 1) {
    throw new Error("Chase reconciliation fixtures require exactly one repack.");
  }
  const repacks = selectedRepacks.map((detail) => {
    if (chaseMode === "none") {
      return withoutChases(detail, input.calculatedAt);
    }
    const calculated = withCalculation(detail, input.calculatedAt);
    return chaseMode === "insufficient_known"
      ? {
        ...calculated,
        contentSummary: {
          ...calculated.contentSummary,
          knownCollectibleCount: calculated.contentSummary.chaseCount - 1,
        },
      }
      : calculated;
  });
  const repackChases: PublicRepackChase[] = chaseMode === "none"
    ? []
    : fixture.repackChases
      .filter(({ publicRepackId }) =>
        publicRepackId === repacks[0]!.publicRepackId
      )
      .sort((left, right) =>
        left.displayOrder - right.displayOrder ||
        left.publicCollectibleId.localeCompare(right.publicCollectibleId)
      )
      .map((chase, index) =>
        chaseMode === "duplicate_top" && index === 1
          ? { ...chase, role: "top_chase" as const }
          : chase
      );
  const chaseCollectibleIds = new Set(
    repackChases.map(({ publicCollectibleId }) => publicCollectibleId),
  );
  const collectibles = fixture.collectibles
    .filter(({ publicCollectibleId }) =>
      chaseCollectibleIds.has(publicCollectibleId)
    )
    .sort((left, right) =>
      left.publicCollectibleId.localeCompare(right.publicCollectibleId)
    );
  const rows = repacks.map(repackSearchRowFromDetail);
  const searchShards = input.searchMode === "omitted"
    ? []
    : input.searchMode === "complete"
      ? [await searchShard(0, rows)]
      : await Promise.all(rows.map((row, index) => searchShard(index, [row])));
  const records: {
    [Kind in ProviderCatalogReleaseBatchKindV1]:
      readonly ProviderCatalogReleaseBatchRecordMapV1[Kind][];
  } = {
    vendors: [vendor],
    categories,
    collectibles,
    repacks,
    repack_chases: repackChases,
    search_shards: searchShards,
  };
  const batches: ProviderCatalogReleaseBatchV1[] = [];
  let batchChainHash = EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH;
  for (const kind of PROVIDER_CATALOG_RELEASE_BATCH_KINDS) {
    const kindRecords = records[kind];
    if (kindRecords.length === 0) continue;
    const batchIndex = batches.length;
    const batchHash = await recomputeProviderCatalogReleaseBatchHashV1({
      kind,
      records: kindRecords,
    });
    const byteCount = providerCatalogReleaseBatchByteCount(kindRecords);
    batchChainHash = await extendProviderCatalogReleaseBatchChainV1({
      previousHash: batchChainHash,
      batchIndex,
      kind,
      batchHash,
      recordCount: kindRecords.length,
      byteCount,
    });
    batches.push({
      batchIndex,
      kind,
      batchHash,
      byteCount,
      records: [...kindRecords],
    } as ProviderCatalogReleaseBatchV1);
  }
  const entityHashes = {} as Record<ProviderCatalogReleaseBatchKindV1, string>;
  for (const kind of PROVIDER_CATALOG_RELEASE_BATCH_KINDS) {
    entityHashes[kind] = await recomputeProviderCatalogReleaseEntityHashV1({
      kind,
      batches: batches
        .filter((batch) => batch.kind === kind)
        .map((batch) => ({
          kind: batch.kind,
          batchHash: batch.batchHash,
          recordCount: batch.records.length,
          byteCount: batch.byteCount,
        })),
    });
  }
  const counts = {
    vendors: 1 as const,
    categories: categories.length,
    collectibles: collectibles.length,
    repacks: repacks.length,
    repackChases: repackChases.length,
    searchShards: searchShards.length,
  };
  const contentHash = await recomputeProviderCatalogReleaseContentHashV1({
    entityHashes,
  });
  const identity = {
    platformKey: base.platformKey,
    sharedConfigurationEpoch: base.sharedConfigurationEpoch,
    dataAsOf: "2026-08-15T02:00:00.000Z",
    contentHash,
    publicAssetOrigins: base.publicAssetOrigins,
    governingHashes: base.governingHashes,
    entityHashes,
    counts,
    searchAlgorithmVersion: base.searchAlgorithmVersion,
    providerSearchIndexHash:
      await recomputeProviderCatalogSearchIndexHashV1(searchShards),
    batchCount: batches.length,
    batchChainHash,
  } as const;
  const providerCheckpoint = {
    settledSequence: "40",
    settledAt: "2026-08-15T03:00:00.000Z",
  };
  return {
    schemaVersion: PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
    classification: "publish",
    ...identity,
    providerCheckpoint,
    sourceWatermark: buildProviderCatalogSourceWatermarkV1("alpha", "40"),
    observation: {
      sourceHeadSequence: "40",
      lastSuccessfulObservationAt: "2026-08-15T02:15:00.000Z",
      staleAt: "2026-08-15T03:15:00.000Z",
      freshness: "fresh",
    },
    providerReleaseFingerprint:
      await recomputeProviderCatalogReleaseFingerprintV1(identity),
    publicProviderReleaseId: await derivePublicProviderReleaseIdV1(identity),
    batches,
  };
}

export function providerRepackRequests(
  plan: ProviderCatalogReleasePublishPlanV1,
) {
  const context = providerReleaseContext(
    plan,
    emptyProviderHead(plan.platformKey),
  );
  return {
    start: {
      ...providerOperationEnvelope(`provider:start:${plan.publicProviderReleaseId}`),
      ...context,
    },
    batches: plan.batches.map((batch) => ({
      ...providerOperationEnvelope(
        `provider:batch:${batch.batchIndex}:${plan.publicProviderReleaseId}`,
      ),
      ...context,
      batch,
    })),
    finalize: {
      ...providerOperationEnvelope(`provider:finalize:${plan.publicProviderReleaseId}`),
      ...context,
    },
  };
}
