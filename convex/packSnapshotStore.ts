import {
  PACK_SNAPSHOT_HASH_DOMAIN,
  compareCanonicalStrings,
  hashPackCatalogValue,
  isCanonicalAscending,
  packCatalogCanonicalByteCount,
  packCatalogCanonicalJson,
  type PackCatalogPublicationOperationKind,
  type PackCatalogPublicationReceipt,
  type PublicationReasonCode,
} from "@packscout/contracts";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import {
  assertProviderScope,
  authorizePackCatalogRequest,
  type AuthorizedPackCatalogRequest,
  type ExecutionArgs,
} from "./packCatalogPublicationAuth";
import {
  applied,
  buildPackCatalogReceipt,
  conflict,
  findPackCatalogReplay,
  describeOperation,
  refused,
  storePackCatalogReceipt,
  type ReceiptOutcome,
} from "./packCatalogOperationStore";
import {
  EXECUTION_ARGS,
  comparePublicationSequences,
  loadCollectibleProfileHead,
  loadPackHead,
  loadPackSnapshot,
  loadProviderProfileHead,
  packHeadEvidence,
  packHeadFields,
  packSnapshotIdentityOf,
  packSnapshotWorkState,
} from "./packCatalogStoreSupport";

/**
 * Authenticated immutable storage for one pack at a time
 * (pack-version-publication/005, tech-003).
 *
 * `start` records a complete descriptor and the wire header; ordered `batch`
 * calls prove and store the contents, accumulating the invariants the P01
 * payload schema would check over the whole pack; `finalize` rebuilds the two
 * contents-derived vectors, recomputes the content digest, and marks the
 * snapshot complete; `activate` is one compare-and-swap over that pack's head.
 * Nothing staged is reachable from any head, and no operation here touches a
 * second pack.
 */

type Kind = Extract<PackCatalogPublicationOperationKind,
  | "start_pack_snapshot" | "apply_pack_snapshot_batch" | "finalize_pack_snapshot"
  | "activate_pack_snapshot" | "pack_publication_status" | "block_pack_snapshot">;

const NO_EVIDENCE = { snapshotId: null, snapshotState: null, packHead: null, profileHead: null, statusOperation: null } as const;

async function run<K extends Kind>(
  ctx: MutationCtx,
  args: ExecutionArgs,
  kind: K,
  handler: (authorized: AuthorizedPackCatalogRequest<K>) => Promise<ReceiptOutcome>,
): Promise<PackCatalogPublicationReceipt> {
  const authorized = await authorizePackCatalogRequest(args, [kind]);
  const replay = await findPackCatalogReplay(ctx, authorized.request, authorized.requestSha256, authorized.now);
  if (replay !== null) return replay;
  const { store, ...outcome } = await handler(authorized);
  const receipt = await buildPackCatalogReceipt({
    request: authorized.request,
    requestSha256: authorized.requestSha256,
    now: authorized.now,
    outcome,
  });
  return store
    ? await storePackCatalogReceipt(ctx, receipt, authorized.authorizationScopeSha256)
    : receipt;
}

function evidence(root: Doc<"publicPackSnapshots">, head: Doc<"activePackHeads"> | null) {
  return { snapshotId: root.publicPackSnapshotId, snapshotState: root.state, packHead: packHeadEvidence(head), profileHead: null, statusOperation: null };
}

function blockedReason(root: Doc<"publicPackSnapshots">): PublicationReasonCode {
  return root.blockReasonCode ?? "INVALID_DOMAIN_DATA";
}

async function block(ctx: MutationCtx, root: Doc<"publicPackSnapshots">, reasonCode: PublicationReasonCode, now: string) {
  await ctx.db.patch("publicPackSnapshots", root._id, { state: "blocked", blockReasonCode: reasonCode, terminalAt: now });
  return { ...root, state: "blocked" as const, blockReasonCode: reasonCode, terminalAt: now };
}

