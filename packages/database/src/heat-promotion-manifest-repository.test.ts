import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH,
  EMPTY_PRODUCTION_HEAT_SIGNAL_SET_HASH,
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  PROVIDER_CATALOG_RELEASE_BATCH_KINDS,
  PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
  REPACK_HEAT_AGGREGATION_VERSION,
  REPACK_HEAT_LARGE_HIT_MULTIPLE_BASIS_POINTS,
  REPACK_HEAT_MINIMUM_BASELINE_PULLS,
  REPACK_HEAT_MINIMUM_CURRENT_PULLS,
  REPACK_HEAT_POLICY_VERSION,
  REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
  canonicalJson,
  catalogManifestReceiptDigest,
  deriveProductionHeatFrameId,
  derivePublicProviderReleaseIdV1,
  extendProductionHeatSignalSetHash,
  extendProviderCatalogReleaseBatchChainV1,
  extendProviderCatalogReleaseEntityHashV1,
  initializeProviderCatalogReleaseEntityHashV1,
  productionHeatBatchByteCount,
  productionHeatContentIdentity,
  productionHeatCoreByteCount,
  productionHeatFinalizeRequestSchema,
  productionHeatReceiptHash,
  productionHeatReceiptSchema,
  productionHeatStartRequestSchema,
  productionHeatApplyBatchRequestSchema,
  providerCatalogReleaseBatchByteCount,
  providerCatalogReleaseBatchV1Schema,
  recomputeProductionHeatBatchHash,
  recomputeProductionHeatFrameHash,
  recomputeProviderCatalogReleaseBatchHashV1,
  recomputeProviderCatalogReleaseContentHashV1,
  recomputeProviderCatalogReleaseFingerprintV1,
  recomputeProviderCatalogReleaseOriginSetHashV1,
  recomputeGlobalCatalogProviderReferenceSetHashV1,
  recomputeProviderCatalogSearchIndexHashV1,
  recomputeProviderCatalogSearchShardHashV1,
  repackSearchRowFromDetail,
  verifyProviderCatalogReleasePlanV1,
  type ProductionHeatFrameEnvelope,
  type ProductionHeatManifestAlignment,
  type PublicRepackDetail,
  type PublicRepackHeatSignal,
  type ProviderCatalogReleaseBatchKindV1,
  type ProviderCatalogReleaseBatchV1,
  type ProviderCatalogReleaseEntityHashesV1,
  type ProviderCatalogReleasePublishPlanV1,
  type ProviderCatalogSharedConfigurationEpochV1,
  type CatalogManifestRefreshReceipt,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import {
  parseHeatManifestSourceProof,
  type ActiveCatalogHeatManifest,
} from "./active-catalog-heat-manifest.ts";
import {
  PrismaHeatPromotionManifestRepository,
} from "./heat-promotion-manifest-repository.ts";
import { PrismaHeatPromotionRepository } from
  "./heat-promotion-repository.ts";
import { PrismaManifestPromotionRepository } from
  "./manifest-promotion-repository.ts";
import { PrismaProviderPromotionRepository } from
  "./provider-promotion-repository.ts";
import {
  completedExpectedHead,
  manifestActivationFixture,
  manifestRefreshFixture,
  providerPublicationFixture,
  seedPromotionV2AuthoritativeConfiguration,
  seedPromotionV2VerifiedEmptyBootstrap,
  type ManifestActivationFixture,
  type ProviderPublicationFixture,
} from "./promotion-v2-test-fixtures.ts";
import { promotionV2Sha256 } from "./promotion-v2-types.ts";
import {
  createMigratedTestDatabase,
  type MigratedTestDatabase,
} from "./test-support.ts";

const organizationId = "94000000-0000-4000-8000-000000000001";
const otherOrganizationId = "94000000-0000-4000-8000-000000000002";
const deploymentKey = "heat-manifest-proof";
const base = new Date("2026-08-16T12:00:00.000Z");
const epoch: ProviderCatalogSharedConfigurationEpochV1 = {
  configurationKey: "catalog-v1",
  revision: 1,
  publicChangeSequence: "1",
  configurationHash: "a".repeat(64),
};
const providerIds = Object.freeze({
  alpha: "61000000-0000-5000-8000-000000000101",
  beta: "62000000-0000-5000-8000-000000000101",
});
const repackIds = Object.freeze({
  alphaA: "83000000-0000-5000-8000-000000000001",
  alphaB: "83000000-0000-5000-8000-000000000002",
  betaA: "84000000-0000-5000-8000-000000000001",
});

function publicRepack(input: Readonly<{
  platformKey: "alpha" | "beta";
  publicRepackId: string;
  sourceUpdatedAt: string;
}>): PublicRepackDetail {
  return {
    publicRepackId: input.publicRepackId,
    publicVendorId: providerIds[input.platformKey],
    vendorKey: input.platformKey,
    vendorDisplayName: input.platformKey.toUpperCase(),
    vendorLogoUrl: null,
    name: `${input.platformKey}-${input.publicRepackId.slice(-4)}`,
    format: "repack",
    contentMode: "unknown",
    categories: [],
    collectibleTypes: [],
    availability: "active",
    price: {
      displayMoney: null,
      usdComparison: {
        status: "unavailable",
        value: null,
        reason: "PRICE_UNAVAILABLE",
      },
    },
    buyback: {
      status: "unavailable",
      value: null,
      reason: "BUYBACK_UNAVAILABLE",
    },
    primaryImage: null,
    evEstimates: {
      vendorReported: {
        status: "unavailable",
        displayMoney: null,
        metrics: null,
        observedAt: null,
        reason: "NOT_REPORTED",
      },
      packScout: {
        status: "unavailable",
        metrics: null,
        confidence: null,
        modelVersion: "packscout-ev-v2",
        confidencePolicyVersion: "confidence-v1",
        dataAsOf: null,
        calculatedAt: null,
        reason: "ESTIMATE_INPUT_INCOMPLETE",
      },
    },
    topChase: null,
    contentSummary: {
      knownCollectibleCount: 0,
      chaseCount: 0,
      categoryCount: 0,
      collectibleTypeCount: 0,
      evidenceCompleteness: "unknown",
      probabilityCoverageBasisPoints: null,
    },
    actionAvailability: { promo: false, repackLink: false },
    sourceUpdatedAt: input.sourceUpdatedAt,
    description: null,
    actions: {},
  };
}

