/// <reference types="vite/client" />

import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  CATALOG_RETENTION_SCHEMA_VERSION,
  MAX_CATALOG_RETENTION_DOCUMENTS_PER_MUTATION,
  MAX_CATALOG_RETENTION_OPERATION_RECEIPTS,
  MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES,
  EMPTY_PRODUCTION_HEAT_SIGNAL_SET_HASH,
  REPACK_HEAT_AGGREGATION_VERSION,
  REPACK_HEAT_POLICY_VERSION,
  buildGlobalCatalogAggregateObservationV1,
  canonicalJson,
  catalogManifestActivateRequestSchema,
  catalogManifestBlockRequestSchema,
  catalogManifestPublicationRequestDigest,
  catalogRetentionManifestRequestSchema,
  catalogRetentionPostgresProofSnapshotDigest,
  catalogRetentionPostgresProofSnapshotSchema,
  catalogRetentionProviderRequestSchema,
  catalogRetentionPublicationRequestDigest,
  catalogRetentionStatusRequestSchema,
  productionHeatManifestAlignmentSchema,
  recomputeProductionHeatFrameHash,
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
import type { Id } from "./_generated/dataModel";
import { ensureImmutableCatalogManifest } from "./catalogManifestActivate";
import { CATALOG_RETENTION_REFERENCE_AUDIT_PAGE_SIZE } from
  "./catalogManifestRetentionReferences";
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
  test("retains an old manifest until its staged Heat publication is gone", async () => {
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
      if (head !== null) await ctx.db.delete("providerCatalogCompletedHeads", head._id);
    });
    const manifest = await buildCatalogManifestFromProviderPlans(
      [plan],
      "retention-heat-reference-v1",
      "canonical",
    );
    const manifestDocument = await insertOldManifest(
      t,
      manifest,
      completed.release._id,
    );
    const alignment = productionHeatManifestAlignmentSchema.parse(
      manifestIdentity(manifest),
    );
    const frameCandidate = {
      publicHeatFrameId: "91000000-0000-4000-8000-000000000091",
      manifestAlignment: alignment,
      frameSequence: 1,
      sourceWatermark: "1",
      signalSetHash: SHA_A,
      frameHash: "0".repeat(64),
      signalCount: manifest.counts.repacks,
      aggregationVersion: REPACK_HEAT_AGGREGATION_VERSION,
      heatPolicyVersion: REPACK_HEAT_POLICY_VERSION,
      baselineWindowStartedAt: "2026-08-15T10:00:00.000Z",
      baselineWindowEndedAt: "2026-08-15T11:00:00.000Z",
      currentWindowStartedAt: "2026-08-15T11:00:00.000Z",
      currentWindowEndedAt: "2026-08-15T11:55:00.000Z",
      calculatedAt: "2026-08-15T12:00:00.000Z",
      expiresAt: "2026-08-15T12:15:00.000Z",
    };
    const frame = {
      ...frameCandidate,
      frameHash: await recomputeProductionHeatFrameHash(frameCandidate),
    };
    await t.run(async (ctx) => {
      const signalSetId = await ctx.db.insert("repackHeatSignalSets", {
        manifestId: manifestDocument._id,
        manifestAlignment: alignment,
        signalSetHash: frame.signalSetHash,
        lifecycle: "staging",
        sourceKind: "observed",
        scenarioVersion: null,
        aggregationVersion: frame.aggregationVersion,
        heatPolicyVersion: frame.heatPolicyVersion,
        signalCount: frame.signalCount,
        originatingPublicationId: frame.publicHeatFrameId,
        createdAt: OLD_TIME,
        completedAt: null,
        retentionEligibleAt: frame.expiresAt,
      });
      await ctx.db.insert("repackHeatPublications", {
        publicationId: frame.publicHeatFrameId,
        manifestId: manifestDocument._id,
        signalSetId,
        frame,
        expectedBatchCount: 1,
        acceptedBatchCount: 0,
        acceptedSignalCount: 0,
        acceptedSignalSetHash: EMPTY_PRODUCTION_HEAT_SIGNAL_SET_HASH,
        lastPublicRepackId: null,
        state: "staging",
        createdAt: OLD_TIME,
        completedAt: null,
        retentionEligibleAt: frame.expiresAt,
      });
    });

    const protectedReceipt = await execute(
      t,
      internal.catalogRetention.retainManifests,
      await manifestRequest(t, {
        operationId: "retention:heat-reference:protected",
        generation: 0,
        sequence: 1,
      }),
    );
    expect(protectedReceipt.details).toMatchObject({
      selectedManifest: null,
      deletedManifestCount: 0,
    });
    expect(protectedReceipt.details.protectionSet.manifests).toEqual([
      expect.objectContaining({
        publicReleaseId: manifest.publicReleaseId,
        reasons: expect.arrayContaining(["heat_reference"]),
      }),
    ]);
    expect(await t.run((ctx) =>
      ctx.db.get("globalCatalogManifests", manifestDocument._id)
    )).not.toBeNull();

    const providerProtected = await execute(
      t,
      internal.catalogRetention.retainProviderReleases,
      await providerRequest(t, {
        operationId: "retention:heat-reference:provider-protected",
        generation: 1,
        sequence: 1,
      }),
    );
    expect(providerProtected.details.selectedProviderRelease).toBeNull();
    expect(providerProtected.details.protectionSet.providerReleasesByPlatform[0]
      .releases[0].reasons).toContain("retained_manifest_reference");

    await t.run(async (ctx) => {
      const publication = await ctx.db.query("repackHeatPublications").unique();
      const signalSet = await ctx.db.query("repackHeatSignalSets").unique();
      if (publication === null || signalSet === null) {
        throw new Error("Expected staged Heat references.");
      }
      await ctx.db.delete("repackHeatPublications", publication._id);
      await ctx.db.delete("repackHeatSignalSets", signalSet._id);
    });
    const releasedReceipt = await execute(
      t,
      internal.catalogRetention.retainManifests,
      await manifestRequest(t, {
        operationId: "retention:heat-reference:released",
        generation: 2,
        sequence: 2,
      }),
    );
    expect(releasedReceipt.details).toMatchObject({
      selectedManifest: {
        publicReleaseId: manifest.publicReleaseId,
        manifestFingerprint: manifest.manifestFingerprint,
      },
      deletedManifestCount: 1,
    });
  });

  test("audits arbitrarily large reference backlogs before deleting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_TIME);
    const plan = await buildProviderPublishPlan();
    configure(plan.governingHashes.originSetHash);
    const t = createTest();
    const completed = await t.run((ctx) =>
      seedProviderCatalogPublishPlanGraph(ctx, plan, OLD_TIME)
    );
    const manifestCount = CATALOG_RETENTION_REFERENCE_AUDIT_PAGE_SIZE +
      MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES + 2;
    const manifests = await Promise.all(
      Array.from({ length: manifestCount }, (_, index) =>
        buildCatalogManifestFromProviderPlans(
          [plan],
          `retention-backlog-${index.toString().padStart(2, "0")}`,
          "canonical",
        )),
    );
    await t.run(async (ctx) => {
      for (const manifest of manifests) {
        await ensureImmutableCatalogManifest(ctx, {
          manifest,
          providerReleaseIds: [completed.release._id],
          serverTime: OLD_TIME,
        });
      }
    });

    const duplicate = await t.run(async (ctx) => {
      const ordered = await ctx.db.query("globalCatalogManifests")
        .withIndex("by_public_release_id")
        .take(CATALOG_RETENTION_REFERENCE_AUDIT_PAGE_SIZE + 1);
      const previous = ordered[CATALOG_RETENTION_REFERENCE_AUDIT_PAGE_SIZE - 1];
      const boundary = ordered[CATALOG_RETENTION_REFERENCE_AUDIT_PAGE_SIZE];
      if (previous === undefined || boundary === undefined) {
        throw new Error("Expected a full manifest audit page.");
      }
      await ctx.db.patch("globalCatalogManifests", boundary._id, {
        publicReleaseId: previous.publicReleaseId,
      });
      return { id: boundary._id, publicReleaseId: boundary.publicReleaseId };
    });
    await expect(execute(
      t,
      internal.catalogRetention.retainManifests,
      await manifestRequest(t, {
        operationId: "retention:backlog:duplicate-cursor",
        generation: 0,
        sequence: 1,
      }),
    )).rejects.toThrow("CATALOG_RETENTION_REFERENCE_INVALID");
    await t.run((ctx) =>
      ctx.db.patch("globalCatalogManifests", duplicate.id, {
        publicReleaseId: duplicate.publicReleaseId,
      })
    );

    const first = await execute(
      t,
      internal.catalogRetention.retainManifests,
      await manifestRequest(t, {
        operationId: "retention:backlog:audit-page-1",
        generation: 0,
        sequence: 1,
      }),
    );
    expect(first.details).toMatchObject({
      deletedManifestCount: 0,
      deletedManifestReferenceCount: 0,
      hasMore: true,
    });
    expect(await t.run((ctx) =>
      ctx.db.query("globalCatalogManifests").collect()
    )).toHaveLength(manifestCount);

    const corrupted = await t.run(async (ctx) => {
      const state = await ctx.db.query("catalogRetentionState").unique();
      if (state?.referenceAuditCursor === null || state === null) {
        throw new Error("Expected a resumable reference-audit cursor.");
      }
      const remainingManifest = await ctx.db
        .query("globalCatalogManifests")
        .withIndex("by_public_release_id", (index) =>
          index.gt("publicReleaseId", state.referenceAuditCursor!)
        )
        .first();
      if (remainingManifest === null) {
        throw new Error("Expected an unaudited manifest.");
      }
      const edge = await ctx.db.query("catalogManifestProviderReferences")
        .withIndex("by_manifest_id_and_platform_key", (index) =>
          index.eq("manifestId", remainingManifest._id)
        )
        .first();
      if (edge === null) throw new Error("Expected an unaudited edge.");
      await ctx.db.patch("catalogManifestProviderReferences", edge._id, {
        platformKey: "rogue",
      });
      return { id: edge._id, platformKey: edge.platformKey };
    });
    await expect(execute(
      t,
      internal.catalogRetention.retainManifests,
      await manifestRequest(t, {
        operationId: "retention:backlog:orphan-refusal",
        generation: 1,
        sequence: 1,
      }),
    )).rejects.toThrow("CATALOG_RETENTION_REFERENCE_INVALID");
    expect(await t.run((ctx) =>
      ctx.db.query("globalCatalogManifests").collect()
    )).toHaveLength(manifestCount);

    await t.run((ctx) =>
      ctx.db.patch("catalogManifestProviderReferences", corrupted.id, {
        platformKey: corrupted.platformKey,
      })
    );
    let generation = first.retentionGeneration;
    let sawIncompleteEdgeAudit = false;
    let completionReceipt: any = null;
    const maximumAuditCalls = Math.ceil(
      manifestCount / CATALOG_RETENTION_REFERENCE_AUDIT_PAGE_SIZE,
    ) + 2;
    for (let index = 0; index < maximumAuditCalls; index += 1) {
      const receipt = await execute(
        t,
        internal.catalogRetention.retainManifests,
        await manifestRequest(t, {
          operationId: `retention:backlog:audit-page-${index + 2}`,
          generation,
          sequence: 1,
        }),
      );
      generation = receipt.retentionGeneration;
      const state = await t.run((ctx) =>
        ctx.db.query("catalogRetentionState").unique()
      );
      if (state === null) throw new Error("Expected retention state.");
      if (state.referenceAuditComplete) {
        completionReceipt = receipt;
        break;
      }
      if (state.referenceAuditPhase === "edges") {
        sawIncompleteEdgeAudit = true;
      }
      expect(receipt.details).toMatchObject({
        deletedManifestCount: 0,
        deletedManifestReferenceCount: 0,
        hasMore: true,
      });
      expect(await t.run((ctx) =>
        ctx.db.query("globalCatalogManifests").collect()
      )).toHaveLength(manifestCount);
    }
    expect(sawIncompleteEdgeAudit).toBe(true);
    expect(completionReceipt?.details).toMatchObject({
      deletedManifestCount: 1,
      deletedManifestReferenceCount: 1,
      hasMore: true,
    });
    expect(await t.run((ctx) =>
      ctx.db.query("globalCatalogManifests").collect()
    )).toHaveLength(manifestCount - 1);
    expect(await t.run((ctx) =>
      ctx.db.query("catalogRetentionState").unique()
    )).toMatchObject({
      generation,
      referenceAuditComplete: true,
      manifestPhaseComplete: false,
    });
  }, 30_000);

  test("does not charge Heat-referenced manifests against the complete allowance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_TIME);
    const plan = await buildProviderPublishPlan();
    configure(plan.governingHashes.originSetHash);
    const t = createTest();
    const completed = await t.run((ctx) =>
      seedProviderCatalogPublishPlanGraph(ctx, plan, SERVER_TIME)
    );
    const manifests = await Promise.all(
      ["heat", "a", "b", "c"].map((suffix) =>
        buildCatalogManifestFromProviderPlans(
          [plan],
          `retention-heat-allowance-${suffix}`,
          "canonical",
        )),
    );
    const documents = await t.run(async (ctx) => {
      const stored = [];
      for (const manifest of manifests) {
        stored.push(await ensureImmutableCatalogManifest(ctx, {
          manifest,
          providerReleaseIds: [completed.release._id],
          serverTime: SERVER_TIME,
        }));
      }
      const retentionTimes = [
        "2026-08-23T12:00:00.000Z",
        "2026-08-22T12:00:00.000Z",
        "2026-08-21T12:00:00.000Z",
        "2026-08-20T12:00:00.000Z",
      ];
      for (const [index, document] of stored.entries()) {
        await ctx.db.patch("globalCatalogManifests", document._id, {
          retentionEligibleAt: retentionTimes[index]!,
        });
      }
      await ctx.db.insert("repackHeatSignalSets", {
        manifestId: stored[0]!._id,
        manifestAlignment: productionHeatManifestAlignmentSchema.parse(
          manifestIdentity(manifests[0]!),
        ),
        signalSetHash: SHA_A,
        lifecycle: "complete",
        sourceKind: "observed",
        scenarioVersion: null,
        aggregationVersion: REPACK_HEAT_AGGREGATION_VERSION,
        heatPolicyVersion: REPACK_HEAT_POLICY_VERSION,
        signalCount: 0,
        originatingPublicationId: null,
        createdAt: SERVER_TIME,
        completedAt: SERVER_TIME,
      });
      return stored;
    });

    const receipt = await execute(
      t,
      internal.catalogRetention.retainManifests,
      await manifestRequest(t, {
        operationId: "retention:heat-allowance",
        generation: 0,
        sequence: 1,
      }),
    );
    expect(receipt.details).toMatchObject({
      selectedManifest: null,
      deletedManifestCount: 0,
      hasMore: false,
    });
    expect(receipt.details.protectionSet.manifests).toHaveLength(4);
    expect(receipt.details.protectionSet.manifests.find(
      ({ publicReleaseId }: { publicReleaseId: string }) =>
        publicReleaseId === manifests[0]!.publicReleaseId,
    )?.reasons).toContain("heat_reference");
    expect(await t.run((ctx) =>
      Promise.all(documents.map(({ _id }) =>
        ctx.db.get("globalCatalogManifests", _id)
      ))
    )).not.toContain(null);
  });

  test("keeps the maximum platform graph below Convex query limits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_TIME);
    const platformKeys = [
      "alpha",
      "beta",
      "delta",
      "epsilon",
      "eta",
      "gamma",
      "theta",
      "zeta",
    ];
    const plans = await Promise.all(platformKeys.map((platformKey, index) =>
      buildProviderPublishPlan({
        platformKey,
        publicVendorId:
          `10000000-0000-5000-8000-${(index + 1).toString().padStart(12, "0")}`,
        vendorDisplayName: `Retention vendor ${platformKey}`,
      })
    ));
    configure(plans[0]!.governingHashes.originSetHash);
    vi.stubEnv(
      "PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS",
      canonicalJson(Object.fromEntries(platformKeys.map((platformKey) =>
        [`provider-${platformKey}-v1`, platformKey]
      ))),
    );
    const t = createTest();
    const releaseIds: Id<"providerCatalogReleases">[] = [];
    for (const plan of plans) {
      const seeded = await t.run((ctx) =>
        seedProviderCatalogPublishPlanGraph(ctx, plan, SERVER_TIME)
      );
      releaseIds.push(seeded.release._id);
    }
    const manifests = await Promise.all(
      Array.from({ length: 21 }, (_, index) =>
        buildCatalogManifestFromProviderPlans(
          plans,
          `retention-platform-scale-${index.toString().padStart(2, "0")}`,
          "canonical",
        )),
    );
    await t.run(async (ctx) => {
      for (const manifest of manifests) {
        const document = await ensureImmutableCatalogManifest(ctx, {
          manifest,
          providerReleaseIds: releaseIds,
          serverTime: SERVER_TIME,
        });
        await ctx.db.insert("repackHeatSignalSets", {
          manifestId: document._id,
          manifestAlignment: productionHeatManifestAlignmentSchema.parse(
            manifestIdentity(manifest),
          ),
          signalSetHash: SHA_A,
          lifecycle: "complete",
          sourceKind: "observed",
          scenarioVersion: null,
          aggregationVersion: REPACK_HEAT_AGGREGATION_VERSION,
          heatPolicyVersion: REPACK_HEAT_POLICY_VERSION,
          signalCount: 0,
          originatingPublicationId: null,
          createdAt: SERVER_TIME,
          completedAt: SERVER_TIME,
        });
      }
    });

    let generation = 0;
    let receipt: any = null;
    for (let index = 0; index < 10; index += 1) {
      receipt = await execute(
        t,
        internal.catalogRetention.retainManifests,
        await manifestRequest(t, {
          operationId: `retention:platform-scale:${index}`,
          generation,
          sequence: 1,
        }),
      );
      generation = receipt.retentionGeneration;
      if (!receipt.details.hasMore) break;
    }
    expect(receipt?.details).toMatchObject({
      deletedManifestCount: 0,
      hasMore: false,
    });
    expect(receipt.details.protectionSet.manifests).toHaveLength(21);
    expect(receipt.details.protectionSet.providerReleasesByPlatform)
      .toHaveLength(8);

    const providerReceipt = await execute(
      t,
      internal.catalogRetention.retainProviderReleases,
      await providerRequest(t, {
        operationId: "retention:platform-scale:provider",
        generation,
        sequence: 1,
      }),
    );
    expect(providerReceipt.details).toMatchObject({
      selectedProviderRelease: null,
      hasMore: false,
    });
    expect(providerReceipt.details.protectionSet.providerReleasesByPlatform)
      .toHaveLength(1);
  }, 30_000);

  test("keeps near-bound immutable proofs below Convex read limits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_TIME);
    const publicAssetOrigins = Array.from({ length: 64 }, (_, index) =>
      `https://${index.toString().padStart(2, "0")}.${"a".repeat(60)}.${
        "b".repeat(60)
      }.${"c".repeat(60)}.example`
    );
    const plans = await Promise.all(Array.from({ length: 21 }, (_, index) =>
      buildProviderPublishPlan({
        checkpointSequence: String(100 + index),
        publicAssetOrigins,
        publicVendorId:
          `10000000-0000-5000-8000-${(100 + index).toString().padStart(12, "0")}`,
        vendorDisplayName: `Large proof vendor ${index}`,
      })
    ));
    configure(plans[0]!.governingHashes.originSetHash);
    const t = createTest();
    for (const [index, plan] of plans.entries()) {
      const completed = await t.run((ctx) =>
        seedProviderCatalogPublishPlanGraph(ctx, plan, SERVER_TIME)
      );
      const manifest = await buildCatalogManifestFromProviderPlans(
        [plan],
        `retention-large-proof-${index.toString().padStart(2, "0")}`,
        "canonical",
      );
      await t.run(async (ctx) => {
        const document = await ensureImmutableCatalogManifest(ctx, {
          manifest,
          providerReleaseIds: [completed.release._id],
          serverTime: SERVER_TIME,
        });
        await ctx.db.insert("repackHeatSignalSets", {
          manifestId: document._id,
          manifestAlignment: productionHeatManifestAlignmentSchema.parse(
            manifestIdentity(manifest),
          ),
          signalSetHash: SHA_A,
          lifecycle: "complete",
          sourceKind: "observed",
          scenarioVersion: null,
          aggregationVersion: REPACK_HEAT_AGGREGATION_VERSION,
          heatPolicyVersion: REPACK_HEAT_POLICY_VERSION,
          signalCount: 0,
          originatingPublicationId: null,
          createdAt: SERVER_TIME,
          completedAt: SERVER_TIME,
        });
      });
    }

    let generation = 0;
    let manifestReceipt: any = null;
    for (let index = 0; index < 10; index += 1) {
      manifestReceipt = await execute(
        t,
        internal.catalogRetention.retainManifests,
        await manifestRequest(t, {
          operationId: `retention:large-proof:${index}`,
          generation,
          sequence: 1,
        }),
      );
      generation = manifestReceipt.retentionGeneration;
      if (!manifestReceipt.details.hasMore) break;
    }
    expect(manifestReceipt?.details).toMatchObject({
      selectedManifest: null,
      hasMore: false,
    });
    const providerReceipt = await execute(
      t,
      internal.catalogRetention.retainProviderReleases,
      await providerRequest(t, {
        operationId: "retention:large-proof:provider",
        generation,
        sequence: 1,
      }),
    );
    expect(providerReceipt.details).toMatchObject({
      selectedProviderRelease: null,
      hasMore: false,
    });
    expect(providerReceipt.details.protectionSet.providerReleasesByPlatform[0]
      .releases).toHaveLength(21);
  }, 60_000);

  test("freezes age eligibility to the PostgreSQL proof time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-16T13:00:00.000Z");
    const plan = await buildProviderPublishPlan();
    configure(plan.governingHashes.originSetHash);
    const t = createTest();
    const completed = await t.run((ctx) =>
      seedProviderCatalogPublishPlanGraph(ctx, plan, OLD_TIME)
    );
    const manifest = await buildCatalogManifestFromProviderPlans(
      [plan],
      "retention-frozen-eligibility",
      "canonical",
    );
    const document = await insertOldManifest(
      t,
      manifest,
      completed.release._id,
    );
    await t.run((ctx) =>
      ctx.db.patch("globalCatalogManifests", document._id, {
        lifecycle: "failed",
        retentionEligibleAt: "2026-08-16T12:30:00.000Z",
      })
    );

    const receipt = await execute(
      t,
      internal.catalogRetention.retainManifests,
      await manifestRequest(t, {
        operationId: "retention:frozen-eligibility",
        generation: 0,
        sequence: 1,
      }),
    );
    expect(receipt.serverTime).toBe("2026-08-16T13:00:00.000Z");
    expect(receipt.details.protectionSet.authoritativeEvaluationTime).toBe(
      SERVER_TIME,
    );
    expect(receipt.details).toMatchObject({
      selectedManifest: null,
      deletedManifestCount: 0,
      hasMore: false,
    });
    expect(await t.run((ctx) =>
      ctx.db.get("globalCatalogManifests", document._id)
    )).not.toBeNull();
  });

  test("refuses deletion when a protected release lost its completion proof", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_TIME);
    const [firstPlan, secondPlan] = await Promise.all([
      buildProviderPublishPlan(),
      buildProviderPublishPlan({
        checkpointSequence: "30",
        settledAt: "2026-08-15T13:00:00.000Z",
        publicVendorId: "10000000-0000-5000-8000-000000000030",
        vendorDisplayName: "Second retention vendor",
      }),
    ]);
    configure(firstPlan.governingHashes.originSetHash);
    const t = createTest();
    const first = await t.run((ctx) =>
      seedProviderCatalogPublishPlanGraph(ctx, firstPlan, OLD_TIME)
    );
    const second = await t.run((ctx) =>
      seedProviderCatalogPublishPlanGraph(ctx, secondPlan, OLD_TIME)
    );
    const [protectedManifest, deletionCandidate] = await Promise.all([
      buildCatalogManifestFromProviderPlans(
        [firstPlan],
        "retention-protected-proof",
        "canonical",
      ),
      buildCatalogManifestFromProviderPlans(
        [secondPlan],
        "retention-unrelated-candidate",
        "canonical",
      ),
    ]);
    await t.run(async (ctx) => {
      await ensureImmutableCatalogManifest(ctx, {
        manifest: protectedManifest,
        providerReleaseIds: [first.release._id],
        serverTime: SERVER_TIME,
      });
    });
    const candidateDocument = await insertOldManifest(
      t,
      deletionCandidate,
      second.release._id,
    );
    await t.run(async (ctx) => {
      const operation = await ctx.db
        .query("providerCatalogReleaseCompletionProofs")
        .withIndex("by_release_id", (index) =>
          index.eq("releaseId", first.release._id)
        )
        .unique();
      if (operation === null) throw new Error("Expected completion receipt.");
      await ctx.db.delete(
        "providerCatalogReleaseCompletionProofs",
        operation._id,
      );
    });

    await expect(execute(
      t,
      internal.catalogRetention.retainManifests,
      await manifestRequest(t, {
        operationId: "retention:missing-protected-completion",
        generation: 0,
        sequence: 1,
      }),
    )).rejects.toThrow("CATALOG_RETENTION_REFERENCE_INVALID");
    expect(await t.run((ctx) =>
      ctx.db.get("globalCatalogManifests", candidateDocument._id)
    )).not.toBeNull();
  });

  test("refuses a dangling manifest even when its compact proof remains", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_TIME);
    const [firstPlan, laterPlan] = await Promise.all([
      buildProviderPublishPlan(),
      buildProviderPublishPlan({
        checkpointSequence: "31",
        settledAt: "2026-08-15T13:01:00.000Z",
        publicVendorId: "10000000-0000-5000-8000-000000000031",
        vendorDisplayName: "Later retention vendor",
      }),
    ]);
    configure(firstPlan.governingHashes.originSetHash);
    const t = createTest();
    const first = await t.run((ctx) =>
      seedProviderCatalogPublishPlanGraph(ctx, firstPlan, OLD_TIME)
    );
    await t.run((ctx) =>
      seedProviderCatalogPublishPlanGraph(ctx, laterPlan, OLD_TIME)
    );
    const manifest = await buildCatalogManifestFromProviderPlans(
      [firstPlan],
      "retention-dangling-release",
      "canonical",
    );
    await t.run(async (ctx) => {
      await ensureImmutableCatalogManifest(ctx, {
        manifest,
        providerReleaseIds: [first.release._id],
        serverTime: SERVER_TIME,
      });
      await ctx.db.delete("providerCatalogReleases", first.release._id);
    });

    await expect(execute(
      t,
      internal.catalogRetention.retainManifests,
      await manifestRequest(t, {
        operationId: "retention:dangling-release",
        generation: 0,
        sequence: 1,
      }),
    )).rejects.toThrow("CATALOG_RETENTION_REFERENCE_INVALID");
  });

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

  test("binds compact manifest proofs and accepts a proven absent block target", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_TIME);
    const plan = await buildProviderPublishPlan();
    configure(plan.governingHashes.originSetHash);
    const t = createTest();
    const block = catalogManifestBlockRequestSchema.parse({
      schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
      operationId: "catalog:block:retention-absent",
      idempotencyKey: "catalog:block:retention-absent",
      publicReleaseId: "11111111-1111-5111-8111-111111111111",
      manifestFingerprint: SHA_A,
      blockSequence: "1",
      reason: "MANIFEST_SECURITY_INVALID",
    });
    await executeManifest(t, internal.catalogManifestBlock.block, block);
    const terminalReceiptSha256 = await t.run(async (ctx) => {
      const operation = await ctx.db.query("catalogManifestOperations")
        .withIndex("by_operation_id", (index) =>
          index.eq("operationId", block.operationId)
        )
        .unique();
      if (operation === null) throw new Error("Expected stored block receipt.");
      return operation.terminalReceiptSha256;
    });
    const requestDigest = await catalogManifestPublicationRequestDigest(block);
    const protection: CatalogRetentionExternalManifestProtection = {
      manifest: {
        publicReleaseId: block.publicReleaseId,
        manifestFingerprint: block.manifestFingerprint,
        sharedConfigurationEpoch: plan.sharedConfigurationEpoch,
        providerReferenceSetHash: SHA_B,
      },
      reason: "block_recovery",
      operationProof: {
        operationKind: "block",
        operationId: block.operationId,
        operationState: "acknowledged",
        canonicalRequestBody: null,
        requestDigest,
        terminalReceiptSha256,
      },
    };
    await expect(execute(
      t,
      internal.catalogRetention.retainManifests,
      await manifestRequest(t, {
        operationId: "retention:compact-block:wrong-target",
        generation: 0,
        sequence: 1,
        manifestProtections: [{
          ...protection,
          manifest: {
            ...protection.manifest,
            publicReleaseId: "22222222-2222-5222-8222-222222222222",
            manifestFingerprint: SHA_C,
          },
        }],
      }),
    )).rejects.toThrow("CATALOG_RETENTION_PROOF_INCOMPLETE");

    const receipt = await execute(
      t,
      internal.catalogRetention.retainManifests,
      await manifestRequest(t, {
        operationId: "retention:compact-block:exact-target",
        generation: 0,
        sequence: 2,
        manifestProtections: [protection],
      }),
    );
    expect(receipt.details).toMatchObject({
      selectedManifest: null,
      deletedManifestCount: 0,
      hasMore: false,
    });
    expect(receipt.details.protectionSet.manifests).toEqual([]);
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
