import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REPACK_HEAT_AGGREGATION_VERSION,
  REPACK_HEAT_LARGE_HIT_MULTIPLE_BASIS_POINTS,
  REPACK_HEAT_MINIMUM_BASELINE_PULLS,
  REPACK_HEAT_MINIMUM_CURRENT_PULLS,
  REPACK_HEAT_POLICY_VERSION,
  containsProtectedPublicationField,
  extendProductionHeatSignalSetHash,
  productionHeatApplyBatchRequestSchema,
  productionHeatActiveStateReceiptSchema,
  productionHeatFrameEnvelopeSchema,
  productionPublicationRequestSigningValue,
  recomputeProductionHeatBatchHash,
  recomputeProductionHeatFrameHash,
  productionHeatTerminalReceiptSha256,
  repackHeatSignalCore,
  type ProductionHeatFrameEnvelope,
  type PublicRepackHeatSignal,
} from "./index.ts";

const FRAME_ID = "81000000-0000-4000-8000-000000000001";
const RELEASE_ID = "82000000-0000-4000-8000-000000000001";
const REPACK_ID = "83000000-0000-4000-8000-000000000001";

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
    catalogPublicReleaseId: RELEASE_ID,
    frameSequence: Date.parse("2026-08-15T12:00:00.000Z") / 60_000,
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
      catalogPublicReleaseId: RELEASE_ID,
      sourceWatermark: "44",
      frameSequence: Date.parse("2026-08-15T12:00:00.000Z") / 60_000,
      terminalReceiptSha256: digest,
    },
  }).success, true);
});