async function batch(
  batchIndex: number,
  kind: ProviderCatalogReleaseBatchKindV1,
  records: readonly unknown[],
): Promise<ProviderCatalogReleaseBatchV1> {
  return providerCatalogReleaseBatchV1Schema.parse({
    batchIndex,
    kind,
    records,
    byteCount: providerCatalogReleaseBatchByteCount(records),
    batchHash: await recomputeProviderCatalogReleaseBatchHashV1({
      kind, records,
    }),
  });
}

async function providerPlan(input: Readonly<{
  platformKey: "alpha" | "beta";
  sequence: bigint;
  publicRepackIds: readonly string[];
}>): Promise<ProviderCatalogReleasePublishPlanV1> {
  const settledAt = new Date(base.getTime() + Number(input.sequence) * 1_000);
  const dataAsOf = new Date(settledAt.getTime() - 2_000).toISOString();
  const origin = `https://${input.platformKey}.example`;
  const vendor = {
    publicVendorId: providerIds[input.platformKey],
    vendorKey: input.platformKey,
    displayName: input.platformKey.toUpperCase(),
    logoUrl: null,
    websiteUrl: origin,
    listingHosts: [`${input.platformKey}.example`],
    imageOrigins: [origin],
    referralParameters: [],
    publicPromo: null,
  };
  const repacks = input.publicRepackIds.map((publicRepackId) => publicRepack({
    platformKey: input.platformKey,
    publicRepackId,
    sourceUpdatedAt: dataAsOf,
  }));
  const rows = repacks.map(repackSearchRowFromDetail);
  const shard = {
    shardNumber: 0,
    rowCount: rows.length,
    byteCount: providerCatalogReleaseBatchByteCount(rows),
    contentHash: await recomputeProviderCatalogSearchShardHashV1(rows),
    rows,
  };
  const batches = [
    await batch(0, "vendors", [vendor]),
    await batch(1, "repacks", repacks),
    await batch(2, "search_shards", [shard]),
  ];
  let batchChainHash = EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH;
  const entityHashes = {} as Record<
    ProviderCatalogReleaseBatchKindV1,
    string
  >;
  for (const kind of PROVIDER_CATALOG_RELEASE_BATCH_KINDS) {
    entityHashes[kind] = await initializeProviderCatalogReleaseEntityHashV1(
      kind,
    );
  }
  for (const item of batches) {
    batchChainHash = await extendProviderCatalogReleaseBatchChainV1({
      previousHash: batchChainHash,
      batchIndex: item.batchIndex,
      kind: item.kind,
      batchHash: item.batchHash,
      recordCount: item.records.length,
      byteCount: item.byteCount,
    });
    entityHashes[item.kind] = await extendProviderCatalogReleaseEntityHashV1({
      previousHash: entityHashes[item.kind],
      kind: item.kind,
      batchHash: item.batchHash,
      recordCount: item.records.length,
      byteCount: item.byteCount,
    });
  }
  const counts = {
    vendors: 1 as const,
    categories: 0,
    collectibles: 0,
    repacks: repacks.length,
    repackChases: 0,
    searchShards: 1,
  };
  const immutable = {
    platformKey: input.platformKey,
    sharedConfigurationEpoch: epoch,
    dataAsOf,
    contentHash: await recomputeProviderCatalogReleaseContentHashV1({
      entityHashes: entityHashes as ProviderCatalogReleaseEntityHashesV1,
    }),
    publicAssetOrigins: [origin],
    governingHashes: {
      providerConfigurationHash: "1".repeat(64),
      sharedCategoriesHash: "2".repeat(64),
      identityMappingsHash: "3".repeat(64),
      originSetHash: await recomputeProviderCatalogReleaseOriginSetHashV1(
        [origin],
      ),
      confidencePolicyHash: "4".repeat(64),
    },
    entityHashes: entityHashes as ProviderCatalogReleaseEntityHashesV1,
    counts,
    searchAlgorithmVersion: "repack_search_v2" as const,
    providerSearchIndexHash: await recomputeProviderCatalogSearchIndexHashV1(
      [shard],
    ),
    batchCount: batches.length,
    batchChainHash,
  };
  const verified = await verifyProviderCatalogReleasePlanV1({
    schemaVersion: PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
    classification: "publish",
    ...immutable,
    publicProviderReleaseId: await derivePublicProviderReleaseIdV1(immutable),
    providerReleaseFingerprint:
      await recomputeProviderCatalogReleaseFingerprintV1(immutable),
    providerCheckpoint: {
      settledSequence: String(input.sequence),
      settledAt: settledAt.toISOString(),
    },
    sourceWatermark: `provider-catalog:${input.platformKey}:${input.sequence}`,
    observation: {
      sourceHeadSequence: String(input.sequence),
      lastSuccessfulObservationAt: settledAt.toISOString(),
      staleAt: new Date(settledAt.getTime() + 900_000).toISOString(),
      freshness: "fresh",
    },
    batches,
  });
  if (verified.classification !== "publish") {
    throw new TypeError("Provider fixture did not produce a publish plan.");
  }
  return verified;
}

