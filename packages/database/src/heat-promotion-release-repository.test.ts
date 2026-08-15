import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  DATA_RELEASE_SCHEMA_VERSION,
  EMPTY_PRODUCTION_HEAT_SIGNAL_SET_HASH,
  PRODUCTION_HEAT_RETENTION_MILLISECONDS,
  REPACK_HEAT_AGGREGATION_VERSION,
  REPACK_HEAT_LARGE_HIT_MULTIPLE_BASIS_POINTS,
  REPACK_HEAT_MINIMUM_BASELINE_PULLS,
  REPACK_HEAT_MINIMUM_CURRENT_PULLS,
  REPACK_HEAT_POLICY_VERSION,
  REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
  canonicalJson,
  extendProductionBatchChain,
  extendProductionHeatSignalSetHash,
  productionApplyBatchRequestSchema,
  productionBatchByteCount,
  productionFinalizeRequestSchema,
  productionHeatApplyBatchRequestSchema,
  productionHeatCoreByteCount,
  productionHeatFinalizeRequestSchema,
  productionHeatFrameEnvelopeSchema,
  productionHeatReceiptHash,
  productionHeatReceiptSchema,
  productionHeatStartRequestSchema,
  productionReceiptHash,
  productionReceiptSchema,
  productionRefreshRequestSchema,
  productionStartRequestSchema,
  recomputeProductionBatchHash,
  recomputeProductionHeatBatchHash,
  recomputeProductionHeatFrameHash,
  recomputeProductionManifestFingerprint,
  type ProductionHeatFrameEnvelope,
  type PublicRepackHeatSignal,
} from "@packscout/contracts";
import type { PackscoutPrismaClient } from "./database.ts";
import {
  PrismaHeatPromotionReleaseRepository,
} from "./heat-promotion-release-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const organizationId = "94000000-0000-4000-8000-000000000001";
const otherOrganizationId = "94000000-0000-4000-8000-000000000002";
const deploymentKey = "convex-production-us";
const catalogReleaseId = "82000000-0000-4000-8000-000000000001";
const publicVendorId = "81000000-0000-5000-8000-000000000001";
const publicRepackIds = [
  "83000000-0000-5000-8000-000000000001",
  "83000000-0000-5000-8000-000000000002",
] as const;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function repack(publicRepackId: string, name: string) {
  return {
    publicRepackId,
    publicVendorId,
    vendorKey: "vendor",
    vendorDisplayName: "Vendor",
    vendorLogoUrl: null,
    name,
    format: "repack" as const,
    contentMode: "unknown" as const,
    categories: [],
    collectibleTypes: [],
    availability: "active" as const,
    price: {
      displayMoney: null,
      usdComparison: {
        status: "unavailable" as const,
        value: null,
        reason: "PRICE_UNAVAILABLE" as const,
      },
    },
    buyback: {
      status: "unavailable" as const,
      value: null,
      reason: "BUYBACK_UNAVAILABLE" as const,
    },
    primaryImage: null,
    evEstimates: {
      vendorReported: {
        status: "unavailable" as const,
        displayMoney: null,
        metrics: null,
        observedAt: null,
        reason: "NOT_REPORTED" as const,
      },
      packScout: {
        status: "unavailable" as const,
        metrics: null,
        confidence: null,
        modelVersion: "packscout-ev-v2",
        confidencePolicyVersion: "confidence-v1",
        dataAsOf: null,
        calculatedAt: null,
        reason: "ESTIMATE_INPUT_INCOMPLETE" as const,
      },
    },
    topChase: null,
    contentSummary: {
      knownCollectibleCount: 0,
      chaseCount: 0,
      categoryCount: 0,
      collectibleTypeCount: 0,
      evidenceCompleteness: "unknown" as const,
      probabilityCoverageBasisPoints: null,
    },
    actionAvailability: { promo: false, repackLink: false },
    sourceUpdatedAt: "2026-08-15T12:00:00.000Z",
    description: null,
    actions: {},
  };
}

interface ProvenOperationSeed {
  operationKind: string;
  requestPath: string;
  canonicalRequestBody: string;
  receiptBody: string;
}

interface ProvenAttemptSeed {
  id: string;
  targetWatermark: bigint;
  contentIdentity: string;
  publicationIdentity: string;
  terminalReceiptBody: string;
  terminalAt: Date;
  state?: "published" | "unchanged";
  operations: readonly ProvenOperationSeed[];
}

