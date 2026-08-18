/// <reference types="vite/client" />

import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  EMPTY_PRODUCTION_HEAT_SIGNAL_SET_HASH,
  REPACK_HEAT_AGGREGATION_VERSION,
  REPACK_HEAT_POLICY_VERSION,
  buildGlobalCatalogAggregateObservationV1,
  canonicalJson,
  catalogManifestPublicationRequestDigest,
  catalogManifestRefreshActiveStateRequestSchema,
  catalogManifestRollbackRequestSchema,
  deriveRepackHeatV1Policy,
  extendProductionHeatSignalSetHash,
  productionHeatCoreByteCount,
  productionHeatManifestAlignmentSchema,
  publicRepackHeatSignalSchema,
  recomputeProductionHeatBatchHash,
  recomputeProductionHeatFrameHash,
  productionHeatTerminalReceiptSha256,
  type ProductionHeatApplyBatchRequest,
  type ProductionHeatFinalizeRequest,
  type ProductionHeatFrameEnvelope,
  type ProductionHeatManifestAlignment,
  type ProductionHeatRefreshFrameRequest,
  type ProductionHeatStartRequest,
  type PublicRepackHeatSignal,
} from "@packscout/contracts";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  MOCK_DATA_RELEASE_ORIGIN_SET_HASH,
} from "./mockDataReleaseFixture";
import { buildMockHeatFrame } from "./mockHeatSimulationFixture";
import { seedHeatCatalogManifestForTest } from "./repackHeatTestCatalog";
import { refreshCatalogManifestRequest } from "./catalogManifestRefresh";
import { rollbackCatalogManifestRequest } from "./catalogManifestRollback";
import { loadActiveCatalogManifestState } from "./catalogManifestState";

const modules = import.meta.glob("./**/*.ts");
type HeatTest = TestConvex<typeof schema>;

const KEY_ID = "heat-publisher-v1";
const KEY_SECRET = Uint8Array.from([
  0xff, 0x00, 0x80, 0x7f, 0x01, 0xfe, 0x81, 0x42,
  0xc3, 0x28, 0xa0, 0xa1, 0xf5, 0x90, 0x80, 0x80,
  0xde, 0xad, 0xbe, 0xef, 0x10, 0x20, 0x30, 0x40,
  0x50, 0x60, 0x70, 0x90, 0xaa, 0xbb, 0xcc, 0xdd,
]);
const FIRST_FRAME_ID = "91000000-0000-4000-8000-000000000001";
const SECOND_FRAME_ID = "91000000-0000-4000-8000-000000000002";
const THIRD_FRAME_ID = "91000000-0000-4000-8000-000000000003";
const START_AT = "2026-08-15T12:00:00.000Z";
let activeManifestAlignment: ProductionHeatManifestAlignment;

function createTest() {
  return convexTest({ schema, modules, transactionLimits: true });
}

function configure() {
  vi.useFakeTimers();
  vi.setSystemTime(START_AT);
  vi.stubEnv("PACKSCOUT_RUNTIME_ENVIRONMENT", "local");
  vi.stubEnv("PACKSCOUT_MOCK_DATA_RELEASE_SEED_ENABLED", "1");
  vi.stubEnv(
    "PACKSCOUT_PUBLIC_ORIGIN_SET_HASH",
    MOCK_DATA_RELEASE_ORIGIN_SET_HASH,
  );
  vi.stubEnv(
    "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS",
    JSON.stringify({
      [KEY_ID]: btoa(String.fromCharCode(...KEY_SECRET)),
    }),
  );
  vi.stubEnv(
    "PACKSCOUT_HEAT_PUBLICATION_KEY_IDS",
    canonicalJson([KEY_ID]),
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function bodyDigest(bodyJson: string): Promise<string> {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bodyJson)),
    ),
  );
}

async function hmacHex(value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    KEY_SECRET,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
    ),
  );
}

let nonceSequence = 0;
async function signedFetch(t: HeatTest, path: string, body: unknown) {
  nonceSequence += 1;
  const bodyJson = JSON.stringify(body);
  const digest = await bodyDigest(bodyJson);
  const timestamp = String(Date.now());
  const nonce = `heatnonce${String(nonceSequence).padStart(16, "0")}`;
  const signature = await hmacHex(
    ["v1", "POST", path, digest, timestamp, nonce].join("\n"),
  );
  return await t.fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-packscout-signature-version": "v1",
      "x-packscout-key-id": KEY_ID,
      "x-packscout-timestamp": timestamp,
      "x-packscout-nonce": nonce,
      "x-packscout-content-sha256": digest,
      "x-packscout-signature": signature,
    },
    body: bodyJson,
  });
}

async function seedCanonicalCatalog(t: HeatTest) {
  const seeded = await t.run((ctx) => seedHeatCatalogManifestForTest(ctx));
  vi.stubEnv(
    "PACKSCOUT_PUBLIC_ORIGIN_SET_HASH",
    seeded.manifest.governingHashes.originSetHash,
  );
  activeManifestAlignment = productionHeatManifestAlignmentSchema.parse({
    publicReleaseId: seeded.manifest.publicReleaseId,
    manifestFingerprint: seeded.manifest.manifestFingerprint,
    sharedConfigurationEpoch: seeded.manifest.sharedConfigurationEpoch,
    providerReferenceSetHash: seeded.manifest.providerReferenceSetHash,
  });
  return seeded;
}

async function activateEquivalentCatalog(
  t: HeatTest,
): Promise<ProductionHeatManifestAlignment> {
  const seeded = await t.run((ctx) =>
    seedHeatCatalogManifestForTest(ctx, {
      providerRevisions: { collector_crypt: 1 },
      observationSequence: 2,
      serverTime: "2026-08-15T12:01:00.000Z",
    })
  );
  activeManifestAlignment = productionHeatManifestAlignmentSchema.parse({
    publicReleaseId: seeded.manifest.publicReleaseId,
    manifestFingerprint: seeded.manifest.manifestFingerprint,
    sharedConfigurationEpoch: seeded.manifest.sharedConfigurationEpoch,
    providerReferenceSetHash: seeded.manifest.providerReferenceSetHash,
  });
  return activeManifestAlignment;
}

