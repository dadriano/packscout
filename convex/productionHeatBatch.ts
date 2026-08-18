import {
  MAX_PRODUCTION_HEAT_BATCH_BYTES,
  canonicalJson,
  extendProductionHeatSignalSetHash,
  productionHeatApplyBatchRequestSchema,
  productionHeatBatchByteCount,
  productionHeatCoreByteCount,
  recomputeProductionHeatBatchHash,
  repackHeatSignalCore,
  type ProductionHeatReceipt,
} from "@packscout/contracts";
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { refuseProductionDataRelease } from "./productionDataReleaseErrors";
import {
  loadExactHeatOperationReplay,
  storeProductionHeatReceipt,
} from "./productionHeatOperations";
import {
  assertProductionHeatFrame,
  loadActiveCatalogHeatManifest,
  loadOwnedHeatRepacks,
  parseProductionHeatRequest,
} from "./productionHeatProtocol";

function signalMatchesFrame(
  signal: ReturnType<typeof productionHeatApplyBatchRequestSchema.parse>["records"][number],
  frame: {
    aggregationVersion: string;
    heatPolicyVersion: string;
    baselineWindowStartedAt: string;
    baselineWindowEndedAt: string;
    currentWindowStartedAt: string;
    currentWindowEndedAt: string;
    calculatedAt: string;
    expiresAt: string;
  },
): boolean {
  return signal.provenance.kind === "observed" &&
    signal.provenance.aggregationVersion === frame.aggregationVersion &&
    signal.heatPolicyVersion === frame.heatPolicyVersion &&
    signal.baselineWindow.startedAt === frame.baselineWindowStartedAt &&
    signal.baselineWindow.endedAt === frame.baselineWindowEndedAt &&
    signal.currentWindow.startedAt === frame.currentWindowStartedAt &&
    signal.currentWindow.endedAt === frame.currentWindowEndedAt &&
    signal.calculatedAt === frame.calculatedAt &&
    signal.expiresAt === frame.expiresAt;
}

export const applyBatch = internalMutation({
  args: { bodyJson: v.string(), requestDigest: v.string() },
  handler: async (ctx, { bodyJson, requestDigest }): Promise<ProductionHeatReceipt> => {
    const request = parseProductionHeatRequest(
      bodyJson,
      productionHeatApplyBatchRequestSchema,
    );
    const replay = await loadExactHeatOperationReplay(ctx, {
      kind: "applyBatch",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      bodyHash: requestDigest,
    });
    if (replay !== null) return replay;
    const publications = await ctx.db
      .query("repackHeatPublications")
      .withIndex("by_publication_id", (index) =>
        index.eq("publicationId", request.publicationId),
      )
      .take(2);
    if (publications.length !== 1) {
      refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
    }
    const publication = publications[0]!;
    const signalSet = await ctx.db.get(
      "repackHeatSignalSets",
      publication.signalSetId,
    );
    const frame = await assertProductionHeatFrame(publication.frame);
    const catalog = await loadActiveCatalogHeatManifest(
      ctx,
      frame.manifestAlignment,
    );
    const byteCount = productionHeatBatchByteCount(request.records);
    const coreByteCount = productionHeatCoreByteCount(request.records);
    const batchHash = await recomputeProductionHeatBatchHash(request.records);
    const ids = request.records.map(({ publicRepackId }) => publicRepackId);
    if (
      publication.state !== "staging" ||
      publication.manifestId !== catalog.manifestDocument._id ||
      signalSet === null ||
      signalSet.lifecycle !== "staging" ||
      signalSet.manifestId !== catalog.manifestDocument._id ||
      canonicalJson(signalSet.manifestAlignment) !==
        canonicalJson(catalog.alignment) ||
      request.batchIndex !== publication.acceptedBatchCount ||
      request.batchIndex >= publication.expectedBatchCount ||
      request.batchHash !== batchHash ||
      byteCount > MAX_PRODUCTION_HEAT_BATCH_BYTES ||
      coreByteCount > MAX_PRODUCTION_HEAT_BATCH_BYTES ||
      publication.acceptedSignalCount + request.records.length >
        frame.signalCount ||
      ids.some((id, index) =>
        (index > 0 && id <= ids[index - 1]!) ||
        (index === 0 && publication.lastPublicRepackId !== null &&
          id <= publication.lastPublicRepackId) ||
        !signalMatchesFrame(request.records[index]!, frame))
    ) {
      refuseProductionDataRelease("PUBLICATION_BATCH_CONFLICT");
    }
    const existingBatches = await ctx.db
      .query("repackHeatBatches")
      .withIndex("by_publication_id_and_batch_index", (index) =>
        index
          .eq("publicationId", request.publicationId)
          .eq("batchIndex", request.batchIndex),
      )
      .take(2);
    if (existingBatches.length !== 0) {
      refuseProductionDataRelease("PUBLICATION_BATCH_CONFLICT");
    }
    const ownedRepacks = await loadOwnedHeatRepacks(ctx, catalog, ids);
    for (const signal of request.records) {
      const owned = ownedRepacks.get(signal.publicRepackId);
      if (owned === undefined) {
        refuseProductionDataRelease("PUBLICATION_REFERENCE_INVALID");
      }
      await ctx.db.insert("repackHeatSignals", {
        signalSetId: signalSet._id,
        providerReleaseId: owned.release._id,
        repackId: owned.repack._id,
        publicRepackId: signal.publicRepackId,
        detail: repackHeatSignalCore(signal),
      });
    }
    const signalSetProgressHash = await extendProductionHeatSignalSetHash({
      previousHash: publication.acceptedSignalSetHash,
      batchIndex: request.batchIndex,
      batchHash,
      recordCount: request.records.length,
      coreByteCount,
    });
    const now = new Date().toISOString();
    await ctx.db.insert("repackHeatBatches", {
      publicationId: request.publicationId,
      manifestId: catalog.manifestDocument._id,
      signalSetId: signalSet._id,
      batchIndex: request.batchIndex,
      idempotencyKey: request.idempotencyKey,
      bodyHash: requestDigest,
      batchHash,
      recordCount: request.records.length,
      byteCount,
      coreByteCount,
      signalSetProgressHash,
      acceptedAt: now,
      operationId: request.operationId,
    });
    const acceptedSignalCount =
      publication.acceptedSignalCount + request.records.length;
    await ctx.db.patch("repackHeatPublications", publication._id, {
      acceptedBatchCount: publication.acceptedBatchCount + 1,
      acceptedSignalCount,
      acceptedSignalSetHash: signalSetProgressHash,
      lastPublicRepackId: ids.at(-1)!,
    });
    return await storeProductionHeatReceipt(ctx, {
      operationId: request.operationId,
      operationKind: "applyBatch",
      idempotencyKey: request.idempotencyKey,
      publicationId: request.publicationId,
      terminalState: "staging",
      result: "accepted",
      serverTime: now,
      requestDigest,
      details: {
        batchIndex: request.batchIndex,
        batchHash,
        recordCount: request.records.length,
        byteCount,
        coreByteCount,
        acceptedSignalCount,
        signalSetProgressHash,
      },
    });
  },
});