async function catalogAttempt(): Promise<ProvenAttemptSeed> {
  const records = [
    repack(publicRepackIds[0], "Pack A"),
    repack(publicRepackIds[1], "Pack B"),
  ];
  const batchHash = await recomputeProductionBatchHash({
    kind: "repacks",
    records,
  });
  const batchChainHash = await extendProductionBatchChain({
    previousHash: "0".repeat(64),
    batchIndex: 0,
    kind: "repacks",
    batchHash,
    recordCount: records.length,
    byteCount: productionBatchByteCount(records),
  });
  const counts = {
    vendors: 0,
    categories: 0,
    collectibles: 0,
    repacks: records.length,
    repackChases: 0,
    searchShards: 0,
  };
  const manifestWithoutFingerprint = {
    publicReleaseId: catalogReleaseId,
    sourceWatermark: "public-change:42",
    observationSequence: 42,
    manifestFingerprint: "0".repeat(64),
    contentHash: "2".repeat(64),
    publicConfigRevision: 1,
    publicConfigHash: "3".repeat(64),
    originSetHash: "4".repeat(64),
    searchAlgorithmVersion: "repack_search_v2" as const,
    repackSearchIndexHash: "5".repeat(64),
    confidencePolicyVersion: "confidence-v1",
    createdAt: "2026-08-15T11:59:00.000Z",
    dataAsOf: "2026-08-15T11:59:00.000Z",
    lastSuccessfulObservationAt: "2026-08-15T11:59:00.000Z",
    staleAt: "2026-08-15T12:14:00.000Z",
    freshness: "fresh" as const,
    delayedVendorCount: 0,
    counts,
    batchCount: 1,
    batchChainHash,
    publicAssetOrigins: [],
  };
  const start = productionStartRequestSchema.parse({
    schemaVersion: DATA_RELEASE_SCHEMA_VERSION,
    operationId: "catalog:start:42",
    idempotencyKey: "catalog:start:42",
    publicationId: catalogReleaseId,
    expectedPredecessorPublicReleaseId: null,
    manifest: {
      ...manifestWithoutFingerprint,
      manifestFingerprint: await recomputeProductionManifestFingerprint(
        manifestWithoutFingerprint,
      ),
    },
  });
  const batch = productionApplyBatchRequestSchema.parse({
    schemaVersion: DATA_RELEASE_SCHEMA_VERSION,
    operationId: "catalog:batch:42:0",
    idempotencyKey: "catalog:batch:42:0",
    publicationId: catalogReleaseId,
    batchIndex: 0,
    kind: "repacks",
    batchHash,
    records,
  });
  const finalize = productionFinalizeRequestSchema.parse({
    schemaVersion: DATA_RELEASE_SCHEMA_VERSION,
    operationId: "catalog:finalize:42",
    idempotencyKey: "catalog:finalize:42",
    publicationId: catalogReleaseId,
    expectedPredecessorPublicReleaseId: null,
    expectedCounts: counts,
    expectedBatchCount: 1,
    expectedBatchChainHash: batchChainHash,
  });
  const bodies = [start, batch, finalize].map(canonicalJson);
  const receiptWithoutDigest = {
    schemaVersion: DATA_RELEASE_SCHEMA_VERSION,
    operationId: finalize.operationId,
    operationKind: "finalize" as const,
    publicationId: catalogReleaseId,
    terminalState: "complete" as const,
    result: "activated" as const,
    serverTime: "2026-08-15T12:00:00.000Z",
    requestDigest: digest(bodies[2]!),
    details: {
      manifestFingerprint: start.manifest.manifestFingerprint,
      contentHash: start.manifest.contentHash,
      sourceWatermark: start.manifest.sourceWatermark,
      activePublicReleaseId: catalogReleaseId,
      previousPublicReleaseId: null,
      counts,
      batchCount: 1,
      batchChainHash,
    },
  };
  const terminalReceiptBody = canonicalJson(productionReceiptSchema.parse({
    ...receiptWithoutDigest,
    receiptDigest: await productionReceiptHash(receiptWithoutDigest),
  }));
  return {
    id: "94100000-0000-4000-8000-000000000001",
    targetWatermark: 42n,
    contentIdentity: start.manifest.contentHash,
    publicationIdentity: catalogReleaseId,
    terminalReceiptBody,
    terminalAt: new Date("2026-08-15T12:00:00.000Z"),
    operations: bodies.map((canonicalRequestBody, index) => ({
      operationKind: ["start", "applyBatch", "finalize"][index]!,
      requestPath: [
        "/internal/data-release/v2/start",
        "/internal/data-release/v2/apply-batch",
        "/internal/data-release/v2/finalize",
      ][index]!,
      canonicalRequestBody,
      receiptBody: index === 2 ? terminalReceiptBody : "{}",
    })),
  };
}

