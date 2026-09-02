/// <reference types="vite/client" />

import {
  canonicalJson,
  derivePublicProviderReleaseIdV1,
  extendProviderCatalogReleaseBatchChainV1,
  extendProviderCatalogReleaseEntityHashV1,
  providerCatalogReleaseBatchByteCount,
  recomputeProviderCatalogReleaseBatchHashV1,
  recomputeProviderCatalogReleaseContentHashV1,
  recomputeProviderCatalogReleaseFingerprintV1,
  verifyProviderCatalogReleasePlanV1,
  type ProviderCatalogReleaseBatchV1,
  type ProviderCatalogReleasePublishPlanV1,
  type PublicCategory,
} from "@packscout/contracts";
import type { FunctionReference } from "convex/server";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  buildProviderRepackPlan,
  providerRepackRequests,
} from "./providerReleaseReconciliation.test-support";
import {
  PROVIDER_TEST_KEY_ID,
  buildProviderPublishPlan,
  providerBodyDigest,
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
type RepackRequests = ReturnType<typeof providerRepackRequests>;
type BatchRequest = RepackRequests["batches"][number];
type CompactPublicationPatch = Partial<Pick<
  Doc<"providerCatalogPublications">,
  | "acceptedBatchCount"
  | "acceptedBatchChainHash"
  | "acceptedCounts"
  | "acceptedEntityHashes"
  | "acceptedSearchRowCount"
  | "unresolvedRepackCount"
  | "latestEvidenceAt"
>>;

function createTest(): ProviderTest {
  return convexTest({ schema, modules, transactionLimits: true });
}

function createReadBoundedTest(): ProviderTest {
  return convexTest({
    schema,
    modules,
    transactionLimits: { documentsRead: 32 },
  });
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

async function stageRelease(
  t: ProviderTest,
  request: RepackRequests,
): Promise<void> {
  await execute(t, internal.providerReleaseStart.start, request.start);
  for (const batch of request.batches) {
    await execute(t, internal.providerReleaseBatch.applyBatch, batch);
  }
}

async function expectFinalizationReconciliationFailure(
  t: ProviderTest,
  request: RepackRequests,
): Promise<void> {
  await expect(execute(
    t,
    internal.providerReleaseFinalize.finalize,
    request.finalize,
  )).rejects.toThrow("PROVIDER_RELEASE_RECONCILIATION_FAILED");
  expect(await t.run(async (ctx) => ({
    completedHead:
      await ctx.db.query("providerCatalogCompletedHeads").unique(),
    release: await ctx.db.query("providerCatalogReleases").unique(),
    publication:
      await ctx.db.query("providerCatalogPublications").unique(),
  }))).toMatchObject({
    completedHead: null,
    release: { lifecycle: "staging" },
    publication: { state: "staging" },
  });
}

async function withBatchRecords(
  request: BatchRequest,
  records: readonly unknown[],
): Promise<BatchRequest> {
  const batch = {
    ...request.batch,
    records,
    byteCount: providerCatalogReleaseBatchByteCount(records),
    batchHash: await recomputeProviderCatalogReleaseBatchHashV1({
      kind: request.batch.kind,
      records,
    }),
  } as ProviderCatalogReleaseBatchV1;
  return { ...request, batch };
}

async function publicationProgress(t: ProviderTest) {
  return await t.run(async (ctx) => {
    const publication =
      await ctx.db.query("providerCatalogPublications").unique();
    return publication === null
      ? null
      : {
        acceptedBatchCount: publication.acceptedBatchCount,
        acceptedBatchChainHash: publication.acceptedBatchChainHash,
        acceptedCounts: publication.acceptedCounts,
        acceptedEntityHashes: publication.acceptedEntityHashes,
        lastBatchKind: publication.lastBatchKind,
        lastRecordKey: publication.lastRecordKey,
        acceptedSearchRowCount: publication.acceptedSearchRowCount,
        unresolvedRepackCount: publication.unresolvedRepackCount,
        latestEvidenceAt: publication.latestEvidenceAt,
      };
  });
}

async function buildManyCategoryPlan(
  categoryCount: number,
): Promise<ProviderCatalogReleasePublishPlanV1> {
  const base = await buildProviderPublishPlan({ checkpointSequence: "40" });
  const categories: PublicCategory[] = Array.from(
    { length: categoryCount },
    (_, index) => {
      const suffix = String(index + 1).padStart(12, "0");
      const publicCategoryId = `20000000-0000-5000-8000-${suffix}`;
      return {
        publicCategoryId,
        parentPublicCategoryId: null,
        categoryKey: `bounded_category_${String(index).padStart(3, "0")}`,
        name: `Bounded category ${index}`,
        kind: "vertical",
        depth: 0,
        pathPublicCategoryIds: [publicCategoryId],
        displayOrder: index,
      };
    },
  );
  const byteCount = providerCatalogReleaseBatchByteCount(categories);
  const batchHash = await recomputeProviderCatalogReleaseBatchHashV1({
    kind: "categories",
    records: categories,
  });
  const categoryBatch: ProviderCatalogReleaseBatchV1 = {
    batchIndex: 1,
    kind: "categories",
    batchHash,
    byteCount,
    records: categories,
  };
  const entityHashes = {
    ...base.entityHashes,
    categories: await extendProviderCatalogReleaseEntityHashV1({
      previousHash: base.entityHashes.categories,
      kind: "categories",
      batchHash,
      recordCount: categories.length,
      byteCount,
    }),
  };
  const batchChainHash = await extendProviderCatalogReleaseBatchChainV1({
    previousHash: base.batchChainHash,
    batchIndex: categoryBatch.batchIndex,
    kind: categoryBatch.kind,
    batchHash,
    recordCount: categories.length,
    byteCount,
  });
  const identity = {
    platformKey: base.platformKey,
    sharedConfigurationEpoch: base.sharedConfigurationEpoch,
    dataAsOf: base.dataAsOf,
    contentHash:
      await recomputeProviderCatalogReleaseContentHashV1({ entityHashes }),
    publicAssetOrigins: base.publicAssetOrigins,
    governingHashes: base.governingHashes,
    entityHashes,
    counts: { ...base.counts, categories: categories.length },
    searchAlgorithmVersion: base.searchAlgorithmVersion,
    providerSearchIndexHash: base.providerSearchIndexHash,
    batchCount: 2,
    batchChainHash,
  } as const;
  const providerReleaseFingerprint =
    await recomputeProviderCatalogReleaseFingerprintV1(identity);
  const plan = {
    ...base,
    ...identity,
    providerReleaseFingerprint,
    publicProviderReleaseId: await derivePublicProviderReleaseIdV1(identity),
    batches: [base.batches[0]!, categoryBatch],
  };
  return await verifyProviderCatalogReleasePlanV1(plan) as
    ProviderCatalogReleasePublishPlanV1;
}

const boundedValidationCases = [
  {
    name: "category hierarchy",
    kind: "categories",
    error: "PROVIDER_RELEASE_REFERENCE_INVALID",
    mutate(batch: ProviderCatalogReleaseBatchV1): readonly unknown[] {
      if (batch.kind !== "categories") throw new Error("Expected categories.");
      return batch.records.map((record, index) =>
        index === 1
          ? {
            ...record,
            parentPublicCategoryId:
              "29999999-9999-5999-8999-999999999999",
            pathPublicCategoryIds: [
              "29999999-9999-5999-8999-999999999999",
              record.publicCategoryId,
            ],
          }
          : record
      );
    },
  },
  {
    name: "content mode",
    kind: "repacks",
    error: "PROVIDER_RELEASE_ENTITY_INVALID",
    mutate(batch: ProviderCatalogReleaseBatchV1): readonly unknown[] {
      if (batch.kind !== "repacks") throw new Error("Expected repacks.");
      return batch.records.map((record) => ({
        ...record,
        contentMode: record.contentMode === "mixed" ? "focused" : "mixed",
      }));
    },
  },
  {
    name: "record timing",
    kind: "repacks",
    error: "PROVIDER_RELEASE_ENTITY_INVALID",
    mutate(batch: ProviderCatalogReleaseBatchV1): readonly unknown[] {
      if (batch.kind !== "repacks") throw new Error("Expected repacks.");
      return batch.records.map((record) => ({
        ...record,
        sourceUpdatedAt: "2026-08-15T02:00:00.001Z",
      }));
    },
  },
] as const;

const terminalWitnessTamperCases = [
  { name: "missing terminal witness", tamper: "missing" },
  { name: "duplicate terminal witness", tamper: "duplicate" },
  { name: "terminal kind", tamper: "kind" },
  { name: "terminal chain hash", tamper: "chain_hash" },
  { name: "terminal entity hash", tamper: "entity_hash" },
  { name: "terminal record count", tamper: "record_count" },
] as const;

const compactProofTamperCases: readonly Readonly<{
  name: string;
  patch: (
    publication: Doc<"providerCatalogPublications">,
  ) => CompactPublicationPatch;
}>[] = [
  {
    name: "accepted batch count",
    patch: (publication) => ({
      acceptedBatchCount: publication.acceptedBatchCount - 1,
    }),
  },
  {
    name: "accepted batch chain hash",
    patch: () => ({ acceptedBatchChainHash: "0".repeat(64) }),
  },
  {
    name: "accepted counts",
    patch: (publication) => ({
      acceptedCounts: {
        ...publication.acceptedCounts,
        repacks: publication.acceptedCounts.repacks + 1,
      },
    }),
  },
  {
    name: "accepted entity hashes",
    patch: (publication) => ({
      acceptedEntityHashes: {
        ...publication.acceptedEntityHashes,
        repacks: "0".repeat(64),
      },
    }),
  },
  {
    name: "accepted search row count",
    patch: (publication) => ({
      acceptedSearchRowCount: publication.acceptedSearchRowCount + 1,
    }),
  },
  {
    name: "unresolved repack count",
    patch: () => ({ unresolvedRepackCount: 1 }),
  },
  {
    name: "future latest evidence time",
    patch: () => ({ latestEvidenceAt: "2026-08-15T03:00:00.001Z" }),
  },
];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("provider release finalization", () => {
  test.each(boundedValidationCases)(
    "rejects malformed $name in its bounded batch transaction",
    async ({ kind, error, mutate }) => {
      vi.useFakeTimers();
      vi.setSystemTime("2026-08-15T03:00:00.000Z");
      const plan = await buildProviderRepackPlan({
        calculatedAt: "2026-08-15T02:30:00.000Z",
        repackCount: 1,
        searchMode: "complete",
      });
      configureProvider(plan.governingHashes.originSetHash);
      const t = createTest();
      const request = providerRepackRequests(plan);
      const batchIndex = request.batches.findIndex(
        ({ batch }) => batch.kind === kind,
      );
      expect(batchIndex).toBeGreaterThan(0);
      await execute(t, internal.providerReleaseStart.start, request.start);
      for (const batch of request.batches.slice(0, batchIndex)) {
        await execute(t, internal.providerReleaseBatch.applyBatch, batch);
      }
      const before = await publicationProgress(t);
      const original = request.batches[batchIndex]!;
      const malformed = await withBatchRecords(original, mutate(original.batch));

      await expect(execute(
        t,
        internal.providerReleaseBatch.applyBatch,
        malformed,
      )).rejects.toThrow(error);
      expect(await publicationProgress(t)).toEqual(before);
      expect(await t.run(async (ctx) => ({
        batches:
          (await ctx.db.query("providerCatalogBatches").collect()).length,
        targetRows: kind === "categories"
          ? (await ctx.db.query("providerCatalogCategories").collect()).length
          : (await ctx.db.query("providerCatalogRepacks").collect()).length,
      }))).toEqual({ batches: batchIndex, targetRows: 0 });
    },
  );

  test("finalizes and exactly replays without reading the release-wide graph", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-15T12:00:00.000Z");
    const plan = await buildManyCategoryPlan(64);
    configureProvider(plan.governingHashes.originSetHash);
    const t = createReadBoundedTest();
    const request = providerRepackRequests(plan);
    await stageRelease(t, request);

    const receipt = await execute(
      t,
      internal.providerReleaseFinalize.finalize,
      request.finalize,
    );
    expect(receipt).toMatchObject({ result: "completed" });
    await expect(execute(
      t,
      internal.providerReleaseFinalize.finalize,
      request.finalize,
    )).resolves.toEqual(receipt);
    expect(await t.run((ctx) =>
      ctx.db.query("providerCatalogCompletedHeads").unique()
    )).toMatchObject({
      publicProviderReleaseId: plan.publicProviderReleaseId,
    });
  });

  test.each(terminalWitnessTamperCases)(
    "refuses $name corruption without completing",
    async ({ tamper }) => {
      vi.useFakeTimers();
      vi.setSystemTime("2026-08-15T03:00:00.000Z");
      const plan = await buildProviderRepackPlan({
        calculatedAt: "2026-08-15T02:30:00.000Z",
        repackCount: 1,
        searchMode: "complete",
      });
      configureProvider(plan.governingHashes.originSetHash);
      const t = createTest();
      const request = providerRepackRequests(plan);
      await stageRelease(t, request);
      await t.run(async (ctx) => {
        const release = await ctx.db.query("providerCatalogReleases").unique();
        if (release === null) throw new Error("Expected staged release.");
        const terminalBatches = await ctx.db
          .query("providerCatalogBatches")
          .withIndex("by_release_id_and_batch_index", (index) =>
            index
              .eq("releaseId", release._id)
              .eq("batchIndex", release.batchCount - 1)
          )
          .take(2);
        const terminal = terminalBatches[0];
        if (terminalBatches.length !== 1 || terminal === undefined) {
          throw new Error("Expected one terminal batch witness.");
        }
        switch (tamper) {
          case "missing":
            await ctx.db.delete("providerCatalogBatches", terminal._id);
            break;
          case "duplicate":
            await ctx.db.insert("providerCatalogBatches", {
              releaseId: terminal.releaseId,
              platformKey: terminal.platformKey,
              publicProviderReleaseId: terminal.publicProviderReleaseId,
              batchIndex: terminal.batchIndex,
              kind: terminal.kind,
              idempotencyKey: terminal.idempotencyKey,
              bodyHash: terminal.bodyHash,
              batchHash: terminal.batchHash,
              recordCount: terminal.recordCount,
              byteCount: terminal.byteCount,
              acceptedAt: terminal.acceptedAt,
              operationId: terminal.operationId,
              chainHash: terminal.chainHash,
              entityHash: terminal.entityHash,
            });
            break;
          case "kind":
            await ctx.db.patch("providerCatalogBatches", terminal._id, {
              kind: terminal.kind === "vendors" ? "categories" : "vendors",
            });
            break;
          case "chain_hash":
            await ctx.db.patch("providerCatalogBatches", terminal._id, {
              chainHash: "0".repeat(64),
            });
            break;
          case "entity_hash":
            await ctx.db.patch("providerCatalogBatches", terminal._id, {
              entityHash: "0".repeat(64),
            });
            break;
          case "record_count":
            await ctx.db.patch("providerCatalogBatches", terminal._id, {
              recordCount: 0,
            });
            break;
        }
      });

      await expectFinalizationReconciliationFailure(t, request);
    },
  );

  test.each(compactProofTamperCases)(
    "refuses compact publication proof tampering: $name",
    async ({ patch }) => {
      vi.useFakeTimers();
      vi.setSystemTime("2026-08-15T03:00:00.000Z");
      const plan = await buildProviderRepackPlan({
        calculatedAt: "2026-08-15T02:30:00.000Z",
        repackCount: 1,
        searchMode: "complete",
      });
      configureProvider(plan.governingHashes.originSetHash);
      const t = createTest();
      const request = providerRepackRequests(plan);
      await stageRelease(t, request);
      await t.run(async (ctx) => {
        const publication =
          await ctx.db.query("providerCatalogPublications").unique();
        if (publication === null) throw new Error("Expected publication.");
        await ctx.db.patch(
          "providerCatalogPublications",
          publication._id,
          patch(publication),
        );
      });

      await expectFinalizationReconciliationFailure(t, request);
    },
  );
});
