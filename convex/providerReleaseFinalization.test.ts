/// <reference types="vite/client" />

import { canonicalJson } from "@packscout/contracts";
import type { FunctionReference } from "convex/server";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import {
  buildProviderRepackPlan,
  providerRepackRequests,
} from "./providerReleaseReconciliation.test-support";
import {
  PROVIDER_TEST_KEY_ID,
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

async function stageRelease(
  t: ProviderTest,
  request: ReturnType<typeof providerRepackRequests>,
): Promise<void> {
  await execute(t, internal.providerReleaseStart.start, request.start);
  for (const batch of request.batches) {
    await execute(t, internal.providerReleaseBatch.applyBatch, batch);
  }
}

const tamperCases = [
  {
    name: "category hierarchy",
    apply: async (t: ProviderTest) => {
      await t.run(async (ctx) => {
        const categories = await ctx.db
          .query("providerCatalogCategories")
          .take(3);
        const child = categories.find(
          ({ detail }) => detail.parentPublicCategoryId !== null,
        )!;
        await ctx.db.patch(child._id, {
          parentCategoryId: null,
          detail: { ...child.detail, parentPublicCategoryId: null },
        });
      });
    },
  },
  {
    name: "content mode",
    apply: async (t: ProviderTest) => {
      await t.run(async (ctx) => {
        const repack = (await ctx.db.query("providerCatalogRepacks").take(1))[0]!;
        await ctx.db.patch(repack._id, {
          detail: {
            ...repack.detail,
            contentMode: repack.detail.contentMode === "mixed"
              ? "focused"
              : "mixed",
          },
        });
      });
    },
  },
  {
    name: "record timing",
    apply: async (t: ProviderTest) => {
      await t.run(async (ctx) => {
        const repack = (await ctx.db.query("providerCatalogRepacks").take(1))[0]!;
        await ctx.db.patch(repack._id, {
          detail: {
            ...repack.detail,
            sourceUpdatedAt: "2026-08-15T02:00:00.001Z",
          },
        });
      });
    },
  },
  {
    name: "top-chase role",
    apply: async (t: ProviderTest) => {
      await t.run(async (ctx) => {
        const chases = await ctx.db
          .query("providerCatalogRepackChases")
          .take(10);
        const nonTop = chases.find(({ detail }) => detail.role !== "top_chase")!;
        await ctx.db.patch(nonTop._id, {
          detail: { ...nonTop.detail, role: "top_chase" },
        });
      });
    },
  },
  {
    name: "known collectible count",
    apply: async (t: ProviderTest) => {
      await t.run(async (ctx) => {
        const repack = (await ctx.db.query("providerCatalogRepacks").take(1))[0]!;
        await ctx.db.patch(repack._id, {
          detail: {
            ...repack.detail,
            contentSummary: {
              ...repack.detail.contentSummary,
              knownCollectibleCount: 0,
            },
          },
        });
      });
    },
  },
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("provider release finalization", () => {
  test.each(tamperCases)(
    "rejects non-empty $name tampering without completing the release",
    async ({ apply }) => {
      vi.useFakeTimers();
      vi.setSystemTime("2026-08-15T03:00:00.000Z");
      const plan = await buildProviderRepackPlan({
        calculatedAt: "2026-08-15T02:30:00.000Z",
        repackCount: 1,
        searchMode: "complete",
        chaseMode: "valid",
      });
      configureProvider(plan.governingHashes.originSetHash);
      const t = createTest();
      const request = providerRepackRequests(plan);
      await stageRelease(t, request);
      await apply(t);

      await expect(execute(
        t,
        internal.providerReleaseFinalize.finalize,
        request.finalize,
      )).rejects.toThrow("PROVIDER_RELEASE_RECONCILIATION_FAILED");
      expect(await t.run(async (ctx) => ({
        completedHead:
          await ctx.db.query("providerCatalogCompletedHeads").unique(),
        release:
          await ctx.db.query("providerCatalogReleases").unique(),
        publication:
          await ctx.db.query("providerCatalogPublications").unique(),
      }))).toMatchObject({
        completedHead: null,
        release: { lifecycle: "staging" },
        publication: { state: "staging" },
      });
    },
  );
});
