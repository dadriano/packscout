import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REPACK_HEAT_AGGREGATION_VERSION,
  REPACK_HEAT_LARGE_HIT_MULTIPLE_BASIS_POINTS,
  REPACK_HEAT_MINIMUM_BASELINE_PULLS,
  REPACK_HEAT_MINIMUM_CURRENT_PULLS,
  REPACK_HEAT_POLICY_VERSION,
  containsProtectedPublicationField,
  deriveProductionHeatFrameId,
  extendProductionHeatSignalSetHash,
  productionHeatApplyBatchRequestSchema,
  productionHeatActiveStateReceiptSchema,
  productionHeatContentIdentity,
  productionHeatFinalizeReceiptSchema,
  productionHeatFinalizeRequestSchema,
  productionHeatFrameEnvelopeSchema,
  productionHeatManifestAlignmentSchema,
  productionHeatRefreshFrameReceiptSchema,
  productionHeatRefreshFrameRequestSchema,
  productionHeatStartReceiptSchema,
  productionHeatStartRequestSchema,
  productionPublicationRequestSigningValue,
  recomputeProductionHeatBatchHash,
  recomputeProductionHeatFrameHash,
  productionHeatTerminalReceiptSha256,
  repackHeatSignalCore,
  type ProductionHeatFrameEnvelope,
  type ProductionHeatManifestAlignment,
  type PublicRepackHeatSignal,
} from "./index.ts";

const FRAME_ID = "81000000-0000-4000-8000-000000000001";
const OTHER_FRAME_ID = "81000000-0000-4000-8000-000000000002";
const RELEASE_ID = "82000000-0000-5000-8000-000000000001";
const REPACK_ID = "83000000-0000-4000-8000-000000000001";
const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);
const HASH_3 = "3".repeat(64);
const HASH_4 = "4".repeat(64);
const FRAME_SEQUENCE = Date.parse("2026-08-15T12:00:00.000Z") / 60_000;

const MANIFEST_ALIGNMENT = Object.freeze({
  publicReleaseId: RELEASE_ID,
  manifestFingerprint: HASH_1,
  sharedConfigurationEpoch: Object.freeze({
    configurationKey: "catalog:public",
    revision: 7,
    publicChangeSequence: "41",
    configurationHash: HASH_2,
  }),
  providerReferenceSetHash: HASH_3,
}) satisfies ProductionHeatManifestAlignment;

function signal(
  calculatedAt = "2026-08-15T12:00:00.000Z",
): PublicRepackHeatSignal {
  return {
    publicRepackId: REPACK_ID,
    state: "normal",
    scoreBasisPoints: 5_000,
    signalConfidence: { scoreBasisPoints: 10_000, band: "high" },
    provenance: {
      kind: "observed",
      aggregationVersion: REPACK_HEAT_AGGREGATION_VERSION,
    },
    sourceCoverage: "complete",
    currentWindow: {
      startedAt: "2026-08-15T11:45:00.000Z",
      endedAt: "2026-08-15T12:00:00.000Z",
      pullCount: 20,
    },
    baselineWindow: {
      startedAt: "2026-08-14T11:45:00.000Z",
      endedAt: "2026-08-15T11:45:00.000Z",
      pullCount: 200,
    },
    sampleRequirements: {
      minimumCurrentPullCount: REPACK_HEAT_MINIMUM_CURRENT_PULLS,
      minimumBaselinePullCount: REPACK_HEAT_MINIMUM_BASELINE_PULLS,
    },
    components: {
      activity: {
        status: "available",
        currentPullCount: 20,
        baselinePullCount: 200,
        relativeRateDeltaBasisPoints: 6_000,
      },
      observedReturn: {
        status: "available",
        currentReturnBasisPoints: 8_000,
        baselineReturnBasisPoints: 8_000,
        rateDeltaBasisPoints: 0,
      },
      largeHitFrequency: {
        status: "available",
        currentHitCount: 0,
        baselineHitCount: 0,
        currentRateBasisPoints: 0,
        baselineRateBasisPoints: 0,
        rateDeltaBasisPoints: 0,
        thresholdMultipleBasisPoints:
          REPACK_HEAT_LARGE_HIT_MULTIPLE_BASIS_POINTS,
      },
      chaseAvailability: {
        status: "available",
        currentAvailableChaseCount: 1,
        baselineAvailableChaseCount: 1,
        change: "unchanged",
      },
      poolComposition: {
        status: "available",
        addedOutcomeCount: 0,
        removedOutcomeCount: 0,
        changeMagnitudeBasisPoints: 0,
        changed: false,
      },
    },
    drivers: [
      { code: "activity", contributionBasisPoints: 840 },
      { code: "chase_availability", contributionBasisPoints: 0 },
      { code: "large_hit_frequency", contributionBasisPoints: 0 },
      { code: "observed_return", contributionBasisPoints: 0 },
      { code: "pool_composition", contributionBasisPoints: 0 },
    ],
    limitationCodes: [],
    heatPolicyVersion: REPACK_HEAT_POLICY_VERSION,
    calculatedAt,
    expiresAt: new Date(Date.parse(calculatedAt) + 15 * 60_000).toISOString(),
  };
}

