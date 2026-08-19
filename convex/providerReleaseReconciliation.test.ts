/// <reference types="vite/client" />

import {
  EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH,
  PROVIDER_CATALOG_RELEASE_BATCH_KINDS,
  PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
  buildProviderCatalogSourceWatermarkV1,
  canonicalJson,
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
import type { FunctionReference } from "convex/server";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import { buildMockDataReleaseV2 } from "./mockDataReleaseFixture";
import {
  PROVIDER_TEST_KEY_ID,
  buildProviderPublishPlan,
  emptyProviderHead,
  providerBodyDigest,
  providerOperationEnvelope,
  providerReleaseContext,
} from "./providerReleaseSecurity.test-support";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type ProviderTest = TestConvex<typeof schema>;
type ExecutionReference = FunctionReference<
  "mutation",
  "internal",
  {
    bodyJson: string;
    requestDigest: string;
    authenticatedKeyId: string;
  },
  unknown
>;

function createTest(): ProviderTest {
  return convexTest({ schema, modules, transactionLimits: true });
}

function configureProvider(originSetHash: string): void {
  vi.stubEnv("PACKSCOUT_PUBLIC_ORIGIN_SET_HASH", originSetHash);
  vi.stubEnv(
    "PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS",
    JSON.stringify({ [PROVIDER_TEST_KEY_ID]: "alpha" }),
  );
}

async function execute(
  t: ProviderTest,
  operation: ExecutionReference,
  request: unknown,
): Promise<unknown> {
  const bodyJson = canonicalJson(request);
  return await t.mutation(operation, {
    bodyJson,
    requestDigest: await providerBodyDigest(bodyJson),
    authenticatedKeyId: PROVIDER_TEST_KEY_ID,
  });
}

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

async function buildRepackPlan(input: {
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
  const collectorRepacks = selectedRepacks.map((detail) => {
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
        publicRepackId === collectorRepacks[0]!.publicRepackId
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
  const rows = collectorRepacks.map(repackSearchRowFromDetail);
  const searchShards = input.searchMode === "omitted"
    ? []
    : input.searchMode === "complete"
      ? [await searchShard(0, rows)]
      : await Promise.all(rows.map((row, index) => searchShard(index, [row])));
  const records: {
    [K in ProviderCatalogReleaseBatchKindV1]:
      readonly ProviderCatalogReleaseBatchRecordMapV1[K][];
  } = {
    vendors: [vendor],
    categories,
    collectibles,
    repacks: collectorRepacks,
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
    repacks: collectorRepacks.length,
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

function requests(plan: ProviderCatalogReleasePublishPlanV1) {
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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("provider release reconciliation", () => {
  test("accepts calculations through checkpoint but refuses missing search rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-15T03:00:00.000Z");
    const plan = await buildRepackPlan({
      calculatedAt: "2026-08-15T02:30:00.000Z",
      repackCount: 1,
      searchMode: "omitted",
    });
    configureProvider(plan.governingHashes.originSetHash);
    const t = createTest();
    const request = requests(plan);
    await execute(t, internal.providerReleaseStart.start, request.start);
    for (const batch of request.batches) {
      await execute(t, internal.providerReleaseBatch.applyBatch, batch);
    }
    await expect(execute(
      t,
      internal.providerReleaseFinalize.finalize,
      request.finalize,
    )).rejects.toThrow("PROVIDER_RELEASE_RECONCILIATION_FAILED");
    expect(await t.run((ctx) =>
      ctx.db.query("providerCatalogCompletedHeads").unique()
    )).toBeNull();

    const completePlan = await buildRepackPlan({
      calculatedAt: "2026-08-15T02:30:00.000Z",
      repackCount: 1,
      searchMode: "complete",
    });
    const completeTest = createTest();
    const completeRequests = requests(completePlan);
    await execute(
      completeTest,
      internal.providerReleaseStart.start,
      completeRequests.start,
    );
    for (const batch of completeRequests.batches) {
      await execute(
        completeTest,
        internal.providerReleaseBatch.applyBatch,
        batch,
      );
    }
    await expect(execute(
      completeTest,
      internal.providerReleaseFinalize.finalize,
      completeRequests.finalize,
    )).resolves.toMatchObject({ result: "completed" });
    expect(await completeTest.run((ctx) =>
      ctx.db.query("providerCatalogCompletedHeads").unique()
    )).toMatchObject({
      publicProviderReleaseId: completePlan.publicProviderReleaseId,
    });
  });

  test("rejects calculations after checkpoint and early search-shard splits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-15T03:00:00.000Z");
    const futurePlan = await buildRepackPlan({
      calculatedAt: "2026-08-15T03:00:00.001Z",
      repackCount: 1,
      searchMode: "omitted",
    });
    configureProvider(futurePlan.governingHashes.originSetHash);
    const futureTest = createTest();
    const futureRequests = requests(futurePlan);
    await execute(
      futureTest,
      internal.providerReleaseStart.start,
      futureRequests.start,
    );
    for (const batch of futureRequests.batches.slice(0, -1)) {
      await execute(futureTest, internal.providerReleaseBatch.applyBatch, batch);
    }
    await expect(execute(
      futureTest,
      internal.providerReleaseBatch.applyBatch,
      futureRequests.batches.at(-1),
    )).rejects.toThrow("PROVIDER_RELEASE_ENTITY_INVALID");

    const splitPlan = await buildRepackPlan({
      calculatedAt: "2026-08-15T02:30:00.000Z",
      repackCount: 2,
      searchMode: "early_split",
    });
    const splitTest = createTest();
    const splitRequests = requests(splitPlan);
    await execute(splitTest, internal.providerReleaseStart.start, splitRequests.start);
    for (const batch of splitRequests.batches.slice(0, -1)) {
      await execute(splitTest, internal.providerReleaseBatch.applyBatch, batch);
    }
    await expect(execute(
      splitTest,
      internal.providerReleaseBatch.applyBatch,
      splitRequests.batches.at(-1),
    )).rejects.toThrow("PROVIDER_RELEASE_BATCH_OUT_OF_ORDER");
    expect(await splitTest.run(async (ctx) => ({
      shards: (await ctx.db.query("providerCatalogSearchShards").collect()).length,
      proofs:
        (await ctx.db.query("providerCatalogSearchShardProofs").collect()).length,
    }))).toEqual({ shards: 0, proofs: 0 });
  });

  test("reconciles one top chase and rejects duplicate roles or understated inventory", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-15T03:00:00.000Z");
    const validPlan = await buildRepackPlan({
      calculatedAt: "2026-08-15T02:30:00.000Z",
      repackCount: 1,
      searchMode: "complete",
      chaseMode: "valid",
    });
    configureProvider(validPlan.governingHashes.originSetHash);
    const validTest = createTest();
    const validRequests = requests(validPlan);
    await execute(validTest, internal.providerReleaseStart.start, validRequests.start);
    for (const batch of validRequests.batches) {
      await execute(validTest, internal.providerReleaseBatch.applyBatch, batch);
    }
    await expect(execute(
      validTest,
      internal.providerReleaseFinalize.finalize,
      validRequests.finalize,
    )).resolves.toMatchObject({ result: "completed" });

    for (const chaseMode of [
      "duplicate_top",
      "insufficient_known",
    ] as const) {
      const plan = await buildRepackPlan({
        calculatedAt: "2026-08-15T02:30:00.000Z",
        repackCount: 1,
        searchMode: "complete",
        chaseMode,
      });
      const t = createTest();
      const request = requests(plan);
      const chaseBatchIndex = plan.batches.findIndex(
        ({ kind }) => kind === "repack_chases",
      );
      expect(chaseBatchIndex).toBeGreaterThan(0);
      await execute(t, internal.providerReleaseStart.start, request.start);
      for (const batch of request.batches.slice(0, chaseBatchIndex)) {
        await execute(t, internal.providerReleaseBatch.applyBatch, batch);
      }
      await expect(execute(
        t,
        internal.providerReleaseBatch.applyBatch,
        request.batches[chaseBatchIndex],
      )).rejects.toThrow("PROVIDER_RELEASE_RECONCILIATION_FAILED");
      expect(await t.run(async (ctx) => ({
        chases:
          (await ctx.db.query("providerCatalogRepackChases").collect()).length,
        reconciliation:
          await ctx.db.query("providerCatalogRepackReconciliation").unique(),
      }))).toMatchObject({
        chases: 0,
        reconciliation: {
          acceptedChaseCount: 0,
          acceptedTopChaseCount: 0,
          complete: false,
        },
      });
    }
  });
});