async function publishProvider(
  harness: MigratedTestDatabase,
  fixture: ProviderPublicationFixture,
  offsetMilliseconds = 0,
): Promise<string> {
  const startedAt = new Date(base.getTime() + offsetMilliseconds);
  const repository = new PrismaProviderPromotionRepository(harness.client, {
    organizationId,
    deploymentKey,
    platformKey: fixture.summary.platformKey,
  });
  await repository.enqueueEvaluation({
    checkpoint: fixture.checkpoint,
    requestedAt: startedAt,
  });
  const claim = await repository.claim({
    workerId: `provider-${fixture.summary.platformKey}`,
    now: startedAt,
    leaseExpiresAt: new Date(startedAt.getTime() + 60_000),
  });
  assert.ok(claim);
  await repository.persistPreparedOperations({
    attemptId: claim.attemptId,
    claimToken: claim.claimToken,
    preparedAt: new Date(startedAt.getTime() + 1_000),
    summary: fixture.summary,
    operations: fixture.operations,
  });
  for (const [index, operation] of fixture.operations.entries()) {
    assert.equal(await repository.markOperationSent({
      attemptId: claim.attemptId,
      operationId: operation.operationId,
      claimToken: claim.claimToken,
      sentAt: new Date(startedAt.getTime() + 2_000 + index * 2_000),
    }), true);
    assert.equal(await repository.acknowledgeOperation({
      attemptId: claim.attemptId,
      operationId: operation.operationId,
      claimToken: claim.claimToken,
      acknowledgedAt:
        new Date(startedAt.getTime() + 3_000 + index * 2_000),
      evidence: fixture.evidence[index]!,
    }), true);
  }
  assert.equal(await repository.complete({
    attemptId: claim.attemptId,
    claimToken: claim.claimToken,
    outcome: fixture.summary.classification === "publish"
      ? "published" : "reused",
    completedAt: new Date(startedAt.getTime() + 20_000),
  }), true);
  return claim.attemptId;
}

async function activateManifest(
  harness: MigratedTestDatabase,
  publication: ProviderPublicationFixture,
  publishArtifactAttemptId: string,
): Promise<ManifestActivationFixture> {
  const repository = new PrismaManifestPromotionRepository(harness.client, {
    organizationId,
    deploymentKey,
  });
  const claim = await repository.claim({
    workerId: "manifest-activation",
    now: new Date(base.getTime() + 21_000),
    leaseExpiresAt: new Date(base.getTime() + 81_000),
  });
  assert.ok(claim);
  const activation = await manifestActivationFixture({
    publication,
    organizationId,
    evaluationSequence: claim.evaluationSequence,
    publishArtifactAttemptId,
  });
  await harness.client.manifest_promotion_attempts.update({
    where: { id: claim.attemptId },
    data: {
      evaluation_snapshot_body: activation.snapshotBody,
      evaluation_snapshot_sha256: activation.snapshotSha256,
    },
  });
  await repository.persistPreparedOperation({
    attemptId: claim.attemptId,
    claimToken: claim.claimToken,
    preparedAt: new Date(base.getTime() + 22_000),
    summary: activation.summary,
    operation: activation.operation,
  });
  assert.equal(await repository.markOperationSent({
    attemptId: claim.attemptId,
    operationId: activation.operation.operationId,
    claimToken: claim.claimToken,
    sentAt: new Date(base.getTime() + 23_000),
  }), true);
  assert.equal(await repository.acknowledgeOperation({
    attemptId: claim.attemptId,
    operationId: activation.operation.operationId,
    claimToken: claim.claimToken,
    acknowledgedAt: new Date(base.getTime() + 24_000),
    evidence: activation.evidence,
  }), true);
  assert.equal(await repository.complete({
    attemptId: claim.attemptId,
    claimToken: claim.claimToken,
    outcome: "activated",
    completedAt: new Date(base.getTime() + 25_000),
  }), true);
  return activation;
}

async function refreshManifest(input: Readonly<{
  harness: MigratedTestDatabase;
  publication: ProviderPublicationFixture;
  activation: ManifestActivationFixture;
  publishArtifactAttemptId: string;
}>): Promise<void> {
  const repository = new PrismaManifestPromotionRepository(
    input.harness.client,
    { organizationId, deploymentKey },
  );
  const startedAt = new Date(base.getTime() + 121_000);
  const claim = await repository.claim({
    workerId: "manifest-metadata-refresh",
    now: startedAt,
    leaseExpiresAt: new Date(startedAt.getTime() + 60_000),
  });
  assert.ok(claim);
  const refresh = manifestRefreshFixture({
    publication: input.publication,
    manifest: input.activation.manifest,
    activeState: input.activation.activeState,
    organizationId,
    evaluationSequence: claim.evaluationSequence,
    publishArtifactAttemptId: input.publishArtifactAttemptId,
    operationTag: "metadata-refresh",
  });
  await input.harness.client.manifest_promotion_attempts.update({
    where: { id: claim.attemptId },
    data: {
      evaluation_snapshot_body: refresh.snapshotBody,
      evaluation_snapshot_sha256: refresh.snapshotSha256,
    },
  });
  await repository.persistPreparedOperation({
    attemptId: claim.attemptId,
    claimToken: claim.claimToken,
    preparedAt: new Date(startedAt.getTime() + 1_000),
    summary: refresh.summary,
    operation: refresh.operation,
  });
  assert.equal(await repository.markOperationSent({
    attemptId: claim.attemptId,
    operationId: refresh.operation.operationId,
    claimToken: claim.claimToken,
    sentAt: new Date(startedAt.getTime() + 2_000),
  }), true);
  const request = JSON.parse(refresh.operation.canonicalRequestBody) as {
    operationId: string;
    idempotencyKey: string;
    manifest: ProductionHeatManifestAlignment;
    observation: NonNullable<ManifestActivationFixture["activeState"]["observation"]>;
    expectedActiveState: ManifestActivationFixture["activeState"];
  };
  if (input.activation.activeState.activeManifest === null) {
    throw new TypeError("Metadata refresh fixture requires an active manifest.");
  }
  const activeState = {
    generation: input.activation.activeState.generation + 1,
    activeManifest: input.activation.activeState.activeManifest,
    previousManifest: input.activation.activeState.previousManifest,
    observation: request.observation,
  };
  const withoutDigest = {
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationKind: "refreshActiveState" as const,
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    publicReleaseId: request.manifest.publicReleaseId,
    manifestFingerprint: request.manifest.manifestFingerprint,
    terminalState: "complete" as const,
    result: "refreshed" as const,
    serverTime: new Date(startedAt.getTime() + 3_000).toISOString(),
    requestDigest: promotionV2Sha256(refresh.operation.canonicalRequestBody),
    details: {
      expectedActiveState: request.expectedActiveState,
      activeState,
    },
  };
  const receipt = {
    ...withoutDigest,
    receiptDigest: await catalogManifestReceiptDigest(withoutDigest),
  } satisfies CatalogManifestRefreshReceipt;
  assert.equal(await repository.acknowledgeOperation({
    attemptId: claim.attemptId,
    operationId: refresh.operation.operationId,
    claimToken: claim.claimToken,
    acknowledgedAt: new Date(startedAt.getTime() + 3_000),
    evidence: { canonicalReceiptBody: canonicalJson(receipt) },
  }), true);
  assert.equal(await repository.complete({
    attemptId: claim.attemptId,
    claimToken: claim.claimToken,
    outcome: "refreshed",
    completedAt: new Date(startedAt.getTime() + 4_000),
  }), true);
}

