import { PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3 } from "@packscout/contracts";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, type QueryCtx } from "./_generated/server";
import { canonicalJson } from "./dataReleaseCanonicalHash";
import { loadEvFactSet, loadReleaseEvFacts } from "./dataReleaseV3EvFacts";
import { loadRetainedEvForScopes, loadRetainedEvTransition } from "./dataReleaseV3RetainedEv";
import { MAX_DATA_RELEASE_V3_REPACKS } from "./dataReleaseV3Search";
import { refuseProductionDataRelease } from "./productionDataReleaseErrors";

const refuse = () => refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
type State = Doc<"activeDataReleaseV3State">;

/** Temporary rollout shape, removed after all selected legacy heads are initialized. */
export async function usesLegacyEvSnapshot(ctx: Pick<QueryCtx, "db">,
  release: Doc<"dataReleaseV3Releases">, state: State): Promise<boolean> {
  if (release.evFactsRequired !== undefined || state.retainedEvTransitionId !== undefined ||
      state.retainedEvTransitionDirection !== undefined) return false;
  // Earlier feature builds already staged facts before this derived marker
  // existed. Those releases must not masquerade as pre-feature snapshots.
  if ((await loadEvFactSet(ctx, release._id))?.source === "staging") return refuse();
  // A completed initialization from an earlier feature build can also lack
  // the new marker. Its journal proves that this is no longer a legacy head.
  const priorTransition = await ctx.db.query("dataReleaseV3EvRetentionTransitions")
    .withIndex("by_from_release_id", (index) => index.eq("fromReleaseId", release._id)).first();
  const nextTransition = await ctx.db.query("dataReleaseV3EvRetentionTransitions")
    .withIndex("by_to_release_id", (index) => index.eq("toReleaseId", release._id)).first();
  if (priorTransition !== null || nextTransition !== null) return refuse();
  return true;
}

async function releaseForPointer(ctx: Pick<QueryCtx, "db">,
  releaseId: Id<"dataReleaseV3Releases"> | null, pointer: State["activeRelease"]) {
  if (releaseId === null && pointer === null) return null;
  if (releaseId === null || pointer === null) return refuse();
  const release = await ctx.db.get("dataReleaseV3Releases", releaseId);
  if (release === null || release.lifecycle !== "complete" || release.completedAt === null ||
      release.publicEvPolicyVersion !== PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3 ||
      release.expectedCounts.repacks > MAX_DATA_RELEASE_V3_REPACKS ||
      canonicalJson(release.acceptedCounts) !== canonicalJson(release.expectedCounts) ||
      canonicalJson(release.acceptedEntityChainHashes) !== canonicalJson(release.expectedEntityChainHashes) ||
      release.acceptedBatchCount !== release.expectedBatchCount ||
      release.acceptedBatchChainHash !== release.expectedBatchChainHash ||
      release.acceptedSearchRowCount !== release.expectedCounts.repacks ||
      canonicalJson(pointer) !== canonicalJson({ publicReleaseId: release.publicReleaseId,
        releaseFingerprint: release.releaseFingerprint, methodVersion: release.methodVersion,
        confidencePolicyVersion: release.confidencePolicyVersion, publicEvPolicyVersion: release.publicEvPolicyVersion,
        dataAsOf: release.dataAsOf, completedAt: release.completedAt, counts: release.expectedCounts })) return refuse();
  return release;
}

/** No public reads, publication writes, source reads, or scans of complete pack details. */
export async function loadEvMigrationState(ctx: Pick<QueryCtx, "db">) {
  const state = await ctx.db.query("activeDataReleaseV3State")
    .withIndex("by_key", (index) => index.eq("key", "singleton")).unique();
  const active = state === null ? null : await releaseForPointer(ctx, state.activeReleaseId, state.activeRelease);
  const previous = state === null ? null : await releaseForPointer(ctx, state.previousReleaseId, state.previousRelease);
  if (state !== null && (!Number.isSafeInteger(state.generation) || state.generation < 0)) return refuse();
  if (active === null && state !== null && (previous !== null || state.generation !== 0 ||
      state.retainedEvTransitionId !== undefined || state.retainedEvTransitionDirection !== undefined)) return refuse();
  const result = { expectedGeneration: state?.generation ?? 0,
    expectedActivePublicReleaseId: active?.publicReleaseId ?? null,
    expectedPreviousPublicReleaseId: previous?.publicReleaseId ?? null,
    activeRelease: state?.activeRelease ?? null, previousRelease: state?.previousRelease ?? null };
  if (state === null || active === null) return { ...result, initialized: true };
  if (await usesLegacyEvSnapshot(ctx, active, state)) return { ...result, initialized: false };
  await loadReleaseEvFacts(ctx, active);
  if (previous !== null) await loadReleaseEvFacts(ctx, previous);
  const { changes, forward } = await loadRetainedEvTransition(ctx, state);
  const retained = await loadRetainedEvForScopes(ctx, changes);
  if (changes.some((change, index) => canonicalJson(retained[index]?.value ?? null) !==
      canonicalJson(forward ? change.after : change.before))) return refuse();
  return { ...result, initialized: true };
}

export const migrationState = internalQuery({ args: {}, handler: loadEvMigrationState });