async function refreshCatalogObservation(t: HeatTest): Promise<void> {
  const current = await t.run(async (ctx) =>
    (await loadActiveCatalogManifestState(ctx)).state
  );
  if (current.activeManifest === null || current.observation === null) {
    throw new Error("Expected an active catalog manifest observation.");
  }
  const observation = buildGlobalCatalogAggregateObservationV1({
    observationSequence: current.observation.observationSequence + 1,
    publicReleaseId: current.activeManifest.publicReleaseId,
    providerReferenceSetHash:
      current.activeManifest.providerReferenceSetHash,
    providerSelections: current.observation.providerSelections,
  });
  const request = catalogManifestRefreshActiveStateRequestSchema.parse({
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId: "catalog:refresh:heat-metadata",
    idempotencyKey: "catalog:refresh:heat-metadata",
    manifest: {
      publicReleaseId: current.activeManifest.publicReleaseId,
      manifestFingerprint: current.activeManifest.manifestFingerprint,
      sharedConfigurationEpoch:
        current.activeManifest.sharedConfigurationEpoch,
      providerReferenceSetHash:
        current.activeManifest.providerReferenceSetHash,
    },
    observation,
    expectedActiveState: current,
  });
  const requestDigest = await catalogManifestPublicationRequestDigest(request);
  await t.run((ctx) =>
    refreshCatalogManifestRequest(ctx, request, requestDigest)
  );
}

function observedSignal(signal: PublicRepackHeatSignal) {
  return publicRepackHeatSignalSchema.parse({
    ...signal,
    provenance: {
      kind: "observed",
      aggregationVersion: REPACK_HEAT_AGGREGATION_VERSION,
    },
    limitationCodes: signal.limitationCodes.filter(
      (code) => code !== "simulated_data",
    ),
  });
}

function partialSignal(signal: PublicRepackHeatSignal) {
  const policy = deriveRepackHeatV1Policy({
    currentPullCount: signal.currentWindow.pullCount,
    baselinePullCount: signal.baselineWindow.pullCount,
    components: signal.components,
    sourceCoverage: "partial",
    provenanceKind: "observed",
  });
  return publicRepackHeatSignalSchema.parse({
    ...signal,
    sourceCoverage: "partial",
    ...policy,
  });
}

type HeatPlan = Readonly<{
  frame: ProductionHeatFrameEnvelope;
  records: readonly PublicRepackHeatSignal[];
  start: ProductionHeatStartRequest;
  batch: ProductionHeatApplyBatchRequest;
  finalize: ProductionHeatFinalizeRequest;
}>;

async function buildPlan(
  publicHeatFrameId = FIRST_FRAME_ID,
  expectedBatchCount = 1,
  minuteOffset = 0,
  expectedActivePublicHeatFrameId: string | null = null,
  manifestAlignment: ProductionHeatManifestAlignment = activeManifestAlignment,
  contentVariant: "default" | "partial" = "default",
): Promise<HeatPlan> {
  const mock = await buildMockHeatFrame({
    seed: "production-protocol-test",
    startAt: START_AT,
    frameIndex: minuteOffset,
    frameStepMilliseconds: 60_000,
    publicationCadenceMilliseconds: 60_000,
  });
  const records = mock.signals.map(observedSignal).map((signal) =>
    contentVariant === "partial" ? partialSignal(signal) : signal
  ).sort((left, right) =>
    left.publicRepackId.localeCompare(right.publicRepackId)
  );
  const batchHash = await recomputeProductionHeatBatchHash(records);
  const signalSetHash = await extendProductionHeatSignalSetHash({
    previousHash: EMPTY_PRODUCTION_HEAT_SIGNAL_SET_HASH,
    batchIndex: 0,
    batchHash,
    recordCount: records.length,
    coreByteCount: productionHeatCoreByteCount(records),
  });
  const candidate: ProductionHeatFrameEnvelope = {
    publicHeatFrameId,
    manifestAlignment,
    frameSequence: Date.parse(records[0]!.currentWindow.endedAt) / 60_000,
    sourceWatermark: String(100 + minuteOffset),
    signalSetHash,
    frameHash: "0".repeat(64),
    signalCount: records.length,
    aggregationVersion: REPACK_HEAT_AGGREGATION_VERSION,
    heatPolicyVersion: REPACK_HEAT_POLICY_VERSION,
    baselineWindowStartedAt: records[0]!.baselineWindow.startedAt,
    baselineWindowEndedAt: records[0]!.baselineWindow.endedAt,
    currentWindowStartedAt: records[0]!.currentWindow.startedAt,
    currentWindowEndedAt: records[0]!.currentWindow.endedAt,
    calculatedAt: records[0]!.calculatedAt,
    expiresAt: records[0]!.expiresAt,
  };
  const frame = {
    ...candidate,
    frameHash: await recomputeProductionHeatFrameHash(candidate),
  };
  const start = {
    schemaVersion: "repack_heat_publication_v1",
    operationId: `start:${publicHeatFrameId}`,
    idempotencyKey: `start:${publicHeatFrameId}`,
    publicationId: publicHeatFrameId,
    frame,
    expectedBatchCount,
  } satisfies ProductionHeatStartRequest;
  const batch = {
    schemaVersion: "repack_heat_publication_v1",
    operationId: `apply:${publicHeatFrameId}:0`,
    idempotencyKey: `apply:${publicHeatFrameId}:0`,
    publicationId: publicHeatFrameId,
    batchIndex: 0,
    batchHash,
    records,
  } satisfies ProductionHeatApplyBatchRequest;
  const finalize = {
    schemaVersion: "repack_heat_publication_v1",
    operationId: `finalize:${publicHeatFrameId}`,
    idempotencyKey: `finalize:${publicHeatFrameId}`,
    publicationId: publicHeatFrameId,
    expectedActivePublicHeatFrameId,
    expectedManifestAlignment: manifestAlignment,
    expectedSignalSetHash: signalSetHash,
    expectedFrameHash: frame.frameHash,
    expectedSignalCount: records.length,
    expectedBatchCount,
  } satisfies ProductionHeatFinalizeRequest;
  return { frame, records, start, batch, finalize };
}

async function invoke<T>(
  t: HeatTest,
  operation: Parameters<HeatTest["mutation"]>[0],
  body: unknown,
): Promise<T> {
  const bodyJson = JSON.stringify(body);
  return await t.mutation(operation, {
    bodyJson,
    requestDigest: await bodyDigest(bodyJson),
  }) as T;
}

async function publish(t: HeatTest, plan: HeatPlan) {
  await invoke(t, internal.productionHeatLifecycle.start, plan.start);
  await invoke(t, internal.productionHeatBatch.applyBatch, plan.batch);
  return await invoke<Record<string, unknown>>(
    t,
    internal.productionHeatLifecycle.finalize,
    plan.finalize,
  );
}

async function refreshedFrame(
  current: ProductionHeatFrameEnvelope,
  publicHeatFrameId: string,
  minuteOffset: number,
): Promise<ProductionHeatFrameEnvelope> {
  const shift = (value: string) =>
    new Date(Date.parse(value) + minuteOffset * 60_000).toISOString();
  const candidate = {
    ...current,
    publicHeatFrameId,
    frameSequence: current.frameSequence + minuteOffset,
    sourceWatermark: String(BigInt(current.sourceWatermark) + BigInt(minuteOffset)),
    frameHash: "0".repeat(64),
    baselineWindowStartedAt: shift(current.baselineWindowStartedAt),
    baselineWindowEndedAt: shift(current.baselineWindowEndedAt),
    currentWindowStartedAt: shift(current.currentWindowStartedAt),
    currentWindowEndedAt: shift(current.currentWindowEndedAt),
    calculatedAt: shift(current.calculatedAt),
    expiresAt: shift(current.expiresAt),
  };
  return { ...candidate, frameHash: await recomputeProductionHeatFrameHash(candidate) };
}