function heatSignal(
  publicRepackId: string,
  frameEndedAt: Date,
): PublicRepackHeatSignal {
  const currentEndedAt = frameEndedAt.getTime();
  const currentStartedAt = currentEndedAt - 15 * 60_000;
  const baselineStartedAt = currentStartedAt - 24 * 60 * 60_000;
  const calculatedAt = new Date(currentEndedAt + 1_000).toISOString();
  return {
    publicRepackId,
    state: "hot",
    scoreBasisPoints: 8_505,
    provenance: {
      kind: "observed",
      aggregationVersion: REPACK_HEAT_AGGREGATION_VERSION,
    },
    sourceCoverage: "complete",
    currentWindow: {
      startedAt: new Date(currentStartedAt).toISOString(),
      endedAt: frameEndedAt.toISOString(),
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
    signalConfidence: { scoreBasisPoints: 10_000, band: "high" },
    limitationCodes: [],
    heatPolicyVersion: REPACK_HEAT_POLICY_VERSION,
    calculatedAt,
    expiresAt: new Date(Date.parse(calculatedAt) + 15 * 60_000).toISOString(),
  };
}

interface HeatFixture {
  readonly frame: ProductionHeatFrameEnvelope;
  readonly contentIdentity: string;
  readonly operations: readonly Readonly<{
    operationIndex: number;
    operationId: string;
    operationKind: "start" | "applyBatch" | "finalize";
    requestPath: string;
    canonicalRequestBody: string;
    receiptBody: string;
  }>[];
}

async function heatFixture(input: Readonly<{
  manifestAlignment: ProductionHeatManifestAlignment;
  publicRepackIds: readonly string[];
  frameEndedAt: Date;
  sourceWatermark: bigint;
}>): Promise<HeatFixture> {
  const records = input.publicRepackIds.map((id) =>
    heatSignal(id, input.frameEndedAt)
  );
  const batchHash = await recomputeProductionHeatBatchHash(records);
  const signalSetHash = await extendProductionHeatSignalSetHash({
    previousHash: EMPTY_PRODUCTION_HEAT_SIGNAL_SET_HASH,
    batchIndex: 0,
    batchHash,
    recordCount: records.length,
    coreByteCount: productionHeatCoreByteCount(records),
  });
  const frameSequence = input.frameEndedAt.getTime() / 60_000;
  const sourceWatermark = String(input.sourceWatermark);
  const publicHeatFrameId = await deriveProductionHeatFrameId({
    manifestAlignment: input.manifestAlignment,
    frameSequence,
    sourceWatermark,
  });
  const currentStartedAt = input.frameEndedAt.getTime() - 15 * 60_000;
  const calculatedAt = new Date(input.frameEndedAt.getTime() + 1_000);
  const unhashed: ProductionHeatFrameEnvelope = {
    publicHeatFrameId,
    manifestAlignment: input.manifestAlignment,
    frameSequence,
    sourceWatermark,
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
  const frame = { ...unhashed, frameHash: await recomputeProductionHeatFrameHash(
    unhashed,
  ) };
  const start = productionHeatStartRequestSchema.parse({
    schemaVersion: REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
    operationId: `heat:start:${frameSequence}`,
    idempotencyKey: `heat:start:${frameSequence}`,
    publicationId: publicHeatFrameId,
    frame,
    expectedBatchCount: 1,
  });
  const apply = productionHeatApplyBatchRequestSchema.parse({
    schemaVersion: REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
    operationId: `heat:batch:${frameSequence}:0`,
    idempotencyKey: `heat:batch:${frameSequence}:0`,
    publicationId: publicHeatFrameId,
    batchIndex: 0,
    batchHash,
    records,
  });
  const finalize = productionHeatFinalizeRequestSchema.parse({
    schemaVersion: REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
    operationId: `heat:finalize:${frameSequence}`,
    idempotencyKey: `heat:finalize:${frameSequence}`,
    publicationId: publicHeatFrameId,
    expectedActivePublicHeatFrameId: null,
    expectedManifestAlignment: input.manifestAlignment,
    expectedSignalSetHash: signalSetHash,
    expectedFrameHash: frame.frameHash,
    expectedSignalCount: records.length,
    expectedBatchCount: 1,
  });
  const requestBodies = [start, apply, finalize].map(canonicalJson);
  const receipt = async (value: Record<string, unknown>) => {
    const parsed = productionHeatReceiptSchema.parse({
      ...value,
      receiptDigest: await productionHeatReceiptHash(value as never),
    });
    return canonicalJson(parsed);
  };
  const common = {
    schemaVersion: REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
    publicationId: publicHeatFrameId,
    serverTime: calculatedAt.toISOString(),
  } as const;
  const receipts = [
    await receipt({
      ...common,
      operationId: start.operationId,
      operationKind: "start",
      terminalState: "staging",
      result: "created",
      requestDigest: promotionV2Sha256(requestBodies[0]!),
      details: {
        manifestAlignment: input.manifestAlignment,
        frameHash: frame.frameHash,
        signalSetHash,
        sourceWatermark,
        frameSequence,
        expectedSignalCount: records.length,
        expectedBatchCount: 1,
      },
    }),
    await receipt({
      ...common,
      operationId: apply.operationId,
      operationKind: "applyBatch",
      terminalState: "staging",
      result: "accepted",
      requestDigest: promotionV2Sha256(requestBodies[1]!),
      details: {
        batchIndex: 0,
        batchHash,
        recordCount: records.length,
        byteCount: productionHeatBatchByteCount(records),
        coreByteCount: productionHeatCoreByteCount(records),
        acceptedSignalCount: records.length,
        signalSetProgressHash: signalSetHash,
      },
    }),
    await receipt({
      ...common,
      operationId: finalize.operationId,
      operationKind: "finalize",
      terminalState: "complete",
      result: "activated",
      requestDigest: promotionV2Sha256(requestBodies[2]!),
      details: {
        manifestAlignment: input.manifestAlignment,
        activePublicHeatFrameId: publicHeatFrameId,
        previousPublicHeatFrameId: null,
        frameHash: frame.frameHash,
        signalSetHash,
        sourceWatermark,
        frameSequence,
        signalCount: records.length,
        calculatedAt: frame.calculatedAt,
        expiresAt: frame.expiresAt,
      },
    }),
  ];
  return {
    frame,
    contentIdentity: await productionHeatContentIdentity({
      manifestAlignment: input.manifestAlignment,
      signalSetHash,
    }),
    operations: requestBodies.map((canonicalRequestBody, index) => ({
      operationIndex: index,
      operationId: [start, apply, finalize][index]!.operationId,
      operationKind: ["start", "applyBatch", "finalize"][index] as
        "start" | "applyBatch" | "finalize",
      requestPath: [
        "/internal/repack-heat/v1/start",
        "/internal/repack-heat/v1/apply-batch",
        "/internal/repack-heat/v1/finalize",
      ][index]!,
      canonicalRequestBody,
      receiptBody: receipts[index]!,
    })),
  };
}

function providerReference(plan: ProviderCatalogReleasePublishPlanV1) {
  return {
    platformKey: plan.platformKey,
    publicProviderReleaseId: plan.publicProviderReleaseId,
    sharedConfigurationEpoch: plan.sharedConfigurationEpoch,
    providerReleaseFingerprint: plan.providerReleaseFingerprint,
    contentHash: plan.contentHash,
    publicAssetOrigins: plan.publicAssetOrigins,
    governingHashes: plan.governingHashes,
    entityHashes: plan.entityHashes,
    counts: plan.counts,
    searchAlgorithmVersion: plan.searchAlgorithmVersion,
    providerSearchIndexHash: plan.providerSearchIndexHash,
    batchCount: plan.batchCount,
    batchChainHash: plan.batchChainHash,
    dataAsOf: plan.dataAsOf,
  };
}

async function manifestSourceProof(input: Readonly<{
  plans: readonly ProviderCatalogReleasePublishPlanV1[];
  publicReleaseId: string;
  manifestFingerprint: string;
  confirmedManifestWatermark: bigint;
  terminalReceiptSha256: string;
}>): Promise<ActiveCatalogHeatManifest> {
  const providerReferences = input.plans.map(providerReference)
    .sort((left, right) => left.platformKey.localeCompare(right.platformKey));
  const publicRepackOwnership = input.plans
    .toSorted((left, right) => left.platformKey.localeCompare(right.platformKey))
    .flatMap((plan) => plan.batches
      .filter((item) => item.kind === "repacks")
      .flatMap((item) => item.records.map(({ publicRepackId }) => ({
        publicRepackId,
        platformKey: plan.platformKey,
        publicProviderReleaseId: plan.publicProviderReleaseId,
        providerReleaseFingerprint: plan.providerReleaseFingerprint,
      }))));
  return {
    manifestAlignment: {
      publicReleaseId: input.publicReleaseId,
      manifestFingerprint: input.manifestFingerprint,
      sharedConfigurationEpoch: epoch,
      providerReferenceSetHash:
        await recomputeGlobalCatalogProviderReferenceSetHashV1(
          providerReferences,
        ),
    },
    providerReferences,
    publicRepackOwnership,
    publicRepackIds: publicRepackOwnership.map(({ publicRepackId }) =>
      publicRepackId
    ).sort(),
    confirmedManifestWatermark: input.confirmedManifestWatermark,
    terminalReceiptSha256: input.terminalReceiptSha256,
  };
}

async function acknowledgeAndCompleteHeat(
  ledger: PrismaHeatPromotionRepository,
  claim: NonNullable<Awaited<ReturnType<
    PrismaHeatPromotionRepository["claimAttempt"]
  >>>,
  fixture: HeatFixture,
  startedAt: Date,
): Promise<void> {
  for (const operation of fixture.operations) {
    assert.equal(await ledger.markOperationSent({
      attemptId: claim.attemptId,
      operationId: operation.operationId,
      claimToken: claim.claimToken,
      sentAt: new Date(startedAt.getTime() + operation.operationIndex * 2_000),
    }), true);
    assert.equal(await ledger.acknowledgeOperation({
      attemptId: claim.attemptId,
      operationId: operation.operationId,
      claimToken: claim.claimToken,
      acknowledgedAt:
        new Date(startedAt.getTime() + operation.operationIndex * 2_000 + 1_000),
      receiptBody: operation.receiptBody,
    }), true);
  }
  assert.equal(await ledger.completeAttempt({
    attemptId: claim.attemptId,
    claimToken: claim.claimToken,
    terminalState: "published",
    completedAt: new Date(startedAt.getTime() + 7_000),
    receiptBody: fixture.operations.at(-1)!.receiptBody,
    failureClass: null,
    failureCode: null,
  }), true);
}

test("Task 011 manifest proof drives Heat, survives restart, and retains metadata-refresh history", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await harness.client.organizations.createMany({
      data: [
        { id: organizationId, slug: "heat-manifest", name: "Heat Manifest" },
        { id: otherOrganizationId, slug: "other-heat", name: "Other Heat" },
      ],
    });
    await seedPromotionV2AuthoritativeConfiguration(
      harness, organizationId, ["alpha"], base,
    );
    await seedPromotionV2VerifiedEmptyBootstrap(
      harness, organizationId, deploymentKey, ["alpha"], base,
    );
    const plan = await providerPlan({
      platformKey: "alpha",
      sequence: 10n,
      publicRepackIds: [repackIds.alphaA, repackIds.alphaB],
    });
    const publication = await providerPublicationFixture({ publishPlan: plan });
    const artifactAttemptId = await publishProvider(harness, publication);
    const activation = await activateManifest(
      harness, publication, artifactAttemptId,
    );
    const manifests = new PrismaHeatPromotionManifestRepository(
      harness.client,
      { organizationId, deploymentKey },
    );
    const active = await manifests.loadActiveCatalogManifest();
    assert.ok(active);
    assert.deepEqual(active.manifestAlignment, {
      publicReleaseId: activation.manifest.publicReleaseId,
      manifestFingerprint: activation.manifest.manifestFingerprint,
      sharedConfigurationEpoch: activation.manifest.sharedConfigurationEpoch,
      providerReferenceSetHash: activation.manifest.providerReferenceSetHash,
    });
    assert.deepEqual(active.publicRepackIds, [
      repackIds.alphaA, repackIds.alphaB,
    ]);
    assert.deepEqual(active.publicRepackOwnership.map((owner) => ({
      publicRepackId: owner.publicRepackId,
      platformKey: owner.platformKey,
    })), [
      { publicRepackId: repackIds.alphaA, platformKey: "alpha" },
      { publicRepackId: repackIds.alphaB, platformKey: "alpha" },
    ]);
    assert.equal(active.confirmedManifestWatermark, 1n);
    assert.equal(await new PrismaHeatPromotionManifestRepository(
      harness.client,
      { organizationId: otherOrganizationId, deploymentKey },
    ).loadActiveCatalogManifest(), null);

    const ledger = new PrismaHeatPromotionRepository(harness.client, {
      organizationId,
      deploymentKey,
    });
    const fixture = await heatFixture({
      manifestAlignment: active.manifestAlignment,
      publicRepackIds: active.publicRepackIds,
      frameEndedAt: new Date("2026-08-16T12:15:00.000Z"),
      sourceWatermark: 99n,
    });
    await ledger.coalesceSettledWatermark({
      laneKey: "heat",
      settledWatermark: BigInt(fixture.frame.frameSequence),
      settledAt: new Date(base.getTime() + 31_000),
      delayedVendorCount: 0,
    });
    await ledger.verifyBootstrap({
      laneKey: "heat",
      observedPublicationIdentity: null,
      observedWatermark: 0n,
      observedReceiptSha256: null,
      verifiedAt: new Date(base.getTime() + 31_500),
    });
    const claim = await ledger.claimAttempt({
      laneKey: "heat",
      claimOwner: "heat-first",
      now: new Date(base.getTime() + 32_000),
      claimExpiresAt: new Date(base.getTime() + 42_000),
    });
    assert.ok(claim);
    await assert.rejects(() => ledger.persistAssembledOperations({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      now: new Date(base.getTime() + 33_000),
      contentIdentity: fixture.contentIdentity,
      publicationIdentity: fixture.frame.publicHeatFrameId,
      preparedClassification: "publish",
      manifestSourceProof: {
        ...active,
        manifestAlignment: {
          ...active.manifestAlignment,
          manifestFingerprint: "f".repeat(64),
        },
      },
      operations: fixture.operations,
    }), { code: "PROMOTION_INPUT_INVALID" });
    const persisted = await ledger.persistAssembledOperations({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      now: new Date(base.getTime() + 33_000),
      contentIdentity: fixture.contentIdentity,
      publicationIdentity: fixture.frame.publicHeatFrameId,
      preparedClassification: "publish",
      manifestSourceProof: active,
      operations: fixture.operations,
    });
    assert.equal(persisted?.length, 3);
    await assert.rejects(() => harness.client.$executeRaw(Prisma.sql`
      update public.promotion_attempts
      set manifest_source_proof_sha256 = ${"f".repeat(64)}
      where id = cast(${claim.attemptId} as uuid)
    `));
    const recovered = await new PrismaHeatPromotionRepository(
      harness.client,
      { organizationId, deploymentKey },
    ).claimAttempt({
      laneKey: "heat",
      claimOwner: "heat-restart",
      now: new Date(base.getTime() + 43_000),
      claimExpiresAt: new Date(base.getTime() + 103_000),
    });
    assert.ok(recovered);
    assert.deepEqual(recovered.manifestSourceProof, active);
    for (const operation of fixture.operations) {
      assert.equal(await ledger.markOperationSent({
        attemptId: recovered.attemptId,
        operationId: operation.operationId,
        claimToken: recovered.claimToken,
        sentAt: new Date(base.getTime() + 44_000 + operation.operationIndex * 2_000),
      }), true);
      assert.equal(await ledger.acknowledgeOperation({
        attemptId: recovered.attemptId,
        operationId: operation.operationId,
        claimToken: recovered.claimToken,
        acknowledgedAt:
          new Date(base.getTime() + 45_000 + operation.operationIndex * 2_000),
        receiptBody: operation.receiptBody,
      }), true);
    }
    assert.equal(await ledger.completeAttempt({
      attemptId: recovered.attemptId,
      claimToken: recovered.claimToken,
      terminalState: "published",
      completedAt: new Date(base.getTime() + 52_000),
      receiptBody: fixture.operations.at(-1)!.receiptBody,
      failureClass: null,
      failureCode: null,
    }), true);
    const baseline = await manifests.loadActiveHeatFrame();
    assert.ok(baseline);
    assert.deepEqual(baseline.manifestAlignment, active.manifestAlignment);
    assert.equal(baseline.publicHeatFrameId, fixture.frame.publicHeatFrameId);
    assert.equal(await manifests.hasReusableHeatSignalSet({
      manifestAlignment: active.manifestAlignment,
      signalSetHash: fixture.frame.signalSetHash,
      contentIdentity: fixture.contentIdentity,
      signalCount: fixture.frame.signalCount,
      reusableAt: fixture.frame.calculatedAt === ""
        ? base : new Date(fixture.frame.calculatedAt),
    }), true);

    const reuse = await providerPublicationFixture({
      platformKey: "alpha",
      sequence: 20n,
      classification: "reuse",
      predecessor: completedExpectedHead(publication),
      immutableProof: publication.summary.immutableProof,
      operationTag: "metadata-refresh",
    });
    await publishProvider(harness, reuse, 90_000);
    await refreshManifest({
      harness,
      publication: reuse,
      activation,
      publishArtifactAttemptId: artifactAttemptId,
    });
    const refreshed = await manifests.loadActiveCatalogManifest();
    assert.ok(refreshed);
    assert.deepEqual(refreshed.manifestAlignment, active.manifestAlignment);
    assert.deepEqual(refreshed.providerReferences, active.providerReferences);
    assert.deepEqual(
      refreshed.publicRepackOwnership,
      active.publicRepackOwnership,
    );
    assert.equal(refreshed.confirmedManifestWatermark, 2n);
    assert.notEqual(
      refreshed.terminalReceiptSha256,
      active.terminalReceiptSha256,
    );
    const historicalRow = await harness.client.$queryRaw<Array<{
      body: string;
      sha256: string;
    }>>(Prisma.sql`
      select manifest_source_proof_body as body,
             manifest_source_proof_sha256 as sha256
      from public.promotion_attempts
      where id = cast(${recovered.attemptId} as uuid)
    `);
    const historical = await parseHeatManifestSourceProof(
      historicalRow[0]!.body,
      historicalRow[0]!.sha256,
    );
    assert.equal(historical.confirmedManifestWatermark, 1n);
    assert.equal(
      historical.terminalReceiptSha256,
      active.terminalReceiptSha256,
    );
    assert.deepEqual(historical.providerReferences, active.providerReferences);
  } finally {
    await harness.close();
  }
});

