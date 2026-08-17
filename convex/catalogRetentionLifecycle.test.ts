/// <reference types="vite/client" />

import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  CATALOG_RETENTION_SCHEMA_VERSION,
  MAX_CATALOG_RETENTION_DOCUMENTS_PER_MUTATION,
  MAX_CATALOG_RETENTION_OPERATION_RECEIPTS,
  buildGlobalCatalogAggregateObservationV1,
  canonicalJson,
  catalogManifestActivateRequestSchema,
  catalogManifestPublicationRequestDigest,
  catalogRetentionManifestRequestSchema,
  catalogRetentionPostgresProofSnapshotDigest,
  catalogRetentionPostgresProofSnapshotSchema,
  catalogRetentionProviderRequestSchema,
  catalogRetentionPublicationRequestDigest,
  catalogRetentionStatusRequestSchema,
  type CatalogRetentionExternalManifestProtection,
  type CatalogRetentionExternalProviderProtection,
  type CatalogRetentionPostgresProofSnapshot,
  type GlobalCatalogManifestV1,
  type GlobalCatalogProviderActiveObservationV1,
  type ProviderCatalogReleasePublishPlanV1,
  type PublicVendor,
} from "@packscout/contracts";
import type { FunctionReference } from "convex/server";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import { ensureImmutableCatalogManifest } from "./catalogManifestActivate";
import { loadActiveCatalogManifestState } from "./catalogManifestState";
import {
  buildCatalogManifestFromProviderPlans,
  seedProviderCatalogPublishPlanGraph,
} from "./mockCatalogManifestSeed";
import {
  PROVIDER_BETA_TEST_KEY_ID,
  PROVIDER_TEST_KEY_ID,
  buildProviderPublishPlan,
  emptyProviderHead,
  providerBodyDigest,
  providerOperationEnvelope,
  providerReleaseContext,
} from "./providerReleaseSecurity.test-support";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type RetentionTest = TestConvex<typeof schema>;
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

const RETENTION_KEY = "catalog-retain-v1";
const PUBLISH_KEY = "catalog-publish-v1";
const SERVER_TIME = "2026-08-16T12:00:00.000Z";
const OLD_TIME = "2026-08-01T12:00:00.000Z";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function createTest(): RetentionTest {
  return convexTest({ schema, modules, transactionLimits: true });
}

function configure(
  originSetHash: string,
  platforms: "alpha" | "alpha_beta" = "alpha",
): void {
  const secret = Buffer.from(
    "packscout-catalog-retention-test-secret-v1",
  ).toString("base64");
  vi.stubEnv("PACKSCOUT_PUBLIC_ORIGIN_SET_HASH", originSetHash);
  vi.stubEnv(
    "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS",
    canonicalJson({
      [PUBLISH_KEY]: secret,
      [RETENTION_KEY]: secret,
    }),
  );
  vi.stubEnv(
    "PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES",
    canonicalJson({
      [PUBLISH_KEY]: ["publish"],
      [RETENTION_KEY]: ["retain"],
    }),
  );
  vi.stubEnv(
    "PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS",
    canonicalJson(platforms === "alpha"
      ? { [PROVIDER_TEST_KEY_ID]: "alpha" }
      : {
          [PROVIDER_TEST_KEY_ID]: "alpha",
          [PROVIDER_BETA_TEST_KEY_ID]: "beta",
        }),
  );
}

async function execute(
  t: RetentionTest,
  operation: ExecutionReference,
  request: unknown,
  authenticatedKeyId = RETENTION_KEY,
): Promise<any> {
  const bodyJson = canonicalJson(request);
  return await t.mutation(operation, {
    bodyJson,
    requestDigest: await catalogRetentionPublicationRequestDigest(request),
    authenticatedKeyId,
  });
}

async function executeProvider(
  t: RetentionTest,
  operation: ExecutionReference,
  request: unknown,
  authenticatedKeyId = PROVIDER_TEST_KEY_ID,
): Promise<any> {
  const bodyJson = canonicalJson(request);
  return await t.mutation(operation, {
    bodyJson,
    requestDigest: await providerBodyDigest(bodyJson),
    authenticatedKeyId,
  });
}

