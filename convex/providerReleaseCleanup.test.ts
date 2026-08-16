/// <reference types="vite/client" />

import { canonicalJson } from "@packscout/contracts";
import type { FunctionReference } from "convex/server";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
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

describe("provider release cleanup safety", () => {
  test("fails a staging release before bounded deletion can invalidate its proofs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-15T12:00:00.000Z");
    const plan = await buildProviderPublishPlan();
    vi.stubEnv(
      "PACKSCOUT_PUBLIC_ORIGIN_SET_HASH",
      plan.governingHashes.originSetHash,
    );
    vi.stubEnv(
      "PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS",
      JSON.stringify({ [PROVIDER_TEST_KEY_ID]: plan.platformKey }),
    );
    const t = createTest();
    const expected = emptyProviderHead(plan.platformKey);
    const context = providerReleaseContext(plan, expected);
    const start = {
      ...providerOperationEnvelope("provider:start:cleanup-atomicity"),
      ...context,
    };
    const batch = {
      ...providerOperationEnvelope("provider:batch:cleanup-atomicity:0"),
      ...context,
      batch: plan.batches[0]!,
    };
    const finalize = {
      ...providerOperationEnvelope("provider:finalize:cleanup-atomicity"),
      ...context,
    };
    await execute(t, internal.providerReleaseStart.start, start);
    const batchReceipt = await execute(
      t,
      internal.providerReleaseBatch.applyBatch,
      batch,
    );

    vi.setSystemTime("2026-08-16T13:00:00.000Z");
    const cleanupContext = {
      platformKey: plan.platformKey,
      expectedCompletedHead: expected,
      cleanupKind: "expired_provider_artifacts" as const,
    };
    const firstCleanup = await execute(t, internal.providerReleaseCleanup.cleanup, {
      ...providerOperationEnvelope("provider:cleanup:atomicity:1"),
      ...cleanupContext,
      maximumDocuments: 1,
    });
    expect(firstCleanup).toMatchObject({
      terminalState: "continuation_required",
      details: {
        deletedDocumentCount: 1,
        deletedStagingDocumentCount: 1,
        hasMore: true,
      },
    });
    expect(await t.run(async (ctx) => ({
      release: await ctx.db.query("providerCatalogReleases").unique(),
      publication:
        await ctx.db.query("providerCatalogPublications").unique(),
      vendor: await ctx.db.query("providerCatalogVendors").unique(),
      head: await ctx.db.query("providerCatalogCompletedHeads").unique(),
    }))).toMatchObject({
      release: { lifecycle: "failed" },
      publication: { state: "failed" },
      vendor: null,
      head: null,
    });

    await expect(execute(
      t,
      internal.providerReleaseBatch.applyBatch,
      batch,
    )).resolves.toEqual(batchReceipt);
    await expect(execute(t, internal.providerReleaseBatch.applyBatch, {
      ...batch,
      operationId: "provider:batch:cleanup-atomicity:new",
      idempotencyKey: "provider:batch:cleanup-atomicity:new",
    })).rejects.toThrow("PROVIDER_RELEASE_STATE_CONFLICT");
    await expect(execute(
      t,
      internal.providerReleaseFinalize.finalize,
      finalize,
    )).rejects.toThrow("PROVIDER_RELEASE_STATE_CONFLICT");
    expect(await t.run((ctx) =>
      ctx.db.query("providerCatalogCompletedHeads").unique()
    )).toBeNull();

    const secondCleanup = await execute(t, internal.providerReleaseCleanup.cleanup, {
      ...providerOperationEnvelope("provider:cleanup:atomicity:2"),
      ...cleanupContext,
      maximumDocuments: 100,
    });
    expect(secondCleanup).toMatchObject({
      terminalState: "complete",
      details: {
        deletedDocumentCount: 3,
        deletedFailedDocumentCount: 3,
        hasMore: false,
      },
    });
    expect(await t.run(async (ctx) => ({
      releases: (await ctx.db.query("providerCatalogReleases").collect()).length,
      publications:
        (await ctx.db.query("providerCatalogPublications").collect()).length,
      batches: (await ctx.db.query("providerCatalogBatches").collect()).length,
      operations:
        (await ctx.db.query("providerCatalogOperations").collect()).length,
    }))).toEqual({ releases: 0, publications: 0, batches: 0, operations: 4 });
  });
});
