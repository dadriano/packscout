import { createHash } from "node:crypto";
import {
  EMPTY_PRODUCTION_HEAT_SIGNAL_SET_HASH,
  MAX_PRODUCTION_HEAT_BATCH_BYTES,
  MAX_PRODUCTION_HEAT_BATCH_COUNT,
  MAX_PRODUCTION_HEAT_BATCH_RECORDS,
  PRODUCTION_HEAT_FRAME_TTL_MILLISECONDS,
  PRODUCTION_REPACK_HEAT_PATHS,
  REPACK_HEAT_AGGREGATION_VERSION,
  REPACK_HEAT_MAXIMUM_CALCULATION_LAG_MILLISECONDS,
  REPACK_HEAT_POLICY_VERSION,
  REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
  canonicalJson,
  containsProtectedPublicationField,
  deriveProductionHeatFrameId,
  extendProductionHeatSignalSetHash,
  productionHeatApplyBatchRequestSchema,
  productionHeatBatchByteCount,
  productionHeatCoreByteCount,
  productionHeatFinalizeRequestSchema,
  productionHeatFrameEnvelopeSchema,
  productionHeatContentIdentity,
  productionHeatReceiptSchema,
  productionHeatRefreshFrameRequestSchema,
  productionHeatStartRequestSchema,
  recomputeProductionHeatBatchHash,
  recomputeProductionHeatFrameHash,
  type ProductionHeatApplyBatchRequest,
  type ProductionHeatFinalizeRequest,
  type ProductionHeatFrameEnvelope,
  type ProductionHeatManifestAlignment,
  type ProductionHeatReceipt,
  type ProductionHeatRefreshFrameRequest,
  type ProductionHeatStartRequest,
  type PublicRepackHeatSignal,
} from "@packscout/contracts";
import {
  buildNormalizedHeatFrameWindows,
} from "./normalized-heat-observation-port.ts";
import { calculateRepackHeat } from "./repack-heat-calculator.ts";
import type {
  ActiveCatalogHeatManifest,
  ActiveHeatFrameBaseline,
  HeatPromotionObservationPort,
  HeatPromotionOperation,
  HeatPromotionOperationKind,
  HeatPromotionPreparedPlan,
} from "./heat-promotion-types.ts";

export type HeatPromotionPreparationFailureCode =
  | "HEAT_CALCULATION_INVALID"
  | "HEAT_CATALOG_UNAVAILABLE"
  | "HEAT_FRAME_EXPIRED"
  | "HEAT_FRAME_SEQUENCE_INVALID"
  | "HEAT_OBSERVATION_COVERAGE_INCOMPLETE"
  | "HEAT_OPERATION_INVALID"
  | "HEAT_PROTECTED_FIELD";

export class HeatPromotionPreparationError extends Error {
  constructor(readonly code: HeatPromotionPreparationFailureCode) {
    super("Heat promotion preparation failed safely.");
    this.name = "HeatPromotionPreparationError";
  }
}

