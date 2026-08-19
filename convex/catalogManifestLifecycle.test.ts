/// <reference types="vite/client" />

import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  buildGlobalCatalogAggregateObservationV1,
  buildProviderCatalogSourceWatermarkV1,
  canonicalJson,
  catalogManifestActivateRequestSchema,
  catalogManifestBlockRequestSchema,
  catalogManifestPublicationRequestDigest,
  catalogManifestRefreshActiveStateRequestSchema,
  catalogManifestRollbackRequestSchema,
  catalogManifestStatusRequestSchema,
  type ActiveCatalogManifestStateV1,
  type GlobalCatalogManifestV1,
  type GlobalCatalogProviderActiveObservationV1,
  type ProviderCatalogReleasePublishPlanV1,
  type ProviderReleaseExpectedCompletedHeadV1,
} from "@packscout/contracts";
import type { FunctionReference } from "convex/server";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import {
  buildCatalogManifestFromProviderPlans,
  seedProviderCatalogPublishPlanGraph,
} from "./mockCatalogManifestSeed";
import {
  PROVIDER_BETA_TEST_KEY_ID,
  PROVIDER_TEST_KEY_ID,
  buildProviderPublishPlan,
  providerBodyDigest,
  providerOperationEnvelope,
  providerReleaseContext,
  providerReleaseProof,
} from "./providerReleaseSecurity.test-support";
import { loadActiveCatalogManifestState, loadValidatedCatalogManifest } from "./catalogManifestState";

const modules = import.meta.glob("./**/*.ts");
type CatalogTest = TestConvex<typeof schema>;
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

const PUBLISH_KEY = "catalog-publish-v1";
const ROLLBACK_KEY = "catalog-rollback-v1";
const CLEAR_KEY = "catalog-clear-v1";
const SERVER_TIME = "2026-08-16T12:00:00.000Z";

function createTest(): CatalogTest {
  return convexTest({ schema, modules, transactionLimits: true });
}

function configureKeys(originSetHash: string): void {
  const secret = Buffer.from(
    "packscout-catalog-manifest-test-secret-v1",
  ).toString("base64");
  vi.stubEnv("PACKSCOUT_PUBLIC_ORIGIN_SET_HASH", originSetHash);
  vi.stubEnv(
    "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS",
    canonicalJson({
      [CLEAR_KEY]: secret,
      [PUBLISH_KEY]: secret,
      [ROLLBACK_KEY]: secret,
    }),
  );
  vi.stubEnv(
    "PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES",
    canonicalJson({
      [CLEAR_KEY]: ["clear"],
      [PUBLISH_KEY]: ["publish"],
      [ROLLBACK_KEY]: ["rollback"],
    }),
  );
  vi.stubEnv(
    "PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS",
    canonicalJson({
      [PROVIDER_TEST_KEY_ID]: "alpha",
      [PROVIDER_BETA_TEST_KEY_ID]: "beta",
    }),
  );
}

async function execute(
  t: CatalogTest,
  operation: ExecutionReference,
  request: unknown,
  keyId = PUBLISH_KEY,
): Promise<any> {
  const bodyJson = canonicalJson(request);
  return await t.mutation(operation, {
    bodyJson,
    requestDigest: await catalogManifestPublicationRequestDigest(request),
    authenticatedKeyId: keyId,
  });
}

