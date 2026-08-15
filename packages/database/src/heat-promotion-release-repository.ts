import { createHash } from "node:crypto";
import {
  EMPTY_BATCH_CHAIN_HASH,
  MAX_PUBLIC_REPACKS_PER_RELEASE,
  MAX_PRODUCTION_BATCH_BYTES,
  EMPTY_PRODUCTION_HEAT_SIGNAL_SET_HASH,
  PRODUCTION_HEAT_RETENTION_MILLISECONDS,
  canonicalJson,
  extendProductionBatchChain,
  productionApplyBatchRequestSchema,
  productionBatchByteCount,
  productionFinalizeRequestSchema,
  productionHeatFinalizeRequestSchema,
  productionHeatApplyBatchRequestSchema,
  productionHeatCoreByteCount,
  productionHeatReceiptHash,
  productionHeatReceiptSchema,
  productionHeatRefreshFrameRequestSchema,
  productionHeatStartRequestSchema,
  productionReceiptHash,
  productionReceiptSchema,
  productionRefreshRequestSchema,
  productionStartRequestSchema,
  type ProductionHeatFrameEnvelope,
  extendProductionHeatSignalSetHash,
  recomputeProductionHeatBatchHash,
  recomputeProductionBatchHash,
  recomputeProductionManifestFingerprint,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import type { PackscoutQueryClient } from "./database.ts";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const deploymentKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;

export interface ProvenActiveCatalogHeatRelease {
  readonly publicReleaseId: string;
  readonly publicRepackIds: readonly string[];
  readonly confirmedWatermark: bigint;
  readonly terminalReceiptSha256: string;
}

export interface ProvenActiveHeatFrame {
  readonly publicHeatFrameId: string;
  readonly catalogPublicReleaseId: string;
  readonly frameSequence: number;
  readonly sourceWatermark: bigint;
  readonly signalSetHash: string;
  readonly frameHash: string;
  readonly signalCount: number;
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
  publicationIdentity: string;
  terminalReceiptBody: string;
  terminalReceiptSha256: string;
}

interface OperationProofRow {
  operationIndex: number;
  operationKind: string;
  canonicalRequestBody: string;
}

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function invalidProof(): never {
  throw new Error("Promotion release proof is invalid.");
}

export class PrismaHeatPromotionReleaseRepository {
  readonly #deploymentKey: string;
  readonly #organizationId: string;

  constructor(
    private readonly database: PackscoutQueryClient,
    binding: Readonly<{ organizationId: string; deploymentKey: string }>,
  ) {
    if (
      !uuidPattern.test(binding.organizationId) ||
      !deploymentKeyPattern.test(binding.deploymentKey)
    ) throw new RangeError("Heat promotion release binding is invalid.");
    this.#organizationId = binding.organizationId.toLowerCase();
    this.#deploymentKey = binding.deploymentKey;
  }

  async loadActiveCatalogRelease(): Promise<ProvenActiveCatalogHeatRelease | null> {
    const lane = await this.loadLaneProof("catalog");
    if (lane === null) return null;
    const active = await this.loadConfirmedAttempt("catalog", lane);
    const activeReceipt = productionReceiptSchema.safeParse(
      JSON.parse(active.terminalReceiptBody) as unknown,
    );
    if (
      !activeReceipt.success ||
      canonicalJson(activeReceipt.data) !== active.terminalReceiptBody ||
      activeReceipt.data.publicationId !== lane.confirmedPublicationIdentity ||
      !["finalize", "refreshObservation"].includes(
        activeReceipt.data.operationKind,
      )
    ) invalidProof();
    const {
      receiptDigest: activeReceiptDigest,
      ...activeReceiptWithoutDigest
    } = activeReceipt.data;
    if (
      await productionReceiptHash(activeReceiptWithoutDigest) !==
        activeReceiptDigest
    ) invalidProof();
    let activeRefreshContentHash: string | null = null;
    if (activeReceipt.data.operationKind === "refreshObservation") {
      const activeOperations = await this.loadOperations(active.id);
      const activeOperation = activeOperations[0];
      if (
        activeOperations.length !== 1 ||
        activeOperation?.operationKind !== "refreshObservation"
      ) invalidProof();
      const refresh = productionRefreshRequestSchema.safeParse(
        JSON.parse(activeOperation.canonicalRequestBody) as unknown,
      );
      if (
        !refresh.success ||
        canonicalJson(refresh.data) !== activeOperation.canonicalRequestBody ||
        refresh.data.operationId !== activeReceipt.data.operationId ||
        refresh.data.publicReleaseId !== lane.confirmedPublicationIdentity ||
        activeReceipt.data.requestDigest !==
          sha256(activeOperation.canonicalRequestBody) ||
        BigInt(refresh.data.observationSequence) !== lane.confirmedWatermark ||
        activeReceipt.data.details.contentHash !== refresh.data.contentHash ||
        activeReceipt.data.details.observationSequence !==
          refresh.data.observationSequence ||
        activeReceipt.data.details.dataAsOf !== refresh.data.dataAsOf ||
        activeReceipt.data.details.lastSuccessfulObservationAt !==
          refresh.data.lastSuccessfulObservationAt ||
        activeReceipt.data.details.staleAt !== refresh.data.staleAt ||
        activeReceipt.data.details.freshness !== refresh.data.freshness ||
        activeReceipt.data.details.delayedVendorCount !==
          refresh.data.delayedVendorCount
      ) invalidProof();
      activeRefreshContentHash = refresh.data.contentHash;
    }

    const publishedRows = await this.database.$queryRaw<AttemptProofRow[]>(Prisma.sql`
      select id, target_watermark as "targetWatermark",
             publication_identity as "publicationIdentity",
             terminal_receipt_body as "terminalReceiptBody",
             terminal_receipt_sha256 as "terminalReceiptSha256"
      from public.promotion_attempts
      where organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
        and lane_key = 'catalog'
        and state = 'published'
        and publication_identity = ${lane.confirmedPublicationIdentity}
        and terminal_receipt_body is not null
        and terminal_receipt_sha256 is not null
      order by target_watermark desc, terminal_at desc
      limit 1
    `);
    const published = publishedRows[0];
    if (
      !published ||
      sha256(published.terminalReceiptBody) !==
        published.terminalReceiptSha256
    ) invalidProof();
    if (
      activeReceipt.data.operationKind === "finalize" &&
      active.id !== published.id
    ) invalidProof();
    const operations = await this.loadOperations(published.id);
    const start = operations[0];
    const finalize = operations.at(-1);
    if (
      !start || !finalize ||
      operations.some(({ operationIndex }, index) => operationIndex !== index) ||
      start.operationKind !== "start" ||
      finalize.operationKind !== "finalize"
    ) invalidProof();
    const startRequest = productionStartRequestSchema.safeParse(
      JSON.parse(start.canonicalRequestBody) as unknown,
    );
    const finalizeRequest = productionFinalizeRequestSchema.safeParse(
      JSON.parse(finalize.canonicalRequestBody) as unknown,
    );
    if (
      !startRequest.success ||
      !finalizeRequest.success ||
      canonicalJson(startRequest.data) !== start.canonicalRequestBody ||
      canonicalJson(finalizeRequest.data) !== finalize.canonicalRequestBody ||
      startRequest.data.publicationId !== lane.confirmedPublicationIdentity ||
      finalizeRequest.data.publicationId !== lane.confirmedPublicationIdentity
    ) invalidProof();
    const publishedReceipt = productionReceiptSchema.safeParse(
      JSON.parse(published.terminalReceiptBody) as unknown,
    );
    if (
      !publishedReceipt.success ||
      publishedReceipt.data.operationKind !== "finalize" ||
      canonicalJson(publishedReceipt.data) !== published.terminalReceiptBody ||
      publishedReceipt.data.publicationId !== lane.confirmedPublicationIdentity ||
      publishedReceipt.data.operationId !== finalizeRequest.data.operationId ||
      publishedReceipt.data.requestDigest !== sha256(finalize.canonicalRequestBody)
    ) invalidProof();
    const {
      receiptDigest: publishedReceiptDigest,
      ...publishedReceiptWithoutDigest
    } = publishedReceipt.data;
    if (
      await productionReceiptHash(publishedReceiptWithoutDigest) !==
        publishedReceiptDigest
    ) invalidProof();
    const computedCounts = {
      vendors: 0,
      categories: 0,
      collectibles: 0,
      repacks: 0,
      repackChases: 0,
      searchShards: 0,
    };
    let computedBatchChainHash = EMPTY_BATCH_CHAIN_HASH;
    const publicRepackIds: string[] = [];
    let previousPublicRepackId: string | null = null;
    for (const [batchIndex, operation] of
      operations.slice(1, -1).entries()) {
      if (operation.operationKind !== "applyBatch") invalidProof();
      const batch = productionApplyBatchRequestSchema.safeParse(
        JSON.parse(operation.canonicalRequestBody) as unknown,
      );
      const byteCount = batch.success
        ? productionBatchByteCount(batch.data.records)
        : 0;
      if (
        !batch.success ||
        canonicalJson(batch.data) !== operation.canonicalRequestBody ||
        batch.data.publicationId !== lane.confirmedPublicationIdentity ||
        batch.data.batchIndex !== batchIndex ||
        byteCount > MAX_PRODUCTION_BATCH_BYTES ||
        batch.data.batchHash !== await recomputeProductionBatchHash({
          kind: batch.data.kind,
          records: batch.data.records,
        })
      ) {
        invalidProof();
      }
      computedBatchChainHash = await extendProductionBatchChain({
        previousHash: computedBatchChainHash,
        batchIndex,
        kind: batch.data.kind,
        batchHash: batch.data.batchHash,
        recordCount: batch.data.records.length,
        byteCount,
      });
      if (batch.data.kind === "repack_chases") {
        computedCounts.repackChases += batch.data.records.length;
      } else if (batch.data.kind === "search_shards") {
        computedCounts.searchShards += batch.data.records.length;
      } else {
        computedCounts[batch.data.kind] += batch.data.records.length;
      }
      if (batch.data.kind === "repacks") {
        for (const { publicRepackId } of batch.data.records) {
          if (
            previousPublicRepackId !== null &&
            publicRepackId <= previousPublicRepackId
          ) invalidProof();
          publicRepackIds.push(publicRepackId);
          previousPublicRepackId = publicRepackId;
        }
      }
    }
    const computedBatchCount = operations.length - 2;
    const sameCounts = (value: unknown): boolean =>
      canonicalJson(value) === canonicalJson(computedCounts);
    if (
      startRequest.data.manifest.publicReleaseId !==
        lane.confirmedPublicationIdentity ||
      BigInt(startRequest.data.manifest.observationSequence) !==
        published.targetWatermark ||
      (activeRefreshContentHash !== null &&
        activeRefreshContentHash !== startRequest.data.manifest.contentHash) ||
      startRequest.data.manifest.batchCount !== computedBatchCount ||
      startRequest.data.manifest.batchChainHash !== computedBatchChainHash ||
      startRequest.data.manifest.manifestFingerprint !==
        await recomputeProductionManifestFingerprint(
          startRequest.data.manifest,
        ) ||
      !sameCounts(startRequest.data.manifest.counts) ||
      finalizeRequest.data.expectedPredecessorPublicReleaseId !==
        startRequest.data.expectedPredecessorPublicReleaseId ||
      finalizeRequest.data.expectedBatchCount !== computedBatchCount ||
      finalizeRequest.data.expectedBatchChainHash !== computedBatchChainHash ||
      !sameCounts(finalizeRequest.data.expectedCounts) ||
      publishedReceipt.data.details.manifestFingerprint !==
        startRequest.data.manifest.manifestFingerprint ||
      publishedReceipt.data.details.contentHash !==
        startRequest.data.manifest.contentHash ||
      publishedReceipt.data.details.sourceWatermark !==
        startRequest.data.manifest.sourceWatermark ||
      publishedReceipt.data.details.activePublicReleaseId !==
        lane.confirmedPublicationIdentity ||
      publishedReceipt.data.details.previousPublicReleaseId !==
        startRequest.data.expectedPredecessorPublicReleaseId ||
      publishedReceipt.data.details.batchCount !== computedBatchCount ||
      publishedReceipt.data.details.batchChainHash !== computedBatchChainHash ||
      !sameCounts(publishedReceipt.data.details.counts)
    ) invalidProof();
    if (
      publicRepackIds.length === 0 ||
      publicRepackIds.length !== finalizeRequest.data.expectedCounts.repacks
    ) invalidProof();
    return Object.freeze({
      publicReleaseId: lane.confirmedPublicationIdentity,
      publicRepackIds: Object.freeze(publicRepackIds),
      confirmedWatermark: lane.confirmedWatermark,
      terminalReceiptSha256: lane.confirmedReceiptSha256,
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
      catalogPublicReleaseId: proven.frame.catalogPublicReleaseId,
      frameSequence: proven.frame.frameSequence,
      sourceWatermark: BigInt(proven.frame.sourceWatermark),
      signalSetHash: proven.frame.signalSetHash,
      frameHash: proven.frame.frameHash,
      signalCount: proven.frame.signalCount,
      terminalReceiptSha256: lane.confirmedReceiptSha256,
    });
  }

  async hasReusableHeatSignalSet(input: Readonly<{
    catalogPublicReleaseId: string;
    signalSetHash: string;
    contentIdentity: string;
    signalCount: number;
    reusableAt: Date;
  }>): Promise<boolean> {
    if (
      !uuidPattern.test(input.catalogPublicReleaseId) ||
      !sha256Pattern.test(input.signalSetHash) ||
      !sha256Pattern.test(input.contentIdentity) ||
      !Number.isFinite(input.reusableAt.getTime()) ||
      !Number.isSafeInteger(input.signalCount) ||
      input.signalCount < 1 ||
      input.signalCount > MAX_PUBLIC_REPACKS_PER_RELEASE
    ) throw new RangeError("Reusable Heat signal set identity is invalid.");
    const candidates = await this.database.$queryRaw<AttemptProofRow[]>(Prisma.sql`
      select id, target_watermark as "targetWatermark",
             publication_identity as "publicationIdentity",
             terminal_receipt_body as "terminalReceiptBody",
             terminal_receipt_sha256 as "terminalReceiptSha256"
      from public.promotion_attempts
      where organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
        and lane_key = 'heat'
        and state = 'published'
        and content_identity = ${input.contentIdentity}
        and terminal_receipt_body is not null
        and terminal_receipt_sha256 is not null
      order by target_watermark desc
      limit 8
    `);
    for (const candidate of candidates) {
      const proven = await this.loadProvenHeatAttempt(candidate);
      if (
        proven.frame.catalogPublicReleaseId ===
          input.catalogPublicReleaseId &&
        proven.frame.signalSetHash === input.signalSetHash &&
        proven.frame.signalCount === input.signalCount &&
        proven.receiptDetails.catalogPublicReleaseId ===
          input.catalogPublicReleaseId &&
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
    receiptDetails: Readonly<{
      catalogPublicReleaseId: string;
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
      !uuidPattern.test(attempt.publicationIdentity)
    ) invalidProof();
    const parsedReceipt = productionHeatReceiptSchema.safeParse(
      JSON.parse(attempt.terminalReceiptBody) as unknown,
    );
    if (
      !parsedReceipt.success ||
      canonicalJson(parsedReceipt.data) !== attempt.terminalReceiptBody ||
      (parsedReceipt.data.operationKind !== "finalize" &&
        parsedReceipt.data.operationKind !== "refreshFrame")
    ) invalidProof();
    const receipt = parsedReceipt.data;
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
    const first = operations[0]!;
    const terminal = operations.at(-1)!;
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
        finalize.data.expectedCatalogPublicReleaseId !==
          start.data.frame.catalogPublicReleaseId ||
        finalize.data.expectedFrameHash !== start.data.frame.frameHash ||
        finalize.data.expectedSignalSetHash !== start.data.frame.signalSetHash ||
        finalize.data.expectedSignalCount !== start.data.frame.signalCount
      ) invalidProof();
      let acceptedSignalCount = 0;
      let expectedSignalSetHash = EMPTY_PRODUCTION_HEAT_SIGNAL_SET_HASH;
      let previousPublicRepackId: string | null = null;
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
        }
        acceptedSignalCount += batch.data.records.length;
        expectedSignalSetHash = await extendProductionHeatSignalSetHash({
          previousHash: expectedSignalSetHash,
          batchIndex,
          batchHash: batch.data.batchHash,
          recordCount: batch.data.records.length,
          coreByteCount: productionHeatCoreByteCount(batch.data.records),
        });
      }
      if (
        acceptedSignalCount !== start.data.frame.signalCount ||
        expectedSignalSetHash !== start.data.frame.signalSetHash
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
      details.catalogPublicReleaseId !== frame.catalogPublicReleaseId ||
      details.activePublicHeatFrameId !== frame.publicHeatFrameId ||
      details.previousPublicHeatFrameId !== expectedPreviousPublicHeatFrameId ||
      details.frameHash !== frame.frameHash ||
      details.signalSetHash !== frame.signalSetHash ||
      details.sourceWatermark !== frame.sourceWatermark ||
      details.frameSequence !== frame.frameSequence ||
      details.signalCount !== frame.signalCount ||
      details.calculatedAt !== frame.calculatedAt ||
      details.expiresAt !== frame.expiresAt
    ) invalidProof();
    return { frame, receiptDetails: details };
  }

  private async loadLaneProof(laneKey: "catalog" | "heat"):
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
    laneKey: "catalog" | "heat",
    lane: LaneProofRow,
  ): Promise<AttemptProofRow> {
    const rows = await this.database.$queryRaw<AttemptProofRow[]>(Prisma.sql`
      select id, target_watermark as "targetWatermark",
             publication_identity as "publicationIdentity",
             terminal_receipt_body as "terminalReceiptBody",
             terminal_receipt_sha256 as "terminalReceiptSha256"
      from public.promotion_attempts
      where organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
        and lane_key = ${laneKey}
        and state in ('published', 'unchanged')
        and target_watermark = ${lane.confirmedWatermark}
        and publication_identity = ${lane.confirmedPublicationIdentity}
        and terminal_receipt_body is not null
        and terminal_receipt_sha256 is not null
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
             operation_kind as "operationKind",
             canonical_request_body as "canonicalRequestBody"
      from public.promotion_operations
      where attempt_id = ${uuid(attemptId)}
        and organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
        and state = 'acknowledged'
      order by operation_index
    `);
  }
}
