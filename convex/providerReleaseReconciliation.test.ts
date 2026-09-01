/// <reference types="vite/client" />

import { canonicalJson } from "@packscout/contracts";
import type { FunctionReference } from "convex/server";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import {
  PROVIDER_TEST_KEY_ID,
  providerBodyDigest,
} from "./providerReleaseSecurity.test-support";
import {
  buildProviderRepackPlan as buildRepackPlan,
  providerRepackRequests as requests,
} from "./providerReleaseReconciliation.test-support";
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