async function catalogRefreshAttempt(
  published: ProvenAttemptSeed,
): Promise<ProvenAttemptSeed> {
  const start = productionStartRequestSchema.parse(
    JSON.parse(published.operations[0]!.canonicalRequestBody) as unknown,
  );
  const refresh = productionRefreshRequestSchema.parse({
    schemaVersion: DATA_RELEASE_SCHEMA_VERSION,
    operationId: "catalog:refresh:43",
    idempotencyKey: "catalog:refresh:43",
    publicReleaseId: catalogReleaseId,
    contentHash: start.manifest.contentHash,
    observationSequence: 43,
    dataAsOf: "2026-08-15T12:00:30.000Z",
    lastSuccessfulObservationAt: "2026-08-15T12:00:30.000Z",
    staleAt: "2026-08-15T12:15:30.000Z",
    freshness: "fresh",
    delayedVendorCount: 0,
  });
  const canonicalRequestBody = canonicalJson(refresh);
  const receiptWithoutDigest = {
    schemaVersion: DATA_RELEASE_SCHEMA_VERSION,
    operationId: refresh.operationId,
    operationKind: "refreshObservation" as const,
    publicationId: catalogReleaseId,
    terminalState: "complete" as const,
    result: "refreshed" as const,
    serverTime: "2026-08-15T12:00:31.000Z",
    requestDigest: digest(canonicalRequestBody),
    details: {
      contentHash: refresh.contentHash,
      observationSequence: refresh.observationSequence,
      dataAsOf: refresh.dataAsOf,
      lastSuccessfulObservationAt: refresh.lastSuccessfulObservationAt,
      staleAt: refresh.staleAt,
      freshness: refresh.freshness,
      delayedVendorCount: refresh.delayedVendorCount,
    },
  };
  const terminalReceiptBody = canonicalJson(productionReceiptSchema.parse({
    ...receiptWithoutDigest,
    receiptDigest: await productionReceiptHash(receiptWithoutDigest),
  }));
  return {
    id: "94100000-0000-4000-8000-000000000002",
    targetWatermark: 43n,
    contentIdentity: start.manifest.contentHash,
    publicationIdentity: catalogReleaseId,
    terminalReceiptBody,
    terminalAt: new Date("2026-08-15T12:00:31.000Z"),
    state: "unchanged",
    operations: [{
      operationKind: "refreshObservation",
      requestPath: "/internal/data-release/v2/refresh-observation",
      canonicalRequestBody,
      receiptBody: terminalReceiptBody,
    }],
  };
}

function heatSignal(input: Readonly<{
  publicRepackId: string;
  frameEndedAt: Date;
  partial: boolean;
}>): PublicRepackHeatSignal {
  const currentEndedAt = input.frameEndedAt.getTime();
  const currentStartedAt = currentEndedAt - 15 * 60_000;
  const baselineStartedAt = currentStartedAt - 24 * 60 * 60_000;
  const calculatedAt = new Date(currentEndedAt + 1_000).toISOString();
  return {
    publicRepackId: input.publicRepackId,
    state: "hot",
    scoreBasisPoints: 8_505,
    provenance: {
      kind: "observed",
      aggregationVersion: REPACK_HEAT_AGGREGATION_VERSION,
    },
    sourceCoverage: input.partial ? "partial" : "complete",
    currentWindow: {
      startedAt: new Date(currentStartedAt).toISOString(),
      endedAt: input.frameEndedAt.toISOString(),
      pullCount: 80,
    },
    baselineWindow: {
      startedAt: new Date(baselineStartedAt).toISOString(),
      endedAt: new Date(currentStartedAt).toISOString(),
      pullCount: 2_000,
    },
    sampleRequirements: {
      minimumCurrentPullCount: REPACK_HEAT_MINIMUM_CURRENT_PULLS,
      minimumBaselinePullCount: REPACK_HEAT_MINIMUM_BASELINE_PULLS,
    },
    components: {
      activity: {
        status: "available",
        currentPullCount: 80,
        baselinePullCount: 2_000,
        relativeRateDeltaBasisPoints: 28_400,
      },
      observedReturn: {
        status: "available",
        currentReturnBasisPoints: 9_000,
        baselineReturnBasisPoints: 8_500,
        rateDeltaBasisPoints: 500,
      },
      largeHitFrequency: {
        status: "available",
        currentHitCount: 2,
        baselineHitCount: 20,
        currentRateBasisPoints: 250,
        baselineRateBasisPoints: 100,
        rateDeltaBasisPoints: 150,
        thresholdMultipleBasisPoints:
          REPACK_HEAT_LARGE_HIT_MULTIPLE_BASIS_POINTS,
      },
      chaseAvailability: {
        status: "available",
        currentAvailableChaseCount: 3,
        baselineAvailableChaseCount: 2,
        change: "restocked",
      },
      poolComposition: {
        status: "available",
        addedOutcomeCount: 1,
        removedOutcomeCount: 0,
        changeMagnitudeBasisPoints: 500,
        changed: true,
      },
    },
    drivers: [
      { code: "activity", contributionBasisPoints: 2_800 },
      { code: "chase_availability", contributionBasisPoints: 500 },
      { code: "large_hit_frequency", contributionBasisPoints: 105 },
      { code: "observed_return", contributionBasisPoints: 90 },
      { code: "pool_composition", contributionBasisPoints: 10 },
    ],
    signalConfidence: input.partial
      ? { scoreBasisPoints: 7_999, band: "medium" }
      : { scoreBasisPoints: 10_000, band: "high" },
    limitationCodes: input.partial ? ["partial_source_coverage"] : [],
    heatPolicyVersion: REPACK_HEAT_POLICY_VERSION,
    calculatedAt,
    expiresAt: new Date(Date.parse(calculatedAt) + 15 * 60_000).toISOString(),
  };
}

