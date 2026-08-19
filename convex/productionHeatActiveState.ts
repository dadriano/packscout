import {
  REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
  canonicalJson,
  productionHeatActiveStateReceiptSchema,
  productionHeatActiveStateRequestSchema,
  productionHeatReceiptHash,
  productionHeatTerminalReceiptSha256,
  recomputeProductionHeatFrameHash,
  type ProductionHeatActiveStateReceipt,
  type ProductionHeatManifestAlignment,
} from "@packscout/contracts";
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { refuseProductionDataRelease } from "./productionDataReleaseErrors";
import { loadHeatReceiptByOperationId } from "./productionHeatOperations";
import {
  assertStoredHeatManifest,
  loadActiveHeatFrame,
  loadHeatState,
  parseProductionHeatRequest,
  productionHeatFrameFromSnapshot,
} from "./productionHeatProtocol";

async function activeStateReceipt(input: Readonly<{
  operationId: string;
  requestDigest: string;
  activePublicHeatFrameId: string | null;
  manifestAlignment: ProductionHeatManifestAlignment | null;
  sourceWatermark: string | null;
  frameSequence: number;
  terminalReceiptSha256: string | null;
}>): Promise<ProductionHeatActiveStateReceipt> {
  const receiptWithoutDigest = {
    schemaVersion: REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
    operationId: input.operationId,
    operationKind: "activeState" as const,
    publicationId: input.activePublicHeatFrameId,
    terminalState: "observed" as const,
    result: "active_state" as const,
    serverTime: new Date().toISOString(),
    requestDigest: input.requestDigest,
    details: {
      activePublicHeatFrameId: input.activePublicHeatFrameId,
      manifestAlignment: input.manifestAlignment,
      sourceWatermark: input.sourceWatermark,
      frameSequence: input.frameSequence,
      terminalReceiptSha256: input.terminalReceiptSha256,
    },
  };
  return productionHeatActiveStateReceiptSchema.parse({
    ...receiptWithoutDigest,
    receiptDigest: await productionHeatReceiptHash(receiptWithoutDigest),
  });
}

export const activeState = internalMutation({
  args: { bodyJson: v.string(), requestDigest: v.string() },
  handler: async (ctx, { bodyJson, requestDigest }) => {
    const request = parseProductionHeatRequest(
      bodyJson,
      productionHeatActiveStateRequestSchema,
    );
    const state = await loadHeatState(ctx);
    if (state === null) {
      return await activeStateReceipt({
        operationId: request.operationId,
        requestDigest,
        activePublicHeatFrameId: null,
        manifestAlignment: null,
        sourceWatermark: null,
        frameSequence: 0,
        terminalReceiptSha256: null,
      });
    }
    const active = await loadActiveHeatFrame(ctx, state);
    if (
      active === null ||
      active.sourceKind !== "observed" ||
      active.publicationId !== active.publicHeatSnapshotId ||
      active.sourceWatermark === null ||
      !/^[1-9][0-9]{0,18}$/u.test(active.sourceWatermark) ||
      !Number.isSafeInteger(active.sequence) ||
      active.sequence <= 0
    ) {
      return refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
    }
    const [signalSet, previous, finalizeOperations, refreshOperations] =
      await Promise.all([
        ctx.db.get("repackHeatSignalSets", active.signalSetId),
        state.previousHeatSnapshotId === null
          ? Promise.resolve(null)
          : ctx.db.get("repackHeatSnapshots", state.previousHeatSnapshotId),
        ctx.db
          .query("repackHeatOperations")
          .withIndex("by_publication_id_and_kind", (index) =>
            index
              .eq("publicationId", active.publicHeatSnapshotId)
              .eq("kind", "finalize"),
          )
          .take(2),
        ctx.db
          .query("repackHeatOperations")
          .withIndex("by_publication_id_and_kind", (index) =>
            index
              .eq("publicationId", active.publicHeatSnapshotId)
              .eq("kind", "refreshFrame"),
          )
          .take(2),
      ]);
    await assertStoredHeatManifest(
      ctx,
      active.manifestId,
      active.manifestAlignment,
    );
    const operations = [...finalizeOperations, ...refreshOperations];
    let frame;
    try {
      frame = signalSet === null
        ? null
        : productionHeatFrameFromSnapshot(active, signalSet);
    } catch {
      return refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
    }
    if (
      signalSet === null ||
      frame === null ||
      frame.frameHash !== await recomputeProductionHeatFrameHash(frame) ||
      signalSet.lifecycle !== "complete" ||
      signalSet.manifestId !== active.manifestId ||
      canonicalJson(signalSet.manifestAlignment) !==
        canonicalJson(active.manifestAlignment) ||
      signalSet.sourceKind !== "observed" ||
      signalSet.scenarioVersion !== null ||
      signalSet.aggregationVersion !== active.aggregationVersion ||
      signalSet.heatPolicyVersion !== active.heatPolicyVersion ||
      signalSet.signalCount !== active.signalCount ||
      (state.previousHeatSnapshotId === null) !== (previous === null) ||
      (previous !== null && (
        previous._id === active._id ||
        previous.lifecycle !== "retired"
      )) ||
      operations.length !== 1 ||
      operations[0]!.receiptJson === undefined
    ) {
      return refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
    }
    const operation = operations[0]!;
    const receipt = await loadHeatReceiptByOperationId(
      ctx,
      operation.operationId,
      active.publicHeatSnapshotId,
    );
    if (
      receipt === null ||
      (receipt.operationKind !== "finalize" &&
        receipt.operationKind !== "refreshFrame") ||
      receipt.details.activePublicHeatFrameId !== active.publicHeatSnapshotId ||
      canonicalJson(receipt.details.manifestAlignment) !==
        canonicalJson(active.manifestAlignment) ||
      receipt.details.sourceWatermark !== active.sourceWatermark ||
      receipt.details.frameSequence !== active.sequence ||
      receipt.details.frameHash !== active.contentHash ||
      receipt.details.signalSetHash !== signalSet.signalSetHash ||
      receipt.details.signalCount !== active.signalCount ||
      receipt.details.calculatedAt !== active.calculatedAt ||
      receipt.details.expiresAt !== active.expiresAt ||
      receipt.details.previousPublicHeatFrameId !==
        (previous?.publicHeatSnapshotId ?? null)
    ) {
      return refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
    }
    return await activeStateReceipt({
      operationId: request.operationId,
      requestDigest,
      activePublicHeatFrameId: active.publicHeatSnapshotId,
      manifestAlignment: active.manifestAlignment,
      sourceWatermark: active.sourceWatermark,
      frameSequence: active.sequence,
      terminalReceiptSha256: await productionHeatTerminalReceiptSha256(
        receipt,
      ),
    });
  },
});