async function executeProvider(
  t: CatalogTest,
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

function identity(manifest: GlobalCatalogManifestV1) {
  return {
    publicReleaseId: manifest.publicReleaseId,
    manifestFingerprint: manifest.manifestFingerprint,
    sharedConfigurationEpoch: manifest.sharedConfigurationEpoch,
    providerReferenceSetHash: manifest.providerReferenceSetHash,
  };
}

async function activeState(t: CatalogTest): Promise<ActiveCatalogManifestStateV1> {
  return await t.run(async (ctx) =>
    (await loadActiveCatalogManifestState(ctx)).state
  );
}

async function seedInitialProvider(
  t: CatalogTest,
  plan: ProviderCatalogReleasePublishPlanV1,
) {
  return await t.run((ctx) =>
    seedProviderCatalogPublishPlanGraph(ctx, plan, SERVER_TIME)
  );
}

async function activate(
  t: CatalogTest,
  manifest: GlobalCatalogManifestV1,
  selection: GlobalCatalogProviderActiveObservationV1 |
    readonly GlobalCatalogProviderActiveObservationV1[],
  expected: ActiveCatalogManifestStateV1,
  operationId: string,
) {
  const observation = buildGlobalCatalogAggregateObservationV1({
    observationSequence: (expected.observation?.observationSequence ?? 0) + 1,
    publicReleaseId: manifest.publicReleaseId,
    providerReferenceSetHash: manifest.providerReferenceSetHash,
    providerSelections: Array.isArray(selection) ? selection : [selection],
  });
  const request = catalogManifestActivateRequestSchema.parse({
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId,
    idempotencyKey: operationId,
    manifest,
    observation,
    expectedActiveState: expected,
  });
  return {
    request,
    receipt: await execute(
      t,
      internal.catalogManifestActivate.activateManifest,
      request,
    ),
  };
}

async function expectedProviderHead(
  t: CatalogTest,
  platformKey = "alpha",
): Promise<ProviderReleaseExpectedCompletedHeadV1> {
  const head = await t.run((ctx) =>
    ctx.db.query("providerCatalogCompletedHeads")
      .withIndex("by_platform_key", (index) =>
        index.eq("platformKey", platformKey)
      )
      .unique()
  );
  if (head === null) throw new Error("Expected provider head.");
  return {
    platformKey: head.platformKey,
    publicProviderReleaseId: head.publicProviderReleaseId,
    sharedConfigurationEpoch: head.sharedConfigurationEpoch,
    providerCheckpoint: head.providerCheckpoint,
    observation: head.observation,
    terminalReceiptSha256: head.terminalReceiptSha256,
  };
}

async function confirmProviderReuse(
  t: CatalogTest,
  plan: ProviderCatalogReleasePublishPlanV1,
  checkpointSequence: string,
): Promise<GlobalCatalogProviderActiveObservationV1> {
  const expected = await expectedProviderHead(t, plan.platformKey);
  const settledAt = "2026-08-16T12:04:00.000Z";
  const lastSuccessfulObservationAt = "2026-08-16T12:03:00.000Z";
  const staleAt = "2026-08-16T12:18:00.000Z";
  const receipt = await executeProvider(
    t,
    internal.providerReleaseFinalize.confirmReuse,
    {
      ...providerOperationEnvelope(
        `provider:reuse:${plan.platformKey}:${checkpointSequence}`,
      ),
      release: providerReleaseProof(plan),
      providerCheckpoint: { settledSequence: checkpointSequence, settledAt },
      sourceWatermark: buildProviderCatalogSourceWatermarkV1(
        plan.platformKey,
        checkpointSequence,
      ),
      observation: {
        sourceHeadSequence: checkpointSequence,
        lastSuccessfulObservationAt,
        staleAt,
        freshness: "fresh",
      },
      expectedCompletedHead: expected,
    },
    plan.platformKey === "beta"
      ? PROVIDER_BETA_TEST_KEY_ID
      : PROVIDER_TEST_KEY_ID,
  );
  const head = await t.run((ctx) =>
    ctx.db.query("providerCatalogCompletedHeads")
      .withIndex("by_platform_key", (index) =>
        index.eq("platformKey", plan.platformKey)
      )
      .unique()
  );
  if (head === null) throw new Error("Expected reused provider head.");
  return {
    platformKey: plan.platformKey,
    publicProviderReleaseId: plan.publicProviderReleaseId,
    terminalOperationKind: "confirmReuse",
    terminalOperationId: receipt.operationId,
    terminalReceiptSha256: head.terminalReceiptSha256,
    selectedProviderCheckpoint: head.providerCheckpoint,
    selectedDataAsOf: plan.dataAsOf,
    latestAffectedSettledSequence: head.providerCheckpoint.settledSequence,
    latestAffectedSourceHeadSequence: head.observation.sourceHeadSequence,
    initialBackfillComplete: true,
    affectedDerivationsSettled: true,
    settledSourceFreshness: head.observation.freshness,
    lastSuccessfulObservationAt: head.observation.lastSuccessfulObservationAt,
    staleAt: head.observation.staleAt,
  };
}

async function completeNextProviderRelease(
  t: CatalogTest,
  plan: ProviderCatalogReleasePublishPlanV1,
): Promise<GlobalCatalogProviderActiveObservationV1> {
  const expected = await expectedProviderHead(t);
  const context = providerReleaseContext(plan, expected);
  const suffix = `${plan.platformKey}:${plan.providerCheckpoint.settledSequence}`;
  await executeProvider(t, internal.providerReleaseStart.start, {
    ...providerOperationEnvelope(`provider:start:${suffix}`),
    ...context,
  });
  await executeProvider(t, internal.providerReleaseBatch.applyBatch, {
    ...providerOperationEnvelope(`provider:batch:${suffix}:0`),
    ...context,
    batch: plan.batches[0]!,
  });
  const finalize = await executeProvider(
    t,
    internal.providerReleaseFinalize.finalize,
    {
      ...providerOperationEnvelope(`provider:finalize:${suffix}`),
      ...context,
    },
  );
  const head = await t.run((ctx) =>
    ctx.db.query("providerCatalogCompletedHeads")
      .withIndex("by_platform_key", (index) => index.eq("platformKey", "alpha"))
      .unique()
  );
  if (head === null) throw new Error("Expected advanced provider head.");
  return {
    platformKey: plan.platformKey,
    publicProviderReleaseId: plan.publicProviderReleaseId,
    terminalOperationKind: "finalize",
    terminalOperationId: finalize.operationId,
    terminalReceiptSha256: head.terminalReceiptSha256,
    selectedProviderCheckpoint: plan.providerCheckpoint,
    selectedDataAsOf: plan.dataAsOf,
    latestAffectedSettledSequence: plan.providerCheckpoint.settledSequence,
    latestAffectedSourceHeadSequence: plan.observation.sourceHeadSequence,
    initialBackfillComplete: true,
    affectedDerivationsSettled: true,
    settledSourceFreshness: plan.observation.freshness,
    lastSuccessfulObservationAt: plan.observation.lastSuccessfulObservationAt,
    staleAt: plan.observation.staleAt,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("catalog manifest lifecycle", () => {
  test("activates atomically, replays exactly, and rejects a stale CAS", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_TIME);
    const plan = await buildProviderPublishPlan({
      checkpointSequence: "20",
      platformKey: "alpha",
    });
    configureKeys(plan.governingHashes.originSetHash);
    const t = createTest();
    const completed = await seedInitialProvider(t, plan);
    const manifest = await buildCatalogManifestFromProviderPlans(
      [plan],
      "confidence-v1",
      "canonical",
    );
    const pristine = await activeState(t);
    const first = await activate(
      t,
      manifest,
      completed.selection,
      pristine,
      "catalog:activate:a1",
    );
    const replay = await execute(
      t,
      internal.catalogManifestActivate.activateManifest,
      first.request,
    );
    expect(replay).toEqual(first.receipt);
    const activationDigest = await catalogManifestPublicationRequestDigest(
      first.request,
    );
    const status = catalogManifestStatusRequestSchema.parse({
      schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
      target: {
        operationKind: "activateManifest",
        operationId: first.request.operationId,
        idempotencyKey: first.request.idempotencyKey,
        requestDigest: activationDigest,
        publicReleaseId: manifest.publicReleaseId,
        manifestFingerprint: manifest.manifestFingerprint,
      },
    });
    await expect(
      execute(t, internal.catalogManifestRead.status, status),
    ).resolves.toEqual(first.receipt);
    await expect(
      execute(t, internal.catalogManifestRead.status, {
        ...status,
        target: { ...status.target, requestDigest: "0".repeat(64) },
      }),
    ).rejects.toThrow("CATALOG_MANIFEST_OPERATION_CONFLICT");
    await expect(
      activate(
        t,
        manifest,
        completed.selection,
        pristine,
        "catalog:activate:stale",
      ),
    ).rejects.toThrow(/REFERENCE_SET_UNCHANGED|PREDECESSOR_CONFLICT/u);
    const stored = await t.run(async (ctx) => ({
      manifests: await ctx.db.query("globalCatalogManifests").collect(),
      operations: await ctx.db.query("catalogManifestOperations").collect(),
      heads: await ctx.db.query("providerCatalogCompletedHeads").collect(),
    }));
    expect(stored.manifests).toHaveLength(1);
    expect(stored.operations).toHaveLength(1);
    expect(stored.heads[0]!.publicProviderReleaseId).toBe(
      plan.publicProviderReleaseId,
    );
  });

  test("provider completion remains invisible until a manifest transition", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_TIME);
    const firstPlan = await buildProviderPublishPlan({
      checkpointSequence: "20",
      platformKey: "alpha",
      vendorDisplayName: "Alpha A1",
    });
    configureKeys(firstPlan.governingHashes.originSetHash);
    const t = createTest();
    const first = await seedInitialProvider(t, firstPlan);
    const manifest = await buildCatalogManifestFromProviderPlans(
      [firstPlan], "confidence-v1", "canonical",
    );
    await activate(
      t,
      manifest,
      first.selection,
      await activeState(t),
      "catalog:activate:invisible:a1",
    );
    const before = await t.run((ctx) => loadValidatedCatalogManifest(ctx));
    const nextPlan = await buildProviderPublishPlan({
      checkpointSequence: "30",
      platformKey: "alpha",
      vendorDisplayName: "Alpha A2",
    });
    await completeNextProviderRelease(t, nextPlan);
    const after = await t.run((ctx) => loadValidatedCatalogManifest(ctx));
    expect(after?.manifest.publicReleaseId).toBe(manifest.publicReleaseId);
    expect(after?.providerReleases[0]?._id).toBe(
      before?.providerReleases[0]?._id,
    );
    expect(after?.state).toEqual(before?.state);
  });

  test("activates A2 with delayed B1 facts beyond B's head and refreshes B1 after reuse", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_TIME);
    const alphaOne = await buildProviderPublishPlan({
      checkpointSequence: "20",
      platformKey: "alpha",
      vendorDisplayName: "Alpha A1",
    });
    const betaOne = await buildProviderPublishPlan({
      checkpointSequence: "20",
      platformKey: "beta",
      publicVendorId: "bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb",
      vendorDisplayName: "Beta B1",
    });
    configureKeys(alphaOne.governingHashes.originSetHash);
    const t = createTest();
    const alphaCompleted = await seedInitialProvider(t, alphaOne);
    const betaCompleted = await seedInitialProvider(t, betaOne);
    const initialManifest = await buildCatalogManifestFromProviderPlans(
      [alphaOne, betaOne],
      "confidence-v1",
      "canonical",
    );
    await activate(
      t,
      initialManifest,
      [alphaCompleted.selection, betaCompleted.selection],
      await activeState(t),
      "catalog:activate:delayed:a1-b1",
    );

    const alphaTwo = await buildProviderPublishPlan({
      checkpointSequence: "30",
      platformKey: "alpha",
      vendorDisplayName: "Alpha A2",
    });
    const alphaTwoSelection = await completeNextProviderRelease(t, alphaTwo);
    const advancedBetaFacts = {
      ...betaCompleted.selection,
      latestAffectedSettledSequence: "30",
      latestAffectedSourceHeadSequence: "30",
      affectedDerivationsSettled: false,
      settledSourceFreshness: "delayed" as const,
      lastSuccessfulObservationAt: "2026-08-16T12:01:00.000Z",
      staleAt: "2026-08-16T12:16:00.000Z",
    };
    const advancedManifest = await buildCatalogManifestFromProviderPlans(
      [alphaTwo, betaOne],
      "confidence-v1",
      "canonical",
    );
    await activate(
      t,
      advancedManifest,
      [alphaTwoSelection, advancedBetaFacts],
      await activeState(t),
      "catalog:activate:delayed:a2-b1",
    );
    const delayed = await activeState(t);
    expect(delayed.activeManifest?.publicReleaseId).toBe(
      advancedManifest.publicReleaseId,
    );
    expect(delayed.observation).toMatchObject({
      freshness: "delayed",
      delayedProviderCount: 1,
    });
    expect(
      (await expectedProviderHead(t, "beta")).providerCheckpoint.settledSequence,
    ).toBe("20");

    vi.setSystemTime("2026-08-16T12:20:00.000Z");
    const recoveredBeta = await confirmProviderReuse(t, betaOne, "30");
    const beforeRefresh = await activeState(t);
    const recoveredObservation = buildGlobalCatalogAggregateObservationV1({
      observationSequence: beforeRefresh.observation!.observationSequence + 1,
      publicReleaseId: advancedManifest.publicReleaseId,
      providerReferenceSetHash: advancedManifest.providerReferenceSetHash,
      providerSelections: [alphaTwoSelection, recoveredBeta],
    });
    const refresh = catalogManifestRefreshActiveStateRequestSchema.parse({
      schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
      operationId: "catalog:refresh:recovered:a2-b1",
      idempotencyKey: "catalog:refresh:recovered:a2-b1",
      manifest: identity(advancedManifest),
      observation: recoveredObservation,
      expectedActiveState: beforeRefresh,
    });
    const manifestCountBefore = await t.run(async (ctx) =>
      (await ctx.db.query("globalCatalogManifests").collect()).length
    );
    await execute(t, internal.catalogManifestRefresh.refreshActiveState, refresh);
    const recovered = await activeState(t);
    expect(recovered.observation).toMatchObject({
      freshness: "fresh",
      delayedProviderCount: 0,
    });
    expect(await t.run(async (ctx) =>
      (await ctx.db.query("globalCatalogManifests").collect()).length
    )).toBe(manifestCountBefore);
    expect(
      (await expectedProviderHead(t, "beta")).publicProviderReleaseId,
    ).toBe(betaOne.publicProviderReleaseId);
  });

  test("refresh keeps immutable identity and historical rollback leaves head advanced", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_TIME);
    const firstPlan = await buildProviderPublishPlan({
      checkpointSequence: "20",
      platformKey: "alpha",
      vendorDisplayName: "Alpha A1",
    });
    configureKeys(firstPlan.governingHashes.originSetHash);
    const t = createTest();
    const first = await seedInitialProvider(t, firstPlan);
    const firstManifest = await buildCatalogManifestFromProviderPlans(
      [firstPlan], "confidence-v1", "canonical",
    );
    await activate(
      t,
      firstManifest,
      first.selection,
      await activeState(t),
      "catalog:activate:rollback:a1",
    );
    const nextPlan = await buildProviderPublishPlan({
      checkpointSequence: "30",
      platformKey: "alpha",
      vendorDisplayName: "Alpha A2",
    });
    const nextSelection = await completeNextProviderRelease(t, nextPlan);
    const nextManifest = await buildCatalogManifestFromProviderPlans(
      [nextPlan], "confidence-v1", "canonical",
    );
    await activate(
      t,
      nextManifest,
      nextSelection,
      await activeState(t),
      "catalog:activate:rollback:a2",
    );
    const manifestCount = await t.run(async (ctx) =>
      (await ctx.db.query("globalCatalogManifests").collect()).length
    );
    const expected = await activeState(t);
    const refreshedObservation = buildGlobalCatalogAggregateObservationV1({
      observationSequence: expected.observation!.observationSequence + 1,
      publicReleaseId: nextManifest.publicReleaseId,
      providerReferenceSetHash: nextManifest.providerReferenceSetHash,
      providerSelections: [nextSelection],
    });
    const refresh = catalogManifestRefreshActiveStateRequestSchema.parse({
      schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
      operationId: "catalog:refresh:a2",
      idempotencyKey: "catalog:refresh:a2",
      manifest: identity(nextManifest),
      observation: refreshedObservation,
      expectedActiveState: expected,
    });
    await execute(
      t,
      internal.catalogManifestRefresh.refreshActiveState,
      refresh,
    );
    expect(await t.run(async (ctx) =>
      (await ctx.db.query("globalCatalogManifests").collect()).length
    )).toBe(manifestCount);

    const beforeRollback = await activeState(t);
    const delayedFirstSelection = {
      ...first.selection,
      latestAffectedSettledSequence:
        nextSelection.latestAffectedSettledSequence,
      latestAffectedSourceHeadSequence:
        nextSelection.latestAffectedSourceHeadSequence,
      settledSourceFreshness: nextSelection.settledSourceFreshness,
      lastSuccessfulObservationAt:
        nextSelection.lastSuccessfulObservationAt,
      staleAt: nextSelection.staleAt,
    };
    const rollbackObservation = buildGlobalCatalogAggregateObservationV1({
      observationSequence: beforeRollback.observation!.observationSequence + 1,
      publicReleaseId: firstManifest.publicReleaseId,
      providerReferenceSetHash: firstManifest.providerReferenceSetHash,
      providerSelections: [delayedFirstSelection],
    });
    const rollback = catalogManifestRollbackRequestSchema.parse({
      schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
      operationId: "catalog:rollback:a1",
      idempotencyKey: "catalog:rollback:a1",
      rollbackKind: "manifest",
      targetManifest: identity(firstManifest),
      observation: rollbackObservation,
      expectedActiveState: beforeRollback,
    });
    const headBefore = await expectedProviderHead(t);
    await execute(
      t,
      internal.catalogManifestRollback.rollback,
      rollback,
      ROLLBACK_KEY,
    );
    const headAfter = await expectedProviderHead(t);
    expect(headAfter).toEqual(headBefore);
    const rolledBack = await activeState(t);
    expect(rolledBack.activeManifest?.publicReleaseId).toBe(
      firstManifest.publicReleaseId,
    );
    expect(rolledBack.observation?.freshness).toBe("delayed");
  });

  test("blocks bind fingerprint identity and cannot newly block active state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_TIME);
    const plan = await buildProviderPublishPlan({ platformKey: "alpha" });
    configureKeys(plan.governingHashes.originSetHash);
    const t = createTest();
    const firstBlock = catalogManifestBlockRequestSchema.parse({
      schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
      operationId: "catalog:block:one",
      idempotencyKey: "catalog:block:one",
      publicReleaseId: "11111111-1111-5111-8111-111111111111",
      manifestFingerprint: "f".repeat(64),
      blockSequence: "1",
      reason: "MANIFEST_SECURITY_INVALID",
    });
    await execute(t, internal.catalogManifestBlock.block, firstBlock);
    const mismatched = catalogManifestBlockRequestSchema.parse({
      ...firstBlock,
      operationId: "catalog:block:two",
      idempotencyKey: "catalog:block:two",
      publicReleaseId: "22222222-2222-5222-8222-222222222222",
      blockSequence: "2",
    });
    await expect(
      execute(t, internal.catalogManifestBlock.block, mismatched),
    ).rejects.toThrow("CATALOG_MANIFEST_IDENTITY_MISMATCH");

    const completed = await seedInitialProvider(t, plan);
    const manifest = await buildCatalogManifestFromProviderPlans(
      [plan], "confidence-v1", "canonical",
    );
    await activate(
      t,
      manifest,
      completed.selection,
      await activeState(t),
      "catalog:activate:block",
    );
    const blockActive = catalogManifestBlockRequestSchema.parse({
      schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
      operationId: "catalog:block:active",
      idempotencyKey: "catalog:block:active",
      publicReleaseId: manifest.publicReleaseId,
      manifestFingerprint: manifest.manifestFingerprint,
      blockSequence: "1",
      reason: "MANIFEST_SECURITY_INVALID",
    });
    const stateBefore = await activeState(t);
    await expect(
      execute(t, internal.catalogManifestBlock.block, blockActive),
    ).rejects.toThrow("CATALOG_MANIFEST_STATE_CONFLICT");
    expect(await activeState(t)).toEqual(stateBefore);
  });

  test("clear requires its separate role and writes one terminal empty state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_TIME);
    const plan = await buildProviderPublishPlan({ platformKey: "alpha" });
    configureKeys(plan.governingHashes.originSetHash);
    const t = createTest();
    const completed = await seedInitialProvider(t, plan);
    const manifest = await buildCatalogManifestFromProviderPlans(
      [plan], "confidence-v1", "canonical",
    );
    await activate(
      t,
      manifest,
      completed.selection,
      await activeState(t),
      "catalog:activate:clear",
    );
    const expected = await activeState(t);
    const clear = catalogManifestRollbackRequestSchema.parse({
      schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
      operationId: "catalog:clear",
      idempotencyKey: "catalog:clear",
      rollbackKind: "clear",
      clearAuthorization: "clear_catalog_manifest_v1",
      expectedActiveState: expected,
    });
    await expect(
      execute(
        t,
        internal.catalogManifestRollback.rollback,
        clear,
        ROLLBACK_KEY,
      ),
    ).rejects.toThrow("CATALOG_MANIFEST_AUTH_FORBIDDEN");
    await execute(
      t,
      internal.catalogManifestRollback.rollback,
      clear,
      CLEAR_KEY,
    );
    const cleared = await activeState(t);
    expect(cleared).toMatchObject({
      generation: expected.generation + 1,
      activeManifest: null,
      previousManifest: null,
      observation: null,
    });
    expect(cleared.terminalReceiptSha256).toMatch(/^[0-9a-f]{64}$/u);
  });
});
