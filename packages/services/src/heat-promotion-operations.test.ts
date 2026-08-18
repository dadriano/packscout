import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  MAX_PRODUCTION_HEAT_BATCH_BYTES,
  MAX_PRODUCTION_HEAT_BATCH_COUNT,
  MAX_PRODUCTION_HEAT_BATCH_RECORDS,
  MAX_PRODUCTION_HTTP_BODY_BYTES,
  MAX_PUBLIC_REPACKS_PER_RELEASE,
  canonicalJson,
  containsProtectedPublicationField,
  productionHeatApplyBatchRequestSchema,
  productionHeatBatchByteCount,
} from "@packscout/contracts";
import {
  HeatPromotionPreparationError,
  prepareHeatPromotion,
  validateHeatPromotionOperation,
} from "./heat-promotion-operations.ts";
import type {
  ActiveCatalogHeatManifest,
  ActiveHeatFrameBaseline,
  HeatPromotionObservationPort,
} from "./heat-promotion-types.ts";

const releaseId = "82000000-0000-5000-8000-000000000001";
const repackA = "83000000-0000-5000-8000-000000000001";
const repackB = "83000000-0000-5000-8000-000000000002";
const frameEndedAt = new Date("2026-08-15T12:00:00.000Z");
const calculatedAt = new Date("2026-08-15T12:00:01.000Z");
const targetFrameSequence = BigInt(frameEndedAt.getTime() / 60_000);

const manifestAlignment = Object.freeze({
  publicReleaseId: releaseId,
  manifestFingerprint: "1".repeat(64),
  sharedConfigurationEpoch: Object.freeze({
    configurationKey: "catalog-v1",
    revision: 1,
    publicChangeSequence: "20",
    configurationHash: "2".repeat(64),
  }),
  providerReferenceSetHash: "3".repeat(64),
});