async function heatAttempt(input: Readonly<{
  id: string;
  publicHeatFrameId: string;
  frameEndedAt: Date;
  sourceWatermark: bigint;
  previousPublicHeatFrameId: string | null;
  partial: boolean;
}>): Promise<ProvenAttemptSeed & Readonly<{
  frame: ProductionHeatFrameEnvelope;
  signalSetHash: string;
}>> {
  const records = publicRepackIds.map((publicRepackId) => heatSignal({
    publicRepackId,
    frameEndedAt: input.frameEndedAt,
    partial: input.partial,
  }));
  const batchHash = await recomputeProductionHeatBatchHash(records);
  const coreByteCount = productionHeatCoreByteCount(records);
  const signalSetHash = await extendProductionHeatSignalSetHash({
    previousHash: EMPTY_PRODUCTION_HEAT_SIGNAL_SET_HASH,
    batchIndex: 0,
    batchHash,
    recordCount: records.length,
    coreByteCount,
  });
  const calculatedAt = new Date(input.frameEndedAt.getTime() + 1_000);
  const currentStartedAt = input.frameEndedAt.getTime() - 15 * 60_000;
  const frameWithoutHash: ProductionHeatFrameEnvelope = {
    publicHeatFrameId: input.publicHeatFrameId,
    catalogPublicReleaseId: catalogReleaseId,
    frameSequence: input.frameEndedAt.getTime() / 60_000,
    sourceWatermark: input.sourceWatermark.toString(),
    signalSetHash,
    frameHash: "0".repeat(64),
    signalCount: records.length,
    aggregationVersion: REPACK_HEAT_AGGREGATION_VERSION,
    heatPolicyVersion: REPACK_HEAT_POLICY_VERSION,
    baselineWindowStartedAt:
      new Date(currentStartedAt - 24 * 60 * 60_000).toISOString(),
    baselineWindowEndedAt: new Date(currentStartedAt).toISOString(),
    currentWindowStartedAt: new Date(currentStartedAt).toISOString(),
    currentWindowEndedAt: input.frameEndedAt.toISOString(),
    calculatedAt: calculatedAt.toISOString(),
    expiresAt: new Date(calculatedAt.getTime() + 15 * 60_000).toISOString(),
  };
  const frame = productionHeatFrameEnvelopeSchema.parse({
    ...frameWithoutHash,
    frameHash: await recomputeProductionHeatFrameHash(frameWithoutHash),
  });
  const start = productionHeatStartRequestSchema.parse({
    schemaVersion: REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
    operationId: `heat:start:${input.publicHeatFrameId}`,
    idempotencyKey: `heat:start:${input.publicHeatFrameId}`,
    publicationId: input.publicHeatFrameId,
    frame,
    expectedBatchCount: 1,
  });
  const batch = productionHeatApplyBatchRequestSchema.parse({
    schemaVersion: REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
    operationId: `heat:batch:${input.publicHeatFrameId}:0`,
    idempotencyKey: `heat:batch:${input.publicHeatFrameId}:0`,
    publicationId: input.publicHeatFrameId,
    batchIndex: 0,
    batchHash,
    records,
  });
  const finalize = productionHeatFinalizeRequestSchema.parse({
    schemaVersion: REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
    operationId: `heat:finalize:${input.publicHeatFrameId}`,
    idempotencyKey: `heat:finalize:${input.publicHeatFrameId}`,
    publicationId: input.publicHeatFrameId,
    expectedActivePublicHeatFrameId: input.previousPublicHeatFrameId,
    expectedCatalogPublicReleaseId: catalogReleaseId,
    expectedSignalSetHash: signalSetHash,
    expectedFrameHash: frame.frameHash,
    expectedSignalCount: records.length,
    expectedBatchCount: 1,
  });
  const bodies = [start, batch, finalize].map(canonicalJson);
  const terminalWithoutDigest = {
    schemaVersion: REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
    operationId: finalize.operationId,
    operationKind: "finalize" as const,
    publicationId: input.publicHeatFrameId,
    terminalState: "complete" as const,
    result: "activated" as const,
    serverTime: calculatedAt.toISOString(),
    requestDigest: digest(bodies[2]!),
    details: {
      catalogPublicReleaseId: catalogReleaseId,
      activePublicHeatFrameId: input.publicHeatFrameId,
      previousPublicHeatFrameId: input.previousPublicHeatFrameId,
      frameHash: frame.frameHash,
      signalSetHash,
      sourceWatermark: frame.sourceWatermark,
      frameSequence: frame.frameSequence,
      signalCount: frame.signalCount,
      calculatedAt: frame.calculatedAt,
      expiresAt: frame.expiresAt,
    },
  };
  const terminalReceiptBody = canonicalJson(productionHeatReceiptSchema.parse({
    ...terminalWithoutDigest,
    receiptDigest: await productionHeatReceiptHash(terminalWithoutDigest),
  }));
  return {
    id: input.id,
    targetWatermark: BigInt(frame.frameSequence),
    contentIdentity: digest(canonicalJson([
      "packscout.heat-release-signal-set.v1",
      catalogReleaseId,
      signalSetHash,
    ])),
    publicationIdentity: input.publicHeatFrameId,
    terminalReceiptBody,
    terminalAt: calculatedAt,
    operations: bodies.map((canonicalRequestBody, index) => ({
      operationKind: ["start", "applyBatch", "finalize"][index]!,
      requestPath: [
        "/internal/repack-heat/v1/start",
        "/internal/repack-heat/v1/apply-batch",
        "/internal/repack-heat/v1/finalize",
      ][index]!,
      canonicalRequestBody,
      receiptBody: index === 2 ? terminalReceiptBody : "{}",
    })),
    frame,
    signalSetHash,
  };
}