const PATH_BY_KIND = Object.freeze({
  start: PRODUCTION_REPACK_HEAT_PATHS.start,
  applyBatch: PRODUCTION_REPACK_HEAT_PATHS.applyBatch,
  finalize: PRODUCTION_REPACK_HEAT_PATHS.finalize,
  refreshFrame: PRODUCTION_REPACK_HEAT_PATHS.refreshFrame,
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function heatPromotionContentIdentity(input: Readonly<{
  manifestAlignment: ProductionHeatManifestAlignment;
  signalSetHash: string;
}>): Promise<string> {
  return productionHeatContentIdentity(input);
}

function sameManifestAlignment(
  left: ProductionHeatManifestAlignment,
  right: ProductionHeatManifestAlignment,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function schemaFor(kind: HeatPromotionOperationKind) {
  switch (kind) {
    case "start": return productionHeatStartRequestSchema;
    case "applyBatch": return productionHeatApplyBatchRequestSchema;
    case "finalize": return productionHeatFinalizeRequestSchema;
    case "refreshFrame": return productionHeatRefreshFrameRequestSchema;
  }
}

function operation(
  operationIndex: number,
  operationKind: HeatPromotionOperationKind,
  request: unknown,
): HeatPromotionOperation {
  if (containsProtectedPublicationField(request)) {
    throw new HeatPromotionPreparationError("HEAT_PROTECTED_FIELD");
  }
  const parsed = schemaFor(operationKind).safeParse(request);
  if (!parsed.success) {
    throw new HeatPromotionPreparationError("HEAT_OPERATION_INVALID");
  }
  const canonicalRequestBody = canonicalJson(parsed.data);
  const identity = parsed.data as { operationId: string; publicationId: string };
  return {
    operationIndex,
    operationId: identity.operationId,
    operationKind,
    requestPath: PATH_BY_KIND[operationKind],
    canonicalRequestBody,
    requestSha256: sha256(canonicalRequestBody),
    state: "pending",
    sendCount: 0,
    lastSentAt: null,
    acknowledgedAt: null,
    receiptBody: null,
    receiptSha256: null,
  };
}

export function validateHeatPromotionOperation(
  candidate: HeatPromotionOperation,
): void {
  let value: unknown;
  try {
    value = JSON.parse(candidate.canonicalRequestBody) as unknown;
  } catch {
    throw new HeatPromotionPreparationError("HEAT_OPERATION_INVALID");
  }
  if (containsProtectedPublicationField(value)) {
    throw new HeatPromotionPreparationError("HEAT_PROTECTED_FIELD");
  }
  const parsed = schemaFor(candidate.operationKind).safeParse(value);
  if (
    !parsed.success ||
    canonicalJson(parsed.data) !== candidate.canonicalRequestBody ||
    sha256(candidate.canonicalRequestBody) !== candidate.requestSha256 ||
    candidate.requestPath !== PATH_BY_KIND[candidate.operationKind]
  ) {
    throw new HeatPromotionPreparationError("HEAT_OPERATION_INVALID");
  }
  const identity = parsed.data as { operationId: string; publicationId: string };
  if (identity.operationId !== candidate.operationId) {
    throw new HeatPromotionPreparationError("HEAT_OPERATION_INVALID");
  }
}

type HeatBatch = Readonly<{
  batchIndex: number;
  batchHash: string;
  coreByteCount: number;
  records: readonly PublicRepackHeatSignal[];
}>;

async function buildBatches(
  signals: readonly PublicRepackHeatSignal[],
): Promise<Readonly<{
  batches: readonly HeatBatch[];
  signalSetHash: string;
}>> {
  const batches: HeatBatch[] = [];
  let current: PublicRepackHeatSignal[] = [];
  const flush = async (): Promise<void> => {
    if (current.length === 0) return;
    if (batches.length >= MAX_PRODUCTION_HEAT_BATCH_COUNT) {
      throw new HeatPromotionPreparationError("HEAT_OPERATION_INVALID");
    }
    const records = Object.freeze([...current]);
    batches.push(Object.freeze({
      batchIndex: batches.length,
      batchHash: await recomputeProductionHeatBatchHash(records),
      coreByteCount: productionHeatCoreByteCount(records),
      records,
    }));
    current = [];
  };
  for (const signal of signals) {
    const candidate = [...current, signal];
    if (
      candidate.length > MAX_PRODUCTION_HEAT_BATCH_RECORDS ||
      productionHeatBatchByteCount(candidate) > MAX_PRODUCTION_HEAT_BATCH_BYTES
    ) {
      await flush();
    }
    current.push(signal);
    if (productionHeatBatchByteCount(current) > MAX_PRODUCTION_HEAT_BATCH_BYTES) {
      throw new HeatPromotionPreparationError("HEAT_OPERATION_INVALID");
    }
  }
  await flush();
  let signalSetHash = EMPTY_PRODUCTION_HEAT_SIGNAL_SET_HASH;
  for (const batch of batches) {
    signalSetHash = await extendProductionHeatSignalSetHash({
      previousHash: signalSetHash,
      batchIndex: batch.batchIndex,
      batchHash: batch.batchHash,
      recordCount: batch.records.length,
      coreByteCount: batch.coreByteCount,
    });
  }
  return { batches: Object.freeze(batches), signalSetHash };
}

function positiveFrameSequence(value: bigint): number {
  const frameSequence = Number(value);
  if (
    value <= 0n ||
    !Number.isSafeInteger(frameSequence) ||
    BigInt(frameSequence) !== value
  ) {
    throw new HeatPromotionPreparationError("HEAT_FRAME_SEQUENCE_INVALID");
  }
  return frameSequence;
}

function requireCurrentCalculation(frameEndedAt: Date, calculatedAt: Date): void {
  if (
    !Number.isFinite(frameEndedAt.getTime()) ||
    frameEndedAt.getTime() % 60_000 !== 0 ||
    !Number.isFinite(calculatedAt.getTime()) ||
    calculatedAt < frameEndedAt ||
    calculatedAt.getTime() - frameEndedAt.getTime() >
      REPACK_HEAT_MAXIMUM_CALCULATION_LAG_MILLISECONDS
  ) {
    throw new HeatPromotionPreparationError("HEAT_FRAME_EXPIRED");
  }
}

export async function prepareHeatPromotion(input: Readonly<{
  targetFrameSequence: bigint;
  frameEndedAt: Date;
  calculatedAt: Date;
  sourceWatermark: bigint;
  catalog: ActiveCatalogHeatManifest;
  baseline: ActiveHeatFrameBaseline | null;
  observations: HeatPromotionObservationPort;
  canReuseSignalSet(input: Readonly<{
    manifestAlignment: ProductionHeatManifestAlignment;
    signalSetHash: string;
    contentIdentity: string;
    signalCount: number;
    reusableAt: Date;
  }>): Promise<boolean>;
}>): Promise<HeatPromotionPreparedPlan> {
  const frameSequence = positiveFrameSequence(input.targetFrameSequence);
  requireCurrentCalculation(input.frameEndedAt, input.calculatedAt);
  if (
    input.targetFrameSequence !==
      BigInt(input.frameEndedAt.getTime() / 60_000) ||
    input.sourceWatermark <= 0n ||
    input.sourceWatermark > 9_223_372_036_854_775_807n
  ) {
    throw new HeatPromotionPreparationError("HEAT_FRAME_SEQUENCE_INVALID");
  }
  if (input.catalog.publicRepackIds.length === 0) {
    throw new HeatPromotionPreparationError("HEAT_CATALOG_UNAVAILABLE");
  }
  const frameEndedAt = input.frameEndedAt.toISOString();
  const windows = buildNormalizedHeatFrameWindows(frameEndedAt);
  const source = await input.observations.readFrame({
    publicRepackIds: input.catalog.publicRepackIds,
    frameEndedAt,
    maximumSettledCausalSequence: input.sourceWatermark,
  });
  if (!source.sourceCoverageComplete || source.truncated) {
    throw new HeatPromotionPreparationError(
      "HEAT_OBSERVATION_COVERAGE_INCOMPLETE",
    );
  }
  const calculatedAt = input.calculatedAt.toISOString();
  const expiresAt = new Date(
    input.calculatedAt.getTime() + PRODUCTION_HEAT_FRAME_TTL_MILLISECONDS,
  )
    .toISOString();
  let signals: readonly PublicRepackHeatSignal[];
  try {
    signals = calculateRepackHeat({
      publicRepackIds: input.catalog.publicRepackIds,
      observations: source.observations,
      currentWindow: windows.currentWindow,
      baselineWindow: windows.baselineWindow,
      provenance: {
        kind: "observed",
        aggregationVersion: REPACK_HEAT_AGGREGATION_VERSION,
      },
      heatPolicyVersion: REPACK_HEAT_POLICY_VERSION,
      sourceCoverageComplete: true,
      calculatedAt,
      expiresAt,
    });
  } catch {
    throw new HeatPromotionPreparationError("HEAT_CALCULATION_INVALID");
  }
  if (
    signals.length !== input.catalog.publicRepackIds.length ||
    signals.some((signal, index) =>
      signal.publicRepackId !== input.catalog.publicRepackIds[index])
  ) {
    throw new HeatPromotionPreparationError("HEAT_CALCULATION_INVALID");
  }
  const { batches, signalSetHash } = await buildBatches(signals);
  const contentIdentity = await heatPromotionContentIdentity({
    manifestAlignment: input.catalog.manifestAlignment,
    signalSetHash,
  });
  const publicHeatFrameId = await deriveProductionHeatFrameId({
    manifestAlignment: input.catalog.manifestAlignment,
    frameSequence,
    sourceWatermark: input.sourceWatermark.toString(),
  });
  const frameWithoutHash: ProductionHeatFrameEnvelope = {
    publicHeatFrameId,
    manifestAlignment: input.catalog.manifestAlignment,
    frameSequence,
    sourceWatermark: input.sourceWatermark.toString(),
    signalSetHash,
    frameHash: "0".repeat(64),
    signalCount: signals.length,
    aggregationVersion: REPACK_HEAT_AGGREGATION_VERSION,
    heatPolicyVersion: REPACK_HEAT_POLICY_VERSION,
    baselineWindowStartedAt: windows.baselineWindow.startAt,
    baselineWindowEndedAt: windows.baselineWindow.endAt,
    currentWindowStartedAt: windows.currentWindow.startAt,
    currentWindowEndedAt: windows.currentWindow.endAt,
    calculatedAt,
    expiresAt,
  };
  const frame = productionHeatFrameEnvelopeSchema.parse({
    ...frameWithoutHash,
    frameHash: await recomputeProductionHeatFrameHash(frameWithoutHash),
  });
  const reusable = input.baseline !== null &&
    ((sameManifestAlignment(
      input.baseline.manifestAlignment,
      input.catalog.manifestAlignment,
    ) && input.baseline.signalSetHash === signalSetHash &&
      input.baseline.signalCount === signals.length) ||
      await input.canReuseSignalSet({
        manifestAlignment: input.catalog.manifestAlignment,
        signalSetHash,
        contentIdentity,
        signalCount: signals.length,
        reusableAt: input.calculatedAt,
      }));
  const operations: HeatPromotionOperation[] = [];
  if (reusable) {
    const request: ProductionHeatRefreshFrameRequest = {
      schemaVersion: REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
      operationId: `heat:refresh:${publicHeatFrameId}`,
      idempotencyKey: `heat:refresh:${publicHeatFrameId}`,
      publicationId: publicHeatFrameId,
      expectedActivePublicHeatFrameId: input.baseline!.publicHeatFrameId,
      frame,
    };
    operations.push(operation(0, "refreshFrame", request));
  } else {
    const start: ProductionHeatStartRequest = {
      schemaVersion: REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
      operationId: `heat:start:${publicHeatFrameId}`,
      idempotencyKey: `heat:start:${publicHeatFrameId}`,
      publicationId: publicHeatFrameId,
      frame,
      expectedBatchCount: batches.length,
    };
    operations.push(operation(0, "start", start));
    for (const batch of batches) {
      const request: ProductionHeatApplyBatchRequest = {
        schemaVersion: REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
        operationId: `heat:batch:${publicHeatFrameId}:${batch.batchIndex}`,
        idempotencyKey: `heat:batch:${publicHeatFrameId}:${batch.batchIndex}`,
        publicationId: publicHeatFrameId,
        batchIndex: batch.batchIndex,
        batchHash: batch.batchHash,
        records: [...batch.records],
      };
      operations.push(operation(operations.length, "applyBatch", request));
    }
    const finalize: ProductionHeatFinalizeRequest = {
      schemaVersion: REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
      operationId: `heat:finalize:${publicHeatFrameId}`,
      idempotencyKey: `heat:finalize:${publicHeatFrameId}`,
      publicationId: publicHeatFrameId,
      expectedActivePublicHeatFrameId:
        input.baseline?.publicHeatFrameId ?? null,
      expectedManifestAlignment: input.catalog.manifestAlignment,
      expectedSignalSetHash: signalSetHash,
      expectedFrameHash: frame.frameHash,
      expectedSignalCount: signals.length,
      expectedBatchCount: batches.length,
    };
    operations.push(operation(operations.length, "finalize", finalize));
  }
  return Object.freeze({
    classification: reusable ? "refresh_unchanged" : "publish",
    publicHeatFrameId,
    targetFrameSequence: input.targetFrameSequence,
    manifestAlignment: input.catalog.manifestAlignment,
    sourceWatermark: input.sourceWatermark,
    signalSetHash,
    contentIdentity,
    frameHash: frame.frameHash,
    signalCount: signals.length,
    frame,
    signals: Object.freeze([...signals]),
    operations: Object.freeze(operations),
  });
}

export function validateHeatPromotionReceipt(
  receiptInput: unknown,
  expected: Readonly<{
    operation: HeatPromotionOperation;
    checkRequestDetails?: boolean;
  }>,
): ProductionHeatReceipt {
  const receipt = productionHeatReceiptSchema.parse(receiptInput);
  const operation = expected.operation;
  if (
    receipt.operationId !== operation.operationId ||
    receipt.publicationId !== JSON.parse(operation.canonicalRequestBody).publicationId ||
    receipt.requestDigest !== operation.requestSha256 ||
    receipt.operationKind !== operation.operationKind
  ) {
    throw new HeatPromotionPreparationError("HEAT_OPERATION_INVALID");
  }
  if (expected.checkRequestDetails === false) return receipt;
  const request = schemaFor(operation.operationKind).parse(
    JSON.parse(operation.canonicalRequestBody) as unknown,
  );
  if (operation.operationKind === "start") {
    const value = request as ProductionHeatStartRequest;
    if (
      receipt.operationKind !== "start" ||
      !sameManifestAlignment(
        receipt.details.manifestAlignment,
        value.frame.manifestAlignment,
      ) ||
      receipt.details.frameHash !== value.frame.frameHash ||
      receipt.details.signalSetHash !== value.frame.signalSetHash ||
      receipt.details.sourceWatermark !== value.frame.sourceWatermark ||
      receipt.details.frameSequence !== value.frame.frameSequence ||
      receipt.details.expectedSignalCount !== value.frame.signalCount ||
      receipt.details.expectedBatchCount !== value.expectedBatchCount
    ) throw new HeatPromotionPreparationError("HEAT_OPERATION_INVALID");
  } else if (operation.operationKind === "applyBatch") {
    const value = request as ProductionHeatApplyBatchRequest;
    if (
      receipt.operationKind !== "applyBatch" ||
      receipt.details.batchIndex !== value.batchIndex ||
      receipt.details.batchHash !== value.batchHash ||
      receipt.details.recordCount !== value.records.length ||
      receipt.details.byteCount !== productionHeatBatchByteCount(value.records) ||
      receipt.details.coreByteCount !== productionHeatCoreByteCount(value.records)
    ) throw new HeatPromotionPreparationError("HEAT_OPERATION_INVALID");
  } else if (operation.operationKind === "finalize") {
    const value = request as ProductionHeatFinalizeRequest;
    if (
      receipt.operationKind !== "finalize" ||
      !sameManifestAlignment(
        receipt.details.manifestAlignment,
        value.expectedManifestAlignment,
      ) ||
      receipt.details.activePublicHeatFrameId !== value.publicationId ||
      receipt.details.previousPublicHeatFrameId !==
        value.expectedActivePublicHeatFrameId ||
      receipt.details.frameHash !== value.expectedFrameHash ||
      receipt.details.signalSetHash !== value.expectedSignalSetHash ||
      receipt.details.signalCount !== value.expectedSignalCount
    ) throw new HeatPromotionPreparationError("HEAT_OPERATION_INVALID");
  } else {
    const value = request as ProductionHeatRefreshFrameRequest;
    if (
      receipt.operationKind !== "refreshFrame" ||
      !sameManifestAlignment(
        receipt.details.manifestAlignment,
        value.frame.manifestAlignment,
      ) ||
      receipt.details.activePublicHeatFrameId !== value.publicationId ||
      receipt.details.previousPublicHeatFrameId !==
        value.expectedActivePublicHeatFrameId ||
      receipt.details.frameHash !== value.frame.frameHash ||
      receipt.details.signalSetHash !== value.frame.signalSetHash ||
      receipt.details.sourceWatermark !== value.frame.sourceWatermark ||
      receipt.details.frameSequence !== value.frame.frameSequence ||
      receipt.details.signalCount !== value.frame.signalCount
    ) throw new HeatPromotionPreparationError("HEAT_OPERATION_INVALID");
  }
  return receipt;
}

type HeatBatchProgress = Readonly<{
  acceptedSignalCount: number;
  signalSetProgressHash: string;
}>;

type ValidatedHeatOperationSet = Readonly<{
  frame: ProductionHeatFrameEnvelope;
  expectedPreviousPublicHeatFrameId: string | null;
  publicRepackIds: readonly string[] | null;
  progressByOperationId: ReadonlyMap<string, HeatBatchProgress>;
}>;

const validatedOperationSets = new WeakMap<
  readonly HeatPromotionOperation[],
  Promise<ValidatedHeatOperationSet>
>();

async function buildValidatedHeatOperationSet(
  operations: readonly HeatPromotionOperation[],
): Promise<ValidatedHeatOperationSet> {
  const first = operations[0];
  const terminal = operations.at(-1);
  if (!first || !terminal) {
    throw new HeatPromotionPreparationError("HEAT_OPERATION_INVALID");
  }
  if (first.operationKind === "refreshFrame") {
    if (operations.length !== 1) {
      throw new HeatPromotionPreparationError("HEAT_OPERATION_INVALID");
    }
    const refresh = productionHeatRefreshFrameRequestSchema.parse(
      JSON.parse(first.canonicalRequestBody) as unknown,
    );
    if (
      refresh.frame.frameHash !==
        await recomputeProductionHeatFrameHash(refresh.frame)
    ) throw new HeatPromotionPreparationError("HEAT_OPERATION_INVALID");
    return {
      frame: refresh.frame,
      expectedPreviousPublicHeatFrameId:
        refresh.expectedActivePublicHeatFrameId,
      publicRepackIds: null,
      progressByOperationId: new Map(),
    };
  }
  if (first.operationKind !== "start" || terminal.operationKind !== "finalize") {
    throw new HeatPromotionPreparationError("HEAT_OPERATION_INVALID");
  }
  const start = productionHeatStartRequestSchema.parse(
    JSON.parse(first.canonicalRequestBody) as unknown,
  );
  const finalize = productionHeatFinalizeRequestSchema.parse(
    JSON.parse(terminal.canonicalRequestBody) as unknown,
  );
  const batchOperations = operations.slice(1, -1);
  if (
    start.expectedBatchCount !== batchOperations.length ||
    finalize.expectedBatchCount !== batchOperations.length ||
    !sameManifestAlignment(
      finalize.expectedManifestAlignment,
      start.frame.manifestAlignment,
    ) ||
    finalize.expectedFrameHash !== start.frame.frameHash ||
    finalize.expectedSignalSetHash !== start.frame.signalSetHash ||
    finalize.expectedSignalCount !== start.frame.signalCount ||
    start.frame.frameHash !== await recomputeProductionHeatFrameHash(start.frame)
  ) throw new HeatPromotionPreparationError("HEAT_OPERATION_INVALID");
  let acceptedSignalCount = 0;
  let signalSetProgressHash = EMPTY_PRODUCTION_HEAT_SIGNAL_SET_HASH;
  let previousPublicRepackId: string | null = null;
  const publicRepackIds: string[] = [];
  const progressByOperationId = new Map<string, HeatBatchProgress>();
  for (const [batchIndex, operation] of batchOperations.entries()) {
    if (operation.operationKind !== "applyBatch") {
      throw new HeatPromotionPreparationError("HEAT_OPERATION_INVALID");
    }
    const request = productionHeatApplyBatchRequestSchema.parse(
      JSON.parse(operation.canonicalRequestBody) as unknown,
    );
    if (
      request.publicationId !== start.publicationId ||
      request.batchIndex !== batchIndex ||
      request.batchHash !==
        await recomputeProductionHeatBatchHash(request.records) ||
      productionHeatBatchByteCount(request.records) >
        MAX_PRODUCTION_HEAT_BATCH_BYTES
    ) throw new HeatPromotionPreparationError("HEAT_OPERATION_INVALID");
    for (const { publicRepackId } of request.records) {
      if (
        previousPublicRepackId !== null &&
        publicRepackId <= previousPublicRepackId
      ) throw new HeatPromotionPreparationError("HEAT_OPERATION_INVALID");
      previousPublicRepackId = publicRepackId;
      publicRepackIds.push(publicRepackId);
    }
    const coreByteCount = productionHeatCoreByteCount(request.records);
    acceptedSignalCount += request.records.length;
    signalSetProgressHash = await extendProductionHeatSignalSetHash({
      previousHash: signalSetProgressHash,
      batchIndex,
      batchHash: request.batchHash,
      recordCount: request.records.length,
      coreByteCount,
    });
    progressByOperationId.set(operation.operationId, {
      acceptedSignalCount,
      signalSetProgressHash,
    });
  }
  if (
    acceptedSignalCount !== start.frame.signalCount ||
    signalSetProgressHash !== start.frame.signalSetHash
  ) throw new HeatPromotionPreparationError("HEAT_OPERATION_INVALID");
  return {
    frame: start.frame,
    expectedPreviousPublicHeatFrameId:
      finalize.expectedActivePublicHeatFrameId,
    publicRepackIds: Object.freeze(publicRepackIds),
    progressByOperationId,
  };
}

export function validateHeatPromotionOperationSet(
  operations: readonly HeatPromotionOperation[],
): Promise<ValidatedHeatOperationSet> {
  let validation = validatedOperationSets.get(operations);
  if (validation === undefined) {
    validation = buildValidatedHeatOperationSet(operations);
    validatedOperationSets.set(operations, validation);
  }
  return validation;
}

export async function validateHeatBatchProgressReceipt(
  receipt: ProductionHeatReceipt,
  operation: HeatPromotionOperation,
  operations: readonly HeatPromotionOperation[],
): Promise<void> {
  if (operation.operationKind !== "applyBatch") return;
  if (receipt.operationKind !== "applyBatch") {
    throw new HeatPromotionPreparationError("HEAT_OPERATION_INVALID");
  }
  const expected = (await validateHeatPromotionOperationSet(operations))
    .progressByOperationId.get(operation.operationId);
  if (
    expected === undefined ||
    receipt.details.acceptedSignalCount !== expected.acceptedSignalCount ||
    receipt.details.signalSetProgressHash !== expected.signalSetProgressHash
  ) throw new HeatPromotionPreparationError("HEAT_OPERATION_INVALID");
}

export function validateHeatTerminalReceipt(
  receiptInput: unknown,
  operations: readonly HeatPromotionOperation[],
): ProductionHeatReceipt {
  const terminal = operations.at(-1);
  const first = operations[0];
  if (!terminal || !first) {
    throw new HeatPromotionPreparationError("HEAT_OPERATION_INVALID");
  }
  const receipt = validateHeatPromotionReceipt(receiptInput, {
    operation: terminal,
  });
  const frameRequest = first.operationKind === "start"
    ? productionHeatStartRequestSchema.parse(
        JSON.parse(first.canonicalRequestBody) as unknown,
      )
    : first.operationKind === "refreshFrame"
      ? productionHeatRefreshFrameRequestSchema.parse(
          JSON.parse(first.canonicalRequestBody) as unknown,
        )
      : null;
  if (
    frameRequest === null ||
    !["finalize", "refreshFrame"].includes(receipt.operationKind)
  ) throw new HeatPromotionPreparationError("HEAT_OPERATION_INVALID");
  const details = receipt.details as {
    manifestAlignment: ProductionHeatManifestAlignment;
    activePublicHeatFrameId: string;
    previousPublicHeatFrameId: string | null;
    frameHash: string;
    signalSetHash: string;
    sourceWatermark: string;
    frameSequence: number;
    signalCount: number;
    calculatedAt: string;
    expiresAt: string;
  };
  const expectedPrevious = terminal.operationKind === "finalize"
    ? productionHeatFinalizeRequestSchema.parse(
        JSON.parse(terminal.canonicalRequestBody) as unknown,
      ).expectedActivePublicHeatFrameId
    : productionHeatRefreshFrameRequestSchema.parse(
        JSON.parse(terminal.canonicalRequestBody) as unknown,
      ).expectedActivePublicHeatFrameId;
  const frame = frameRequest.frame;
  if (
    !sameManifestAlignment(details.manifestAlignment, frame.manifestAlignment) ||
    details.activePublicHeatFrameId !== frame.publicHeatFrameId ||
    details.previousPublicHeatFrameId !== expectedPrevious ||
    details.frameHash !== frame.frameHash ||
    details.signalSetHash !== frame.signalSetHash ||
    details.sourceWatermark !== frame.sourceWatermark ||
    details.frameSequence !== frame.frameSequence ||
    details.signalCount !== frame.signalCount ||
    details.calculatedAt !== frame.calculatedAt ||
    details.expiresAt !== frame.expiresAt
  ) throw new HeatPromotionPreparationError("HEAT_OPERATION_INVALID");
  return receipt;
}