/** First activation re-proves every referenced profile snapshot is the current head. */
async function initialProfileReferencesHold(ctx: MutationCtx, root: Doc<"publicPackSnapshots">): Promise<boolean> {
  const providerHead = await loadProviderProfileHead(ctx, root.providerId);
  if (providerHead === null || providerHead.activeProfileSnapshotId !== root.header.providerProfileSnapshotId) return false;
  const dependencies = await ctx.db.query("publicPackSnapshotBatchDependencies")
    .withIndex("by_public_pack_snapshot_id_and_batch_index", (index) => index.eq("publicPackSnapshotId", root.publicPackSnapshotId))
    .take(root.descriptor.batches.length + 1);
  if (dependencies.length !== root.descriptor.batches.length) return false;
  for (const dependency of dependencies) {
    for (const reference of dependency.collectibleProfiles) {
      const head = await loadCollectibleProfileHead(ctx, reference.publicCollectibleId);
      if (head === null || head.activeProfileSnapshotId !== reference.collectibleProfileSnapshotId) return false;
    }
  }
  return true;
}

export const start = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: (ctx, args) => run(ctx, args, "start_pack_snapshot", async (authorized) => {
    const { request, now } = authorized;
    const { descriptor, header, packPublicationSequence, evidence: sealEvidence } = request.body;
    const identity = descriptor.identity;
    assertProviderScope(authorized, header.providerId);
    const head = await loadPackHead(ctx, header.publicRepackId);
    if (identity.summarySha256 !== await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, header.summaryProjection)) {
      return { ...NO_EVIDENCE, packHead: packHeadEvidence(head), result: refused("INVALID_DOMAIN_DATA"), store: true };
    }
    const existing = await loadPackSnapshot(ctx, identity.publicPackSnapshotId);
    if (existing !== null) {
      if (existing.state === "blocked") {
        return { ...evidence(existing, head), result: refused(blockedReason(existing), "blocked"), store: true };
      }
      const stored = { descriptor: existing.descriptor, header: existing.header };
      const same = packCatalogCanonicalJson(stored) === packCatalogCanonicalJson({ descriptor, header });
      const state = packSnapshotWorkState(existing, head);
      if (!same) return { ...evidence(existing, head), result: conflict(state), store: false };
      const order = comparePublicationSequences(packPublicationSequence, existing.packPublicationSequence);
      if (order < 0) return { ...evidence(existing, head), result: conflict(state), store: true };
      if (order > 0) {
        // The same bytes are desired again under a later sequence: record that
        // declaration so activation can bind to it (byte reuse, distinct intent).
        await ctx.db.patch("publicPackSnapshots", existing._id, { packPublicationSequence, evidence: sealEvidence });
        return { ...evidence(existing, head), result: applied("applied", state), store: true };
      }
      return { ...evidence(existing, head), result: applied("already_applied", state), store: true };
    }
    const required = head === null;
    if (required) {
      const providerHead = await loadProviderProfileHead(ctx, header.providerId);
      if (providerHead === null || providerHead.activeProfileSnapshotId !== header.providerProfileSnapshotId) {
        return { ...NO_EVIDENCE, result: refused("PROFILE_HEAD_MISSING"), store: true };
      }
    }
    const rootId = await ctx.db.insert("publicPackSnapshots", {
      ...identity,
      state: "staging",
      blockReasonCode: null,
      descriptor,
      header,
      packPublicationSequence,
      evidence: sealEvidence,
      receivedBatchCount: 0,
      receivedContentCount: 0,
      probabilityMicrosSum: 0,
      lastPublicCollectibleId: null,
      topChaseCandidate: null,
      categoryIdsSeen: [header.category.publicCategoryId],
      initialProfileProof: { required, providerHeadVerified: required, collectibleHeadsVerified: 0 },
      stagedAt: now,
      completedAt: null,
      deactivatedAt: null,
      displacedBy: null,
      terminalAt: null,
    });
    const root = (await ctx.db.get("publicPackSnapshots", rootId))!;
    return { ...evidence(root, head), result: applied("applied", "publishing"), store: true };
  }),
});