const catalog: ActiveCatalogHeatManifest = {
  manifestAlignment,
  providerReferences: [],
  publicRepackOwnership: [repackA, repackB].map((publicRepackId) => ({
    publicRepackId,
    platformKey: "alpha",
    publicProviderReleaseId:
      "84000000-0000-5000-8000-000000000001",
    providerReleaseFingerprint: "4".repeat(64),
  })),
  publicRepackIds: [repackA, repackB],
  confirmedManifestWatermark: 40n,
  terminalReceiptSha256: "a".repeat(64),
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function observationPort(input: {
  coverage?: boolean;
  truncated?: boolean;
  onRead?: (value: Parameters<HeatPromotionObservationPort["readFrame"]>[0]) => void;
} = {}): HeatPromotionObservationPort {
  return {
    async readFrame(value) {
      input.onRead?.(value);
      return {
        observations: [],
        sourceCoverageComplete: input.coverage ?? true,
        truncated: input.truncated ?? false,
      };
    },
  };
}

function prepare(overrides: Partial<Parameters<typeof prepareHeatPromotion>[0]> = {}) {
  return prepareHeatPromotion({
    targetFrameSequence,
    frameEndedAt,
    calculatedAt,
    sourceWatermark: 44n,
    catalog,
    baseline: null,
    observations: observationPort(),
    async canReuseSignalSet() { return false; },
    ...overrides,
  });
}

test("one deterministic frame reads only active public IDs through settlement", async () => {
  let read: Parameters<HeatPromotionObservationPort["readFrame"]>[0] | null = null;
  const first = await prepare({
    observations: observationPort({ onRead(value) { read = value; } }),
  });
  const second = await prepare();
  assert.deepEqual(read, {
    publicRepackIds: [repackA, repackB],
    frameEndedAt: frameEndedAt.toISOString(),
    maximumSettledCausalSequence: 44n,
  });
  assert.equal(first.classification, "publish");
  assert.equal(first.signals.length, 2);
  assert.deepEqual(first.signals.map(({ publicRepackId }) => publicRepackId), [
    repackA,
    repackB,
  ]);
  assert.equal(first.frame.sourceWatermark, "44");
  assert.deepEqual(first.frame.manifestAlignment, manifestAlignment);
  assert.equal(first.frame.currentWindowEndedAt, frameEndedAt.toISOString());
  assert.equal(first.frame.expiresAt, "2026-08-15T12:15:01.000Z");
  assert.deepEqual(second, first);
});

test("coverage, catalog ordering, and minute identity fail closed", async () => {
  await assert.rejects(
    prepare({ observations: observationPort({ coverage: false }) }),
    (error: unknown) => error instanceof HeatPromotionPreparationError &&
      error.code === "HEAT_OBSERVATION_COVERAGE_INCOMPLETE",
  );
  await assert.rejects(
    prepare({ targetFrameSequence: targetFrameSequence + 1n }),
    (error: unknown) => error instanceof HeatPromotionPreparationError &&
      error.code === "HEAT_FRAME_SEQUENCE_INVALID",
  );
});

test("publication operation validation refuses protected raw fields", async () => {
  const plan = await prepare();
  const batch = plan.operations.find(({ operationKind }) =>
    operationKind === "applyBatch");
  assert.ok(batch);
  const body = JSON.parse(batch.canonicalRequestBody) as {
    records: Array<Record<string, unknown>>;
  };
  body.records[0] = { ...body.records[0], rawPayload: { secret: "never" } };
  assert.equal(containsProtectedPublicationField(body), true);
  const canonicalRequestBody = canonicalJson(body);
  assert.throws(
    () => validateHeatPromotionOperation({
      ...batch,
      canonicalRequestBody,
      requestSha256: sha256(canonicalRequestBody),
    }),
    (error: unknown) => error instanceof HeatPromotionPreparationError &&
      error.code === "HEAT_PROTECTED_FIELD",
  );
});

test("quiet minutes refresh one frame per boundary without rewriting signals", async () => {
  let baseline: ActiveHeatFrameBaseline | null = null;
  const frameIds = new Set<string>();
  for (let minute = 0; minute < 16; minute += 1) {
    const endedAt = new Date(frameEndedAt.getTime() + minute * 60_000);
    const plan = await prepare({
      targetFrameSequence: BigInt(endedAt.getTime() / 60_000),
      frameEndedAt: endedAt,
      calculatedAt: new Date(endedAt.getTime() + 1_000),
      baseline,
    });
    assert.equal(plan.classification, minute === 0 ? "publish" : "refresh_unchanged");
    assert.equal(plan.operations.length, minute === 0 ? 3 : 1);
    assert.equal(plan.operations.at(-1)?.operationKind,
      minute === 0 ? "finalize" : "refreshFrame");
    assert.equal(frameIds.has(plan.publicHeatFrameId), false);
    frameIds.add(plan.publicHeatFrameId);
    baseline = {
      publicHeatFrameId: plan.publicHeatFrameId,
      manifestAlignment: plan.manifestAlignment,
      frameSequence: Number(plan.targetFrameSequence),
      sourceWatermark: plan.sourceWatermark,
      signalSetHash: plan.signalSetHash,
      frameHash: plan.frameHash,
      signalCount: plan.signalCount,
      terminalReceiptSha256: "b".repeat(64),
    };
  }
  assert.equal(frameIds.size, 16);
});

test("A to B to A uses a retained release-scoped set without restaging", async () => {
  const currentB: ActiveHeatFrameBaseline = {
    publicHeatFrameId: "84000000-0000-4000-8000-000000000001",
    manifestAlignment,
    frameSequence: Number(targetFrameSequence - 1n),
    sourceWatermark: 43n,
    signalSetHash: "c".repeat(64),
    frameHash: "d".repeat(64),
    signalCount: 2,
    terminalReceiptSha256: "e".repeat(64),
  };
  let lookup: unknown = null;
  const plan = await prepare({
    baseline: currentB,
    async canReuseSignalSet(input) {
      lookup = input;
      return true;
    },
  });
  assert.equal(plan.classification, "refresh_unchanged");
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0]?.operationKind, "refreshFrame");
  assert.deepEqual(lookup, {
    manifestAlignment,
    signalSetHash: plan.signalSetHash,
    contentIdentity: plan.contentIdentity,
    signalCount: plan.signalCount,
    reusableAt: calculatedAt,
  });
});