test("malformed persisted source proof fails closed on PostgreSQL restart", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await harness.client.organizations.create({
      data: { id: organizationId, slug: "bad-proof", name: "Bad Proof" },
    });
    const ledger = new PrismaHeatPromotionRepository(harness.client, {
      organizationId,
      deploymentKey,
    });
    await ledger.coalesceSettledWatermark({
      laneKey: "heat",
      settledWatermark: 1n,
      settledAt: base,
      delayedVendorCount: 0,
    });
    await ledger.verifyBootstrap({
      laneKey: "heat",
      observedPublicationIdentity: null,
      observedWatermark: 0n,
      observedReceiptSha256: null,
      verifiedAt: base,
    });
    const claim = await ledger.claimAttempt({
      laneKey: "heat",
      claimOwner: "bad-proof-first",
      now: base,
      claimExpiresAt: new Date(base.getTime() + 1_000),
    });
    assert.ok(claim);
    const malformedBody = canonicalJson({ schemaVersion: "wrong" });
    await assert.rejects(() => harness.client.$executeRaw(Prisma.sql`
      update public.promotion_attempts
      set manifest_source_proof_body = ${malformedBody}
      where id = cast(${claim.attemptId} as uuid)
    `));
    await harness.client.$executeRaw(Prisma.sql`
      update public.promotion_attempts
      set manifest_source_proof_body = ${malformedBody},
          manifest_source_proof_sha256 = ${promotionV2Sha256(malformedBody)}
      where id = cast(${claim.attemptId} as uuid)
    `);
    await assert.rejects(() => new PrismaHeatPromotionRepository(
      harness.client,
      { organizationId, deploymentKey },
    ).claimAttempt({
      laneKey: "heat",
      claimOwner: "bad-proof-restart",
      now: new Date(base.getTime() + 2_000),
      claimExpiresAt: new Date(base.getTime() + 62_000),
    }), { code: "PROMOTION_ATTEMPT_CONFLICT" });
  } finally {
    await harness.close();
  }
});