export const applyBatch = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: (ctx, args) => run(ctx, args, "apply_pack_snapshot_batch", async (authorized) => {
    const { request, now } = authorized;
    const { publicRepackId, publicPackSnapshotId, batch } = request.body;
    const root = await loadPackSnapshot(ctx, publicPackSnapshotId);
    const head = await loadPackHead(ctx, publicRepackId);
    assertProviderScope(authorized, root?.providerId ?? head?.providerId);
    if (root === null || root.publicRepackId !== publicRepackId) {
      return { ...NO_EVIDENCE, packHead: packHeadEvidence(head), result: refused("INCOMPLETE_CONTENTS", "waiting"), store: true };
    }
    const state = packSnapshotWorkState(root, head);
    if (root.state === "blocked") return { ...evidence(root, head), result: refused(blockedReason(root), "blocked"), store: true };
    if (batch.batchIndex < root.receivedBatchCount || root.state === "complete") {
      const stored = await ctx.db.query("publicPackSnapshotBatches")
        .withIndex("by_public_pack_snapshot_id_and_batch_index", (index) =>
          index.eq("publicPackSnapshotId", publicPackSnapshotId).eq("batchIndex", batch.batchIndex))
        .take(1);
      const same = stored[0]?.batchSha256 === batch.batchSha256;
      return { ...evidence(root, head), result: same ? applied("already_applied", state) : conflict(state), store: same };
    }
    if (batch.batchIndex !== root.receivedBatchCount) {
      return { ...evidence(root, head), result: conflict(state), store: false };
    }
    const expected = root.descriptor.batches[batch.batchIndex];
    const body = { kind: "contents_batch", providerId: root.providerId, publicRepackId: root.publicRepackId, batchIndex: batch.batchIndex, records: batch.records };
    const ids = batch.records.map(({ publicCollectibleId }) => publicCollectibleId);
    const invalid = expected === undefined ||
      expected.recordCount !== batch.recordCount || expected.byteCount !== batch.byteCount ||
      expected.batchSha256 !== batch.batchSha256 ||
      batch.byteCount !== packCatalogCanonicalByteCount(body) ||
      batch.batchSha256 !== await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, body) ||
      !isCanonicalAscending(ids) ||
      (root.lastPublicCollectibleId !== null && compareCanonicalStrings(root.lastPublicCollectibleId, ids[0]!) >= 0) ||
      batch.records.some(({ valuation }) => valuation.status === "available" && valuation.amount.currency !== root.header.price.currency) ||
      root.receivedContentCount + batch.records.length > root.header.contentCount;
    if (invalid) return { ...evidence(root, head), result: refused("INVALID_DOMAIN_DATA", state), store: true };
    const probabilityMicrosSum = root.probabilityMicrosSum + batch.records.reduce((sum, { probabilityMicros }) => sum + probabilityMicros, 0);
    if (probabilityMicrosSum > 1_000_000) {
      return { ...evidence(root, head), result: refused("INVALID_PROBABILITIES", state), store: true };
    }
    if (root.initialProfileProof.required) {
      for (const record of batch.records) {
        const profileHead = await loadCollectibleProfileHead(ctx, record.publicCollectibleId);
        if (profileHead === null || profileHead.activeProfileSnapshotId !== record.collectibleProfileSnapshotId) {
          return { ...evidence(root, head), result: refused("PROFILE_HEAD_MISSING", "waiting"), store: true };
        }
      }
    }
    let topChaseCandidate = root.topChaseCandidate;
    for (const record of batch.records) {
      if (!record.eligibleForChase || record.valuation.status !== "available") continue;
      const candidate = { publicCollectibleId: record.publicCollectibleId, valuationIdentity: record.valuation.valuationIdentity, amount: record.valuation.amount };
      if (topChaseCandidate === null || candidate.amount.minorUnits > topChaseCandidate.amount.minorUnits ||
        (candidate.amount.minorUnits === topChaseCandidate.amount.minorUnits &&
          compareCanonicalStrings(candidate.publicCollectibleId, topChaseCandidate.publicCollectibleId) < 0)) {
        topChaseCandidate = candidate;
      }
    }
    const categoryIdsSeen = [...new Set([...root.categoryIdsSeen, ...batch.records.map(({ category }) => category.publicCategoryId)])]
      .sort(compareCanonicalStrings).slice(0, 101);
    await ctx.db.insert("publicPackSnapshotBatches", {
      publicPackSnapshotId, batchIndex: batch.batchIndex, recordCount: batch.recordCount,
      byteCount: batch.byteCount, batchSha256: batch.batchSha256, records: batch.records,
    });
    await ctx.db.insert("publicPackSnapshotBatchDependencies", {
      publicPackSnapshotId,
      batchIndex: batch.batchIndex,
      collectibleProfileSnapshotIds: batch.records.map(({ collectibleProfileSnapshotId }) => collectibleProfileSnapshotId).sort(compareCanonicalStrings),
      valuationDependencyIdentities: batch.records.filter(({ eligibleForChase }) => eligibleForChase)
        .map(({ valuation }) => valuation.valuationIdentity).sort(compareCanonicalStrings),
      collectibleProfiles: batch.records.map(({ publicCollectibleId, collectibleProfileSnapshotId }) => ({ publicCollectibleId, collectibleProfileSnapshotId })),
    });
    for (const record of batch.records) {
      await ctx.db.insert("publicPackMemberships", {
        publicCollectibleId: record.publicCollectibleId, publicRepackId, publicPackSnapshotId, providerId: root.providerId,
      });
    }
    await ctx.db.patch("publicPackSnapshots", root._id, {
      receivedBatchCount: root.receivedBatchCount + 1,
      receivedContentCount: root.receivedContentCount + batch.records.length,
      probabilityMicrosSum,
      lastPublicCollectibleId: ids[ids.length - 1]!,
      topChaseCandidate,
      categoryIdsSeen,
      initialProfileProof: {
        ...root.initialProfileProof,
        collectibleHeadsVerified: root.initialProfileProof.collectibleHeadsVerified +
          (root.initialProfileProof.required ? batch.records.length : 0),
      },
    });
    void now;
    return { ...evidence(root, head), result: applied("applied", "publishing"), store: true };
  }),
});

