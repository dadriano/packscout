import {
  EMPTY_PRODUCTION_HEAT_SIGNAL_SET_HASH,
  PRODUCTION_HEAT_RETENTION_MILLISECONDS,
  REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
  canonicalJson,
  productionHeatFinalizeRequestSchema,
  productionHeatRefreshFrameRequestSchema,
  productionHeatStartRequestSchema,
  productionHeatStatusRequestSchema,
  type ProductionHeatFrameEnvelope,
  type ProductionHeatReceipt,
  type ProductionHeatStatusNotFoundReceipt,
} from "@packscout/contracts";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { refuseProductionDataRelease } from "./productionDataReleaseErrors";
import {
  loadExactHeatOperationReplay,
  loadHeatReceiptByOperationId,
  storeProductionHeatReceipt,
} from "./productionHeatOperations";
import {
  type ActiveCatalogHeatManifest,
  assertMonotonicHeatFrame,
  assertProductionHeatFrame,
  loadActiveCatalogHeatManifest,
  loadActiveHeatFrame,
  loadHeatState,
  parseProductionHeatRequest,
} from "./productionHeatProtocol";

async function publicationById(ctx: MutationCtx, publicationId: string) {
  const matches = await ctx.db
    .query("repackHeatPublications")
    .withIndex("by_publication_id", (index) =>
      index.eq("publicationId", publicationId),
    )
    .take(2);
  if (matches.length !== 1) {
    refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  return matches[0]!;
}

async function signalSetByHash(
  ctx: MutationCtx,
  manifestId: Id<"globalCatalogManifests">,
  signalSetHash: string,
): Promise<Doc<"repackHeatSignalSets"> | null> {
  const matches = await ctx.db
    .query("repackHeatSignalSets")
    .withIndex("by_manifest_id_and_signal_set_hash", (index) =>
      index.eq("manifestId", manifestId).eq("signalSetHash", signalSetHash),
    )
    .take(2);
  if (matches.length > 1) {
    refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  return matches[0] ?? null;
}

async function assertUnusedHeatIdentity(
  ctx: MutationCtx,
  publicationId: string,
): Promise<void> {
  const [publications, frames] = await Promise.all([
    ctx.db
      .query("repackHeatPublications")
      .withIndex("by_publication_id", (index) =>
        index.eq("publicationId", publicationId),
      )
      .take(1),
    ctx.db
      .query("repackHeatSnapshots")
      .withIndex("by_public_heat_snapshot_id", (index) =>
        index.eq("publicHeatSnapshotId", publicationId),
      )
      .take(1),
  ]);
  if (publications.length !== 0 || frames.length !== 0) {
    refuseProductionDataRelease("PUBLICATION_OPERATION_CONFLICT");
  }
}

async function activateFrame(
  ctx: MutationCtx,
  input: Readonly<{
    frame: ProductionHeatFrameEnvelope;
    publicationId: string;
    catalog: ActiveCatalogHeatManifest;
    signalSet: Doc<"repackHeatSignalSets">;
    expectedActivePublicHeatFrameId?: string | null;
  }>,
): Promise<Readonly<{
  frameId: Id<"repackHeatSnapshots">;
  previousPublicHeatFrameId: string | null;
}>> {
  const state = await loadHeatState(ctx);
  const active = await loadActiveHeatFrame(ctx, state);
  if (
    input.expectedActivePublicHeatFrameId !== undefined &&
    (active?.publicHeatSnapshotId ?? null) !==
      input.expectedActivePublicHeatFrameId
  ) {
    refuseProductionDataRelease("PUBLICATION_PREDECESSOR_CONFLICT");
  }
  assertMonotonicHeatFrame(active, input.frame);
  const existing = await ctx.db
    .query("repackHeatSnapshots")
    .withIndex("by_public_heat_snapshot_id", (index) =>
      index.eq("publicHeatSnapshotId", input.frame.publicHeatFrameId),
    )
    .take(2);
  if (existing.length !== 0) {
    refuseProductionDataRelease("PUBLICATION_OPERATION_CONFLICT");
  }
  const retentionEligibleAt = new Date(
    Date.parse(input.frame.expiresAt) + PRODUCTION_HEAT_RETENTION_MILLISECONDS,
  ).toISOString();
  const frameId = await ctx.db.insert("repackHeatSnapshots", {
    manifestId: input.catalog.manifestDocument._id,
    manifestAlignment: input.catalog.alignment,
    signalSetId: input.signalSet._id,
    publicHeatSnapshotId: input.frame.publicHeatFrameId,
    publicationId: input.publicationId,
    simulationRunId: null,
    sequence: input.frame.frameSequence,
    sourceWatermark: input.frame.sourceWatermark,
    lifecycle: "complete",
    sourceKind: "observed",
    scenarioVersion: null,
    aggregationVersion: input.frame.aggregationVersion,
    heatPolicyVersion: input.frame.heatPolicyVersion,
    contentHash: input.frame.frameHash,
    signalCount: input.frame.signalCount,
    baselineWindowStartedAt: input.frame.baselineWindowStartedAt,
    baselineWindowEndedAt: input.frame.baselineWindowEndedAt,
    currentWindowStartedAt: input.frame.currentWindowStartedAt,
    currentWindowEndedAt: input.frame.currentWindowEndedAt,
    calculatedAt: input.frame.calculatedAt,
    expiresAt: input.frame.expiresAt,
    retentionEligibleAt,
  });
  if (active !== null) {
    await ctx.db.patch("repackHeatSnapshots", active._id, {
      lifecycle: "retired",
    });
  }
  const now = new Date().toISOString();
  if (state === null) {
    await ctx.db.insert("repackHeatState", {
      key: "singleton",
      activeHeatSnapshotId: frameId,
      previousHeatSnapshotId: null,
      freshness: "current",
      expiresAt: input.frame.expiresAt,
      latestSequence: input.frame.frameSequence,
      updatedAt: now,
    });
  } else {
    await ctx.db.patch("repackHeatState", state._id, {
      activeHeatSnapshotId: frameId,
      previousHeatSnapshotId: active?._id ?? null,
      freshness: "current",
      expiresAt: input.frame.expiresAt,
      latestSequence: input.frame.frameSequence,
      updatedAt: now,
    });
  }
  await ctx.scheduler.runAt(
    Date.parse(input.frame.expiresAt),
    internal.productionHeatLifecycle.expireActiveFrame,
    {
      publicHeatFrameId: input.frame.publicHeatFrameId,
      expectedExpiresAt: input.frame.expiresAt,
    },
  );
  return {
    frameId,
    previousPublicHeatFrameId: active?.publicHeatSnapshotId ?? null,
  };
}

function activationDetails(
  frame: ProductionHeatFrameEnvelope,
  previousPublicHeatFrameId: string | null,
) {
  return {
    manifestAlignment: frame.manifestAlignment,
    activePublicHeatFrameId: frame.publicHeatFrameId,
    previousPublicHeatFrameId,
    frameHash: frame.frameHash,
    signalSetHash: frame.signalSetHash,
    sourceWatermark: frame.sourceWatermark,
    frameSequence: frame.frameSequence,
    signalCount: frame.signalCount,
    calculatedAt: frame.calculatedAt,
    expiresAt: frame.expiresAt,
  };
}

export const start = internalMutation({
  args: { bodyJson: v.string(), requestDigest: v.string() },
  handler: async (ctx, { bodyJson, requestDigest }): Promise<ProductionHeatReceipt> => {
    const request = parseProductionHeatRequest(
      bodyJson,
      productionHeatStartRequestSchema,
    );
    const replay = await loadExactHeatOperationReplay(ctx, {
      kind: "start",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      bodyHash: requestDigest,
    });
    if (replay !== null) return replay;
    const frame = await assertProductionHeatFrame(request.frame);
    const catalog = await loadActiveCatalogHeatManifest(
      ctx,
      frame.manifestAlignment,
    );
    await assertUnusedHeatIdentity(ctx, request.publicationId);
    if (
      frame.signalCount !== catalog.manifest.counts.repacks ||
      (frame.signalCount === 0) !== (request.expectedBatchCount === 0) ||
      request.expectedBatchCount > frame.signalCount ||
      await signalSetByHash(
        ctx,
        catalog.manifestDocument._id,
        frame.signalSetHash,
      ) !== null
    ) {
      refuseProductionDataRelease("PUBLICATION_RECONCILIATION_FAILED");
    }
    const now = new Date().toISOString();
    const signalSetId = await ctx.db.insert("repackHeatSignalSets", {
      manifestId: catalog.manifestDocument._id,
      manifestAlignment: catalog.alignment,
      signalSetHash: frame.signalSetHash,
      lifecycle: "staging",
      sourceKind: "observed",
      scenarioVersion: null,
      aggregationVersion: frame.aggregationVersion,
      heatPolicyVersion: frame.heatPolicyVersion,
      signalCount: frame.signalCount,
      originatingPublicationId: request.publicationId,
      createdAt: now,
      completedAt: null,
      retentionEligibleAt: frame.expiresAt,
    });
    await ctx.db.insert("repackHeatPublications", {
      publicationId: request.publicationId,
      manifestId: catalog.manifestDocument._id,
      signalSetId,
      frame,
      expectedBatchCount: request.expectedBatchCount,
      acceptedBatchCount: 0,
      acceptedSignalCount: 0,
      acceptedSignalSetHash: EMPTY_PRODUCTION_HEAT_SIGNAL_SET_HASH,
      lastPublicRepackId: null,
      state: "staging",
      createdAt: now,
      completedAt: null,
      retentionEligibleAt: frame.expiresAt,
    });
    return await storeProductionHeatReceipt(ctx, {
      operationId: request.operationId,
      operationKind: "start",
      idempotencyKey: request.idempotencyKey,
      publicationId: request.publicationId,
      terminalState: "staging",
      result: "created",
      serverTime: now,
      requestDigest,
      details: {
        manifestAlignment: frame.manifestAlignment,
        frameHash: frame.frameHash,
        signalSetHash: frame.signalSetHash,
        sourceWatermark: frame.sourceWatermark,
        frameSequence: frame.frameSequence,
        expectedSignalCount: frame.signalCount,
        expectedBatchCount: request.expectedBatchCount,
      },
    });
  },
});

export const finalize = internalMutation({
  args: { bodyJson: v.string(), requestDigest: v.string() },
  handler: async (ctx, { bodyJson, requestDigest }): Promise<ProductionHeatReceipt> => {
    const request = parseProductionHeatRequest(
      bodyJson,
      productionHeatFinalizeRequestSchema,
    );
    const replay = await loadExactHeatOperationReplay(ctx, {
      kind: "finalize",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      bodyHash: requestDigest,
    });
    if (replay !== null) return replay;
    const publication = await publicationById(ctx, request.publicationId);
    const frame = await assertProductionHeatFrame(publication.frame);
    const signalSet = await ctx.db.get(
      "repackHeatSignalSets",
      publication.signalSetId,
    );
    const catalog = await loadActiveCatalogHeatManifest(
      ctx,
      request.expectedManifestAlignment,
    );
    if (
      publication.state !== "staging" ||
      publication.manifestId !== catalog.manifestDocument._id ||
      canonicalJson(frame.manifestAlignment) !==
        canonicalJson(request.expectedManifestAlignment) ||
      frame.signalSetHash !== request.expectedSignalSetHash ||
      frame.frameHash !== request.expectedFrameHash ||
      frame.signalCount !== request.expectedSignalCount ||
      publication.expectedBatchCount !== request.expectedBatchCount ||
      publication.acceptedBatchCount !== request.expectedBatchCount ||
      publication.acceptedSignalCount !== request.expectedSignalCount ||
      publication.acceptedSignalSetHash !== request.expectedSignalSetHash ||
      signalSet === null ||
      signalSet.lifecycle !== "staging" ||
      signalSet.manifestId !== catalog.manifestDocument._id ||
      canonicalJson(signalSet.manifestAlignment) !==
        canonicalJson(catalog.alignment) ||
      signalSet.signalSetHash !== request.expectedSignalSetHash ||
      signalSet.signalCount !== request.expectedSignalCount ||
      signalSet.originatingPublicationId !== request.publicationId
    ) {
      refuseProductionDataRelease("PUBLICATION_RECONCILIATION_FAILED");
    }
    const activated = await activateFrame(ctx, {
      frame,
      publicationId: request.publicationId,
      catalog,
      signalSet,
      expectedActivePublicHeatFrameId:
        request.expectedActivePublicHeatFrameId,
    });
    const now = new Date().toISOString();
    await ctx.db.patch("repackHeatSignalSets", signalSet._id, {
      lifecycle: "complete",
      completedAt: now,
    });
    await ctx.db.patch("repackHeatPublications", publication._id, {
      state: "complete",
      completedAt: now,
    });
    return await storeProductionHeatReceipt(ctx, {
      operationId: request.operationId,
      operationKind: "finalize",
      idempotencyKey: request.idempotencyKey,
      publicationId: request.publicationId,
      terminalState: "complete",
      result: "activated",
      serverTime: now,
      requestDigest,
      details: activationDetails(frame, activated.previousPublicHeatFrameId),
    });
  },
});

export const refreshFrame = internalMutation({
  args: { bodyJson: v.string(), requestDigest: v.string() },
  handler: async (ctx, { bodyJson, requestDigest }): Promise<ProductionHeatReceipt> => {
    const request = parseProductionHeatRequest(
      bodyJson,
      productionHeatRefreshFrameRequestSchema,
    );
    const replay = await loadExactHeatOperationReplay(ctx, {
      kind: "refreshFrame",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      bodyHash: requestDigest,
    });
    if (replay !== null) return replay;
    const frame = await assertProductionHeatFrame(request.frame);
    const catalog = await loadActiveCatalogHeatManifest(
      ctx,
      frame.manifestAlignment,
    );
    const signalSet = await signalSetByHash(
      ctx,
      catalog.manifestDocument._id,
      frame.signalSetHash,
    );
    const state = await loadHeatState(ctx);
    const active = await loadActiveHeatFrame(ctx, state);
    await assertUnusedHeatIdentity(ctx, request.publicationId);
    if (
      signalSet === null ||
      signalSet.lifecycle !== "complete" ||
      signalSet.manifestId !== catalog.manifestDocument._id ||
      canonicalJson(signalSet.manifestAlignment) !==
        canonicalJson(catalog.alignment) ||
      signalSet.signalCount !== frame.signalCount ||
      frame.signalCount !== catalog.manifest.counts.repacks ||
      active === null ||
      active.publicHeatSnapshotId !== request.expectedActivePublicHeatFrameId
    ) {
      refuseProductionDataRelease("PUBLICATION_PREDECESSOR_CONFLICT");
    }
    const activated = await activateFrame(ctx, {
      frame,
      publicationId: request.publicationId,
      catalog,
      signalSet,
      expectedActivePublicHeatFrameId:
        request.expectedActivePublicHeatFrameId,
    });
    const now = new Date().toISOString();
    return await storeProductionHeatReceipt(ctx, {
      operationId: request.operationId,
      operationKind: "refreshFrame",
      idempotencyKey: request.idempotencyKey,
      publicationId: request.publicationId,
      terminalState: "complete",
      result: "refreshed",
      serverTime: now,
      requestDigest,
      details: activationDetails(frame, activated.previousPublicHeatFrameId),
    });
  },
});

export const status = internalMutation({
  args: { bodyJson: v.string(), requestDigest: v.string() },
  handler: async (ctx, { bodyJson, requestDigest }): Promise<
    ProductionHeatReceipt | ProductionHeatStatusNotFoundReceipt
  > => {
    const request = parseProductionHeatRequest(
      bodyJson,
      productionHeatStatusRequestSchema,
    );
    const receipt = await loadHeatReceiptByOperationId(
      ctx,
      request.operationId,
      request.publicationId,
    );
    return receipt ?? {
      schemaVersion: REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
      operationId: request.operationId,
      publicationId: request.publicationId,
      terminalState: "not_found",
      result: "not_found",
      serverTime: new Date().toISOString(),
      requestDigest,
      details: {},
      receiptDigest: null,
    };
  },
});

export const expireActiveFrame = internalMutation({
  args: { publicHeatFrameId: v.string(), expectedExpiresAt: v.string() },
  returns: v.union(v.literal("expired"), v.literal("unchanged")),
  handler: async (ctx, args) => {
    const state = await loadHeatState(ctx);
    const active = await loadActiveHeatFrame(ctx, state);
    if (
      state === null ||
      active === null ||
      active.publicHeatSnapshotId !== args.publicHeatFrameId ||
      active.expiresAt !== args.expectedExpiresAt ||
      state.expiresAt !== args.expectedExpiresAt ||
      Date.now() < Date.parse(args.expectedExpiresAt) ||
      state.freshness === "expired"
    ) {
      return "unchanged" as const;
    }
    if (state.freshness !== "current") {
      refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
    }
    await ctx.db.patch("repackHeatState", state._id, {
      freshness: "expired",
      updatedAt: new Date().toISOString(),
    });
    return "expired" as const;
  },
});