test("historical A2/B1 Heat proof remains exact after A3/B1 preparation", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await harness.client.organizations.create({
      data: {
        id: organizationId,
        slug: "historical-provider-proof",
        name: "Historical Provider Proof",
      },
    });
    const [alpha2, alpha3, beta1] = await Promise.all([
      providerPlan({
        platformKey: "alpha",
        sequence: 20n,
        publicRepackIds: [repackIds.alphaA, repackIds.alphaB],
      }),
      providerPlan({
        platformKey: "alpha",
        sequence: 30n,
        publicRepackIds: [repackIds.alphaA, repackIds.alphaB],
      }),
      providerPlan({
        platformKey: "beta",
        sequence: 10n,
        publicRepackIds: [repackIds.betaA],
      }),
    ]);
    assert.notEqual(
      alpha2.publicProviderReleaseId,
      alpha3.publicProviderReleaseId,
    );
    const a2b1 = await manifestSourceProof({
      plans: [alpha2, beta1],
      publicReleaseId: "85000000-0000-5000-8000-000000000002",
      manifestFingerprint: "2".repeat(64),
      confirmedManifestWatermark: 2n,
      terminalReceiptSha256: "a".repeat(64),
    });
    const a3b1 = await manifestSourceProof({
      plans: [alpha3, beta1],
      publicReleaseId: "85000000-0000-5000-8000-000000000003",
      manifestFingerprint: "3".repeat(64),
      confirmedManifestWatermark: 3n,
      terminalReceiptSha256: "b".repeat(64),
    });
    const ledger = new PrismaHeatPromotionRepository(harness.client, {
      organizationId,
      deploymentKey,
    });
    const first = await heatFixture({
      manifestAlignment: a2b1.manifestAlignment,
      publicRepackIds: a2b1.publicRepackIds,
      frameEndedAt: new Date("2026-08-16T12:30:00.000Z"),
      sourceWatermark: 200n,
    });
    await ledger.coalesceSettledWatermark({
      laneKey: "heat",
      settledWatermark: BigInt(first.frame.frameSequence),
      settledAt: base,
      delayedVendorCount: 0,
    });
    await ledger.verifyBootstrap({
      laneKey: "heat",
      observedPublicationIdentity: null,
      observedWatermark: 0n,
      observedReceiptSha256: null,
      verifiedAt: base,
    });
    const firstClaim = await ledger.claimAttempt({
      laneKey: "heat",
      claimOwner: "a2-b1",
      now: new Date(base.getTime() + 1_000),
      claimExpiresAt: new Date(base.getTime() + 61_000),
    });
    assert.ok(firstClaim);
    await ledger.persistAssembledOperations({
      attemptId: firstClaim.attemptId,
      claimToken: firstClaim.claimToken,
      now: new Date(base.getTime() + 2_000),
      contentIdentity: first.contentIdentity,
      publicationIdentity: first.frame.publicHeatFrameId,
      preparedClassification: "publish",
      manifestSourceProof: a2b1,
      operations: first.operations,
    });
    await acknowledgeAndCompleteHeat(
      ledger, firstClaim, first, new Date(base.getTime() + 3_000),
    );

    const second = await heatFixture({
      manifestAlignment: a3b1.manifestAlignment,
      publicRepackIds: a3b1.publicRepackIds,
      frameEndedAt: new Date("2026-08-16T12:45:00.000Z"),
      sourceWatermark: 300n,
    });
    await ledger.coalesceSettledWatermark({
      laneKey: "heat",
      settledWatermark: BigInt(second.frame.frameSequence),
      settledAt: new Date(base.getTime() + 11_000),
      delayedVendorCount: 0,
    });
    const secondClaim = await ledger.claimAttempt({
      laneKey: "heat",
      claimOwner: "a3-b1",
      now: new Date(base.getTime() + 12_000),
      claimExpiresAt: new Date(base.getTime() + 72_000),
    });
    assert.ok(secondClaim);
    await ledger.persistAssembledOperations({
      attemptId: secondClaim.attemptId,
      claimToken: secondClaim.claimToken,
      now: new Date(base.getTime() + 13_000),
      contentIdentity: second.contentIdentity,
      publicationIdentity: second.frame.publicHeatFrameId,
      preparedClassification: "publish",
      manifestSourceProof: a3b1,
      operations: second.operations,
    });

    const rows = await harness.client.$queryRaw<Array<{
      targetWatermark: bigint;
      body: string;
      sha256: string;
    }>>(Prisma.sql`
      select target_watermark as "targetWatermark",
             manifest_source_proof_body as body,
             manifest_source_proof_sha256 as sha256
      from public.promotion_attempts
      where organization_id = cast(${organizationId} as uuid)
        and deployment_key = ${deploymentKey}
        and lane_key = 'heat'
      order by target_watermark
    `);
    assert.equal(rows.length, 2);
    const historical = await parseHeatManifestSourceProof(
      rows[0]!.body,
      rows[0]!.sha256,
    );
    const current = await parseHeatManifestSourceProof(
      rows[1]!.body,
      rows[1]!.sha256,
    );
    assert.equal(
      historical.providerReferences[0]!.publicProviderReleaseId,
      alpha2.publicProviderReleaseId,
    );
    assert.equal(
      historical.providerReferences[1]!.publicProviderReleaseId,
      beta1.publicProviderReleaseId,
    );
    assert.equal(historical.confirmedManifestWatermark, 2n);
    assert.equal(historical.terminalReceiptSha256, "a".repeat(64));
    assert.equal(
      current.providerReferences[0]!.publicProviderReleaseId,
      alpha3.publicProviderReleaseId,
    );
    assert.equal(
      current.providerReferences[1]!.publicProviderReleaseId,
      beta1.publicProviderReleaseId,
    );
    assert.deepEqual(
      historical.publicRepackOwnership.map((owner) => ({
        platformKey: owner.platformKey,
        publicProviderReleaseId: owner.publicProviderReleaseId,
      })),
      [
        {
          platformKey: "alpha",
          publicProviderReleaseId: alpha2.publicProviderReleaseId,
        },
        {
          platformKey: "alpha",
          publicProviderReleaseId: alpha2.publicProviderReleaseId,
        },
        {
          platformKey: "beta",
          publicProviderReleaseId: beta1.publicProviderReleaseId,
        },
      ],
    );
  } finally {
    await harness.close();
  }
});