async function frame(signalSetHash: string): Promise<ProductionHeatFrameEnvelope> {
  const candidate: ProductionHeatFrameEnvelope = {
    publicHeatFrameId: FRAME_ID,
    manifestAlignment: MANIFEST_ALIGNMENT,
    frameSequence: FRAME_SEQUENCE,
    sourceWatermark: "44",
    signalSetHash,
    frameHash: "0".repeat(64),
    signalCount: 1,
    aggregationVersion: REPACK_HEAT_AGGREGATION_VERSION,
    heatPolicyVersion: REPACK_HEAT_POLICY_VERSION,
    baselineWindowStartedAt: "2026-08-14T11:45:00.000Z",
    baselineWindowEndedAt: "2026-08-15T11:45:00.000Z",
    currentWindowStartedAt: "2026-08-15T11:45:00.000Z",
    currentWindowEndedAt: "2026-08-15T12:00:00.000Z",
    calculatedAt: "2026-08-15T12:00:00.000Z",
    expiresAt: "2026-08-15T12:15:00.000Z",
  };
  return { ...candidate, frameHash: await recomputeProductionHeatFrameHash(candidate) };
}

test("Heat signal-set hashes exclude the temporal frame envelope", async () => {
  const first = signal();
  const refreshed = {
    ...first,
    currentWindow: {
      ...first.currentWindow,
      startedAt: "2026-08-15T11:46:00.000Z",
      endedAt: "2026-08-15T12:01:00.000Z",
    },
    baselineWindow: {
      ...first.baselineWindow,
      startedAt: "2026-08-14T11:46:00.000Z",
      endedAt: "2026-08-15T11:46:00.000Z",
    },
    calculatedAt: "2026-08-15T12:01:00.000Z",
    expiresAt: "2026-08-15T12:16:00.000Z",
  } satisfies PublicRepackHeatSignal;
  assert.deepEqual(repackHeatSignalCore(first), repackHeatSignalCore(refreshed));
  assert.equal(
    await recomputeProductionHeatBatchHash([first]),
    await recomputeProductionHeatBatchHash([refreshed]),
  );
});

test("Heat frame and signal-set identities reconcile deterministically", async () => {
  const record = signal();
  const batchHash = await recomputeProductionHeatBatchHash([record]);
  const signalSetHash = await extendProductionHeatSignalSetHash({
    previousHash: "0".repeat(64),
    batchIndex: 0,
    batchHash,
    recordCount: 1,
    coreByteCount: new TextEncoder().encode(
      JSON.stringify(repackHeatSignalCore(record)),
    ).byteLength,
  });
  const value = await frame(signalSetHash);
  assert.equal(productionHeatFrameEnvelopeSchema.parse(value).frameHash, value.frameHash);
  assert.notEqual(
    await recomputeProductionHeatFrameHash({ ...value, frameSequence: 2 }),
    value.frameHash,
  );
  assert.equal(
    productionHeatFrameEnvelopeSchema.safeParse({
      ...value,
      expiresAt: "2026-08-15T12:14:59.999Z",
    }).success,
    false,
  );
});