test("a first-time manifest alignment stages its own identical signal set", async () => {
  const baseline: ActiveHeatFrameBaseline = {
    publicHeatFrameId: "84000000-0000-4000-8000-000000000002",
    manifestAlignment: {
      ...manifestAlignment,
      providerReferenceSetHash: "5".repeat(64),
    },
    frameSequence: Number(targetFrameSequence - 1n),
    sourceWatermark: 43n,
    signalSetHash: "c".repeat(64),
    frameHash: "d".repeat(64),
    signalCount: 2,
    terminalReceiptSha256: "e".repeat(64),
  };
  let reuseChecked = false;
  const plan = await prepare({
    baseline,
    async canReuseSignalSet() {
      reuseChecked = true;
      return false;
    },
  });
  assert.equal(plan.classification, "publish");
  assert.equal(reuseChecked, true);
  assert.equal(plan.operations.at(-1)?.operationKind, "finalize");
});

test("a manifest rollback reactivates its retained signal set", async () => {
  const baseline: ActiveHeatFrameBaseline = {
    publicHeatFrameId: "84000000-0000-4000-8000-000000000003",
    manifestAlignment: {
      ...manifestAlignment,
      publicReleaseId: "82000000-0000-5000-8000-000000000002",
      manifestFingerprint: "5".repeat(64),
      providerReferenceSetHash: "6".repeat(64),
    },
    frameSequence: Number(targetFrameSequence - 1n),
    sourceWatermark: 43n,
    signalSetHash: "c".repeat(64),
    frameHash: "d".repeat(64),
    signalCount: 2,
    terminalReceiptSha256: "e".repeat(64),
  };
  let lookup: unknown = null;
  const plan = await prepare({
    baseline,
    async canReuseSignalSet(input) {
      lookup = input;
      return true;
    },
  });
  assert.equal(plan.classification, "refresh_unchanged");
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0]?.operationKind, "refreshFrame");
  assert.deepEqual(lookup, {
    manifestAlignment,
    signalSetHash: plan.signalSetHash,
    contentIdentity: plan.contentIdentity,
    signalCount: plan.signalCount,
    reusableAt: calculatedAt,
  });
});

test("maximum release volume remains inside every Heat publication bound", async (t) => {
  const publicRepackIds = Array.from(
    { length: MAX_PUBLIC_REPACKS_PER_RELEASE },
    (_value, index) =>
      `83000000-0000-5000-8000-${String(index + 1).padStart(12, "0")}`,
  );
  const startedAt = performance.now();
  const plan = await prepare({
    catalog: { ...catalog, publicRepackIds },
  });
  const elapsedMilliseconds = performance.now() - startedAt;
  const batches = plan.operations
    .filter(({ operationKind }) => operationKind === "applyBatch")
    .map(({ canonicalRequestBody }) => productionHeatApplyBatchRequestSchema
      .parse(JSON.parse(canonicalRequestBody) as unknown));
  assert.equal(plan.signalCount, MAX_PUBLIC_REPACKS_PER_RELEASE);
  assert.equal(plan.signals.length, MAX_PUBLIC_REPACKS_PER_RELEASE);
  assert.equal(plan.frame.signalSetHash, plan.signalSetHash);
  for (const operation of plan.operations) {
    assert.ok(
      Buffer.byteLength(operation.canonicalRequestBody, "utf8") <=
        MAX_PRODUCTION_HTTP_BODY_BYTES,
    );
  }
  assert.ok(batches.length > 0);
  assert.ok(batches.length <= MAX_PRODUCTION_HEAT_BATCH_COUNT);
  assert.equal(
    batches.reduce((count, batch) => count + batch.records.length, 0),
    MAX_PUBLIC_REPACKS_PER_RELEASE,
  );
  for (const batch of batches) {
    assert.ok(batch.records.length <= MAX_PRODUCTION_HEAT_BATCH_RECORDS);
    assert.ok(
      productionHeatBatchByteCount(batch.records) <=
        MAX_PRODUCTION_HEAT_BATCH_BYTES,
    );
  }
  assert.ok(elapsedMilliseconds < 60_000);
  t.diagnostic(
    `local 8k preparation evidence: ${elapsedMilliseconds.toFixed(1)}ms, ` +
      `${batches.length} batches (not a live p95 measurement)`,
  );
});