async function executeManifest(
  t: RetentionTest,
  operation: ExecutionReference,
  request: unknown,
): Promise<any> {
  return await t.mutation(operation, {
    bodyJson: canonicalJson(request),
    requestDigest: await catalogManifestPublicationRequestDigest(request),
    authenticatedKeyId: PUBLISH_KEY,
  });
}

function manifestIdentity(manifest: GlobalCatalogManifestV1) {
  return {
    publicReleaseId: manifest.publicReleaseId,
    manifestFingerprint: manifest.manifestFingerprint,
    sharedConfigurationEpoch: manifest.sharedConfigurationEpoch,
    providerReferenceSetHash: manifest.providerReferenceSetHash,
  };
}

async function proofSnapshot(
  t: RetentionTest,
  input: Readonly<{
    sequence: number;
    manifestProtections?: readonly CatalogRetentionExternalManifestProtection[];
    providerProtections?: readonly CatalogRetentionExternalProviderProtection[];
  }>,
): Promise<CatalogRetentionPostgresProofSnapshot> {
  const stored = await t.run(async (ctx) => ({
    active: await loadActiveCatalogManifestState(ctx),
    heads: await ctx.db.query("providerCatalogCompletedHeads").collect(),
  }));
  const configuredPlatforms = JSON.parse(
    process.env.PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS ?? "{}",
  ) as Record<string, string>;
  const platformKeys = [...new Set(Object.values(configuredPlatforms))].sort();
  const completedHeads = platformKeys.map((platformKey) => {
    const head = stored.heads.find((candidate) =>
      candidate.platformKey === platformKey
    );
    return head === undefined
      ? {
          platformKey,
          completedHead: emptyProviderHead(platformKey),
          terminalOperationId: null,
        }
      : {
          platformKey,
          completedHead: {
            platformKey,
            publicProviderReleaseId: head.publicProviderReleaseId,
            sharedConfigurationEpoch: head.sharedConfigurationEpoch,
            providerCheckpoint: head.providerCheckpoint,
            observation: head.observation,
            terminalReceiptSha256: head.terminalReceiptSha256,
          },
          terminalOperationId: head.terminalOperationId,
        };
  });
  const providerProtections = input.providerProtections ?? [];
  const providerProtectionsByPlatform = platformKeys
    .map((platformKey) => ({
      platformKey,
      releases: providerProtections.filter(({ release }) =>
        release.platformKey === platformKey
      ),
    }))
    .filter(({ releases }) => releases.length > 0);
  const withoutDigest = {
    snapshotId: `retention:snapshot:${input.sequence}`,
    snapshotSequence: String(input.sequence),
    evaluatedAt: SERVER_TIME,
    activeState: {
      state: stored.active.state,
      terminalOperationId:
        stored.active.document?.terminalOperationId ?? null,
    },
    completedHeads,
    manifestProtections: [...(input.manifestProtections ?? [])],
    providerProtectionsByPlatform,
  };
  return catalogRetentionPostgresProofSnapshotSchema.parse({
    ...withoutDigest,
    snapshotDigest:
      await catalogRetentionPostgresProofSnapshotDigest(withoutDigest),
  });
}

async function manifestRequest(
  t: RetentionTest,
  input: Readonly<{
    operationId: string;
    generation: number;
    sequence: number;
    maximumDocuments?: number;
    manifestProtections?: readonly CatalogRetentionExternalManifestProtection[];
    providerProtections?: readonly CatalogRetentionExternalProviderProtection[];
  }>,
) {
  return catalogRetentionManifestRequestSchema.parse({
    schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
    operationId: input.operationId,
    idempotencyKey: input.operationId,
    expectedRetentionGeneration: input.generation,
    maximumDocuments: input.maximumDocuments ?? 90,
    phase: "manifests",
    postgresProof: await proofSnapshot(t, input),
  });
}

async function providerRequest(
  t: RetentionTest,
  input: Readonly<{
    operationId: string;
    generation: number;
    sequence: number;
    platformKey?: string;
    maximumDocuments?: number;
    manifestProtections?: readonly CatalogRetentionExternalManifestProtection[];
    providerProtections?: readonly CatalogRetentionExternalProviderProtection[];
  }>,
) {
  return catalogRetentionProviderRequestSchema.parse({
    schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
    operationId: input.operationId,
    idempotencyKey: input.operationId,
    expectedRetentionGeneration: input.generation,
    maximumDocuments: input.maximumDocuments ?? 90,
    phase: "provider_releases",
    platformKey: input.platformKey ?? "alpha",
    postgresProof: await proofSnapshot(t, input),
  });
}