test("Heat identity binds the exact immutable manifest alignment", async () => {
  assert.deepEqual(
    productionHeatManifestAlignmentSchema.parse(MANIFEST_ALIGNMENT),
    MANIFEST_ALIGNMENT,
  );
  assert.equal(productionHeatManifestAlignmentSchema.safeParse({
    ...MANIFEST_ALIGNMENT,
    manifestGeneration: 8,
  }).success, false);
  assert.equal(productionHeatManifestAlignmentSchema.safeParse({
    catalogPublicReleaseId: RELEASE_ID,
    manifestFingerprint: HASH_1,
    sharedConfigurationEpoch: MANIFEST_ALIGNMENT.sharedConfigurationEpoch,
    providerReferenceSetHash: HASH_3,
  }).success, false);

  const contentIdentity = await productionHeatContentIdentity({
    manifestAlignment: MANIFEST_ALIGNMENT,
    signalSetHash: HASH_4,
  });
  const frameId = await deriveProductionHeatFrameId({
    manifestAlignment: MANIFEST_ALIGNMENT,
    frameSequence: FRAME_SEQUENCE,
    sourceWatermark: "44",
  });
  assert.equal(
    contentIdentity,
    "7671d7e87737f127652eb31f64bc15905998130e3883c662edc58a7852da540a",
  );
  assert.equal(frameId, "39fdfc8b-51b8-51f6-876f-43419d638381");

  const reorderedAlignment: ProductionHeatManifestAlignment = {
    providerReferenceSetHash: HASH_3,
    sharedConfigurationEpoch: {
      publicChangeSequence: "41",
      configurationHash: HASH_2,
      revision: 7,
      configurationKey: "catalog:public",
    },
    manifestFingerprint: HASH_1,
    publicReleaseId: RELEASE_ID,
  };
  assert.equal(await productionHeatContentIdentity({
    manifestAlignment: reorderedAlignment,
    signalSetHash: HASH_4,
  }), contentIdentity);
  assert.equal(await deriveProductionHeatFrameId({
    manifestAlignment: reorderedAlignment,
    frameSequence: FRAME_SEQUENCE,
    sourceWatermark: "44",
  }), frameId);

  const immutableFrame = await frame(HASH_4);
  const alignmentMutations: readonly ProductionHeatManifestAlignment[] = [
    {
      ...MANIFEST_ALIGNMENT,
      publicReleaseId: "82000000-0000-5000-8000-000000000002",
    },
    { ...MANIFEST_ALIGNMENT, manifestFingerprint: "5".repeat(64) },
    {
      ...MANIFEST_ALIGNMENT,
      sharedConfigurationEpoch: {
        ...MANIFEST_ALIGNMENT.sharedConfigurationEpoch,
        revision: 8,
      },
    },
    { ...MANIFEST_ALIGNMENT, providerReferenceSetHash: "6".repeat(64) },
  ];
  for (const manifestAlignment of alignmentMutations) {
    assert.notEqual(await productionHeatContentIdentity({
      manifestAlignment,
      signalSetHash: HASH_4,
    }), contentIdentity);
    assert.notEqual(await deriveProductionHeatFrameId({
      manifestAlignment,
      frameSequence: FRAME_SEQUENCE,
      sourceWatermark: "44",
    }), frameId);
    assert.notEqual(await recomputeProductionHeatFrameHash({
      ...immutableFrame,
      manifestAlignment,
    }), immutableFrame.frameHash);
  }
});

test("Heat reuse excludes mutable manifest source proof but preserves watermark ordering", async () => {
  const firstSourceProof = {
    manifestAlignment: MANIFEST_ALIGNMENT,
    manifestGeneration: 5,
    manifestEvaluationSequence: "19",
    manifestTerminalReceiptSha256: "7".repeat(64),
    providerReferences: ["A2", "B1"],
    repackOwnership: [REPACK_ID],
  } as const;
  const refreshedSourceProof = {
    ...firstSourceProof,
    manifestGeneration: 6,
    manifestEvaluationSequence: "20",
    manifestTerminalReceiptSha256: "8".repeat(64),
  } as const;
  const firstIdentity = await productionHeatContentIdentity({
    manifestAlignment: firstSourceProof.manifestAlignment,
    signalSetHash: HASH_4,
  });
  assert.equal(await productionHeatContentIdentity({
    manifestAlignment: refreshedSourceProof.manifestAlignment,
    signalSetHash: HASH_4,
  }), firstIdentity);
  const firstFrameId = await deriveProductionHeatFrameId({
    manifestAlignment: firstSourceProof.manifestAlignment,
    frameSequence: FRAME_SEQUENCE,
    sourceWatermark: "44",
  });
  assert.equal(await deriveProductionHeatFrameId({
    manifestAlignment: refreshedSourceProof.manifestAlignment,
    frameSequence: FRAME_SEQUENCE,
    sourceWatermark: "44",
  }), firstFrameId);
  assert.notEqual(await deriveProductionHeatFrameId({
    manifestAlignment: refreshedSourceProof.manifestAlignment,
    frameSequence: FRAME_SEQUENCE + 1,
    sourceWatermark: "45",
  }), firstFrameId);
});

