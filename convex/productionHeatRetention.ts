import {
  PRODUCTION_HEAT_RETENTION_MILLISECONDS,
  productionHeatRetainRequestSchema,
  type ProductionHeatReceipt,
} from "@packscout/contracts";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { refuseProductionDataRelease } from "./productionDataReleaseErrors";
import {
  loadExactHeatOperationReplay,
  storeProductionHeatReceipt,
} from "./productionHeatOperations";
import {
  loadActiveHeatFrame,
  loadHeatState,
  parseProductionHeatRequest,
} from "./productionHeatProtocol";

const MAXIMUM_DOCUMENTS_PER_MUTATION = 100 as const;
const DELETION_BUDGET = 90;

type RetentionCounts = {
  deletedFrameCount: number;
  deletedSignalCount: number;
  deletedSignalSetCount: number;
  deletedOperationCount: number;
  deletedMetadataCount: number;
};

function emptyCounts(): RetentionCounts {
  return {
    deletedFrameCount: 0,
    deletedSignalCount: 0,
    deletedSignalSetCount: 0,
    deletedOperationCount: 0,
    deletedMetadataCount: 0,
  };
}

function total(counts: RetentionCounts): number {
  return counts.deletedFrameCount + counts.deletedSignalCount +
    counts.deletedSignalSetCount + counts.deletedOperationCount +
    counts.deletedMetadataCount;
}

