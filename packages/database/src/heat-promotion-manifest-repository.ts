import { createHash } from "node:crypto";
import {
  EMPTY_PRODUCTION_HEAT_SIGNAL_SET_HASH,
  MAX_PUBLIC_REPACKS_PER_RELEASE,
  PRODUCTION_HEAT_RETENTION_MILLISECONDS,
  canonicalJson,
  extendProductionHeatSignalSetHash,
  productionHeatApplyBatchRequestSchema,
  productionHeatBatchByteCount,
  productionHeatCoreByteCount,
  productionHeatFinalizeRequestSchema,
  productionHeatReceiptHash,
  productionHeatReceiptSchema,
  productionHeatRefreshFrameRequestSchema,
  productionHeatStartRequestSchema,
  productionHeatContentIdentity,
  productionHeatManifestAlignmentSchema,
  deriveProductionHeatFrameId,
  recomputeProductionHeatFrameHash,
  recomputeProductionHeatBatchHash,
  type ProductionHeatFrameEnvelope,
  type ProductionHeatManifestAlignment,
  type ProductionHeatReceipt,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import {
  loadActiveCatalogHeatManifest,
  parseHeatManifestSourceProof,
  type ActiveCatalogHeatManifest,
} from "./active-catalog-heat-manifest.ts";
import type { PackscoutQueryClient } from "./database.ts";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const deploymentKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;

export interface ProvenActiveHeatFrame {
  readonly publicHeatFrameId: string;
  readonly manifestAlignment: ProductionHeatManifestAlignment;
  readonly frameSequence: number;
  readonly sourceWatermark: bigint;
  readonly signalSetHash: string;
  readonly frameHash: string;
  readonly signalCount: number;
  readonly calculatedAt: Date;
  readonly expiresAt: Date;
  readonly terminalReceiptSha256: string;
}

interface LaneProofRow {
  confirmedWatermark: bigint;
  confirmedPublicationIdentity: string;
  confirmedReceiptSha256: string;
}

interface AttemptProofRow {
  id: string;
  targetWatermark: bigint;
  contentIdentity: string;
  publicationIdentity: string;
  terminalReceiptBody: string;
  terminalReceiptSha256: string;
  manifestSourceProofBody: string;
  manifestSourceProofSha256: string;
}

interface OperationProofRow {
  operationIndex: number;
  operationId: string;
  operationKind: string;
  canonicalRequestBody: string;
  requestSha256: string;
  state: string;
  receiptBody: string | null;
  receiptSha256: string | null;
}

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function invalidProof(): never {
  throw new Error("Heat promotion manifest proof is invalid.");
}

export class PrismaHeatPromotionManifestRepository {
  readonly #deploymentKey: string;
  readonly #organizationId: string;

  constructor(
    private readonly database: PackscoutQueryClient,
    binding: Readonly<{ organizationId: string; deploymentKey: string }>,
  ) {
    if (
      !uuidPattern.test(binding.organizationId) ||
      !deploymentKeyPattern.test(binding.deploymentKey)
    ) throw new RangeError("Heat promotion manifest binding is invalid.");
    this.#organizationId = binding.organizationId.toLowerCase();
    this.#deploymentKey = binding.deploymentKey;
  }

  loadActiveCatalogManifest(): Promise<ActiveCatalogHeatManifest | null> {
    return loadActiveCatalogHeatManifest(this.database, {
      organizationId: this.#organizationId,
      deploymentKey: this.#deploymentKey,
    });
  }

  async loadActiveHeatFrame(): Promise<ProvenActiveHeatFrame | null> {
    const lane = await this.loadLaneProof("heat");
    if (lane === null) return null;
    const active = await this.loadConfirmedAttempt("heat", lane);
    const proven = await this.loadProvenHeatAttempt(active);
    if (
      proven.frame.publicHeatFrameId !== lane.confirmedPublicationIdentity ||
      proven.receiptDetails.activePublicHeatFrameId !==
        lane.confirmedPublicationIdentity
    ) invalidProof();
    return Object.freeze({
      publicHeatFrameId: proven.frame.publicHeatFrameId,
      manifestAlignment: proven.frame.manifestAlignment,
      frameSequence: proven.frame.frameSequence,
      sourceWatermark: BigInt(proven.frame.sourceWatermark),
      signalSetHash: proven.frame.signalSetHash,
      frameHash: proven.frame.frameHash,
      signalCount: proven.frame.signalCount,
      calculatedAt: new Date(proven.frame.calculatedAt),
      expiresAt: new Date(proven.frame.expiresAt),
      terminalReceiptSha256: lane.confirmedReceiptSha256,
    });
  }

  async hasReusableHeatSignalSet(input: Readonly<{
    manifestAlignment: ProductionHeatManifestAlignment;
    signalSetHash: string;
    contentIdentity: string;
    signalCount: number;
    reusableAt: Date;
  }>): Promise<boolean> {
    if (
      !productionHeatManifestAlignmentSchema.safeParse(
        input.manifestAlignment,
      ).success || !sha256Pattern.test(input.signalSetHash) ||
      !sha256Pattern.test(input.contentIdentity) ||
      !Number.isFinite(input.reusableAt.getTime()) ||
      !Number.isSafeInteger(input.signalCount) ||
      input.signalCount < 1 ||
      input.signalCount > MAX_PUBLIC_REPACKS_PER_RELEASE
    ) throw new RangeError("Reusable Heat signal set identity is invalid.");
    const candidates = await this.database.$queryRaw<AttemptProofRow[]>(Prisma.sql`
      select id, target_watermark as "targetWatermark",
             content_identity as "contentIdentity",
             publication_identity as "publicationIdentity",
             terminal_receipt_body as "terminalReceiptBody",
             terminal_receipt_sha256 as "terminalReceiptSha256",
             manifest_source_proof_body as "manifestSourceProofBody",
             manifest_source_proof_sha256 as "manifestSourceProofSha256"
      from public.promotion_attempts
      where organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
        and lane_key = 'heat'
        and state = 'published'
        and content_identity = ${input.contentIdentity}
        and terminal_receipt_body is not null
        and terminal_receipt_sha256 is not null
        and manifest_source_proof_body is not null
        and manifest_source_proof_sha256 is not null
      order by target_watermark desc
      limit 8
    `);
    for (const candidate of candidates) {
      const proven = await this.loadProvenHeatAttempt(candidate);
      if (
        canonicalJson(proven.frame.manifestAlignment) ===
          canonicalJson(input.manifestAlignment) &&
        proven.frame.signalSetHash === input.signalSetHash &&
        proven.frame.signalCount === input.signalCount &&
        canonicalJson(proven.receiptDetails.manifestAlignment) ===
          canonicalJson(input.manifestAlignment) &&
        proven.receiptDetails.signalSetHash === input.signalSetHash &&
        proven.receiptDetails.signalCount === input.signalCount
      ) {
        const retainedThrough = Date.parse(proven.frame.expiresAt) +
          PRODUCTION_HEAT_RETENTION_MILLISECONDS;
        if (retainedThrough > input.reusableAt.getTime()) return true;
      }
    }
    return false;
  }

  private async loadProvenHeatAttempt(
    attempt: AttemptProofRow,
  ): Promise<Readonly<{
    frame: ProductionHeatFrameEnvelope;
    manifestSourceProof: ActiveCatalogHeatManifest;
    receiptDetails: Readonly<{
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
    }>;
  }>> {
    if (
      sha256(attempt.terminalReceiptBody) !== attempt.terminalReceiptSha256 ||
      !sha256Pattern.test(attempt.contentIdentity) ||
      !uuidPattern.test(attempt.publicationIdentity)
    ) invalidProof();
    let manifestSourceProof;
    try {
      manifestSourceProof = await parseHeatManifestSourceProof(
        attempt.manifestSourceProofBody,
        attempt.manifestSourceProofSha256,
      );
    } catch {
      invalidProof();
    }
    let parsedReceipt;
    try {
      parsedReceipt = productionHeatReceiptSchema.parse(
        JSON.parse(attempt.terminalReceiptBody) as unknown,
      );
    } catch {
      invalidProof();
    }
    if (
      canonicalJson(parsedReceipt) !== attempt.terminalReceiptBody ||
      (parsedReceipt.operationKind !== "finalize" &&
        parsedReceipt.operationKind !== "refreshFrame")
    ) invalidProof();
    const receipt = parsedReceipt;
    const {
      receiptDigest: heatReceiptDigest,
      ...heatReceiptWithoutDigest
    } = receipt;
    if (
      await productionHeatReceiptHash(heatReceiptWithoutDigest) !==
        heatReceiptDigest
    ) invalidProof();
    const operations = await this.loadOperations(attempt.id);
    if (
      operations.length === 0 ||
      operations.some(({ operationIndex }, index) => operationIndex !== index)
    ) invalidProof();
    const operationReceipts: ProductionHeatReceipt[] = [];
    for (const operation of operations) {
      if (
        operation.state !== "acknowledged" ||
        operation.receiptBody === null ||
        operation.receiptSha256 === null
      ) invalidProof();
      let operationReceipt;
      try {
        operationReceipt = productionHeatReceiptSchema.parse(
          JSON.parse(operation.receiptBody) as unknown,
        );
      } catch {
        invalidProof();
      }
      const {
        receiptDigest: operationReceiptDigest,
        ...operationReceiptWithoutDigest
      } = operationReceipt;
      if (
        sha256(operation.canonicalRequestBody) !== operation.requestSha256 ||
        sha256(operation.receiptBody) !== operation.receiptSha256 ||
        canonicalJson(operationReceipt) !== operation.receiptBody ||
        operationReceipt.operationId !== operation.operationId ||
        operationReceipt.operationKind !== operation.operationKind ||
        operationReceipt.publicationId !== attempt.publicationIdentity ||
        operationReceipt.requestDigest !== operation.requestSha256 ||
        await productionHeatReceiptHash(operationReceiptWithoutDigest) !==
          operationReceiptDigest
      ) invalidProof();
      operationReceipts.push(operationReceipt);
    }
    const first = operations[0]!;
    const terminal = operations.at(-1)!;
    if (
      terminal.receiptBody !== attempt.terminalReceiptBody ||
      terminal.receiptSha256 !== attempt.terminalReceiptSha256
    ) invalidProof();
    let frame: ProductionHeatFrameEnvelope;
    let terminalOperationId: string;
    let expectedPreviousPublicHeatFrameId: string | null;
    if (receipt.operationKind === "finalize") {
      if (
        first.operationKind !== "start" ||
        terminal.operationKind !== "finalize" ||
        operations.length < 2 ||
        operations.slice(1, -1).some(({ operationKind }) =>
          operationKind !== "applyBatch")
      ) invalidProof();
      const start = productionHeatStartRequestSchema.safeParse(
        JSON.parse(first.canonicalRequestBody) as unknown,
      );
      const finalize = productionHeatFinalizeRequestSchema.safeParse(
        JSON.parse(terminal.canonicalRequestBody) as unknown,
      );
      if (
        !start.success || !finalize.success ||
        canonicalJson(start.data) !== first.canonicalRequestBody ||
        canonicalJson(finalize.data) !== terminal.canonicalRequestBody ||
        start.data.expectedBatchCount !== operations.length - 2 ||
        finalize.data.expectedBatchCount !== operations.length - 2 ||
        canonicalJson(finalize.data.expectedManifestAlignment) !==
          canonicalJson(start.data.frame.manifestAlignment) ||
        finalize.data.expectedFrameHash !== start.data.frame.frameHash ||
        finalize.data.expectedSignalSetHash !== start.data.frame.signalSetHash ||
        finalize.data.expectedSignalCount !== start.data.frame.signalCount
      ) invalidProof();
      const startReceipt = operationReceipts[0]!;
      if (
        startReceipt.operationKind !== "start" ||
        canonicalJson(startReceipt.details.manifestAlignment) !==
          canonicalJson(start.data.frame.manifestAlignment) ||
        startReceipt.details.frameHash !== start.data.frame.frameHash ||
        startReceipt.details.signalSetHash !== start.data.frame.signalSetHash ||
        startReceipt.details.sourceWatermark !== start.data.frame.sourceWatermark ||
        startReceipt.details.frameSequence !== start.data.frame.frameSequence ||
        startReceipt.details.expectedSignalCount !== start.data.frame.signalCount ||
        startReceipt.details.expectedBatchCount !== start.data.expectedBatchCount
      ) invalidProof();
      let acceptedSignalCount = 0;
      let expectedSignalSetHash = EMPTY_PRODUCTION_HEAT_SIGNAL_SET_HASH;
      let previousPublicRepackId: string | null = null;
      const publicRepackIds: string[] = [];
      for (const [batchIndex, operation] of operations.slice(1, -1).entries()) {
        const batch = productionHeatApplyBatchRequestSchema.safeParse(
          JSON.parse(operation.canonicalRequestBody) as unknown,
        );
        if (
          !batch.success ||
          canonicalJson(batch.data) !== operation.canonicalRequestBody ||
          batch.data.publicationId !== start.data.publicationId ||
          batch.data.batchIndex !== batchIndex ||
          batch.data.batchHash !==
            await recomputeProductionHeatBatchHash(batch.data.records)
        ) invalidProof();
        for (const { publicRepackId } of batch.data.records) {
          if (
            previousPublicRepackId !== null &&
            publicRepackId <= previousPublicRepackId
          ) invalidProof();
          previousPublicRepackId = publicRepackId;
          publicRepackIds.push(publicRepackId);
        }
        acceptedSignalCount += batch.data.records.length;
        expectedSignalSetHash = await extendProductionHeatSignalSetHash({
          previousHash: expectedSignalSetHash,
          batchIndex,
          batchHash: batch.data.batchHash,
          recordCount: batch.data.records.length,
          coreByteCount: productionHeatCoreByteCount(batch.data.records),
        });
        const batchReceipt = operationReceipts[batchIndex + 1]!;
        if (
          batchReceipt.operationKind !== "applyBatch" ||
          batchReceipt.details.batchIndex !== batchIndex ||
          batchReceipt.details.batchHash !== batch.data.batchHash ||
          batchReceipt.details.recordCount !== batch.data.records.length ||
          batchReceipt.details.byteCount !==
            productionHeatBatchByteCount(batch.data.records) ||
          batchReceipt.details.coreByteCount !==
            productionHeatCoreByteCount(batch.data.records) ||
          batchReceipt.details.acceptedSignalCount !== acceptedSignalCount ||
          batchReceipt.details.signalSetProgressHash !== expectedSignalSetHash
        ) invalidProof();
      }
      if (
        acceptedSignalCount !== start.data.frame.signalCount ||
        expectedSignalSetHash !== start.data.frame.signalSetHash ||
        canonicalJson(publicRepackIds) !==
          canonicalJson(manifestSourceProof.publicRepackIds) ||
        canonicalJson(finalize.data.expectedManifestAlignment) !==
          canonicalJson(start.data.frame.manifestAlignment)
      ) invalidProof();
      frame = start.data.frame;
      terminalOperationId = finalize.data.operationId;
      expectedPreviousPublicHeatFrameId =
        finalize.data.expectedActivePublicHeatFrameId;
    } else {
      if (operations.length !== 1 || first.operationKind !== "refreshFrame") {
        invalidProof();
      }
      const refresh = productionHeatRefreshFrameRequestSchema.safeParse(
        JSON.parse(first.canonicalRequestBody) as unknown,
      );
      if (
        !refresh.success ||
        canonicalJson(refresh.data) !== first.canonicalRequestBody
      ) invalidProof();
      frame = refresh.data.frame;
      terminalOperationId = refresh.data.operationId;
      expectedPreviousPublicHeatFrameId =
        refresh.data.expectedActivePublicHeatFrameId;
    }
    const details = receipt.details;
    if (
      receipt.operationId !== terminalOperationId ||
      receipt.publicationId !== attempt.publicationIdentity ||
      receipt.requestDigest !== sha256(terminal.canonicalRequestBody) ||
      frame.publicHeatFrameId !== attempt.publicationIdentity ||
      BigInt(frame.frameSequence) !== attempt.targetWatermark ||
      canonicalJson(frame.manifestAlignment) !==
        canonicalJson(manifestSourceProof.manifestAlignment) ||
      canonicalJson(details.manifestAlignment) !==
        canonicalJson(frame.manifestAlignment) ||
      details.activePublicHeatFrameId !== frame.publicHeatFrameId ||
      details.previousPublicHeatFrameId !== expectedPreviousPublicHeatFrameId ||
      details.frameHash !== frame.frameHash ||
      details.signalSetHash !== frame.signalSetHash ||
      details.sourceWatermark !== frame.sourceWatermark ||
      details.frameSequence !== frame.frameSequence ||
      details.signalCount !== frame.signalCount ||
      details.calculatedAt !== frame.calculatedAt ||
      details.expiresAt !== frame.expiresAt ||
      frame.signalCount !== manifestSourceProof.publicRepackIds.length ||
      frame.frameHash !== await recomputeProductionHeatFrameHash(frame) ||
      frame.publicHeatFrameId !== await deriveProductionHeatFrameId({
        manifestAlignment: frame.manifestAlignment,
        frameSequence: frame.frameSequence,
        sourceWatermark: frame.sourceWatermark,
      }) ||
      attempt.contentIdentity !== await productionHeatContentIdentity({
        manifestAlignment: frame.manifestAlignment,
        signalSetHash: frame.signalSetHash,
      })
    ) invalidProof();
    return { frame, manifestSourceProof, receiptDetails: details };
  }

  private async loadLaneProof(laneKey: "heat"):
  Promise<LaneProofRow | null> {
    const rows = await this.database.$queryRaw<LaneProofRow[]>(Prisma.sql`
      select confirmed_watermark as "confirmedWatermark",
             confirmed_publication_identity as "confirmedPublicationIdentity",
             confirmed_receipt_sha256 as "confirmedReceiptSha256"
      from public.promotion_lanes
      where organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
        and lane_key = ${laneKey}
        and bootstrap_state = 'verified_local'
        and confirmed_watermark > 0
        and confirmed_publication_identity is not null
        and confirmed_receipt_sha256 is not null
    `);
    const row = rows[0];
    if (!row) return null;
    if (
      !uuidPattern.test(row.confirmedPublicationIdentity) ||
      !sha256Pattern.test(row.confirmedReceiptSha256)
    ) invalidProof();
    return row;
  }

  private async loadConfirmedAttempt(
    laneKey: "heat",
    lane: LaneProofRow,
  ): Promise<AttemptProofRow> {
    const rows = await this.database.$queryRaw<AttemptProofRow[]>(Prisma.sql`
      select id, target_watermark as "targetWatermark",
             content_identity as "contentIdentity",
             publication_identity as "publicationIdentity",
             terminal_receipt_body as "terminalReceiptBody",
             terminal_receipt_sha256 as "terminalReceiptSha256",
             manifest_source_proof_body as "manifestSourceProofBody",
             manifest_source_proof_sha256 as "manifestSourceProofSha256"
      from public.promotion_attempts
      where organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
        and lane_key = ${laneKey}
        and state in ('published', 'unchanged')
        and target_watermark = ${lane.confirmedWatermark}
        and publication_identity = ${lane.confirmedPublicationIdentity}
        and terminal_receipt_body is not null
        and terminal_receipt_sha256 is not null
        and manifest_source_proof_body is not null
        and manifest_source_proof_sha256 is not null
      limit 1
    `);
    const row = rows[0];
    if (
      !row ||
      row.terminalReceiptSha256 !== lane.confirmedReceiptSha256 ||
      sha256(row.terminalReceiptBody) !== lane.confirmedReceiptSha256
    ) invalidProof();
    return row;
  }

  private loadOperations(attemptId: string): Promise<OperationProofRow[]> {
    return this.database.$queryRaw<OperationProofRow[]>(Prisma.sql`
      select operation_index as "operationIndex",
             operation_id as "operationId",
             operation_kind as "operationKind",
             canonical_request_body as "canonicalRequestBody",
             request_sha256 as "requestSha256",
             state,
             receipt_body as "receiptBody",
             receipt_sha256 as "receiptSha256"
      from public.promotion_operations
      where attempt_id = ${uuid(attemptId)}
        and organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
      order by operation_index
    `);
  }
}
