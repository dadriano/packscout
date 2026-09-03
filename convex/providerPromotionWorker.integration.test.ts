// @vitest-environment node
/// <reference types="vite/client" />

import {
  PROVIDER_PUBLIC_PROFILE_HASH_DOMAIN,
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  canonicalJson,
  globalCategoryPublicId,
  packscoutPublicIdentityUuid,
  providerReleaseCatalogPinHash,
  providerReleaseCorrelationSnapshotHash,
  publicVendorSchema,
  recomputeProviderCatalogReleaseOriginSetHashV1,
  sha256CanonicalJson,
} from "@packscout/contracts";
import {
  PrismaProviderPromotionJobRepository,
  PrismaProviderRuntimeRepository,
  ProviderCanonicalRepository,
  type PinnedProviderReleaseInputs,
  type ProviderPrismaClient,
} from "@packscout/database";
import { SignedConvexProviderReleasePublicationClient } from
  "@packscout/services";
import { createProviderHarness } from "@packscout/database/test-support";
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import {
  readProviderPublicationJobAuthorityConfiguration,
} from "../apps/worker/src/distributed-promotion-authority-config.ts";
import { createProviderPromotionJobRuntime } from
  "../apps/worker/src/provider-promotion-job-runtime-composition.ts";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const providerConfigVersionId = "91000000-0000-4000-8000-000000000001";
const publicProfileVersionId = "91000000-0000-4000-8000-000000000002";
const catalogVersionId = "91000000-0000-4000-8000-000000000003";
const globalCategoryId = "91000000-0000-4000-8000-000000000004";
const keyId = "provider.worker.e2e.v1";

afterEach(() => {
  vi.unstubAllEnvs();
});

async function configureProviderRuntime(input: Readonly<{
  client: ProviderPrismaClient;
  providerId: string;
  providerKey: string;
  observedAt: Date;
}>): Promise<void> {
  await new PrismaProviderRuntimeRepository(input.client)
    .synchronizeConfiguration({
      centralProviderId: input.providerId,
      providerKey: input.providerKey,
      configVersionId: providerConfigVersionId,
      configVersionNumber: 1n,
      configuration: { adapterKey: "promotion-worker-e2e" },
      expiresAt: null,
      scheduleSeconds: 300,
      nextDueAt: null,
      synchronizedAt: input.observedAt,
    });
  await input.client.provider_runtime.update({
    where: { singleton_key: true },
    data: {
      last_head_reached_at: input.observedAt,
      last_attempted_at: input.observedAt,
      freshness_state: "fresh",
      row_version: { increment: 1n },
    },
  });
}

async function releasePin(input: Readonly<{
  providerId: string;
  providerKey: string;
  categoryId: string;
  categoryRowVersion: bigint;
}>): Promise<PinnedProviderReleaseInputs> {
  const publicProvider = publicVendorSchema.parse({
    publicVendorId: packscoutPublicIdentityUuid(
      `provider:${input.providerId}`,
    ),
    vendorKey: input.providerKey,
    displayName: "Worker promotion fixture",
    logoUrl: null,
    websiteUrl: "https://fixture.example",
    listingHosts: ["fixture.example"],
    imageOrigins: [],
    referralParameters: [],
    publicPromo: null,
  });
  const publicCategoryId = globalCategoryPublicId(globalCategoryId);
  const catalogCategories: PinnedProviderReleaseInputs["catalogCategories"] = [{
    publicCategoryId,
    parentPublicCategoryId: null,
    categoryKey: "cards",
    displayName: "Cards",
    categoryKind: "vertical",
    displayOrder: 0,
    depth: 0,
    pathPublicCategoryIds: [publicCategoryId],
    lifecycle: "active",
  }];
  const categoryCorrelations = [{
    localCategoryId: input.categoryId,
    localEntityVersion: input.categoryRowVersion,
    publicCategoryId,
  }];
  const catalogContentHash = "a".repeat(64);
  const catalogThroughChangeSequence = 1n;
  const correlationEventSequence = 1n;
  return {
    providerId: input.providerId,
    providerKey: input.providerKey,
    providerConfigVersionId,
    providerConfigExpiresAt: null,
    staleAfterSeconds: 900,
    centralSchemaVersion: "distributed-central-v1",
    catalogVersionId,
    catalogSchemaVersion: "catalog-v1",
    catalogContentHash,
    catalogThroughChangeSequence,
    catalogCategories,
    catalogCollectibles: [],
    catalogAliases: [],
    catalogArtifactVerificationHash: await providerReleaseCatalogPinHash({
      catalogVersionId,
      catalogSchemaVersion: "catalog-v1",
      catalogContentHash,
      catalogThroughChangeSequence: catalogThroughChangeSequence.toString(),
      categories: catalogCategories,
      collectibles: [],
      aliases: [],
    }),
    correlationEventSequence,
    correlationSnapshotHash: await providerReleaseCorrelationSnapshotHash({
      providerId: input.providerId,
      correlationEventSequence: correlationEventSequence.toString(),
      categories: categoryCorrelations.map((row) => ({
        ...row,
        localEntityVersion: row.localEntityVersion.toString(),
      })),
      collectibles: [],
    }),
    categoryCorrelations,
    collectibleCorrelations: [],
    publicProfileVersionId,
    publicProfileHash: await sha256CanonicalJson(
      PROVIDER_PUBLIC_PROFILE_HASH_DOMAIN,
      publicProvider,
    ),
    publicProvider,
  };
}