async function protectedFrameIds(ctx: MutationCtx) {
  const state = await loadHeatState(ctx);
  if (state === null) return new Set<Id<"repackHeatSnapshots">>();
  const active = await loadActiveHeatFrame(ctx, state);
  if (active === null) {
    return refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  const protectedIds = new Set<Id<"repackHeatSnapshots">>([active._id]);
  if (state.previousHeatSnapshotId !== null) {
    const previous = await ctx.db.get(
      "repackHeatSnapshots",
      state.previousHeatSnapshotId,
    );
    if (
      previous === null ||
      previous._id === active._id ||
      (previous.lifecycle !== "retired" && previous.lifecycle !== "complete")
    ) {
      return refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
    }
    protectedIds.add(previous._id);
  }
  return protectedIds;
}

async function protectedOperationPublicationIds(
  ctx: MutationCtx,
): Promise<Set<string>> {
  const state = await loadHeatState(ctx);
  if (state === null) return new Set<string>();
  const ids = [...await protectedFrameIds(ctx)];
  const frames = await Promise.all(
    ids.map((id) => ctx.db.get("repackHeatSnapshots", id)),
  );
  return new Set(frames.flatMap((frame) =>
    frame === null ? [] : [frame.publicHeatSnapshotId]
  ));
}

async function deleteRetiredFrame(
  ctx: MutationCtx,
  cutoff: string,
  counts: RetentionCounts,
): Promise<void> {
  const protectedIds = await protectedFrameIds(ctx);
  const candidates = await ctx.db
    .query("repackHeatSnapshots")
    .withIndex("by_lifecycle_and_expires_at", (index) =>
      index.eq("lifecycle", "retired").lte("expiresAt", cutoff),
    )
    .take(12);
  const candidate = candidates.find((frame) => !protectedIds.has(frame._id));
  if (candidate === undefined) return;
  await ctx.db.delete("repackHeatSnapshots", candidate._id);
  counts.deletedFrameCount += 1;
  const remainingFrames = await ctx.db
    .query("repackHeatSnapshots")
    .withIndex("by_signal_set_id", (index) =>
      index.eq("signalSetId", candidate.signalSetId),
    )
    .take(1);
  if (remainingFrames.length === 0) {
    const signalSet = await ctx.db.get(
      "repackHeatSignalSets",
      candidate.signalSetId,
    );
    if (signalSet !== null && signalSet.lifecycle === "complete") {
      await ctx.db.patch("repackHeatSignalSets", signalSet._id, {
        lifecycle: "retired",
        retentionEligibleAt: new Date().toISOString(),
      });
    }
  }
}

async function deleteRetiredSignalSet(
  ctx: MutationCtx,
  now: string,
  counts: RetentionCounts,
): Promise<void> {
  const sets = await ctx.db
    .query("repackHeatSignalSets")
    .withIndex("by_lifecycle_and_retention_eligible_at", (index) =>
      index.eq("lifecycle", "retired").lte("retentionEligibleAt", now),
    )
    .take(1);
  const signalSet = sets[0];
  if (signalSet === undefined) return;
  const limit = Math.max(0, DELETION_BUDGET - total(counts));
  if (limit === 0) return;
  const signals = await ctx.db
    .query("repackHeatSignals")
    .withIndex("by_signal_set_id_and_public_repack_id", (index) =>
      index.eq("signalSetId", signalSet._id),
    )
    .take(limit);
  for (const signal of signals) {
    await ctx.db.delete("repackHeatSignals", signal._id);
    counts.deletedSignalCount += 1;
  }
  if (signals.length < limit) {
    const frames = await ctx.db
      .query("repackHeatSnapshots")
      .withIndex("by_signal_set_id", (index) =>
        index.eq("signalSetId", signalSet._id),
      )
      .take(1);
    if (frames.length === 0) {
      await ctx.db.delete("repackHeatSignalSets", signalSet._id);
      counts.deletedSignalSetCount += 1;
    }
  }
}

async function deleteCompletedPublication(
  ctx: MutationCtx,
  cutoff: string,
  counts: RetentionCounts,
): Promise<void> {
  if (total(counts) >= DELETION_BUDGET) return;
  const publications = await ctx.db
    .query("repackHeatPublications")
    .withIndex("by_state_and_completed_at", (index) =>
      index.eq("state", "complete").lte("completedAt", cutoff),
    )
    .take(1);
  const publication = publications[0];
  if (publication === undefined) return;
  const limit = DELETION_BUDGET - total(counts);
  const batches = await ctx.db
    .query("repackHeatBatches")
    .withIndex("by_publication_id_and_batch_index", (index) =>
      index.eq("publicationId", publication.publicationId),
    )
    .take(limit);
  for (const batch of batches) {
    await ctx.db.delete("repackHeatBatches", batch._id);
    counts.deletedMetadataCount += 1;
  }
  if (batches.length < limit) {
    await ctx.db.delete("repackHeatPublications", publication._id);
    counts.deletedMetadataCount += 1;
  }
}

async function deleteAbandonedPublication(
  ctx: MutationCtx,
  now: string,
  counts: RetentionCounts,
): Promise<void> {
  if (total(counts) >= DELETION_BUDGET) return;
  let publication: Doc<"repackHeatPublications"> | null = null;
  for (const state of ["staging", "failed"] as const) {
    const matches = await ctx.db
      .query("repackHeatPublications")
      .withIndex("by_state_and_retention_eligible_at", (index) =>
        index.eq("state", state).lte("retentionEligibleAt", now),
      )
      .take(1);
    if (matches[0] !== undefined) {
      publication = matches[0];
      break;
    }
  }
  if (publication === null) return;
  const publicationId = publication.publicationId;
  let limit = DELETION_BUDGET - total(counts);
  const operations = await ctx.db
    .query("repackHeatOperations")
    .withIndex("by_publication_id", (index) =>
      index.eq("publicationId", publicationId),
    )
    .take(limit);
  for (const operation of operations) {
    await ctx.db.delete("repackHeatOperations", operation._id);
    counts.deletedOperationCount += 1;
  }
  limit = DELETION_BUDGET - total(counts);
  if (limit === 0) return;
  const batches = await ctx.db
    .query("repackHeatBatches")
    .withIndex("by_publication_id_and_batch_index", (index) =>
      index.eq("publicationId", publicationId),
    )
    .take(limit);
  for (const batch of batches) {
    await ctx.db.delete("repackHeatBatches", batch._id);
    counts.deletedMetadataCount += 1;
  }
  if (total(counts) >= DELETION_BUDGET) return;
  const [remainingOperations, remainingBatches] = await Promise.all([
    ctx.db
      .query("repackHeatOperations")
      .withIndex("by_publication_id", (index) =>
        index.eq("publicationId", publicationId),
      )
      .take(1),
    ctx.db
      .query("repackHeatBatches")
      .withIndex("by_publication_id_and_batch_index", (index) =>
        index.eq("publicationId", publicationId),
      )
      .take(1),
  ]);
  if (remainingOperations.length > 0 || remainingBatches.length > 0) return;
  const signalSet = await ctx.db.get(
    "repackHeatSignalSets",
    publication.signalSetId,
  );
  await ctx.db.delete("repackHeatPublications", publication._id);
  counts.deletedMetadataCount += 1;
  if (
    signalSet !== null &&
    (signalSet.lifecycle === "staging" || signalSet.lifecycle === "failed")
  ) {
    await ctx.db.patch("repackHeatSignalSets", signalSet._id, {
      lifecycle: "retired",
      retentionEligibleAt: now,
    });
  }
}

async function deleteCompletedOperations(
  ctx: MutationCtx,
  cutoff: string,
  counts: RetentionCounts,
): Promise<void> {
  const limit = Math.max(0, DELETION_BUDGET - total(counts));
  if (limit === 0) return;
  const protectedPublicationIds = await protectedOperationPublicationIds(ctx);
  const candidates = await ctx.db
    .query("repackHeatOperations")
    .withIndex("by_completed_at", (index) =>
      index.gt("completedAt", null).lte("completedAt", cutoff),
    )
    .take(limit + 2);
  const operations = candidates.filter((operation) =>
    !(
      operation.publicationId !== null &&
      protectedPublicationIds.has(operation.publicationId) &&
      (operation.kind === "finalize" || operation.kind === "refreshFrame")
    )
  ).slice(0, limit);
  for (const operation of operations) {
    await ctx.db.delete("repackHeatOperations", operation._id);
    counts.deletedOperationCount += 1;
  }
}

async function workRemains(
  ctx: MutationCtx,
  now: string,
  cutoff: string,
): Promise<boolean> {
  const protectedIds = await protectedFrameIds(ctx);
  const frames = await ctx.db
    .query("repackHeatSnapshots")
    .withIndex("by_lifecycle_and_expires_at", (index) =>
      index.eq("lifecycle", "retired").lte("expiresAt", cutoff),
    )
    .take(12);
  if (frames.some((frame) => !protectedIds.has(frame._id))) return true;
  for (const state of ["staging", "failed"] as const) {
    const abandoned = await ctx.db
      .query("repackHeatPublications")
      .withIndex("by_state_and_retention_eligible_at", (index) =>
        index.eq("state", state).lte("retentionEligibleAt", now),
      )
      .take(1);
    if (abandoned.length > 0) return true;
  }
  const protectedPublicationIds = await protectedOperationPublicationIds(ctx);
  const [sets, publications, operations] = await Promise.all([
    ctx.db
      .query("repackHeatSignalSets")
      .withIndex("by_lifecycle_and_retention_eligible_at", (index) =>
        index.eq("lifecycle", "retired").lte("retentionEligibleAt", now),
      )
      .take(1),
    ctx.db
      .query("repackHeatPublications")
      .withIndex("by_state_and_completed_at", (index) =>
        index.eq("state", "complete").lte("completedAt", cutoff),
      )
      .take(1),
    ctx.db
      .query("repackHeatOperations")
      .withIndex("by_completed_at", (index) =>
        index.gt("completedAt", null).lte("completedAt", cutoff),
      )
      .take(3),
  ]);
  return sets.length > 0 || publications.length > 0 || operations.some(
    (operation) => !(
      operation.publicationId !== null &&
      protectedPublicationIds.has(operation.publicationId) &&
      (operation.kind === "finalize" || operation.kind === "refreshFrame")
    ),
  );
}

async function runRetentionBatch(ctx: MutationCtx, serverNow: number) {
  const now = new Date(serverNow).toISOString();
  const cutoff = new Date(
    serverNow - PRODUCTION_HEAT_RETENTION_MILLISECONDS,
  ).toISOString();
  const counts = emptyCounts();
  await deleteRetiredFrame(ctx, cutoff, counts);
  await deleteAbandonedPublication(ctx, now, counts);
  await deleteRetiredSignalSet(ctx, now, counts);
  await deleteCompletedPublication(ctx, cutoff, counts);
  await deleteCompletedOperations(ctx, cutoff, counts);
  return { ...counts, hasMore: await workRemains(ctx, now, cutoff) };
}

export const retain = internalMutation({
  args: { bodyJson: v.string(), requestDigest: v.string() },
  handler: async (ctx, { bodyJson, requestDigest }): Promise<ProductionHeatReceipt> => {
    const request = parseProductionHeatRequest(
      bodyJson,
      productionHeatRetainRequestSchema,
    );
    const replay = await loadExactHeatOperationReplay(ctx, {
      kind: "retain",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      bodyHash: requestDigest,
    });
    if (replay !== null) return replay;
    const now = Date.now();
    const retained = await runRetentionBatch(ctx, now);
    return await storeProductionHeatReceipt(ctx, {
      operationId: request.operationId,
      operationKind: "retain",
      idempotencyKey: request.idempotencyKey,
      publicationId: null,
      terminalState: retained.hasMore ? "continuation_required" : "complete",
      result: "retained",
      serverTime: new Date(now).toISOString(),
      requestDigest,
      details: {
        ...retained,
        maximumDocumentsPerMutation: MAXIMUM_DOCUMENTS_PER_MUTATION,
      },
    });
  },
});

export const scheduledRetention = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const retained = await runRetentionBatch(ctx, Date.now());
    if (retained.hasMore) {
      await ctx.scheduler.runAfter(
        0,
        internal.productionHeatRetention.scheduledRetention,
        {},
      );
    }
    return null;
  },
});