function refreshRequest(
  frame: ProductionHeatFrameEnvelope,
  expectedActivePublicHeatFrameId: string,
): ProductionHeatRefreshFrameRequest {
  return {
    schemaVersion: "repack_heat_publication_v1",
    operationId: `refresh:${frame.publicHeatFrameId}`,
    idempotencyKey: `refresh:${frame.publicHeatFrameId}`,
    publicationId: frame.publicHeatFrameId,
    expectedActivePublicHeatFrameId,
    frame,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  nonceSequence = 0;
});

describe("production Heat publication", () => {
  test("authenticates private routes and rejects catalog mismatch or protected input without writes", async () => {
    configure();
    const t = createTest();
    await seedCanonicalCatalog(t);
    const plan = await buildPlan();

    const unsigned = await t.fetch("/internal/repack-heat/v1/start", {
      method: "POST",
      body: JSON.stringify(plan.start),
    });
    expect(unsigned.status).toBe(401);

    const emptyState = await signedFetch(
      t,
      "/internal/repack-heat/v1/active-state",
      {
        schemaVersion: "repack_heat_publication_v1",
        operationId: "heat-active-state-empty",
      },
    );
    expect(emptyState.status).toBe(200);
    await expect(emptyState.json()).resolves.toMatchObject({
      receipt: {
        operationKind: "activeState",
        publicationId: null,
        details: {
          activePublicHeatFrameId: null,
          manifestAlignment: null,
          sourceWatermark: null,
          frameSequence: 0,
          terminalReceiptSha256: null,
        },
      },
    });

    const protectedRequest = {
      ...plan.start,
      frame: { ...plan.frame, rawPayload: { provider: "private" } },
    };
    const protectedResponse = await signedFetch(
      t,
      "/internal/repack-heat/v1/start",
      protectedRequest,
    );
    expect(protectedResponse.status).toBe(400);
    await expect(protectedResponse.json()).resolves.toMatchObject({
      code: "PUBLICATION_PROTECTED_FIELD",
    });

    const mismatched = {
      ...plan.start,
      operationId: "start:mismatched-catalog",
      idempotencyKey: "start:mismatched-catalog",
      publicationId: "91000000-0000-4000-8000-000000000099",
      frame: {
        ...plan.frame,
        publicHeatFrameId: "91000000-0000-4000-8000-000000000099",
        manifestAlignment: {
          ...plan.frame.manifestAlignment,
          manifestFingerprint: "9".repeat(64),
        },
      },
    };
    mismatched.frame.frameHash = await recomputeProductionHeatFrameHash(
      mismatched.frame,
    );
    await expect(
      invoke(t, internal.productionHeatLifecycle.start, mismatched),
    ).rejects.toThrow("PUBLICATION_PREDECESSOR_CONFLICT");
    await expect(t.run(async (ctx) => ({
      publications: (await ctx.db.query("repackHeatPublications").collect()).length,
      frames: (await ctx.db.query("repackHeatSnapshots").collect()).length,
      signalSets: (await ctx.db.query("repackHeatSignalSets").collect()).length,
    }))).resolves.toEqual({ publications: 0, frames: 0, signalSets: 0 });
  });

  test("rejects duplicate provider ownership before accepting a Heat batch", async () => {
    configure();
    const t = createTest();
    await seedCanonicalCatalog(t);
    const plan = await buildPlan();
    await invoke(t, internal.productionHeatLifecycle.start, plan.start);
    await t.run(async (ctx) => {
      const repack = await ctx.db.query("providerCatalogRepacks").first();
      const releases = await ctx.db.query("providerCatalogReleases").collect();
      const other = repack === null
        ? null
        : releases.find(({ _id }) => _id !== repack.releaseId) ?? null;
      if (repack === null || other === null) {
        throw new Error("Expected two selected provider releases.");
      }
      await ctx.db.insert("providerCatalogRepacks", {
        releaseId: other._id,
        publicRepackId: repack.publicRepackId,
        vendorId: repack.vendorId,
        detail: repack.detail,
      });
    });

    await expect(
      invoke(t, internal.productionHeatBatch.applyBatch, plan.batch),
    ).rejects.toThrow("PUBLICATION_REFERENCE_INVALID");
    await expect(t.run(async (ctx) => ({
      signals: (await ctx.db.query("repackHeatSignals").collect()).length,
      batches: (await ctx.db.query("repackHeatBatches").collect()).length,
      publication: await ctx.db.query("repackHeatPublications").unique(),
    }))).resolves.toMatchObject({
      signals: 0,
      batches: 0,
      publication: { acceptedBatchCount: 0, acceptedSignalCount: 0 },
    });
  });

  test("stages, reconciles, activates atomically, and replays exact receipts", async () => {
    configure();
    const t = createTest();
    await seedCanonicalCatalog(t);
    const baseline = await buildPlan();
    await publish(t, baseline);
    const prior = await t.run(async (ctx) => ({
      state: await ctx.db.query("repackHeatState").unique(),
      active: await ctx.db.query("repackHeatSnapshots").first(),
      signals: await ctx.db.query("repackHeatSignals").collect(),
      terminal: await ctx.db
        .query("repackHeatOperations")
        .withIndex("by_operation_id", (index) =>
          index.eq("operationId", baseline.finalize.operationId),
        )
        .unique(),
    }));
    vi.setSystemTime("2026-08-15T12:01:00.000Z");
    const incomplete = await buildPlan(
      SECOND_FRAME_ID,
      2,
      1,
      FIRST_FRAME_ID,
      activeManifestAlignment,
      "partial",
    );
    expect(incomplete.frame.signalSetHash).not.toBe(baseline.frame.signalSetHash);
    await invoke(t, internal.productionHeatLifecycle.start, incomplete.start);
    await invoke(t, internal.productionHeatBatch.applyBatch, incomplete.batch);
    await expect(
      invoke(t, internal.productionHeatLifecycle.finalize, incomplete.finalize),
    ).rejects.toThrow("PUBLICATION_RECONCILIATION_FAILED");
    const afterFailure = await t.run(async (ctx) => ({
      state: await ctx.db.query("repackHeatState").unique(),
      active: await ctx.db.get("repackHeatSnapshots", prior.active!._id),
      signals: await ctx.db
        .query("repackHeatSignals")
        .withIndex("by_signal_set_id_and_public_repack_id", (index) =>
          index.eq("signalSetId", prior.active!.signalSetId),
        )
        .collect(),
      terminal: await ctx.db
        .query("repackHeatOperations")
        .withIndex("by_operation_id", (index) =>
          index.eq("operationId", baseline.finalize.operationId),
        )
        .unique(),
    }));
    expect(afterFailure.state).toEqual(prior.state);
    expect(afterFailure.active).toEqual(prior.active);
    expect(afterFailure.signals).toEqual(prior.signals);
    expect(afterFailure.terminal).toEqual(prior.terminal);

    const t2 = createTest();
    vi.setSystemTime(START_AT);
    await seedCanonicalCatalog(t2);
    const plan = await buildPlan();
    const startResponse = await signedFetch(
      t2,
      "/internal/repack-heat/v1/start",
      plan.start,
    );
    const startReplay = await signedFetch(
      t2,
      "/internal/repack-heat/v1/start",
      plan.start,
    );
    expect(startResponse.status).toBe(200);
    expect(startReplay.status).toBe(200);
    const firstStartBody = await startResponse.json();
    const replayStartBody = await startReplay.json();
    expect(replayStartBody.receipt).toEqual(firstStartBody.receipt);
    await expect(invoke(
      t2,
      internal.productionHeatLifecycle.start,
      { ...plan.start, idempotencyKey: "start:conflicting-replay" },
    )).rejects.toThrow("PUBLICATION_OPERATION_CONFLICT");
    await expect(t2.run(async (ctx) => ({
      operations: (await ctx.db.query("repackHeatOperations").collect()).length,
      publications:
        (await ctx.db.query("repackHeatPublications").collect()).length,
      signalSets:
        (await ctx.db.query("repackHeatSignalSets").collect()).length,
      signals: (await ctx.db.query("repackHeatSignals").collect()).length,
    }))).resolves.toEqual({
      operations: 1,
      publications: 1,
      signalSets: 1,
      signals: 0,
    });

    const batchReceipt = await invoke<Record<string, unknown>>(
      t2,
      internal.productionHeatBatch.applyBatch,
      plan.batch,
    );
    expect(await invoke(
      t2,
      internal.productionHeatBatch.applyBatch,
      plan.batch,
    )).toEqual(batchReceipt);
    const finalReceipt = await invoke<Record<string, unknown>>(
      t2,
      internal.productionHeatLifecycle.finalize,
      plan.finalize,
    );
    expect(await invoke(
      t2,
      internal.productionHeatLifecycle.finalize,
      plan.finalize,
    )).toEqual(finalReceipt);

    const status = await invoke<Record<string, unknown>>(
      t2,
      internal.productionHeatLifecycle.status,
      {
        schemaVersion: "repack_heat_publication_v1",
        operationId: plan.finalize.operationId,
        publicationId: plan.start.publicationId,
      },
    );
    expect(status).toEqual(finalReceipt);
    await expect(invoke(
      t2,
      internal.productionHeatLifecycle.status,
      {
        schemaVersion: "repack_heat_publication_v1",
        operationId: plan.finalize.operationId,
        publicationId: null,
      },
    )).rejects.toThrow("PUBLICATION_OPERATION_CONFLICT");
    await expect(invoke(
      t2,
      internal.productionHeatLifecycle.status,
      {
        schemaVersion: "repack_heat_publication_v1",
        operationId: plan.finalize.operationId,
        publicationId: SECOND_FRAME_ID,
      },
    )).rejects.toThrow("PUBLICATION_OPERATION_CONFLICT");
    const stored = await t2.run(async (ctx) => ({
      state: await ctx.db.query("repackHeatState").unique(),
      frames: await ctx.db.query("repackHeatSnapshots").collect(),
      signalSets: await ctx.db.query("repackHeatSignalSets").collect(),
      signals: await ctx.db.query("repackHeatSignals").collect(),
      operations: await ctx.db.query("repackHeatOperations").collect(),
    }));
    expect(stored.state?.activeHeatSnapshotId).toBe(stored.frames[0]?._id);
    expect(stored.frames).toHaveLength(1);
    expect(stored.signalSets).toHaveLength(1);
    expect(stored.signals).toHaveLength(plan.records.length);
    expect(stored.operations).toHaveLength(3);
    expect(canonicalJson(stored.signals)).not.toContain("rawPayload");
    expect(canonicalJson(stored.signals)).not.toContain("organizationId");

    const activeResponse = await signedFetch(
      t2,
      "/internal/repack-heat/v1/active-state",
      {
        schemaVersion: "repack_heat_publication_v1",
        operationId: "heat-active-state-aligned",
      },
    );
    expect(activeResponse.status).toBe(200);
    await expect(activeResponse.json()).resolves.toMatchObject({
      receipt: {
        operationKind: "activeState",
        publicationId: FIRST_FRAME_ID,
        details: {
          activePublicHeatFrameId: FIRST_FRAME_ID,
          manifestAlignment: activeManifestAlignment,
          sourceWatermark: plan.frame.sourceWatermark,
          frameSequence: plan.frame.frameSequence,
          terminalReceiptSha256:
            await productionHeatTerminalReceiptSha256(finalReceipt),
        },
      },
    });
    await t2.run(async (ctx) => {
      const state = await ctx.db.query("repackHeatState").unique();
      if (state?.activeHeatSnapshotId === null || state === null) {
        throw new Error("Expected active Heat frame.");
      }
      const active = await ctx.db.get(
        "repackHeatSnapshots",
        state.activeHeatSnapshotId,
      );
      if (active === null) throw new Error("Expected active Heat frame.");
      await ctx.db.patch("repackHeatSnapshots", active._id, {
        contentHash: "f".repeat(64),
      });
    });
    const driftedFrameState = await signedFetch(
      t2,
      "/internal/repack-heat/v1/active-state",
      {
        schemaVersion: "repack_heat_publication_v1",
        operationId: "heat-active-state-drifted-frame",
      },
    );
    expect(driftedFrameState.status).toBe(409);
    await t2.run(async (ctx) => {
      const state = await ctx.db.query("repackHeatState").unique();
      if (state?.activeHeatSnapshotId === null || state === null) {
        throw new Error("Expected active Heat frame.");
      }
      const active = await ctx.db.get(
        "repackHeatSnapshots",
        state.activeHeatSnapshotId,
      );
      if (active === null) throw new Error("Expected active Heat frame.");
      await ctx.db.patch("repackHeatSnapshots", active._id, {
        contentHash: plan.frame.frameHash,
      });
      await ctx.db.patch("repackHeatSignalSets", active.signalSetId, {
        lifecycle: "retired",
      });
    });
    const driftedSignalSetState = await signedFetch(
      t2,
      "/internal/repack-heat/v1/active-state",
      {
        schemaVersion: "repack_heat_publication_v1",
        operationId: "heat-active-state-drifted-signal-set",
      },
    );
    expect(driftedSignalSetState.status).toBe(409);
    await t2.run(async (ctx) => {
      const state = await ctx.db.query("repackHeatState").unique();
      if (state?.activeHeatSnapshotId === null || state === null) {
        throw new Error("Expected active Heat frame.");
      }
      const active = await ctx.db.get(
        "repackHeatSnapshots",
        state.activeHeatSnapshotId,
      );
      if (active === null) throw new Error("Expected active Heat frame.");
      await ctx.db.patch("repackHeatSignalSets", active.signalSetId, {
        lifecycle: "complete",
      });
      const operation = await ctx.db
        .query("repackHeatOperations")
        .withIndex("by_operation_id", (index) =>
          index.eq("operationId", plan.finalize.operationId),
        )
        .unique();
      if (operation === null) throw new Error("Expected finalize receipt.");
      await ctx.db.patch("repackHeatOperations", operation._id, {
        receiptJson: "{}",
      });
    });
    const corruptState = await signedFetch(
      t2,
      "/internal/repack-heat/v1/active-state",
      {
        schemaVersion: "repack_heat_publication_v1",
        operationId: "heat-active-state-corrupt",
      },
    );
    expect(corruptState.status).toBe(409);
    await expect(corruptState.json()).resolves.toMatchObject({
      code: "PUBLICATION_STATE_CONFLICT",
    });
  });

  test("keeps an aligned Heat frame readable across metadata-only catalog observation refresh", async () => {
    configure();
    const t = createTest();
    await seedCanonicalCatalog(t);
    const plan = await buildPlan();
    await publish(t, plan);
    const before = await t.run(async (ctx) => ({
      catalog: (await loadActiveCatalogManifestState(ctx)).state,
      heatState: await ctx.db.query("repackHeatState").unique(),
      frameIds: (await ctx.db.query("repackHeatSnapshots").collect()).map(
        ({ _id }) => _id,
      ),
      signalSetIds: (await ctx.db.query("repackHeatSignalSets").collect()).map(
        ({ _id }) => _id,
      ),
      signalIds: (await ctx.db.query("repackHeatSignals").collect()).map(
        ({ _id }) => _id,
      ),
    }));

    await refreshCatalogObservation(t);

    const after = await t.run(async (ctx) => ({
      catalog: (await loadActiveCatalogManifestState(ctx)).state,
      heatState: await ctx.db.query("repackHeatState").unique(),
      frameIds: (await ctx.db.query("repackHeatSnapshots").collect()).map(
        ({ _id }) => _id,
      ),
      signalSetIds: (await ctx.db.query("repackHeatSignalSets").collect()).map(
        ({ _id }) => _id,
      ),
      signalIds: (await ctx.db.query("repackHeatSignals").collect()).map(
        ({ _id }) => _id,
      ),
    }));
    expect(after.catalog.generation).toBe(before.catalog.generation + 1);
    expect(after.catalog.activeManifest).toEqual(before.catalog.activeManifest);
    expect(after.catalog.observation?.observationSequence).toBe(
      before.catalog.observation!.observationSequence + 1,
    );
    expect(after.heatState).toEqual(before.heatState);
    expect(after.frameIds).toEqual(before.frameIds);
    expect(after.signalSetIds).toEqual(before.signalSetIds);
    expect(after.signalIds).toEqual(before.signalIds);
    const publicResult = await t.query(api.publicRepacks.listPublicRepacks, {});
    if (!publicResult.ok) throw new Error(JSON.stringify(publicResult));
    expect(publicResult.data.details.every(({ heat }) =>
      heat.status === "current"
    )).toBe(true);
  });

  test("refreshes seventeen quiet minutes without rewriting signals and rejects watermark regression", async () => {
    configure();
    const t = createTest();
    await seedCanonicalCatalog(t);
    const plan = await buildPlan();
    await publish(t, plan);
    const before = await t.run(async (ctx) => ({
      signals: await ctx.db.query("repackHeatSignals").collect(),
      sets: await ctx.db.query("repackHeatSignalSets").collect(),
    }));

    let expectedActive = FIRST_FRAME_ID;
    let latest = plan.frame;
    for (let minute = 1; minute <= 17; minute += 1) {
      vi.setSystemTime(
        new Date(Date.parse(START_AT) + minute * 60_000).toISOString(),
      );
      const publicHeatFrameId =
        `91000000-0000-4000-8000-${String(minute + 1).padStart(12, "0")}`;
      const candidate = await refreshedFrame(
        plan.frame,
        publicHeatFrameId,
        minute,
      );
      const quietCandidate = {
        ...candidate,
        sourceWatermark: plan.frame.sourceWatermark,
        frameHash: "0".repeat(64),
      };
      latest = {
        ...quietCandidate,
        frameHash: await recomputeProductionHeatFrameHash(quietCandidate),
      };
      const request = refreshRequest(latest, expectedActive);
      const receipt = await invoke<Record<string, unknown>>(
        t,
        internal.productionHeatLifecycle.refreshFrame,
        request,
      );
      if (minute === 1) {
        expect(await invoke(
          t,
          internal.productionHeatLifecycle.refreshFrame,
          request,
        )).toEqual(receipt);
      }
      expectedActive = publicHeatFrameId;
    }
    const after = await t.run(async (ctx) => ({
      state: await ctx.db.query("repackHeatState").unique(),
      frames: await ctx.db.query("repackHeatSnapshots").collect(),
      signals: await ctx.db.query("repackHeatSignals").collect(),
      sets: await ctx.db.query("repackHeatSignalSets").collect(),
    }));
    expect(after.frames).toHaveLength(18);
    expect(after.signals.map(({ _id }) => _id)).toEqual(
      before.signals.map(({ _id }) => _id),
    );
    expect(after.sets.map(({ _id }) => _id)).toEqual(before.sets.map(({ _id }) => _id));
    expect(after.state?.activeHeatSnapshotId).toBe(
      after.frames.find(({ publicHeatSnapshotId }) =>
        publicHeatSnapshotId === latest.publicHeatFrameId
      )?._id,
    );

    vi.setSystemTime("2026-08-15T12:18:00.000Z");
    const regressionFrameId = "91000000-0000-4000-8000-000000000099";
    const nextMinute = await refreshedFrame(
      plan.frame,
      regressionFrameId,
      18,
    );
    const regressedCandidate = {
      ...nextMinute,
      frameHash: "0".repeat(64),
      sourceWatermark: "99",
    };
    const regressed = {
      ...regressedCandidate,
      frameHash: await recomputeProductionHeatFrameHash(regressedCandidate),
    };
    await expect(
      invoke(
        t,
        internal.productionHeatLifecycle.refreshFrame,
        refreshRequest(regressed, latest.publicHeatFrameId),
      ),
    ).rejects.toThrow("PUBLICATION_SEQUENCE_REGRESSED");
    expect((await t.run((ctx) => ctx.db.query("repackHeatSnapshots").collect())))
      .toHaveLength(18);
    await expect(t.mutation(internal.productionHeatLifecycle.expireActiveFrame, {
      publicHeatFrameId: FIRST_FRAME_ID,
      expectedExpiresAt: plan.frame.expiresAt,
    })).resolves.toBe("unchanged");
    expect((await t.run((ctx) => ctx.db.query("repackHeatState").unique()))?.freshness)
      .toBe("current");
  });

  test("reactivates A after A to B to A without duplicating immutable sets or signals", async () => {
    configure();
    const t = createTest();
    await seedCanonicalCatalog(t);
    const first = await buildPlan();
    await publish(t, first);

    vi.setSystemTime("2026-08-15T12:01:00.000Z");
    const second = await buildPlan(
      SECOND_FRAME_ID,
      1,
      1,
      FIRST_FRAME_ID,
      activeManifestAlignment,
      "partial",
    );
    await publish(t, second);
    expect(second.frame.signalSetHash).not.toBe(first.frame.signalSetHash);
    const beforeReuse = await t.run(async (ctx) => ({
      sets: await ctx.db.query("repackHeatSignalSets").collect(),
      signals: await ctx.db.query("repackHeatSignals").collect(),
    }));
    expect(beforeReuse.sets).toHaveLength(2);
    expect(beforeReuse.signals).toHaveLength(first.records.length * 2);

    vi.setSystemTime("2026-08-15T12:02:00.000Z");
    const third = await refreshedFrame(first.frame, THIRD_FRAME_ID, 2);
    await invoke(
      t,
      internal.productionHeatLifecycle.refreshFrame,
      refreshRequest(third, SECOND_FRAME_ID),
    );
    const afterReuse = await t.run(async (ctx) => ({
      state: await ctx.db.query("repackHeatState").unique(),
      frames: await ctx.db.query("repackHeatSnapshots").collect(),
      sets: await ctx.db.query("repackHeatSignalSets").collect(),
      signals: await ctx.db.query("repackHeatSignals").collect(),
    }));
    const active = afterReuse.frames.find(({ _id }) =>
      _id === afterReuse.state?.activeHeatSnapshotId
    );
    const firstSet = afterReuse.sets.find(({ signalSetHash }) =>
      signalSetHash === first.frame.signalSetHash
    );
    expect(active?.signalSetId).toBe(firstSet?._id);
    expect(afterReuse.sets.map(({ _id }) => _id)).toEqual(
      beforeReuse.sets.map(({ _id }) => _id),
    );
    expect(afterReuse.signals.map(({ _id }) => _id)).toEqual(
      beforeReuse.signals.map(({ _id }) => _id),
    );
  });

  test("publishes the same core set for a newly active catalog release without hash poisoning", async () => {
    configure();
    const t = createTest();
    await seedCanonicalCatalog(t);
    const first = await buildPlan();
    await publish(t, first);
    const nextAlignment = await activateEquivalentCatalog(t);
    const misalignedPublic = await t.query(
      api.publicRepacks.listPublicRepacks,
      {},
    );
    expect(misalignedPublic.ok).toBe(true);
    if (!misalignedPublic.ok) throw new Error("Expected readable catalog data.");
    expect(misalignedPublic.data.details.every(({ heat }) =>
      heat.status === "unavailable" && heat.reason === "RELEASE_MISMATCH"
    )).toBe(true);
    const misalignedState = await signedFetch(
      t,
      "/internal/repack-heat/v1/active-state",
      {
        schemaVersion: "repack_heat_publication_v1",
        operationId: "heat-active-state-misaligned",
      },
    );
    expect(misalignedState.status).toBe(200);
    await expect(misalignedState.json()).resolves.toMatchObject({
      ok: true,
      receipt: {
        details: { manifestAlignment: first.frame.manifestAlignment },
      },
    });

    vi.setSystemTime("2026-08-15T12:01:00.000Z");
    const next = await buildPlan(
      SECOND_FRAME_ID,
      1,
      1,
      FIRST_FRAME_ID,
      nextAlignment,
    );
    expect(next.frame.signalSetHash).toBe(first.frame.signalSetHash);
    await publish(t, next);
    const stored = await t.run(async (ctx) => ({
      state: await ctx.db.query("repackHeatState").unique(),
      frames: await ctx.db.query("repackHeatSnapshots").collect(),
      sets: await ctx.db.query("repackHeatSignalSets").collect(),
      signals: await ctx.db.query("repackHeatSignals").collect(),
    }));
    expect(stored.sets).toHaveLength(2);
    expect(new Set(stored.sets.map(({ signalSetHash }) => signalSetHash)))
      .toEqual(new Set([first.frame.signalSetHash]));
    expect(new Set(stored.sets.map(({ manifestId }) => manifestId)).size).toBe(2);
    expect(stored.signals).toHaveLength(first.records.length * 2);
    const active = stored.frames.find(({ _id }) =>
      _id === stored.state?.activeHeatSnapshotId
    );
    expect(active?.publicHeatSnapshotId).toBe(SECOND_FRAME_ID);
  });

  test("reactivates a retained Heat set after the catalog rolls back M1 to M2 to M1", async () => {
    configure();
    const t = createTest();
    const firstCatalog = await seedCanonicalCatalog(t);
    const firstCatalogState = await t.run(async (ctx) =>
      (await loadActiveCatalogManifestState(ctx)).state
    );
    const first = await buildPlan();
    await publish(t, first);

    vi.setSystemTime("2026-08-15T12:01:00.000Z");
    const secondAlignment = await activateEquivalentCatalog(t);
    const second = await buildPlan(
      SECOND_FRAME_ID,
      1,
      1,
      FIRST_FRAME_ID,
      secondAlignment,
    );
    await publish(t, second);
    const beforeRollback = await t.run(async (ctx) => ({
      catalog: (await loadActiveCatalogManifestState(ctx)).state,
      sets: await ctx.db.query("repackHeatSignalSets").collect(),
      signals: await ctx.db.query("repackHeatSignals").collect(),
    }));
    expect(beforeRollback.sets).toHaveLength(2);
    expect(beforeRollback.signals).toHaveLength(first.records.length * 2);

    const latestByPlatform = new Map(
      beforeRollback.catalog.observation?.providerSelections.map((selection) =>
        [selection.platformKey, selection] as const
      ) ?? [],
    );
    const rollbackSelections = firstCatalogState.observation?.providerSelections
      .map((selection) => {
        const latest = latestByPlatform.get(selection.platformKey);
        if (latest === undefined) {
          throw new Error("Expected latest provider selection for rollback.");
        }
        return {
          ...selection,
          latestAffectedSettledSequence:
            latest.latestAffectedSettledSequence,
          latestAffectedSourceHeadSequence:
            latest.latestAffectedSourceHeadSequence,
          settledSourceFreshness: latest.settledSourceFreshness,
          lastSuccessfulObservationAt: latest.lastSuccessfulObservationAt,
          staleAt: latest.staleAt,
        };
      });
    if (
      beforeRollback.catalog.observation === null ||
      rollbackSelections === undefined
    ) {
      throw new Error("Expected active catalog observations for rollback.");
    }
    const rollbackObservation = buildGlobalCatalogAggregateObservationV1({
      observationSequence:
        beforeRollback.catalog.observation.observationSequence + 1,
      publicReleaseId: firstCatalog.manifest.publicReleaseId,
      providerReferenceSetHash:
        firstCatalog.manifest.providerReferenceSetHash,
      providerSelections: rollbackSelections,
    });
    const rollback = catalogManifestRollbackRequestSchema.parse({
      schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
      operationId: "catalog:rollback:heat:m1",
      idempotencyKey: "catalog:rollback:heat:m1",
      rollbackKind: "manifest",
      targetManifest: {
        publicReleaseId: firstCatalog.manifest.publicReleaseId,
        manifestFingerprint: firstCatalog.manifest.manifestFingerprint,
        sharedConfigurationEpoch:
          firstCatalog.manifest.sharedConfigurationEpoch,
        providerReferenceSetHash:
          firstCatalog.manifest.providerReferenceSetHash,
      },
      observation: rollbackObservation,
      expectedActiveState: beforeRollback.catalog,
    });
    await t.run(async (ctx) =>
      rollbackCatalogManifestRequest(
        ctx,
        rollback,
        await catalogManifestPublicationRequestDigest(rollback),
      )
    );
    activeManifestAlignment = first.frame.manifestAlignment;

    const mismatched = await t.query(api.publicRepacks.listPublicRepacks, {});
    expect(mismatched.ok).toBe(true);
    if (!mismatched.ok) throw new Error("Expected readable catalog data.");
    expect(mismatched.data.details.every(({ heat }) =>
      heat.status === "unavailable" && heat.reason === "RELEASE_MISMATCH"
    )).toBe(true);

    vi.setSystemTime("2026-08-15T12:02:00.000Z");
    const third = await refreshedFrame(first.frame, THIRD_FRAME_ID, 2);
    await invoke(
      t,
      internal.productionHeatLifecycle.refreshFrame,
      refreshRequest(third, SECOND_FRAME_ID),
    );
    const afterRollbackReuse = await t.run(async (ctx) => ({
      state: await ctx.db.query("repackHeatState").unique(),
      frames: await ctx.db.query("repackHeatSnapshots").collect(),
      sets: await ctx.db.query("repackHeatSignalSets").collect(),
      signals: await ctx.db.query("repackHeatSignals").collect(),
    }));
    const active = afterRollbackReuse.frames.find(({ _id }) =>
      _id === afterRollbackReuse.state?.activeHeatSnapshotId
    );
    const retainedM1Set = afterRollbackReuse.sets.find((set) =>
      set.manifestAlignment.publicReleaseId ===
        first.frame.manifestAlignment.publicReleaseId &&
      set.signalSetHash === first.frame.signalSetHash
    );
    expect(active?.publicHeatSnapshotId).toBe(THIRD_FRAME_ID);
    expect(active?.signalSetId).toBe(retainedM1Set?._id);
    expect(afterRollbackReuse.sets.map(({ _id }) => _id)).toEqual(
      beforeRollback.sets.map(({ _id }) => _id),
    );
    expect(afterRollbackReuse.signals.map(({ _id }) => _id)).toEqual(
      beforeRollback.signals.map(({ _id }) => _id),
    );
    const readable = await t.query(api.publicRepacks.listPublicRepacks, {});
    expect(readable.ok).toBe(true);
    if (!readable.ok) throw new Error("Expected readable catalog data.");
    expect(readable.data.details.every(({ heat }) =>
      heat.status === "current"
    )).toBe(true);
  });

  test("refuses finalize when the catalog pointer moves after staging", async () => {
    configure();
    const t = createTest();
    await seedCanonicalCatalog(t);
    const staged = await buildPlan();
    await invoke(t, internal.productionHeatLifecycle.start, staged.start);
    await invoke(t, internal.productionHeatBatch.applyBatch, staged.batch);
    await activateEquivalentCatalog(t);

    await expect(
      invoke(t, internal.productionHeatLifecycle.finalize, staged.finalize),
    ).rejects.toThrow("PUBLICATION_PREDECESSOR_CONFLICT");
    await expect(t.run(async (ctx) => ({
      state: await ctx.db.query("repackHeatState").unique(),
      frames: (await ctx.db.query("repackHeatSnapshots").collect()).length,
      publication: await ctx.db.query("repackHeatPublications").unique(),
    }))).resolves.toMatchObject({
      state: null,
      frames: 0,
      publication: { state: "staging", acceptedBatchCount: 1 },
    });
  });

  test("refuses a stale changed-content finalize without altering the active pointer", async () => {
    configure();
    const t = createTest();
    await seedCanonicalCatalog(t);
    const first = await buildPlan();
    await publish(t, first);
    const before = await t.run((ctx) => ctx.db.query("repackHeatState").unique());

    vi.setSystemTime("2026-08-15T12:01:00.000Z");
    const second = await buildPlan(
      SECOND_FRAME_ID,
      1,
      1,
      "91000000-0000-4000-8000-000000000098",
      activeManifestAlignment,
      "partial",
    );
    await invoke(t, internal.productionHeatLifecycle.start, second.start);
    await invoke(t, internal.productionHeatBatch.applyBatch, second.batch);
    await expect(
      invoke(t, internal.productionHeatLifecycle.finalize, second.finalize),
    ).rejects.toThrow("PUBLICATION_PREDECESSOR_CONFLICT");
    const after = await t.run(async (ctx) => ({
      state: await ctx.db.query("repackHeatState").unique(),
      active: await ctx.db.get("repackHeatSnapshots", before!.activeHeatSnapshotId!),
      frames: await ctx.db.query("repackHeatSnapshots").collect(),
    }));
    expect(after.state).toEqual(before);
    expect(after.active?.lifecycle).toBe("complete");
    expect(after.frames).toHaveLength(1);
  });

  test("scheduled expiry ignores a stale callback and expires the exact active frame at the boundary", async () => {
    configure();
    const t = createTest();
    await seedCanonicalCatalog(t);
    const first = await buildPlan();
    await publish(t, first);

    await vi.advanceTimersByTimeAsync(60_000);
    const secondFrame = await refreshedFrame(first.frame, SECOND_FRAME_ID, 1);
    await invoke(
      t,
      internal.productionHeatLifecycle.refreshFrame,
      refreshRequest(secondFrame, FIRST_FRAME_ID),
    );

    await vi.advanceTimersByTimeAsync(14 * 60_000 - 1);
    await t.finishInProgressScheduledFunctions();
    expect((await t.run((ctx) => ctx.db.query("repackHeatState").unique()))?.freshness)
      .toBe("current");

    await vi.advanceTimersByTimeAsync(1);
    await t.finishInProgressScheduledFunctions();
    const afterStaleCallback = await t.run((ctx) =>
      ctx.db.query("repackHeatState").unique()
    );
    expect(afterStaleCallback?.freshness).toBe("current");
    expect(afterStaleCallback?.expiresAt).toBe(secondFrame.expiresAt);

    await vi.advanceTimersByTimeAsync(60_000 - 1);
    await t.finishInProgressScheduledFunctions();
    expect((await t.run((ctx) => ctx.db.query("repackHeatState").unique()))?.freshness)
      .toBe("current");

    await vi.advanceTimersByTimeAsync(1);
    await t.finishInProgressScheduledFunctions();
    expect((await t.run((ctx) => ctx.db.query("repackHeatState").unique()))?.freshness)
      .toBe("expired");
    const expired = await t.query(api.publicRepacks.listPublicRepacks, {});
    if (!expired.ok) throw new Error(JSON.stringify(expired));
    expect(expired.data.details.every(({ heat }) =>
      heat.status === "expired"
    )).toBe(true);
  });

  test("cleans an expired abandoned staging publication within bounded retention", async () => {
    configure();
    const t = createTest();
    await seedCanonicalCatalog(t);
    const plan = await buildPlan();
    await invoke(t, internal.productionHeatLifecycle.start, plan.start);
    await invoke(t, internal.productionHeatBatch.applyBatch, plan.batch);
    vi.setSystemTime(plan.frame.expiresAt);
    await t.mutation(internal.productionHeatRetention.scheduledRetention, {});
    await expect(t.run(async (ctx) => ({
      publications: (await ctx.db.query("repackHeatPublications").collect()).length,
      batches: (await ctx.db.query("repackHeatBatches").collect()).length,
      sets: (await ctx.db.query("repackHeatSignalSets").collect()).length,
      signals: (await ctx.db.query("repackHeatSignals").collect()).length,
      operations: (await ctx.db.query("repackHeatOperations").collect()).length,
      frames: (await ctx.db.query("repackHeatSnapshots").collect()).length,
    }))).resolves.toEqual({
      publications: 0,
      batches: 0,
      sets: 0,
      signals: 0,
      operations: 0,
      frames: 0,
    });
  });

  test("materializes expiry after fifteen minutes and retains only unprotected old data", async () => {
    configure();
    const t = createTest();
    await seedCanonicalCatalog(t);
    const plan = await buildPlan();
    await publish(t, plan);
    const before = await t.query(api.publicRepacks.listPublicRepacks, {});
    if (!before.ok) throw new Error(JSON.stringify(before));
    expect(before.data.details.every(({ heat }) =>
      heat.status === "current"
    )).toBe(true);

    vi.setSystemTime("2026-08-15T12:15:00.000Z");
    await expect(t.mutation(internal.productionHeatLifecycle.expireActiveFrame, {
      publicHeatFrameId: FIRST_FRAME_ID,
      expectedExpiresAt: plan.frame.expiresAt,
    })).resolves.toBe("expired");
    const expired = await t.query(api.publicRepacks.listPublicRepacks, {});
    expect(expired.ok).toBe(true);
    if (!expired.ok) throw new Error("Expected readable catalog data.");
    expect(expired.data.details.every(({ heat }) =>
      heat.status === "expired"
    )).toBe(true);
    await t.run(async (ctx) => {
      const catalogState = await ctx.db
        .query("activeCatalogManifestState")
        .unique();
      const manifest = catalogState?.activeManifestId === null ||
          catalogState === null
        ? null
        : await ctx.db.get(
          "globalCatalogManifests",
          catalogState.activeManifestId,
        );
      const repack = await ctx.db.query("providerCatalogRepacks").first();
      if (manifest === null || repack === null) {
        throw new Error("Expected catalog rows.");
      }
      const orphanSetId = await ctx.db.insert("repackHeatSignalSets", {
        manifestId: manifest._id,
        manifestAlignment: productionHeatManifestAlignmentSchema.parse({
          publicReleaseId: manifest.publicReleaseId,
          manifestFingerprint: manifest.manifestFingerprint,
          sharedConfigurationEpoch: manifest.manifest.sharedConfigurationEpoch,
          providerReferenceSetHash: manifest.providerReferenceSetHash,
        }),
        signalSetHash: "f".repeat(64),
        lifecycle: "retired",
        sourceKind: "observed",
        scenarioVersion: null,
        aggregationVersion: REPACK_HEAT_AGGREGATION_VERSION,
        heatPolicyVersion: REPACK_HEAT_POLICY_VERSION,
        signalCount: 1,
        originatingPublicationId: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        completedAt: "2026-08-01T00:00:00.000Z",
        retentionEligibleAt: "2026-08-08T00:00:00.000Z",
      });
      await ctx.db.insert("repackHeatSignals", {
        signalSetId: orphanSetId,
        providerReleaseId: repack.releaseId,
        repackId: repack._id,
        publicRepackId: repack.publicRepackId,
        detail: (await ctx.db.query("repackHeatSignals").first())!.detail,
      });
    });
    vi.setSystemTime("2026-08-22T12:16:00.000Z");
    await t.mutation(internal.productionHeatRetention.scheduledRetention, {});
    const retained = await t.run(async (ctx) => ({
      state: await ctx.db.query("repackHeatState").unique(),
      frames: await ctx.db.query("repackHeatSnapshots").collect(),
      sets: await ctx.db.query("repackHeatSignalSets").collect(),
      signals: await ctx.db.query("repackHeatSignals").collect(),
      operations: await ctx.db.query("repackHeatOperations").collect(),
    }));
    expect(retained.state?.activeHeatSnapshotId).not.toBeNull();
    expect(retained.frames).toHaveLength(1);
    expect(retained.sets).toHaveLength(1);
    expect(retained.signals).toHaveLength(plan.records.length);
    expect(retained.operations).toHaveLength(1);
    expect(retained.operations[0]?.kind).toBe("finalize");
    const stillProvable = await signedFetch(
      t,
      "/internal/repack-heat/v1/active-state",
      {
        schemaVersion: "repack_heat_publication_v1",
        operationId: "heat-active-state-retained",
      },
    );
    expect(stillProvable.status).toBe(200);
    await expect(stillProvable.json()).resolves.toMatchObject({
      receipt: {
        publicationId: FIRST_FRAME_ID,
        details: { activePublicHeatFrameId: FIRST_FRAME_ID },
      },
    });
  });
});