async function seedLane(input: Readonly<{
  client: PackscoutPrismaClient;
  deploymentKey: string;
  laneKey: "catalog" | "heat";
  confirmed: ProvenAttemptSeed;
  attempts: readonly ProvenAttemptSeed[];
}>): Promise<void> {
  await input.client.promotion_lanes.create({
    data: {
      organization_id: organizationId,
      deployment_key: input.deploymentKey,
      lane_key: input.laneKey,
      bootstrap_state: "verified_local",
      bootstrap_verified_at: input.confirmed.terminalAt,
      settled_watermark: input.confirmed.targetWatermark,
      settled_at: input.confirmed.terminalAt,
      requested_watermark: input.confirmed.targetWatermark,
      requested_at: input.confirmed.terminalAt,
      confirmed_watermark: input.confirmed.targetWatermark,
      confirmed_publication_identity: input.confirmed.publicationIdentity,
      confirmed_receipt_sha256: digest(input.confirmed.terminalReceiptBody),
      last_activated_watermark: input.confirmed.targetWatermark,
      last_activated_at: input.confirmed.terminalAt,
    },
  });
  for (const attempt of input.attempts) {
    await input.client.promotion_attempts.create({
      data: {
        id: attempt.id,
        organization_id: organizationId,
        deployment_key: input.deploymentKey,
        lane_key: input.laneKey,
        target_watermark: attempt.targetWatermark,
        state: attempt.state ?? "published",
        content_identity: attempt.contentIdentity,
        publication_identity: attempt.publicationIdentity,
        prepared_classification: attempt.state === "unchanged"
          ? "refresh_unchanged" : "publish",
        prepared_at: attempt.terminalAt,
        terminal_receipt_body: attempt.terminalReceiptBody,
        terminal_receipt_sha256: digest(attempt.terminalReceiptBody),
        terminal_at: attempt.terminalAt,
        created_at: attempt.terminalAt,
        updated_at: attempt.terminalAt,
      },
    });
    await input.client.promotion_operations.createMany({
      data: attempt.operations.map((operation, operationIndex) => ({
        attempt_id: attempt.id,
        organization_id: organizationId,
        deployment_key: input.deploymentKey,
        lane_key: input.laneKey,
        operation_index: operationIndex,
        operation_id: JSON.parse(operation.canonicalRequestBody).operationId,
        operation_kind: operation.operationKind,
        request_path: operation.requestPath,
        canonical_request_body: operation.canonicalRequestBody,
        request_sha256: digest(operation.canonicalRequestBody),
        state: "acknowledged",
        send_count: 1,
        last_sent_at: attempt.terminalAt,
        acknowledged_at: attempt.terminalAt,
        receipt_body: operation.receiptBody,
        receipt_sha256: digest(operation.receiptBody),
        created_at: attempt.terminalAt,
        updated_at: attempt.terminalAt,
      })),
    });
  }
}

