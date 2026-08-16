/// <reference types="vite/client" />

import {
  EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH,
  PROVIDER_CATALOG_RELEASE_BATCH_KINDS,
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  buildProviderCatalogSourceWatermarkV1,
  canonicalJson,
  derivePublicProviderReleaseIdV1,
  extendProviderCatalogReleaseBatchChainV1,
  extendProviderCatalogReleaseEntityHashV1,
  initializeProviderCatalogReleaseEntityHashV1,
  providerCatalogReleaseBatchByteCount,
  recomputeProviderCatalogReleaseBatchHashV1,
  recomputeProviderCatalogReleaseContentHashV1,
  recomputeProviderCatalogReleaseFingerprintV1,
  type ProviderCatalogReleaseBatchKindV1,
  type ProviderCatalogReleaseBatchV1,
  type ProviderCatalogReleaseIdentityInputV1,
  type ProviderCatalogReleasePublishPlanV1,
  type ProviderReleaseExpectedCompletedHeadV1,
  type ProviderReleaseImmutableProofV1,
} from "@packscout/contracts";
import type { FunctionReference } from "convex/server";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import { buildMockDataReleaseV2 } from "./mockDataReleaseFixture";
import {
  PROVIDER_BETA_TEST_KEY_ID,
  PROVIDER_TEST_KEY_ID,
  buildProviderPublishPlan,
  emptyProviderHead,
  providerBodyDigest,
  providerOperationEnvelope,
  providerReleaseContext,
  providerReleaseProof,
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
    JSON.stringify({
      [PROVIDER_TEST_KEY_ID]: "alpha",
      [PROVIDER_BETA_TEST_KEY_ID]: "beta",
    }),
  );
}

async function execute(
  t: ProviderTest,
  operation: ExecutionReference,
  request: unknown,
  authenticatedKeyId = PROVIDER_TEST_KEY_ID,
): Promise<unknown> {
  const bodyJson = canonicalJson(request);
  return await t.mutation(operation, {
    bodyJson,
    requestDigest: await providerBodyDigest(bodyJson),
    authenticatedKeyId,
  });
}

function mutationRequests(
  plan: ProviderCatalogReleasePublishPlanV1,
  expectedCompletedHead: ProviderReleaseExpectedCompletedHeadV1,
) {
  const suffix = `${plan.platformKey}:${plan.providerCheckpoint.settledSequence}`;
  const context = providerReleaseContext(plan, expectedCompletedHead);
  return {
    start: {
      ...providerOperationEnvelope(`provider:start:${suffix}`),
      ...context,
    },
    batch: {
      ...providerOperationEnvelope(`provider:batch:${suffix}:0`),
      ...context,
      batch: plan.batches[0]!,
    },
    finalize: {
      ...providerOperationEnvelope(`provider:finalize:${suffix}`),
      ...context,
    },
  };
}

async function completePlan(
  t: ProviderTest,
  plan: ProviderCatalogReleasePublishPlanV1,
  expected: ProviderReleaseExpectedCompletedHeadV1,
): Promise<void> {
  const requests = mutationRequests(plan, expected);
  await execute(t, internal.providerReleaseStart.start, requests.start);
  await execute(t, internal.providerReleaseBatch.applyBatch, requests.batch);
  await execute(t, internal.providerReleaseFinalize.finalize, requests.finalize);
}

async function expectedHead(
  t: ProviderTest,
  platformKey: string,
): Promise<ProviderReleaseExpectedCompletedHeadV1> {
  const head = await t.run((ctx) =>
    ctx.db
      .query("providerCatalogCompletedHeads")
      .withIndex("by_platform_key", (index) => index.eq("platformKey", platformKey))
      .unique()
  );
  if (head === null) return emptyProviderHead(platformKey);
  return {
    platformKey,
    publicProviderReleaseId: head.publicProviderReleaseId,
    sharedConfigurationEpoch: head.sharedConfigurationEpoch,
    providerCheckpoint: head.providerCheckpoint,
    observation: head.observation,
    terminalReceiptSha256: head.terminalReceiptSha256,
  };
}

function reuseRequest(
  plan: ProviderCatalogReleasePublishPlanV1,
  expected: ProviderReleaseExpectedCompletedHeadV1,
  checkpointSequence: string,
) {
  return {
    ...providerOperationEnvelope(`provider:reuse:${plan.platformKey}:${checkpointSequence}`),
    release: providerReleaseProof(plan),
    providerCheckpoint: {
      settledSequence: checkpointSequence,
      settledAt: "2026-08-15T12:10:00.000Z",
    },
    sourceWatermark: buildProviderCatalogSourceWatermarkV1(
      plan.platformKey,
      checkpointSequence,
    ),
    observation: {
      sourceHeadSequence: checkpointSequence,
      lastSuccessfulObservationAt: "2026-08-15T12:09:00.000Z",
      staleAt: "2026-08-15T12:24:00.000Z",
      freshness: "fresh" as const,
    },
    expectedCompletedHead: expected,
  };
}