export const finalize = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: (ctx, args) => run(ctx, args, "finalize_pack_snapshot", async (authorized) => {
    const { request, now } = authorized;
    const { snapshot } = request.body;
    assertProviderScope(authorized, snapshot.providerId);
    const root = await loadPackSnapshot(ctx, snapshot.publicPackSnapshotId);
    const head = await loadPackHead(ctx, snapshot.publicRepackId);
    if (root === null) return { ...NO_EVIDENCE, packHead: packHeadEvidence(head), result: refused("INCOMPLETE_CONTENTS", "waiting"), store: true };
    if (packCatalogCanonicalJson(packSnapshotIdentityOf(root)) !== packCatalogCanonicalJson(snapshot)) {
      return { ...evidence(root, head), result: refused("INVALID_DOMAIN_DATA", packSnapshotWorkState(root, head)), store: true };
    }
    if (root.state === "blocked") return { ...evidence(root, head), result: refused(blockedReason(root), "blocked"), store: true };
    if (root.state === "complete") return { ...evidence(root, head), result: applied("already_applied", packSnapshotWorkState(root, head)), store: true };
    const manifest = root.descriptor.batches;
    if (root.receivedBatchCount !== manifest.length || root.receivedContentCount !== root.header.contentCount) {
      return { ...evidence(root, head), result: refused("INCOMPLETE_CONTENTS", "publishing"), store: true };
    }
    const permanentlyInvalid = async (reasonCode: PublicationReasonCode) => {
      const blocked = await block(ctx, root, reasonCode, now);
      return { ...evidence(blocked, head), result: refused(reasonCode, "blocked"), store: true };
    };
    if (root.probabilityMicrosSum !== 1_000_000) return await permanentlyInvalid("INVALID_PROBABILITIES");
    const dependencies = await ctx.db.query("publicPackSnapshotBatchDependencies")
      .withIndex("by_public_pack_snapshot_id_and_batch_index", (index) =>
        index.eq("publicPackSnapshotId", root.publicPackSnapshotId))
      .take(manifest.length + 1);
    const collectibleProfileSnapshotIds = dependencies.flatMap((row) => row.collectibleProfileSnapshotIds).sort(compareCanonicalStrings);
    const valuationDependencyIdentities = [...new Set(dependencies.flatMap((row) => row.valuationDependencyIdentities))].sort(compareCanonicalStrings);
    const expectedCategoryIds = [...root.categoryIdsSeen].sort(compareCanonicalStrings);
    if (dependencies.length !== manifest.length ||
      !isCanonicalAscending(collectibleProfileSnapshotIds) ||
      collectibleProfileSnapshotIds.length !== root.header.contentCount ||
      valuationDependencyIdentities.length !== root.descriptor.valuationDependencyCount ||
      packCatalogCanonicalJson(root.topChaseCandidate) !== packCatalogCanonicalJson(root.header.topChase) ||
      packCatalogCanonicalJson(expectedCategoryIds) !== packCatalogCanonicalJson(root.header.searchProjection.categoryIds)) {
      return await permanentlyInvalid("INVALID_DOMAIN_DATA");
    }
    const header = { ...root.header, collectibleProfileSnapshotIds, valuationDependencyIdentities };
    const contentSha256 = await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, {
      kind: "complete_pack",
      header,
      batches: manifest.map(({ batchIndex, recordCount, byteCount, batchSha256 }) => ({ batchIndex, recordCount, byteCount, batchSha256 })),
    });
    if (contentSha256 !== root.contentSha256) return await permanentlyInvalid("INVALID_DOMAIN_DATA");
    await ctx.db.patch("publicPackSnapshots", root._id, { state: "complete", completedAt: now, terminalAt: now });
    const complete = { ...root, state: "complete" as const, completedAt: now, terminalAt: now };
    return { ...evidence(complete, head), result: applied("applied", packSnapshotWorkState(complete, head)), store: true };
  }),
});

