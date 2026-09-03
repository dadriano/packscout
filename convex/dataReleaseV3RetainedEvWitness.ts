import {
  DATA_RELEASE_V3_RETAINED_EV_WITNESS_HASH_DOMAIN,
  dataReleaseV3RetainedEvWitnessSchema,
  type DataReleaseV3RetainedEvWitnessRequest,
  type DataReleaseV3RetainedEvWitnessReadinessRequest,
} from "@packscout/contracts";
import type { MutationCtx } from "./_generated/server";
import { canonicalJson, sha256CanonicalJson } from "./dataReleaseCanonicalHash";
import { loadActiveDataReleaseV3State, loadDataReleaseV3ByPublicReleaseId } from "./dataReleaseV3Lifecycle";
import { loadEvFactSet, loadReleaseEvFacts, parseEvFacts } from "./dataReleaseV3EvFacts";
import { loadRetainedEvForScopes, loadRetainedEvTransition, retainedEvForFacts,
  type RetainedEvScope, type RetainedEvValue } from "./dataReleaseV3RetainedEv";
import { refuseProductionDataRelease } from "./productionDataReleaseErrors";

const refuse = () => refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
const key = (scope: RetainedEvScope) => canonicalJson([scope.vendorKey, scope.publicVendorId, scope.publicRepackId]);

/** Authenticated immutable canonical-row witness, not a standalone Merkle proof.
 * The sealed predecessor metadata and exact indexed row must agree with retained
 * economics. We never scan every predecessor set just to rehash it. */
async function assertSourceFact(ctx: MutationCtx, scope: RetainedEvScope, value: RetainedEvValue) {
  const release = await loadDataReleaseV3ByPublicReleaseId(ctx, value.sourcePublicReleaseId);
  if (release === null || release.lifecycle !== "complete" || release.completedAt === null) return refuse();
  const set = await loadEvFactSet(ctx, release._id);
  if (set === null || set.status !== "complete" || set.factsSha256 === null ||
      set.count !== release.expectedCounts.repacks) return refuse();
  const row = await ctx.db.query("dataReleaseV3EvFacts")
    .withIndex("by_release_id_and_public_repack_id", (index) =>
      index.eq("releaseId", release._id).eq("publicRepackId", scope.publicRepackId)).unique();
  if (row === null || key(row) !== key(scope)) return refuse();
  const facts = parseEvFacts(row);
  if (canonicalJson(facts.estimate) !== canonicalJson(value.estimate) ||
      facts.calculationPriceUsdMinor !== value.calculationPriceUsdMinor) return refuse();
}

/** No writes: one transaction binds scoped raw evidence to the exact active snapshot. */
async function loadPinnedWitnessState(ctx: MutationCtx, request: DataReleaseV3RetainedEvWitnessReadinessRequest) {
  const state = await loadActiveDataReleaseV3State(ctx);
  if (state === null && request.expectedGeneration === 0 &&
      request.expectedActivePublicReleaseId === null && request.expectedActiveReleaseFingerprint === null) return null;
  if (state === null || state.activeReleaseId === null || state.activeRelease === null ||
      state.generation !== request.expectedGeneration ||
      state.activeRelease.publicReleaseId !== request.expectedActivePublicReleaseId ||
      state.activeRelease.releaseFingerprint !== request.expectedActiveReleaseFingerprint) return refuse();
  const release = await ctx.db.get("dataReleaseV3Releases", state.activeReleaseId);
  if (release === null || release.lifecycle !== "complete" || release.completedAt === null ||
      release.publicReleaseId !== request.expectedActivePublicReleaseId ||
      release.releaseFingerprint !== request.expectedActiveReleaseFingerprint ||
      release.completedAt !== state.activeRelease.completedAt ||
      canonicalJson(release.expectedCounts) !== canonicalJson(state.activeRelease.counts) ||
      canonicalJson(release.expectedCounts) !== canonicalJson(release.acceptedCounts) ||
      canonicalJson(release.expectedEntityChainHashes) !== canonicalJson(release.acceptedEntityChainHashes) ||
      release.expectedBatchCount !== release.acceptedBatchCount ||
      release.expectedBatchChainHash !== release.acceptedBatchChainHash ||
      release.acceptedSearchRowCount !== release.expectedCounts.repacks) return refuse();
  return { state, release };
}

/** Deployment readiness is distinct from a real, nonempty scoped witness. */
export async function readRetainedEvWitnessReadiness(ctx: MutationCtx, request: DataReleaseV3RetainedEvWitnessReadinessRequest) {
  const pinned = await loadPinnedWitnessState(ctx, request);
  if (pinned === null) return { generation: 0, activePublicReleaseId: null, activeReleaseFingerprint: null, retention: null };
  const { state, release } = pinned;
  const { transition, forward, changes } = await loadRetainedEvTransition(ctx, state);
  const stored = await loadRetainedEvForScopes(ctx, changes);
  if (changes.some((change, index) => canonicalJson(stored[index]?.value ?? null) !==
      canonicalJson(forward ? change.after : change.before))) return refuse();
  await loadReleaseEvFacts(ctx, release);
  return { generation: state.generation, activePublicReleaseId: release.publicReleaseId,
    activeReleaseFingerprint: release.releaseFingerprint,
    retention: { operationId: transition.operationId, direction: forward ? "forward" as const : "reverse" as const,
      changesSha256: transition.changesSha256 } };
}

export async function readRetainedEvWitness(ctx: MutationCtx, request: DataReleaseV3RetainedEvWitnessRequest) {
  const pinned = await loadPinnedWitnessState(ctx, request);
  if (pinned === null) return refuse();
  const { state, release } = pinned;
  const { transition, forward, changes } = await loadRetainedEvTransition(ctx, state);
  const factsByScope = new Map((await loadReleaseEvFacts(ctx, release)).map((fact) => [key(fact), fact]));
  const stored = await loadRetainedEvForScopes(ctx, request.scopes);
  const changedByScope = new Map(changes.map((change) => [key(change), change]));
  const entries = [];
  // A maximum of 100 scopes, each with bounded indexed source reads; no public
  // descriptions, account records, or release-wide predecessor scans are read.
  for (const [index, scope] of request.scopes.entries()) {
    const facts = factsByScope.get(key(scope));
    if (facts === undefined) return refuse();
    const retained = stored[index]?.value ?? null;
    const changed = changedByScope.get(key(scope));
    if (changed !== undefined && canonicalJson(retained) !== canonicalJson(forward ? changed.after : changed.before)) return refuse();
    if (canonicalJson(retainedEvForFacts(facts, retained, release.publicReleaseId).value) !== canonicalJson(retained)) return refuse();
    if (retained !== null) await assertSourceFact(ctx, scope, retained);
    entries.push({ ...scope, activeFacts: { availability: facts.availability,
      calculationPriceUsdMinor: facts.calculationPriceUsdMinor, estimate: facts.estimate }, retained });
  }
  const witness = { generation: state.generation, activePublicReleaseId: release.publicReleaseId,
    activeReleaseFingerprint: release.releaseFingerprint,
    retention: { operationId: transition.operationId, direction: forward ? "forward" as const : "reverse" as const,
      changesSha256: transition.changesSha256 }, entries };
  const parsed = dataReleaseV3RetainedEvWitnessSchema.safeParse({ ...witness,
    witnessSha256: await sha256CanonicalJson(DATA_RELEASE_V3_RETAINED_EV_WITNESS_HASH_DOMAIN, witness) });
  if (!parsed.success) return refuse();
  return parsed.data;
}