test("Heat mutation requests replace legacy catalog release alignment", async () => {
  const value = await frame(HASH_4);
  const start = {
    schemaVersion: "repack_heat_publication_v1",
    operationId: "heat:start:1",
    idempotencyKey: "heat:start:1",
    publicationId: FRAME_ID,
    frame: value,
    expectedBatchCount: 1,
  } as const;
  assert.equal(productionHeatStartRequestSchema.safeParse(start).success, true);
  const legacyFrame: Record<string, unknown> = { ...value };
  delete legacyFrame.manifestAlignment;
  assert.equal(productionHeatStartRequestSchema.safeParse({
    ...start,
    frame: { ...legacyFrame, catalogPublicReleaseId: RELEASE_ID },
  }).success, false);

  const finalize = {
    schemaVersion: "repack_heat_publication_v1",
    operationId: "heat:finalize:1",
    idempotencyKey: "heat:finalize:1",
    publicationId: FRAME_ID,
    expectedActivePublicHeatFrameId: null,
    expectedManifestAlignment: MANIFEST_ALIGNMENT,
    expectedSignalSetHash: HASH_4,
    expectedFrameHash: value.frameHash,
    expectedSignalCount: 1,
    expectedBatchCount: 1,
  } as const;
  assert.equal(
    productionHeatFinalizeRequestSchema.safeParse(finalize).success,
    true,
  );
  const legacyFinalize: Record<string, unknown> = { ...finalize };
  delete legacyFinalize.expectedManifestAlignment;
  assert.equal(productionHeatFinalizeRequestSchema.safeParse({
    ...legacyFinalize,
    expectedCatalogPublicReleaseId: RELEASE_ID,
  }).success, false);
  assert.equal(productionHeatFinalizeRequestSchema.safeParse({
    ...finalize,
    expectedManifestAlignment: {
      publicReleaseId: RELEASE_ID,
      manifestFingerprint: HASH_1,
    },
  }).success, false);

  assert.equal(productionHeatRefreshFrameRequestSchema.safeParse({
    schemaVersion: "repack_heat_publication_v1",
    operationId: "heat:refresh:1",
    idempotencyKey: "heat:refresh:1",
    publicationId: FRAME_ID,
    expectedActivePublicHeatFrameId: OTHER_FRAME_ID,
    frame: value,
  }).success, true);
  assert.equal(value.sourceWatermark, "44");
});

test("Heat transport is signed on its private path and rejects protected fields", () => {
  const digest = "a".repeat(64);
  assert.equal(
    productionPublicationRequestSigningValue({
      method: "post",
      path: "/internal/repack-heat/v1/start",
      bodyDigest: digest,
      timestamp: "1786813200000",
      nonce: "nonce0000000000000001",
    }),
    `v1\nPOST\n/internal/repack-heat/v1/start\n${digest}\n1786813200000\nnonce0000000000000001`,
  );
  const request = {
    schemaVersion: "repack_heat_publication_v1",
    operationId: "apply:1",
    idempotencyKey: "apply:1",
    publicationId: FRAME_ID,
    batchIndex: 0,
    batchHash: digest,
    records: [{ ...signal(), rawPayload: { secret: "no" } }],
  };
  assert.equal(containsProtectedPublicationField(request), true);
  assert.equal(productionHeatApplyBatchRequestSchema.safeParse(request).success, false);
});