export const activate = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: (ctx, args) => run(ctx, args, "activate_pack_snapshot", async (authorized) => {
    const { request, now } = authorized;
    const { intent } = request.body;
    assertProviderScope(authorized, intent.snapshot.providerId);
    const root = await loadPackSnapshot(ctx, intent.snapshot.publicPackSnapshotId);
    const head = await loadPackHead(ctx, intent.snapshot.publicRepackId);
    if (root === null || root.state === "staging") {
      return { ...(root === null ? NO_EVIDENCE : evidence(root, head)), packHead: packHeadEvidence(head), result: refused("INCOMPLETE_CONTENTS", "publishing"), store: true };
    }
    const state = packSnapshotWorkState(root, head);
    if (root.state === "blocked") return { ...evidence(root, head), result: refused(blockedReason(root), "blocked"), store: true };
    if (packCatalogCanonicalJson(packSnapshotIdentityOf(root)) !== packCatalogCanonicalJson(intent.snapshot) ||
      intent.evidence.packPublicationSequence !== intent.packPublicationSequence) {
      return { ...evidence(root, head), result: refused("INVALID_DOMAIN_DATA", state), store: true };
    }
    if (Date.parse(intent.expiresAt) <= Date.parse(now)) {
      return { ...evidence(root, head), result: refused("OPERATION_EXPIRED", state), store: true };
    }
    // Activation binds to the desired state that staged (or re-declared) these
    // exact bytes: the same provider-local sequence and the same evidence.
    if (intent.packPublicationSequence !== root.packPublicationSequence ||
      packCatalogCanonicalJson(intent.evidence) !== packCatalogCanonicalJson(root.evidence)) {
      return { ...evidence(root, head), result: conflict(state), store: true };
    }
    // The sealed EV evidence must still be valid when the activation was created.
    if (Date.parse(intent.createdAt) >= Date.parse(root.header.ev.validUntil)) {
      return { ...evidence(root, head), result: refused("EV_INPUTS_PENDING", "waiting"), store: true };
    }
    const expected = intent.expectedHead;
    if (head === null) {
      if (expected.generation !== 0 || expected.publicationEpoch !== 0 || expected.activeSnapshotId !== null) {
        return { ...evidence(root, head), result: conflict(state), store: true };
      }
      const proof = root.initialProfileProof;
      if (!proof.required || !proof.providerHeadVerified || proof.collectibleHeadsVerified !== root.header.contentCount ||
        !(await initialProfileReferencesHold(ctx, root))) {
        return { ...evidence(root, head), result: refused("PROFILE_HEAD_MISSING", "waiting"), store: true };
      }
    } else {
      if (head.held) return { ...evidence(root, head), result: refused("OPERATOR_HOLD", "waiting"), store: true };
      if (expected.generation !== head.generation || expected.publicationEpoch !== head.publicationEpoch ||
        expected.activeSnapshotId !== head.activeSnapshot.publicPackSnapshotId) {
        return { ...evidence(root, head), result: conflict(state), store: true };
      }
      const advances = comparePublicationSequences(intent.packPublicationSequence, head.latestAcceptedPackPublicationSequence) > 0;
      if (head.activeSnapshot.publicPackSnapshotId === root.publicPackSnapshotId) {
        if (advances) {
          await ctx.db.patch("activePackHeads", head._id, { latestAcceptedPackPublicationSequence: intent.packPublicationSequence });
        }
        const current = await loadPackHead(ctx, root.publicRepackId);
        return { ...evidence(root, current), result: applied("already_active", "published"), store: true };
      }
      if (!advances) return { ...evidence(root, head), result: conflict(state), store: true };
    }
    const fields = packHeadFields({
      root, previous: head, generation: (head?.generation ?? 0) + 1, publicationEpoch: head?.publicationEpoch ?? 0,
      held: false, latestAcceptedPackPublicationSequence: intent.packPublicationSequence, activatedAt: now,
    });
    if (head === null) await ctx.db.insert("activePackHeads", fields);
    else await ctx.db.replace("activePackHeads", head._id, fields);
    if (head !== null) {
      const displaced = await loadPackSnapshot(ctx, head.activeSnapshot.publicPackSnapshotId);
      if (displaced !== null) await ctx.db.patch("publicPackSnapshots", displaced._id, { deactivatedAt: now, displacedBy: "activation" });
    }
    await ctx.db.patch("publicPackSnapshots", root._id, { deactivatedAt: null, displacedBy: null });
    const current = await loadPackHead(ctx, root.publicRepackId);
    return { ...evidence(root, current), result: applied("applied", "published"), store: true };
  }),
});