async function insertOldManifest(
  t: RetentionTest,
  manifest: GlobalCatalogManifestV1,
  releaseId: any,
): Promise<any> {
  return await t.run(async (ctx) =>
    await ensureImmutableCatalogManifest(ctx, {
      manifest,
      providerReleaseIds: [releaseId],
      serverTime: OLD_TIME,
    })
  );
}

async function startOldFailedRelease(
  t: RetentionTest,
  plan: ProviderCatalogReleasePublishPlanV1,
  authenticatedKeyId = PROVIDER_TEST_KEY_ID,
) {
  const context = providerReleaseContext(
    plan,
    emptyProviderHead(plan.platformKey),
  );
  const start = {
    ...providerOperationEnvelope(`provider:start:failed:${plan.platformKey}`),
    ...context,
  };
  await executeProvider(
    t,
    internal.providerReleaseStart.start,
    start,
    authenticatedKeyId,
  );
  return await t.run(async (ctx) => {
    const release = await ctx.db.query("providerCatalogReleases")
      .withIndex("by_platform_key_and_public_provider_release_id", (index) =>
        index.eq("platformKey", plan.platformKey)
          .eq("publicProviderReleaseId", plan.publicProviderReleaseId)
      )
      .unique();
    if (release === null) throw new Error("Expected staged provider release.");
    const publication = await ctx.db.query("providerCatalogPublications")
      .withIndex("by_release_id", (index) => index.eq("releaseId", release._id))
      .unique();
    if (publication === null) throw new Error("Expected provider publication.");
    await ctx.db.patch("providerCatalogReleases", release._id, {
      lifecycle: "failed",
      retentionEligibleAt: OLD_TIME,
    });
    await ctx.db.patch("providerCatalogPublications", publication._id, {
      state: "failed",
    });
    return release;
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("catalog retention lifecycle", () => {
  test("deletes a shared provider release only after its last manifest reference", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_TIME);
    const plan = await buildProviderPublishPlan();
    configure(plan.governingHashes.originSetHash);
    const t = createTest();
    const completed = await t.run((ctx) =>
      seedProviderCatalogPublishPlanGraph(ctx, plan, OLD_TIME)
    );
    await t.run(async (ctx) => {
      const head = await ctx.db.query("providerCatalogCompletedHeads").unique();
      if (head === null) throw new Error("Expected provider head.");
      await ctx.db.delete("providerCatalogCompletedHeads", head._id);
    });
    const [firstManifest, secondManifest] = await Promise.all([
      buildCatalogManifestFromProviderPlans(
        [plan],
        "retention-shared-confidence-v1",
        "canonical",
      ),
      buildCatalogManifestFromProviderPlans(
        [plan],
        "retention-shared-confidence-v2",
        "canonical",
      ),
    ]);
    await insertOldManifest(t, firstManifest, completed.release._id);
    await insertOldManifest(t, secondManifest, completed.release._id);

    const first = await execute(
      t,
      internal.catalogRetention.retainManifests,
      await manifestRequest(t, {
        operationId: "retention:shared:manifest:1",
        generation: 0,
        sequence: 1,
      }),
    );
    expect(first.details).toMatchObject({
      deletedManifestCount: 1,
      deletedManifestReferenceCount: 1,
      hasMore: true,
    });
    expect(await t.run((ctx) =>
      ctx.db.get("providerCatalogReleases", completed.release._id)
    )).not.toBeNull();
    expect(await t.run((ctx) =>
      ctx.db.query("catalogManifestProviderReferences").collect()
    )).toHaveLength(1);

    await execute(
      t,
      internal.catalogRetention.retainManifests,
      await manifestRequest(t, {
        operationId: "retention:shared:manifest:2",
        generation: 1,
        sequence: 2,
      }),
    );
    expect(await t.run((ctx) =>
      ctx.db.get("providerCatalogReleases", completed.release._id)
    )).not.toBeNull();
    expect(await t.run((ctx) =>
      ctx.db.query("catalogManifestProviderReferences").collect()
    )).toHaveLength(0);

    const provider = await execute(
      t,
      internal.catalogRetention.retainProviderReleases,
      await providerRequest(t, {
        operationId: "retention:shared:provider:1",
        generation: 2,
        sequence: 3,
      }),
    );
    expect(provider.details).toMatchObject({
      selectedProviderRelease: {
        publicProviderReleaseId: plan.publicProviderReleaseId,
      },
      deletedProviderReleaseCount: 1,
      hasMore: false,
    });
    expect(await t.run((ctx) =>
      ctx.db.get("providerCatalogReleases", completed.release._id)
    )).toBeNull();
  });

  test("refuses missing and orphan manifest-provider edges before deletion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_TIME);
    const plan = await buildProviderPublishPlan();
    configure(plan.governingHashes.originSetHash);

    const missingTest = createTest();
    const missingCompleted = await missingTest.run((ctx) =>
      seedProviderCatalogPublishPlanGraph(ctx, plan, OLD_TIME)
    );
    await missingTest.run(async (ctx) => {
      const head = await ctx.db.query("providerCatalogCompletedHeads").unique();
      if (head !== null) {
        await ctx.db.delete("providerCatalogCompletedHeads", head._id);
      }
    });
    const missingManifest = await buildCatalogManifestFromProviderPlans(
      [plan],
      "retention-missing-edge-v1",
      "canonical",
    );
    const missingDocument = await insertOldManifest(
      missingTest,
      missingManifest,
      missingCompleted.release._id,
    );
    await missingTest.run(async (ctx) => {
      const edge = await ctx.db.query("catalogManifestProviderReferences")
        .withIndex("by_manifest_id_and_platform_key", (index) =>
          index.eq("manifestId", missingDocument._id)
        )
        .unique();
      if (edge === null) throw new Error("Expected manifest edge.");
      await ctx.db.delete("catalogManifestProviderReferences", edge._id);
    });
    await expect(execute(
      missingTest,
      internal.catalogRetention.retainManifests,
      await manifestRequest(missingTest, {
        operationId: "retention:missing-edge",
        generation: 0,
        sequence: 1,
      }),
    )).rejects.toThrow("CATALOG_RETENTION_REFERENCE_INVALID");
    expect(await missingTest.run((ctx) =>
      ctx.db.get("globalCatalogManifests", missingDocument._id)
    )).not.toBeNull();

    const orphanTest = createTest();
    const orphanCompleted = await orphanTest.run((ctx) =>
      seedProviderCatalogPublishPlanGraph(ctx, plan, OLD_TIME)
    );
    await orphanTest.run(async (ctx) => {
      const head = await ctx.db.query("providerCatalogCompletedHeads").unique();
      if (head !== null) {
        await ctx.db.delete("providerCatalogCompletedHeads", head._id);
      }
    });
    const orphanManifest = await buildCatalogManifestFromProviderPlans(
      [plan],
      "retention-orphan-edge-v1",
      "canonical",
    );
    const orphanDocument = await insertOldManifest(
      orphanTest,
      orphanManifest,
      orphanCompleted.release._id,
    );
    await orphanTest.run((ctx) =>
      ctx.db.delete("globalCatalogManifests", orphanDocument._id)
    );
    await expect(execute(
      orphanTest,
      internal.catalogRetention.retainProviderReleases,
      await providerRequest(orphanTest, {
        operationId: "retention:orphan-edge",
        generation: 0,
        sequence: 1,
      }),
    )).rejects.toThrow("CATALOG_RETENTION_REFERENCE_INVALID");
    expect(await orphanTest.run((ctx) =>
      ctx.db.get("providerCatalogReleases", orphanCompleted.release._id)
    )).not.toBeNull();
  });

  test("binds exact replay and status while generation races fail closed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_TIME);
    const plan = await buildProviderPublishPlan();
    configure(plan.governingHashes.originSetHash);
    const t = createTest();
    const request = await manifestRequest(t, {
      operationId: "retention:replay",
      generation: 0,
      sequence: 1,
    });
    const receipt = await execute(
      t,
      internal.catalogRetention.retainManifests,
      request,
    );
    await expect(execute(
      t,
      internal.catalogRetention.retainManifests,
      request,
    )).resolves.toEqual(receipt);

    const requestDigest = await catalogRetentionPublicationRequestDigest(
      request,
    );
    const status = catalogRetentionStatusRequestSchema.parse({
      schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
      target: {
        operationKind: "retainManifests",
        operationId: request.operationId,
        idempotencyKey: request.idempotencyKey,
        phase: "manifests",
        platformKey: null,
        requestDigest,
      },
    });
    await expect(execute(
      t,
      internal.catalogRetentionRead.status,
      status,
    )).resolves.toEqual(receipt);

    const racing = await manifestRequest(t, {
      operationId: "retention:racing",
      generation: 0,
      sequence: 2,
    });
    await expect(execute(
      t,
      internal.catalogRetention.retainManifests,
      racing,
    )).rejects.toThrow("CATALOG_RETENTION_PREDECESSOR_CONFLICT");
    expect(await t.run((ctx) =>
      ctx.db.query("catalogRetentionState").unique()
    )).toMatchObject({ generation: 1 });
  });

  test("never deletes more than 100 documents and keeps platforms independent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_TIME);
    const [alpha, beta] = await Promise.all([
      buildProviderPublishPlan(),
      buildProviderPublishPlan({ platformKey: "beta" }),
    ]);
    configure(alpha.governingHashes.originSetHash, "alpha_beta");
    const t = createTest();
    const alphaRelease = await startOldFailedRelease(t, alpha);
    const betaRelease = await startOldFailedRelease(
      t,
      beta,
      PROVIDER_BETA_TEST_KEY_ID,
    );
    const vendor = alpha.batches
      .find(({ kind }) => kind === "vendors")!.records[0] as PublicVendor;
    await t.run(async (ctx) => {
      for (let index = 0; index < 89; index += 1) {
        const publicVendorId = `retention-vendor-${index}`;
        await ctx.db.insert("providerCatalogVendors", {
          releaseId: alphaRelease._id,
          publicVendorId,
          vendorKey: `retention-vendor-key-${index}`,
          detail: {
            ...vendor,
            publicVendorId,
            vendorKey: `retention-vendor-key-${index}`,
          },
        });
      }
      for (let index = 0; index < 10; index += 1) {
        await ctx.db.insert("catalogRetentionOperations", {
          operationId: `retention:expired:${index}`,
          kind: "retainManifests",
          idempotencyKey: `retention:expired:${index}`,
          phase: "manifests",
          platformKey: null,
          bodyHash: SHA_A,
          expectedGeneration: index,
          resultGeneration: index + 1,
          status: "completed",
          result: "retained",
          receiptDigest: SHA_B,
          terminalReceiptSha256: SHA_C,
          completedAt: OLD_TIME,
          expiresAt: "2026-08-08T12:00:00.000Z",
          receiptJson: "{}",
        });
      }
    });

    const receipt = await execute(
      t,
      internal.catalogRetention.retainProviderReleases,
      await providerRequest(t, {
        operationId: "retention:bounded-100",
        generation: 0,
        sequence: 1,
        maximumDocuments: 90,
      }),
    );
    expect(receipt.details).toMatchObject({
      deletedDocumentCount: MAX_CATALOG_RETENTION_DOCUMENTS_PER_MUTATION,
      deletedRetentionOperationCount: 10,
      deletedProviderOwnedDocumentCount: 90,
      deletedProviderReleaseCount: 0,
      hasMore: true,
    });
    const stored = await t.run(async (ctx) => ({
      alpha: await ctx.db.get("providerCatalogReleases", alphaRelease._id),
      beta: await ctx.db.get("providerCatalogReleases", betaRelease._id),
      vendors: await ctx.db.query("providerCatalogVendors")
        .withIndex("by_release_id_and_public_vendor_id", (index) =>
          index.eq("releaseId", alphaRelease._id)
        )
        .collect(),
      operations: await ctx.db.query("catalogRetentionOperations").collect(),
    }));
    expect(stored.alpha).not.toBeNull();
    expect(stored.beta).not.toBeNull();
    expect(stored.vendors).toHaveLength(0);
    expect(stored.operations).toHaveLength(1);
  });

  test("protects sent provider finalize and manifest activate requests and rejects stale states", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_TIME);
    const plan = await buildProviderPublishPlan();
    configure(plan.governingHashes.originSetHash);
    const t = createTest();
    const context = providerReleaseContext(plan, emptyProviderHead("alpha"));
    const start = {
      ...providerOperationEnvelope("provider:start:sent-retention"),
      ...context,
    };
    const batch = {
      ...providerOperationEnvelope("provider:batch:sent-retention:0"),
      ...context,
      batch: plan.batches[0]!,
    };
    const finalize = {
      ...providerOperationEnvelope("provider:finalize:sent-retention"),
      ...context,
    };
    await executeProvider(t, internal.providerReleaseStart.start, start);
    await executeProvider(t, internal.providerReleaseBatch.applyBatch, batch);
    await t.run(async (ctx) => {
      const release = await ctx.db.query("providerCatalogReleases").unique();
      if (release === null) throw new Error("Expected staged release.");
      await ctx.db.patch("providerCatalogReleases", release._id, {
        retentionEligibleAt: OLD_TIME,
      });
    });
    const finalizeBody = canonicalJson(finalize);
    const finalizeDigest = await providerBodyDigest(finalizeBody);
    const sentFinalizeProtection: CatalogRetentionExternalProviderProtection = {
      release: {
        platformKey: plan.platformKey,
        publicProviderReleaseId: plan.publicProviderReleaseId,
        providerReleaseFingerprint: plan.providerReleaseFingerprint,
      },
      reason: "in_flight_attempt",
      operationProof: {
        operationKind: "finalize",
        operationId: finalize.operationId,
        operationState: "sent",
        canonicalRequestBody: finalizeBody,
        requestDigest: finalizeDigest,
        terminalReceiptSha256: null,
      },
    };
    const sentReceipt = await execute(
      t,
      internal.catalogRetention.retainProviderReleases,
      await providerRequest(t, {
        operationId: "retention:sent-finalize",
        generation: 0,
        sequence: 1,
        providerProtections: [sentFinalizeProtection],
      }),
    );
    expect(sentReceipt.details.selectedProviderRelease).toBeNull();
    expect(sentReceipt.details.protectionSet.providerReleasesByPlatform[0]
      .releases[0].reasons).toContain("in_flight_attempt");

    const finalizeReceipt = await executeProvider(
      t,
      internal.providerReleaseFinalize.finalize,
      finalize,
    );
    const pendingButCompleted = {
      ...sentFinalizeProtection,
      operationProof: {
        ...sentFinalizeProtection.operationProof,
        operationState: "pending" as const,
      },
    };
    await expect(execute(
      t,
      internal.catalogRetention.retainProviderReleases,
      await providerRequest(t, {
        operationId: "retention:stale-finalize-state",
        generation: 1,
        sequence: 2,
        providerProtections: [pendingButCompleted],
      }),
    )).rejects.toThrow("CATALOG_RETENTION_PROOF_INCOMPLETE");

    const head = await t.run((ctx) =>
      ctx.db.query("providerCatalogCompletedHeads").unique()
    );
    if (head === null) throw new Error("Expected completed head.");
    const selection: GlobalCatalogProviderActiveObservationV1 = {
      platformKey: plan.platformKey,
      publicProviderReleaseId: plan.publicProviderReleaseId,
      terminalOperationKind: "finalize",
      terminalOperationId: finalizeReceipt.operationId,
      terminalReceiptSha256: head.terminalReceiptSha256,
      selectedProviderCheckpoint: plan.providerCheckpoint,
      selectedDataAsOf: plan.dataAsOf,
      latestAffectedSettledSequence: plan.providerCheckpoint.settledSequence,
      latestAffectedSourceHeadSequence: plan.observation.sourceHeadSequence,
      initialBackfillComplete: true,
      affectedDerivationsSettled: true,
      settledSourceFreshness: plan.observation.freshness,
      lastSuccessfulObservationAt:
        plan.observation.lastSuccessfulObservationAt,
      staleAt: plan.observation.staleAt,
    };
    const manifest = await buildCatalogManifestFromProviderPlans(
      [plan],
      "retention-sent-manifest-v1",
      "canonical",
    );
    const pristine = (await t.run((ctx) =>
      loadActiveCatalogManifestState(ctx)
    )).state;
    const observation = buildGlobalCatalogAggregateObservationV1({
      observationSequence: 1,
      publicReleaseId: manifest.publicReleaseId,
      providerReferenceSetHash: manifest.providerReferenceSetHash,
      providerSelections: [selection],
    });
    const activate = catalogManifestActivateRequestSchema.parse({
      schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
      operationId: "catalog:activate:sent-retention",
      idempotencyKey: "catalog:activate:sent-retention",
      manifest,
      observation,
      expectedActiveState: pristine,
    });
    const activateBody = canonicalJson(activate);
    const activateDigest = await catalogManifestPublicationRequestDigest(
      activate,
    );
    const sentActivateProtection: CatalogRetentionExternalManifestProtection = {
      manifest: manifestIdentity(manifest),
      reason: "in_flight_attempt",
      operationProof: {
        operationKind: "activateManifest",
        operationId: activate.operationId,
        operationState: "sent",
        canonicalRequestBody: activateBody,
        requestDigest: activateDigest,
        terminalReceiptSha256: null,
      },
    };
    const manifestReceipt = await execute(
      t,
      internal.catalogRetention.retainManifests,
      await manifestRequest(t, {
        operationId: "retention:sent-activate",
        generation: 1,
        sequence: 3,
        manifestProtections: [sentActivateProtection],
      }),
    );
    expect(manifestReceipt.details.selectedManifest).toBeNull();
    expect(manifestReceipt.details.protectionSet.providerReleasesByPlatform[0]
      .releases[0].reasons).toContain("in_flight_attempt");

    await executeManifest(
      t,
      internal.catalogManifestActivate.activateManifest,
      activate,
    );
    await expect(execute(
      t,
      internal.catalogRetention.retainManifests,
      await manifestRequest(t, {
        operationId: "retention:stale-activate-state",
        generation: 2,
        sequence: 4,
        manifestProtections: [sentActivateProtection],
      }),
    )).rejects.toThrow("CATALOG_RETENTION_PROOF_INCOMPLETE");
    expect(await t.run((ctx) =>
      ctx.db.query("catalogRetentionState").unique()
    )).toMatchObject({ generation: 2 });
  });

  test("pruned operation replay cannot target a later unchanged catalog generation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_TIME);
    const plan = await buildProviderPublishPlan();
    configure(plan.governingHashes.originSetHash);
    const t = createTest();
    const firstRequest = await manifestRequest(t, {
      operationId: "retention:journal:0",
      generation: 0,
      sequence: 1,
    });
    await execute(
      t,
      internal.catalogRetention.retainManifests,
      firstRequest,
    );
    for (
      let index = 1;
      index <= MAX_CATALOG_RETENTION_OPERATION_RECEIPTS + 1;
      index += 1
    ) {
      await execute(
        t,
        internal.catalogRetention.retainManifests,
        await manifestRequest(t, {
          operationId: `retention:journal:${index}`,
          generation: index,
          sequence: index + 1,
        }),
      );
    }
    const before = await t.run(async (ctx) => ({
      generation: (await ctx.db.query("catalogRetentionState").unique())
        ?.generation,
      operationCount:
        (await ctx.db.query("catalogRetentionOperations").collect()).length,
      first: await ctx.db.query("catalogRetentionOperations")
        .withIndex("by_operation_id", (index) =>
          index.eq("operationId", firstRequest.operationId)
        )
        .unique(),
      manifests: (await ctx.db.query("globalCatalogManifests").collect()).length,
      releases: (await ctx.db.query("providerCatalogReleases").collect()).length,
    }));
    expect(before).toMatchObject({
      generation: MAX_CATALOG_RETENTION_OPERATION_RECEIPTS + 2,
      operationCount: MAX_CATALOG_RETENTION_OPERATION_RECEIPTS,
      first: null,
      manifests: 0,
      releases: 0,
    });
    await expect(execute(
      t,
      internal.catalogRetention.retainManifests,
      firstRequest,
    )).rejects.toThrow("CATALOG_RETENTION_PREDECESSOR_CONFLICT");
    const after = await t.run(async (ctx) => ({
      generation: (await ctx.db.query("catalogRetentionState").unique())
        ?.generation,
      operationCount:
        (await ctx.db.query("catalogRetentionOperations").collect()).length,
      manifests: (await ctx.db.query("globalCatalogManifests").collect()).length,
      releases: (await ctx.db.query("providerCatalogReleases").collect()).length,
    }));
    expect(after).toEqual({
      generation: before.generation,
      operationCount: before.operationCount,
      manifests: 0,
      releases: 0,
    });
  }, 30_000);
});