test("Heat active-state terminal identity hashes canonical receipt bytes", async () => {
  const terminalReceipt = {
    result: "activated",
    operationId: "finalize:frame",
    publicationId: FRAME_ID,
  };
  assert.equal(
    await productionHeatTerminalReceiptSha256(terminalReceipt),
    await productionHeatTerminalReceiptSha256({
      publicationId: FRAME_ID,
      operationId: "finalize:frame",
      result: "activated",
    }),
  );
  const digest = "a".repeat(64);
  assert.equal(productionHeatActiveStateReceiptSchema.safeParse({
    schemaVersion: "repack_heat_publication_v1",
    operationId: "heat-active-state",
    operationKind: "activeState",
    publicationId: FRAME_ID,
    terminalState: "observed",
    result: "active_state",
    serverTime: "2026-08-15T12:00:00.000Z",
    requestDigest: digest,
    receiptDigest: digest,
    details: {
      activePublicHeatFrameId: FRAME_ID,
      manifestAlignment: MANIFEST_ALIGNMENT,
      sourceWatermark: "44",
      frameSequence: FRAME_SEQUENCE,
      terminalReceiptSha256: digest,
    },
  }).success, true);
  assert.equal(productionHeatActiveStateReceiptSchema.safeParse({
    schemaVersion: "repack_heat_publication_v1",
    operationId: "heat-active-state",
    operationKind: "activeState",
    publicationId: FRAME_ID,
    terminalState: "observed",
    result: "active_state",
    serverTime: "2026-08-15T12:00:00.000Z",
    requestDigest: digest,
    receiptDigest: digest,
    details: {
      activePublicHeatFrameId: FRAME_ID,
      catalogPublicReleaseId: RELEASE_ID,
      sourceWatermark: "44",
      frameSequence: FRAME_SEQUENCE,
      terminalReceiptSha256: digest,
    },
  }).success, false);
});

test("Heat receipts carry and cross-bind the exact manifest alignment", () => {
  const digest = "a".repeat(64);
  const receiptBase = {
    schemaVersion: "repack_heat_publication_v1",
    publicationId: FRAME_ID,
    serverTime: "2026-08-15T12:00:00.000Z",
    requestDigest: digest,
    receiptDigest: digest,
  } as const;
  const start = {
    ...receiptBase,
    operationId: "heat:start:1",
    operationKind: "start",
    terminalState: "staging",
    result: "created",
    details: {
      manifestAlignment: MANIFEST_ALIGNMENT,
      frameHash: digest,
      signalSetHash: digest,
      sourceWatermark: "44",
      frameSequence: FRAME_SEQUENCE,
      expectedSignalCount: 1,
      expectedBatchCount: 1,
    },
  } as const;
  assert.equal(productionHeatStartReceiptSchema.safeParse(start).success, true);
  const legacyStartDetails: Record<string, unknown> = { ...start.details };
  delete legacyStartDetails.manifestAlignment;
  assert.equal(productionHeatStartReceiptSchema.safeParse({
    ...start,
    details: {
      ...legacyStartDetails,
      catalogPublicReleaseId: RELEASE_ID,
    },
  }).success, false);

  const activatedDetails = {
    manifestAlignment: MANIFEST_ALIGNMENT,
    activePublicHeatFrameId: FRAME_ID,
    previousPublicHeatFrameId: OTHER_FRAME_ID,
    frameHash: digest,
    signalSetHash: digest,
    sourceWatermark: "44",
    frameSequence: FRAME_SEQUENCE,
    signalCount: 1,
    calculatedAt: "2026-08-15T12:00:00.000Z",
    expiresAt: "2026-08-15T12:15:00.000Z",
  } as const;
  const finalize = {
    ...receiptBase,
    operationId: "heat:finalize:1",
    operationKind: "finalize",
    terminalState: "complete",
    result: "activated",
    details: activatedDetails,
  } as const;
  assert.equal(
    productionHeatFinalizeReceiptSchema.safeParse(finalize).success,
    true,
  );
  assert.equal(productionHeatFinalizeReceiptSchema.safeParse({
    ...finalize,
    publicationId: OTHER_FRAME_ID,
  }).success, false);
  assert.equal(productionHeatRefreshFrameReceiptSchema.safeParse({
    ...receiptBase,
    operationId: "heat:refresh:1",
    operationKind: "refreshFrame",
    terminalState: "complete",
    result: "refreshed",
    details: activatedDetails,
  }).success, true);

  assert.equal(productionHeatActiveStateReceiptSchema.safeParse({
    ...receiptBase,
    operationId: "heat:active:empty",
    operationKind: "activeState",
    publicationId: null,
    terminalState: "observed",
    result: "active_state",
    details: {
      activePublicHeatFrameId: null,
      manifestAlignment: null,
      sourceWatermark: null,
      frameSequence: 0,
      terminalReceiptSha256: null,
    },
  }).success, true);
});