test(
  "a canonical PostgreSQL delta runs through the provider worker into Convex",
  { timeout: 60_000 },
  async (context) => {
    let harness: Awaited<ReturnType<typeof createProviderHarness>>;
    try {
      harness = await createProviderHarness();
    } catch (error) {
      if (process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL === undefined) {
        context.skip("PostgreSQL 16 test infrastructure is not available.");
        return;
      }
      throw error;
    }

    const secret = new Uint8Array(Buffer.alloc(32, 91));
    let runtime: ReturnType<typeof createProviderPromotionJobRuntime>["runtime"]
      | undefined;
    try {
      const observedAt = new Date();
      const convex = convexTest({ schema, modules, transactionLimits: true });
      await configureProviderRuntime({
        client: harness.client,
        providerId: harness.providerId,
        providerKey: harness.providerKey,
        observedAt,
      });
      const canonical = new ProviderCanonicalRepository(harness.client);
      const category = await canonical.upsertCategory({
        categoryKey: "cards",
        parentCategoryId: null,
        displayName: "Cards",
      });
      await canonical.upsertPack({
        packKey: "worker-promotion-fixture",
        categoryId: category.id,
        familyKey: null,
        displayName: "Promoted directly by the new worker",
        description: "Disposable PostgreSQL to Convex integration proof",
        packFormat: "repack",
        availability: "available",
        contentEvidence: "complete",
        totalInventory: 10n,
        remainingInventory: 7n,
        priceAmount: "100",
        priceCurrency: "USD",
        priceUsdAmount: "100",
        priceUnavailableReason: null,
        buybackRate: null,
        buybackSourceKind: null,
        vendorEvAmount: "120",
        vendorEvCurrency: "USD",
        vendorEvObservedAt: observedAt,
        vendorEvUnavailableReason: null,
        packscoutEvAmount: null,
        packscoutEvCurrency: null,
        packscoutEvModelVersion: "model-v1",
        packscoutEvConfidencePolicyVersion: "policy-v1",
        packscoutEvConfidence: null,
        packscoutEvDataAsOf: null,
        packscoutEvCalculatedAt: null,
        packscoutEvUnavailableReason: "ESTIMATE_INPUT_INCOMPLETE",
        primaryImageUrl: null,
        primaryImageAlt: null,
        listingUrl: "https://fixture.example/worker-promotion-fixture",
        attributes: { source: "provider-worker-e2e" },
        sourceUpdatedAt: observedAt,
      });

      const pin = await releasePin({
        providerId: harness.providerId,
        providerKey: harness.providerKey,
        categoryId: category.id,
        categoryRowVersion: category.rowVersion,
      });
      const originSetHash =
        await recomputeProviderCatalogReleaseOriginSetHashV1([]);
      vi.stubEnv("PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS", canonicalJson({
        [keyId]: Buffer.from(secret).toString("base64"),
      }));
      vi.stubEnv("PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS", canonicalJson({
        [keyId]: harness.providerKey,
      }));
      vi.stubEnv("PACKSCOUT_PUBLIC_ORIGIN_SET_HASH", originSetHash);

      const authority = readProviderPublicationJobAuthorityConfiguration({
        PACKSCOUT_CONVEX_PUBLICATION_BASE_URL: "https://convex.example",
        PACKSCOUT_CATALOG_DEPLOYMENT_KEY: "provider-worker-e2e",
        PACKSCOUT_PROMOTION_PROVIDER_ID: harness.providerId,
        PACKSCOUT_PROMOTION_PROVIDER_KEY_ID: keyId,
        PACKSCOUT_PROMOTION_PROVIDER_SECRET_BASE64:
          Buffer.from(secret).toString("base64"),
        PACKSCOUT_PROMOTION_PROVIDER_AUTHORITY_VERSION: "e2e-v1",
      });
      const testFetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
        const url = request instanceof Request
          ? new URL(request.url)
          : new URL(request.toString());
        return await convex.fetch(`${url.pathname}${url.search}`, init);
      }) as typeof fetch;
      const transport = new SignedConvexProviderReleasePublicationClient({
        baseUrl: "http://127.0.0.1",
        keyId,
        secret,
        fetch: testFetch,
      });
      const composed = createProviderPromotionJobRuntime({
        authority,
        provider: harness.client,
        pin,
        loadPin: async () => pin,
        workerId: "provider-promotion:e2e",
        logger: { log() {} },
        manualCommands: {
          async verify() {
            return { state: "rejected", failureCode: "NOT_USED" };
          },
        },
        transport,
        now: () => observedAt,
      });
      runtime = composed.runtime;

      const wake = await new PrismaProviderPromotionJobRepository(
        harness.client,
      ).loadWakeIntent();
      expect(wake.pending).toBe(true);
      const cycle = await runtime.runCycle();
      expect(cycle).toMatchObject({
        reconciliationFailures: 0,
        stateReadFailures: 0,
        invocations: [{
          triggerKind: "change_wake",
          state: "completed",
          outcome: "caught_up",
          failureCode: null,
        }],
      });

      const [lane, publication, terminalInvocation] = await Promise.all([
        harness.client.promotion_ledger.findUniqueOrThrow({
          where: { singleton_key: true },
        }),
        harness.client.provider_publication_state.findUniqueOrThrow({
          where: { singleton_key: true },
        }),
        harness.client.provider_promotion_job_invocations.findFirstOrThrow({
          where: { lifecycle_state: "terminal" },
          orderBy: { requested_at: "desc" },
        }),
      ]);
      expect(publication.completed_through_change_sequence)
        .toBe(lane.last_sequence);
      expect(terminalInvocation.outcome).toBe("caught_up");

      const head = await transport.completedHead({
        schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
        operationId: "provider-worker-e2e-completed-head",
        platformKey: harness.providerKey,
      });
      expect(head.receipt.details.head.release).not.toBeNull();
      expect(head.receipt.details.head.providerCheckpoint.settledSequence)
        .toBe(lane.last_sequence.toString());
      const convexRows = await convex.run(async (ctx) => ({
        heads: await ctx.db.query("providerCatalogCompletedHeads").collect(),
        releases: await ctx.db.query("providerCatalogReleases").collect(),
        repacks: await ctx.db.query("providerCatalogRepacks").collect(),
        operations: await ctx.db.query("providerCatalogOperations").collect(),
      }));
      expect(convexRows.heads).toHaveLength(1);
      expect(convexRows.releases).toHaveLength(1);
      expect(convexRows.repacks).toHaveLength(1);
      expect(convexRows.repacks[0]?.detail.name)
        .toBe("Promoted directly by the new worker");
      expect(convexRows.operations.length).toBeGreaterThanOrEqual(3);
    } finally {
      try {
        runtime?.stop();
      } finally {
        secret.fill(0);
        await harness.close();
      }
    }
  },
);