export const status = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: (ctx, args) => run(ctx, args, "pack_publication_status", async (authorized) => {
    const { request, now } = authorized;
    const { publicRepackId, publicPackSnapshotId, operation } = request.body;
    const head = await loadPackHead(ctx, publicRepackId);
    const root = publicPackSnapshotId === null ? null : await loadPackSnapshot(ctx, publicPackSnapshotId);
    assertProviderScope(authorized, head?.providerId ?? root?.providerId);
    const snapshot = root !== null && root.publicRepackId === publicRepackId ? root : null;
    return {
      snapshotId: snapshot?.publicPackSnapshotId ?? null,
      snapshotState: snapshot?.state ?? null,
      packHead: packHeadEvidence(head),
      profileHead: null,
      statusOperation: await describeOperation(ctx, operation, now),
      result: applied("applied", snapshot !== null ? packSnapshotWorkState(snapshot, head) : head !== null ? "published" : "waiting"),
      store: false,
    };
  }),
});

export const blockSnapshot = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: (ctx, args) => run(ctx, args, "block_pack_snapshot", async (authorized) => {
    const { request, now } = authorized;
    const { publicRepackId, publicPackSnapshotId, reasonCode } = request.body;
    const root = await loadPackSnapshot(ctx, publicPackSnapshotId);
    const head = await loadPackHead(ctx, publicRepackId);
    assertProviderScope(authorized, root?.providerId ?? head?.providerId);
    if (root === null || root.publicRepackId !== publicRepackId) {
      return { ...NO_EVIDENCE, packHead: packHeadEvidence(head), result: refused("INCOMPLETE_CONTENTS", "waiting"), store: true };
    }
    if (root.state === "blocked") return { ...evidence(root, head), result: applied("already_applied", "blocked"), store: true };
    if (head?.activeSnapshot.publicPackSnapshotId === root.publicPackSnapshotId) {
      return { ...evidence(root, head), result: conflict("published"), store: true };
    }
    const blocked = await block(ctx, root, reasonCode, now);
    return { ...evidence(blocked, head), result: applied("applied", "blocked"), store: true };
  }),
});