test("PostgreSQL proves catalog IDs, Heat baseline, and retained A-B-A reuse", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await harness.client.organizations.create({
      data: { id: organizationId, slug: "heat-proof", name: "Heat proof" },
    });
    await harness.client.organizations.create({
      data: {
        id: otherOrganizationId,
        slug: "other-heat-proof",
        name: "Other Heat proof",
      },
    });
    const catalog = await catalogAttempt();
    const catalogRefresh = await catalogRefreshAttempt(catalog);
    await seedLane({
      client: harness.client,
      deploymentKey,
      laneKey: "catalog",
      confirmed: catalogRefresh,
      attempts: [catalog, catalogRefresh],
    });
    const frameA = await heatAttempt({
      id: "94200000-0000-4000-8000-000000000001",
      publicHeatFrameId: "84000000-0000-4000-8000-000000000001",
      frameEndedAt: new Date("2026-08-15T12:00:00.000Z"),
      sourceWatermark: 50n,
      previousPublicHeatFrameId: null,
      partial: false,
    });
    const frameB = await heatAttempt({
      id: "94200000-0000-4000-8000-000000000002",
      publicHeatFrameId: "84000000-0000-4000-8000-000000000002",
      frameEndedAt: new Date("2026-08-15T12:01:00.000Z"),
      sourceWatermark: 51n,
      previousPublicHeatFrameId: frameA.publicationIdentity,
      partial: true,
    });
    await seedLane({
      client: harness.client,
      deploymentKey,
      laneKey: "heat",
      confirmed: frameB,
      attempts: [frameA, frameB],
    });
    const repository = new PrismaHeatPromotionReleaseRepository(
      harness.client,
      { organizationId, deploymentKey },
    );
    assert.deepEqual(await repository.loadActiveCatalogRelease(), {
      publicReleaseId: catalogReleaseId,
      publicRepackIds: [...publicRepackIds],
      confirmedWatermark: 43n,
      terminalReceiptSha256: digest(catalogRefresh.terminalReceiptBody),
    });
    const active = await repository.loadActiveHeatFrame();
    assert.equal(active?.publicHeatFrameId, frameB.publicationIdentity);
    assert.equal(active?.catalogPublicReleaseId, catalogReleaseId);
    assert.equal(active?.signalSetHash, frameB.signalSetHash);
    const reusableInput = {
      catalogPublicReleaseId: catalogReleaseId,
      signalSetHash: frameA.signalSetHash,
      contentIdentity: frameA.contentIdentity,
      signalCount: frameA.frame.signalCount,
      reusableAt: new Date(
        Date.parse(frameA.frame.expiresAt) +
          PRODUCTION_HEAT_RETENTION_MILLISECONDS - 1,
      ),
    };
    assert.equal(
      await repository.hasReusableHeatSignalSet(reusableInput),
      true,
    );
    assert.equal(await repository.hasReusableHeatSignalSet({
      ...reusableInput,
      reusableAt: new Date(
        Date.parse(frameA.frame.expiresAt) +
          PRODUCTION_HEAT_RETENTION_MILLISECONDS,
      ),
    }), false);
    assert.equal(await new PrismaHeatPromotionReleaseRepository(
      harness.client,
      { organizationId: otherOrganizationId, deploymentKey },
    ).loadActiveCatalogRelease(), null);
    assert.equal(await new PrismaHeatPromotionReleaseRepository(
      harness.client,
      { organizationId, deploymentKey: "other-deployment" },
    ).loadActiveHeatFrame(), null);

    const noncanonicalCatalog = {
      ...catalog,
      id: "94300000-0000-4000-8000-000000000001",
      operations: catalog.operations.map((operation, index) => index === 0
        ? {
            ...operation,
            canonicalRequestBody: JSON.stringify(
              JSON.parse(operation.canonicalRequestBody),
              null,
              2,
            ),
          }
        : operation),
    };
    await seedLane({
      client: harness.client,
      deploymentKey: "tampered-catalog",
      laneKey: "catalog",
      confirmed: noncanonicalCatalog,
      attempts: [noncanonicalCatalog],
    });
    await assert.rejects(
      new PrismaHeatPromotionReleaseRepository(harness.client, {
        organizationId,
        deploymentKey: "tampered-catalog",
      }).loadActiveCatalogRelease(),
      /Promotion release proof is invalid/u,
    );

    const catalogBatch = productionApplyBatchRequestSchema.parse(
      JSON.parse(catalog.operations[1]!.canonicalRequestBody) as unknown,
    );
    const catalogStart = productionStartRequestSchema.parse(
      JSON.parse(catalog.operations[0]!.canonicalRequestBody) as unknown,
    );
    const catalogFinalize = productionFinalizeRequestSchema.parse(
      JSON.parse(catalog.operations[2]!.canonicalRequestBody) as unknown,
    );
    const catalogReceipt = productionReceiptSchema.parse(
      JSON.parse(catalog.terminalReceiptBody) as unknown,
    );
    assert.equal(catalogReceipt.operationKind, "finalize");
    if (catalogReceipt.operationKind !== "finalize") {
      throw new Error("catalog fixture receipt kind is invalid");
    }
    const {
      receiptDigest: _catalogReceiptDigest,
      ...catalogReceiptWithoutDigest
    } = catalogReceipt;
    void _catalogReceiptDigest;
    const changedReceiptWithoutDigest = {
      ...catalogReceiptWithoutDigest,
      details: {
        ...catalogReceipt.details,
        batchChainHash: "6".repeat(64),
      },
    };
    const changedTerminalReceiptBody = canonicalJson(
      productionReceiptSchema.parse({
        ...changedReceiptWithoutDigest,
        receiptDigest: await productionReceiptHash(
          changedReceiptWithoutDigest,
        ),
      }),
    );
    const semanticVariants: Array<Readonly<{
      deploymentKey: string;
      attempt: ProvenAttemptSeed;
    }>> = [
      {
        deploymentKey: "tampered-catalog-batch-body",
        attempt: {
          ...catalog,
          id: "94300000-0000-4000-8000-000000000011",
          operations: catalog.operations.map((operation, index) => index === 1
            ? {
                ...operation,
                canonicalRequestBody: canonicalJson(
                  productionApplyBatchRequestSchema.parse({
                    ...catalogBatch,
                    records: catalogBatch.records.map((record, recordIndex) =>
                      recordIndex === 0 ? { ...record, name: "Changed" } : record),
                  }),
                ),
              }
            : operation),
        },
      },
      {
        deploymentKey: "tampered-catalog-batch-hash",
        attempt: {
          ...catalog,
          id: "94300000-0000-4000-8000-000000000012",
          operations: catalog.operations.map((operation, index) => index === 1
            ? {
                ...operation,
                canonicalRequestBody: canonicalJson(
                  productionApplyBatchRequestSchema.parse({
                    ...catalogBatch,
                    batchHash: "6".repeat(64),
                  }),
                ),
              }
            : operation),
        },
      },
      {
        deploymentKey: "tampered-catalog-chain",
        attempt: {
          ...catalog,
          id: "94300000-0000-4000-8000-000000000013",
          operations: catalog.operations.map((operation, index) => index === 0
            ? {
                ...operation,
                canonicalRequestBody: canonicalJson(
                  productionStartRequestSchema.parse({
                    ...catalogStart,
                    manifest: {
                      ...catalogStart.manifest,
                      batchChainHash: "6".repeat(64),
                    },
                  }),
                ),
              }
            : operation),
        },
      },
      {
        deploymentKey: "tampered-catalog-count",
        attempt: {
          ...catalog,
          id: "94300000-0000-4000-8000-000000000014",
          operations: catalog.operations.map((operation, index) => index === 2
            ? {
                ...operation,
                canonicalRequestBody: canonicalJson(
                  productionFinalizeRequestSchema.parse({
                    ...catalogFinalize,
                    expectedCounts: {
                      ...catalogFinalize.expectedCounts,
                      repacks: 1,
                    },
                  }),
                ),
              }
            : operation),
        },
      },
      {
        deploymentKey: "tampered-catalog-details",
        attempt: {
          ...catalog,
          id: "94300000-0000-4000-8000-000000000015",
          terminalReceiptBody: changedTerminalReceiptBody,
          operations: catalog.operations.map((operation, index) => index === 2
            ? { ...operation, receiptBody: changedTerminalReceiptBody }
            : operation),
        },
      },
    ];
    for (const variant of semanticVariants) {
      await seedLane({
        client: harness.client,
        deploymentKey: variant.deploymentKey,
        laneKey: "catalog",
        confirmed: variant.attempt,
        attempts: [variant.attempt],
      });
      await assert.rejects(
        new PrismaHeatPromotionReleaseRepository(harness.client, {
          organizationId,
          deploymentKey: variant.deploymentKey,
        }).loadActiveCatalogRelease(),
        /Promotion release proof is invalid/u,
      );
    }

    const refreshRequest = productionRefreshRequestSchema.parse(
      JSON.parse(catalogRefresh.operations[0]!.canonicalRequestBody) as unknown,
    );
    const changedRefreshRequest = productionRefreshRequestSchema.parse({
      ...refreshRequest,
      observationSequence: 44,
    });
    const changedRefreshRequestBody = canonicalJson(changedRefreshRequest);
    const refreshReceipt = productionReceiptSchema.parse(
      JSON.parse(catalogRefresh.terminalReceiptBody) as unknown,
    );
    assert.equal(refreshReceipt.operationKind, "refreshObservation");
    if (refreshReceipt.operationKind !== "refreshObservation") {
      throw new Error("catalog refresh fixture kind is invalid");
    }
    const {
      receiptDigest: _refreshReceiptDigest,
      ...refreshReceiptWithoutDigest
    } = refreshReceipt;
    void _refreshReceiptDigest;
    const changedRefreshReceiptWithoutDigest = {
      ...refreshReceiptWithoutDigest,
      requestDigest: digest(changedRefreshRequestBody),
      details: {
        ...refreshReceipt.details,
        observationSequence: 44,
      },
    };
    const changedRefreshReceiptBody = canonicalJson(
      productionReceiptSchema.parse({
        ...changedRefreshReceiptWithoutDigest,
        receiptDigest: await productionReceiptHash(
          changedRefreshReceiptWithoutDigest,
        ),
      }),
    );
    const changedRefreshAttempt: ProvenAttemptSeed = {
      ...catalogRefresh,
      id: "94300000-0000-4000-8000-000000000016",
      terminalReceiptBody: changedRefreshReceiptBody,
      operations: [{
        ...catalogRefresh.operations[0]!,
        canonicalRequestBody: changedRefreshRequestBody,
        receiptBody: changedRefreshReceiptBody,
      }],
    };
    const changedRefreshPublishedAttempt: ProvenAttemptSeed = {
      ...catalog,
      id: "94300000-0000-4000-8000-000000000017",
    };
    await seedLane({
      client: harness.client,
      deploymentKey: "tampered-catalog-refresh-target",
      laneKey: "catalog",
      confirmed: changedRefreshAttempt,
      attempts: [changedRefreshPublishedAttempt, changedRefreshAttempt],
    });
    await assert.rejects(
      new PrismaHeatPromotionReleaseRepository(harness.client, {
        organizationId,
        deploymentKey: "tampered-catalog-refresh-target",
      }).loadActiveCatalogRelease(),
      /Promotion release proof is invalid/u,
    );

    const tamperedHeatReceipt = JSON.parse(frameB.terminalReceiptBody) as {
      serverTime: string;
    };
    tamperedHeatReceipt.serverTime = "2026-08-15T12:01:02.000Z";
    const tamperedHeat = {
      ...frameB,
      id: "94300000-0000-4000-8000-000000000002",
      terminalReceiptBody: canonicalJson(tamperedHeatReceipt),
    };
    await seedLane({
      client: harness.client,
      deploymentKey: "tampered-heat",
      laneKey: "heat",
      confirmed: tamperedHeat,
      attempts: [tamperedHeat],
    });
    await assert.rejects(
      new PrismaHeatPromotionReleaseRepository(harness.client, {
        organizationId,
        deploymentKey: "tampered-heat",
      }).loadActiveHeatFrame(),
      /Promotion release proof is invalid/u,
    );
  } finally {
    await harness.close();
  }
});
