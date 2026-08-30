import { PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3, publicRepackDetailV3Schema } from "@packscout/contracts";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { canonicalJson } from "./dataReleaseCanonicalHash";
import { evFactsFromDetail, loadEvFactSet, loadReleaseEvFacts, sealEvFactSet } from "./dataReleaseV3EvFacts";
import { dataReleaseV3SearchRowMatchesDetail, MAX_DATA_RELEASE_V3_REPACKS,
  MAX_ROWS_PER_DATA_RELEASE_V3_SHARD, type DataReleaseV3SearchRow } from "./dataReleaseV3Search";
import { activateRetainedEv } from "./dataReleaseV3RetainedEv";
import { loadEvMigrationState, usesLegacyEvSnapshot } from "./dataReleaseV3EvMigrationState";
import { refuseProductionDataRelease } from "./productionDataReleaseErrors";

const MAX_BACKFILL_PAGE_ROWS = 32;
const MAX_BACKFILL_PAGE_BYTES = 4 * 1_024 * 1_024;
const refuse = () => refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");

async function scope(ctx: Pick<QueryCtx, "db">, publicReleaseId: string) {
  const state = await ctx.db.query("activeDataReleaseV3State")
    .withIndex("by_key", (index) => index.eq("key", "singleton")).unique();
  const active = state?.activeRelease?.publicReleaseId ?? null;
  const previous = state?.previousRelease?.publicReleaseId ?? null;
  if (state === null || (publicReleaseId !== active && publicReleaseId !== previous)) return refuse();
  const releaseId = publicReleaseId === active ? state.activeReleaseId : state.previousReleaseId;
  const pointer = publicReleaseId === active ? state.activeRelease : state.previousRelease;
  const release = releaseId === null ? null : await ctx.db.get("dataReleaseV3Releases", releaseId);
  if (release === null || pointer === null || release.lifecycle !== "complete" ||
      release.completedAt === null || release.publicEvPolicyVersion !== PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3 ||
      release.publicReleaseId !== publicReleaseId || release.releaseFingerprint !== pointer.releaseFingerprint ||
      release.completedAt !== pointer.completedAt || release.expectedCounts.repacks > MAX_DATA_RELEASE_V3_REPACKS) return refuse();
  return { state, release, active, previous };
}

function result(publicReleaseId: string, set: Doc<"dataReleaseV3EvFactSets"> | null) {
  return { publicReleaseId, complete: set?.status === "complete", count: set?.count ?? 0,
    nextCursor: set?.cursor ?? null };
}

/** One-time migration status, internal only; no source reads or public pointer writes. */
export const progress = internalQuery({
  args: { publicReleaseId: v.string() },
  handler: async (ctx, args) => {
    const target = await scope(ctx, args.publicReleaseId);
    return { ...result(args.publicReleaseId, await loadEvFactSet(ctx, target.release._id)),
      expectedGeneration: target.state.generation, expectedActivePublicReleaseId: target.active,
      expectedPreviousPublicReleaseId: target.previous };
  },
});

/** Exact pointer CAS + stable ID cursor; each retry either replays or advances one bounded page. */
export const backfillActiveReleaseEvFacts = internalMutation({
  args: { publicReleaseId: v.string(), expectedGeneration: v.number(),
    expectedActivePublicReleaseId: v.union(v.string(), v.null()),
    expectedPreviousPublicReleaseId: v.union(v.string(), v.null()),
    afterPublicRepackId: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const target = await scope(ctx, args.publicReleaseId);
    if (target.state.generation !== args.expectedGeneration || target.active !== args.expectedActivePublicReleaseId ||
        target.previous !== args.expectedPreviousPublicReleaseId) return refuse();
    const set = await loadEvFactSet(ctx, target.release._id);
    if (set?.status === "complete") {
      await loadReleaseEvFacts(ctx, target.release);
      return result(args.publicReleaseId, set);
    }
    if (set !== null && set.source !== "backfill") return refuse();
    if ((set?.cursor ?? null) !== args.afterPublicRepackId) {
      if (set !== null && set.lastRequestCursor === args.afterPublicRepackId) return result(args.publicReleaseId, set);
      return refuse();
    }
    const shardRows = new Map<number, readonly DataReleaseV3SearchRow[]>();
    const query = ctx.db.query("dataReleaseV3Repacks")
      .withIndex("by_release_id_and_public_repack_id", (index) => {
        const scoped = index.eq("releaseId", target.release._id);
        return args.afterPublicRepackId === null ? scoped : scoped.gt("publicRepackId", args.afterPublicRepackId);
      });
    let count = set?.count ?? 0;
    let cursor = set?.cursor ?? null;
    let bytesRead = 0;
    let pageRows = 0;
    // A single document is at most1MiB; stop below the transaction byte limit
    // even when valid pack descriptions and images are unusually large.
    for await (const stored of query) {
      const size = new TextEncoder().encode(canonicalJson(stored)).byteLength;
      if (bytesRead + size > MAX_BACKFILL_PAGE_BYTES && pageRows > 0) break;
      bytesRead += size;
      const detail = publicRepackDetailV3Schema.parse(stored.detail);
      const shardNumber = Math.floor(count / MAX_ROWS_PER_DATA_RELEASE_V3_SHARD);
      let rows = shardRows.get(shardNumber);
      if (rows === undefined) {
        const shard = await ctx.db.query("dataReleaseV3SearchShards")
          .withIndex("by_release_id_and_shard_number", (index) => index.eq("releaseId", target.release._id)
            .eq("shardNumber", shardNumber)).unique();
        if (shard === null || shard.rows.length !== shard.rowCount || shard.rowCount !==
            Math.min(MAX_ROWS_PER_DATA_RELEASE_V3_SHARD, target.release.expectedCounts.repacks -
              shardNumber * MAX_ROWS_PER_DATA_RELEASE_V3_SHARD)) return refuse();
        rows = shard.rows as DataReleaseV3SearchRow[];
        shardRows.set(shardNumber, rows);
      }
      const row = rows[count % MAX_ROWS_PER_DATA_RELEASE_V3_SHARD];
      if (row === undefined || row.publicRepackId !== stored.publicRepackId ||
          (cursor !== null && stored.publicRepackId <= cursor) || detail.publicRepackId !== stored.publicRepackId ||
          !dataReleaseV3SearchRowMatchesDetail(row, detail)) return refuse();
      const existing = await ctx.db.query("dataReleaseV3EvFacts")
        .withIndex("by_release_id_and_public_repack_id", (index) => index.eq("releaseId", target.release._id)
          .eq("publicRepackId", detail.publicRepackId)).unique();
      if (existing !== null) return refuse();
      await ctx.db.insert("dataReleaseV3EvFacts", { releaseId: target.release._id, ...evFactsFromDetail(detail) });
      count += 1;
      pageRows += 1;
      cursor = detail.publicRepackId;
      if (pageRows === MAX_BACKFILL_PAGE_ROWS) break;
    }
    if (count > target.release.expectedCounts.repacks ||
        (pageRows === 0 && count !== target.release.expectedCounts.repacks)) return refuse();
    const core = { count, cursor, lastRequestCursor: args.afterPublicRepackId };
    const setId = set === null ? await ctx.db.insert("dataReleaseV3EvFactSets", {
      releaseId: target.release._id, source: "backfill", status: "building", factsSha256: null, ...core,
    }) : set._id;
    if (set !== null) await ctx.db.patch("dataReleaseV3EvFactSets", set._id, core);
    const updated = await ctx.db.get("dataReleaseV3EvFactSets", setId);
    if (updated === null) return refuse();
    if (count === target.release.expectedCounts.repacks) await sealEvFactSet(ctx, updated);
    return { ...result(args.publicReleaseId, updated), complete: count === target.release.expectedCounts.repacks };
  },
});