async function buildNoncanonicalSplit() {
  const base = await buildProviderPublishPlan({
    checkpointSequence: "40",
    vendorDisplayName: "Split proof base",
  });
  const fixture = buildMockDataReleaseV2();
  const vendorRecords = [fixture.vendors[0]!];
  const categories = [...fixture.categories].sort((left, right) =>
    left.depth - right.depth ||
    left.publicCategoryId.localeCompare(right.publicCategoryId)
  );
  const firstCategoryRecords = [categories[0]!];
  const secondCategoryRecords = [categories[1]!];
  const batches: ProviderCatalogReleaseBatchV1[] = [
    {
      batchIndex: 0,
      kind: "vendors",
      records: vendorRecords,
      byteCount: providerCatalogReleaseBatchByteCount(vendorRecords),
      batchHash: await recomputeProviderCatalogReleaseBatchHashV1({
        kind: "vendors",
        records: vendorRecords,
      }),
    },
    {
      batchIndex: 1,
      kind: "categories",
      records: firstCategoryRecords,
      byteCount: providerCatalogReleaseBatchByteCount(firstCategoryRecords),
      batchHash: await recomputeProviderCatalogReleaseBatchHashV1({
        kind: "categories",
        records: firstCategoryRecords,
      }),
    },
    {
      batchIndex: 2,
      kind: "categories",
      records: secondCategoryRecords,
      byteCount: providerCatalogReleaseBatchByteCount(secondCategoryRecords),
      batchHash: await recomputeProviderCatalogReleaseBatchHashV1({
        kind: "categories",
        records: secondCategoryRecords,
      }),
    },
  ];
  const entityHashes = {} as Record<ProviderCatalogReleaseBatchKindV1, string>;
  for (const kind of PROVIDER_CATALOG_RELEASE_BATCH_KINDS) {
    entityHashes[kind] = await initializeProviderCatalogReleaseEntityHashV1(kind);
  }
  let batchChainHash = EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH;
  for (const batch of batches) {
    batchChainHash = await extendProviderCatalogReleaseBatchChainV1({
      previousHash: batchChainHash,
      batchIndex: batch.batchIndex,
      kind: batch.kind,
      batchHash: batch.batchHash,
      recordCount: batch.records.length,
      byteCount: batch.byteCount,
    });
    entityHashes[batch.kind] = await extendProviderCatalogReleaseEntityHashV1({
      previousHash: entityHashes[batch.kind],
      kind: batch.kind,
      batchHash: batch.batchHash,
      recordCount: batch.records.length,
      byteCount: batch.byteCount,
    });
  }
  const identity: ProviderCatalogReleaseIdentityInputV1 = {
    ...providerReleaseProof(base),
    entityHashes,
    counts: { ...base.counts, vendors: 1, categories: categories.slice(0, 2).length },
    contentHash: await recomputeProviderCatalogReleaseContentHashV1({ entityHashes }),
    batchCount: batches.length,
    batchChainHash,
  };
  const providerReleaseFingerprint =
    await recomputeProviderCatalogReleaseFingerprintV1(identity);
  const release: ProviderReleaseImmutableProofV1 = {
    ...identity,
    publicAssetOrigins: [...identity.publicAssetOrigins],
    providerReleaseFingerprint,
    publicProviderReleaseId: await derivePublicProviderReleaseIdV1(identity),
  };
  return {
    release,
    providerCheckpoint: base.providerCheckpoint,
    sourceWatermark: base.sourceWatermark,
    observation: base.observation,
    batches,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("provider release lifecycle invariants", () => {
  test("rejects corrupted batch cursors and non-greedy same-kind partitions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-15T12:00:00.000Z");
    const plan = await buildProviderPublishPlan();
    configureProvider(plan.governingHashes.originSetHash);
    const t = createTest();
    const requests = mutationRequests(plan, emptyProviderHead(plan.platformKey));
    await execute(t, internal.providerReleaseStart.start, requests.start);
    await t.run(async (ctx) => {
      const publication = await ctx.db
        .query("providerCatalogPublications")
        .withIndex("by_public_provider_release_id", (index) =>
          index.eq("publicProviderReleaseId", plan.publicProviderReleaseId)
        )
        .unique();
      await ctx.db.patch(publication!._id, { lastBatchKind: "corrupt_kind" });
    });
    await expect(
      execute(t, internal.providerReleaseBatch.applyBatch, requests.batch),
    ).rejects.toThrow("PROVIDER_RELEASE_BATCH_OUT_OF_ORDER");
    expect(await t.run((ctx) => ctx.db.query("providerCatalogVendors").first()))
      .toBeNull();

    const split = await buildNoncanonicalSplit();
    configureProvider(split.release.governingHashes.originSetHash);
    const splitTest = createTest();
    const context = {
      release: split.release,
      providerCheckpoint: split.providerCheckpoint,
      sourceWatermark: split.sourceWatermark,
      observation: split.observation,
      expectedCompletedHead: emptyProviderHead(split.release.platformKey),
    };
    await execute(splitTest, internal.providerReleaseStart.start, {
      ...providerOperationEnvelope("provider:start:split"),
      ...context,
    });
    await execute(splitTest, internal.providerReleaseBatch.applyBatch, {
      ...providerOperationEnvelope("provider:batch:split:0"),
      ...context,
      batch: split.batches[0],
    });
    await execute(splitTest, internal.providerReleaseBatch.applyBatch, {
      ...providerOperationEnvelope("provider:batch:split:1"),
      ...context,
      batch: split.batches[1],
    });
    await expect(execute(splitTest, internal.providerReleaseBatch.applyBatch, {
      ...providerOperationEnvelope("provider:batch:split:2"),
      ...context,
      batch: split.batches[2],
    })).rejects.toThrow("PROVIDER_RELEASE_BATCH_OUT_OF_ORDER");
  });

  test("serializes one platform while completing different platform heads independently", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-15T12:00:00.000Z");
    const [alpha, beta, alphaNext] = await Promise.all([
      buildProviderPublishPlan(),
      buildProviderPublishPlan({ platformKey: "beta" }),
      buildProviderPublishPlan({
        checkpointSequence: "30",
        publicChangeSequence: "11",
        vendorDisplayName: "New epoch vendor",
      }),
    ]);
    configureProvider(alpha.governingHashes.originSetHash);
    const t = createTest();
    const emptyAlpha = emptyProviderHead("alpha");
    const emptyBeta = emptyProviderHead("beta");
    const alphaRequests = mutationRequests(alpha, emptyAlpha);
    const betaRequests = mutationRequests(beta, emptyBeta);
    await execute(t, internal.providerReleaseStart.start, alphaRequests.start);
    await execute(
      t,
      internal.providerReleaseStart.start,
      betaRequests.start,
      PROVIDER_BETA_TEST_KEY_ID,
    );
    await expect(execute(
      t,
      internal.providerReleaseStart.start,
      mutationRequests(alphaNext, emptyAlpha).start,
    )).rejects.toThrow("PROVIDER_RELEASE_OPERATION_CONFLICT");
    await execute(t, internal.providerReleaseBatch.applyBatch, alphaRequests.batch);
    await execute(t, internal.providerReleaseFinalize.finalize, alphaRequests.finalize);
    await execute(
      t,
      internal.providerReleaseBatch.applyBatch,
      betaRequests.batch,
      PROVIDER_BETA_TEST_KEY_ID,
    );
    await execute(
      t,
      internal.providerReleaseFinalize.finalize,
      betaRequests.finalize,
      PROVIDER_BETA_TEST_KEY_ID,
    );

    const betaBefore = await expectedHead(t, "beta");
    const alphaHead = await expectedHead(t, "alpha");
    await completePlan(t, alphaNext, alphaHead);
    expect((await expectedHead(t, "alpha")).sharedConfigurationEpoch)
      .toEqual(alphaNext.sharedConfigurationEpoch);
    expect(await expectedHead(t, "beta")).toEqual(betaBefore);
    expect(await t.run((ctx) => ctx.db.query("providerCatalogCompletedHeads").collect()))
      .toHaveLength(2);
  });

  test("binds finalize CAS to the full prior head after reuse advances it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-15T12:00:00.000Z");
    const first = await buildProviderPublishPlan();
    configureProvider(first.governingHashes.originSetHash);
    const t = createTest();
    await completePlan(t, first, emptyProviderHead(first.platformKey));
    const prior = await expectedHead(t, first.platformKey);
    const next = await buildProviderPublishPlan({
      checkpointSequence: "30",
      vendorDisplayName: "Staged against old head",
    });
    const nextRequests = mutationRequests(next, prior);
    await execute(t, internal.providerReleaseStart.start, nextRequests.start);
    await execute(t, internal.providerReleaseBatch.applyBatch, nextRequests.batch);
    await execute(
      t,
      internal.providerReleaseFinalize.confirmReuse,
      reuseRequest(first, prior, "21"),
    );
    await expect(execute(
      t,
      internal.providerReleaseFinalize.finalize,
      nextRequests.finalize,
    )).rejects.toThrow("PROVIDER_RELEASE_PREDECESSOR_CONFLICT");
    expect((await expectedHead(t, "alpha")).providerCheckpoint.settledSequence)
      .toBe("21");
  });

  test("requires the original finalize proof even after a successful reuse", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-15T12:00:00.000Z");
    const plan = await buildProviderPublishPlan();
    configureProvider(plan.governingHashes.originSetHash);
    const t = createTest();
    await completePlan(t, plan, emptyProviderHead(plan.platformKey));
    const firstHead = await expectedHead(t, plan.platformKey);
    const reuse = reuseRequest(plan, firstHead, "21");
    const firstReuse = await execute(
      t,
      internal.providerReleaseFinalize.confirmReuse,
      reuse,
    );
    const currentHead = await expectedHead(t, plan.platformKey);
    await t.run(async (ctx) => {
      const finalize = await ctx.db
        .query("providerCatalogOperations")
        .withIndex("by_platform_key_and_public_provider_release_id_and_kind", (index) =>
          index
            .eq("platformKey", plan.platformKey)
            .eq("publicProviderReleaseId", plan.publicProviderReleaseId)
            .eq("kind", "finalize")
        )
        .unique();
      await ctx.db.delete(finalize!._id);
    });
    await expect(execute(
      t,
      internal.providerReleaseFinalize.confirmReuse,
      reuse,
    )).resolves.toEqual(firstReuse);
    await expect(execute(
      t,
      internal.providerReleaseFinalize.confirmReuse,
      reuseRequest(plan, currentHead, "22"),
    )).rejects.toThrow("PROVIDER_RELEASE_STATE_CONFLICT");
    await expect(execute(t, internal.providerReleaseRead.completedHead, {
      schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
      operationId: "provider:head:corrupt-completion",
      platformKey: plan.platformKey,
    })).rejects.toThrow("PROVIDER_RELEASE_STATE_CONFLICT");
  });

  test("keeps block decisions durable while expired blocked staging is cleaned", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-15T12:00:00.000Z");
    const plan = await buildProviderPublishPlan();
    configureProvider(plan.governingHashes.originSetHash);
    const t = createTest();
    const expected = emptyProviderHead(plan.platformKey);
    const requests = mutationRequests(plan, expected);
    await execute(t, internal.providerReleaseStart.start, requests.start);
    await execute(t, internal.providerReleaseBatch.applyBatch, requests.batch);
    await execute(t, internal.providerReleaseBlock.block, {
      ...providerOperationEnvelope("provider:block:before-finalize"),
      ...providerReleaseContext(plan, expected),
      blockSequence: "1",
      reason: "PUBLICATION_SECURITY_INVALID",
    });
    await expect(execute(
      t,
      internal.providerReleaseFinalize.finalize,
      requests.finalize,
    )).rejects.toThrow("PROVIDER_RELEASE_FINGERPRINT_BLOCKED");
    await expect(execute(t, internal.providerReleaseStart.start, {
      ...requests.start,
      operationId: "provider:start:blocked-again-before-expiry",
      idempotencyKey: "provider:start:blocked-again-before-expiry",
    })).rejects.toThrow("PROVIDER_RELEASE_FINGERPRINT_BLOCKED");

    vi.setSystemTime("2026-08-16T13:00:00.000Z");
    await expect(execute(t, internal.providerReleaseCleanup.cleanup, {
      ...providerOperationEnvelope("provider:cleanup:blocked-staging"),
      platformKey: plan.platformKey,
      expectedCompletedHead: expected,
      cleanupKind: "expired_provider_artifacts",
      maximumDocuments: 100,
    })).resolves.toMatchObject({
      terminalState: "complete",
      result: "cleaned",
      details: { hasMore: false },
    });
    await expect(execute(t, internal.providerReleaseStart.start, {
      ...requests.start,
      operationId: "provider:start:blocked-again-after-cleanup",
      idempotencyKey: "provider:start:blocked-again-after-cleanup",
    })).rejects.toThrow("PROVIDER_RELEASE_FINGERPRINT_BLOCKED");

    const replacement = await buildProviderPublishPlan({
      checkpointSequence: "21",
      vendorDisplayName: "Safe replacement after blocked cleanup",
    });
    const replacementRequests = mutationRequests(replacement, expected);
    await expect(execute(
      t,
      internal.providerReleaseStart.start,
      replacementRequests.start,
    )).resolves.toMatchObject({ result: "created" });
    expect(await t.run(async (ctx) => ({
      releases: (await ctx.db.query("providerCatalogReleases").collect()).length,
      operations: (await ctx.db.query("providerCatalogOperations").collect()).length,
      blocks: (await ctx.db.query("providerCatalogReleaseBlocks").collect()).length,
    }))).toEqual({ releases: 1, operations: 5, blocks: 1 });
  });
});