/** Complete the one-time cutover without republishing or changing the public generation. */
export const initializeActiveRetention = internalMutation({
  args: { publicReleaseId: v.string(), expectedGeneration: v.number(),
    expectedActivePublicReleaseId: v.union(v.string(), v.null()),
    expectedPreviousPublicReleaseId: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const target = await scope(ctx, args.publicReleaseId);
    const state = target.state;
    if (target.active !== args.publicReleaseId || state.generation !== args.expectedGeneration ||
        target.active !== args.expectedActivePublicReleaseId || target.previous !== args.expectedPreviousPublicReleaseId) return refuse();
    if (state.retainedEvTransitionId !== undefined || state.retainedEvTransitionDirection !== undefined) {
      if (!(await loadEvMigrationState(ctx)).initialized) return refuse();
      return { initialized: true, publicReleaseId: args.publicReleaseId, generation: state.generation };
    }
    if (!(await usesLegacyEvSnapshot(ctx, target.release, state))) return refuse();
    if (state.terminalOperationId === null) return refuse();
    const operation = await ctx.db.query("dataReleaseV3Operations")
      .withIndex("by_operation_id", (index) => index.eq("operationId", state.terminalOperationId!)).unique();
    // After a legacy rollback, `previous` is the displaced future branch.
    // Only a recorded activation proves this predecessor was actually public
    // before the active release. Ambiguous legacy heads need operator review.
    if (operation === null || operation.kind !== "activate" || operation.status !== "completed" ||
        operation.publicReleaseId !== args.publicReleaseId) return refuse();
    const receipt: unknown = JSON.parse(operation.receiptJson);
    if (typeof receipt !== "object" || receipt === null || !("details" in receipt) ||
        typeof receipt.details !== "object" || receipt.details === null ||
        !("generation" in receipt.details) || receipt.details.generation !== state.generation ||
        !("activeRelease" in receipt.details) || canonicalJson(receipt.details.activeRelease) !== canonicalJson(state.activeRelease) ||
        !("previousRelease" in receipt.details) || canonicalJson(receipt.details.previousRelease) !== canonicalJson(state.previousRelease)) return refuse();
    const previous = state.previousReleaseId === null ? null
      : await ctx.db.get("dataReleaseV3Releases", state.previousReleaseId);
    if (state.previousReleaseId !== null && previous === null) return refuse();
    const retained = await activateRetainedEv(ctx, { previousRelease: previous, nextRelease: target.release,
      seedPrevious: true, operationId: `last-known-ev-initialization:${state.terminalOperationId}` });
    // Derived one-way cutover markers are outside immutable publication hashes.
    // Losing both pointer fields later must never re-enable the legacy reader.
    for (const release of previous === null ? [target.release] : [previous, target.release]) {
      await ctx.db.patch("dataReleaseV3Releases", release._id, { evFactsRequired: true });
    }
    await ctx.db.patch("activeDataReleaseV3State", state._id, retained);
    return { initialized: true, publicReleaseId: args.publicReleaseId, generation: state.generation };
  },
});
