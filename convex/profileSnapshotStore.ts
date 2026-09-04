import {
  PROFILE_SNAPSHOT_HASH_DOMAIN,
  hashPackCatalogValue,
  normalizePackCatalogSearchText,
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
  authorizePackCatalogRequest,
  type AuthorizedPackCatalogRequest,
  type ExecutionArgs,
} from "./packCatalogPublicationAuth";
import {
  applied,
  buildPackCatalogReceipt,
  conflict,
  describeOperation,
  findPackCatalogReplay,
  refused,
  storePackCatalogReceipt,
  type ReceiptOutcome,
} from "./packCatalogOperationStore";
import {
  EXECUTION_ARGS,
  loadCollectibleProfileHead,
  loadProfileSnapshot,
  loadProviderProfileHead,
  profileHeadEvidence,
  profileSnapshotWorkState,
} from "./packCatalogStoreSupport";

/**
 * Authenticated immutable storage for provider and collectible profiles
 * (pack-version-publication/005). A profile is one record, so its single
 * batch carries the complete profile; activation is one compare-and-swap over
 * that stable identity's head and never touches a pack head or another
 * profile. Provider-scoped keys publish provider profiles; the catalog scope
 * publishes collectible profiles.
 */

type Kind = Extract<PackCatalogPublicationOperationKind,
  | "start_profile_snapshot" | "apply_profile_snapshot_batch" | "finalize_profile_snapshot"
  | "activate_profile_snapshot" | "profile_publication_status" | "block_profile_snapshot">;
type ProfileRef = { profileKind: "provider"; providerId: string } | { profileKind: "collectible"; publicCollectibleId: string };
type ProfileHead = Doc<"activeProviderProfileHeads"> | Doc<"activeCollectibleProfileHeads"> | null;
type StoredProfile = NonNullable<Doc<"publicProfileSnapshots">["profile"]>;

function isProviderProfile(profile: StoredProfile): profile is Extract<StoredProfile, { identity: { profileKind: "provider" } }> {
  return profile.identity.profileKind === "provider";
}

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

function entityIdOf(ref: ProfileRef): string {
  return ref.profileKind === "provider" ? ref.providerId : ref.publicCollectibleId;
}

async function loadHead(ctx: MutationCtx, ref: ProfileRef): Promise<ProfileHead> {
  return ref.profileKind === "provider"
    ? await loadProviderProfileHead(ctx, ref.providerId)
    : await loadCollectibleProfileHead(ctx, ref.publicCollectibleId);
}

function evidence(root: Doc<"publicProfileSnapshots"> | null, head: ProfileHead) {
  return { snapshotId: root?.publicProfileSnapshotId ?? null, snapshotState: root?.state ?? null, packHead: null, profileHead: profileHeadEvidence(head), statusOperation: null };
}

function state(root: Doc<"publicProfileSnapshots">, head: ProfileHead) {
  return profileSnapshotWorkState(root, head?.activeProfileSnapshotId ?? null);
}

async function block(ctx: MutationCtx, root: Doc<"publicProfileSnapshots">, reasonCode: PublicationReasonCode, now: string) {
  await ctx.db.patch("publicProfileSnapshots", root._id, { state: "blocked", blockReasonCode: reasonCode, terminalAt: now });
  return { ...root, state: "blocked" as const, blockReasonCode: reasonCode, terminalAt: now };
}

export const start = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: (ctx, args) => run(ctx, args, "start_profile_snapshot", async ({ request, now }) => {
    const { descriptor } = request.body;
    const identity = descriptor.identity;
    const head = await loadHead(ctx, identity);
    const existing = await loadProfileSnapshot(ctx, identity.publicProfileSnapshotId);
    if (existing !== null) {
      if (existing.state === "blocked") return { ...evidence(existing, head), result: refused(existing.blockReasonCode ?? "INVALID_DOMAIN_DATA", "blocked"), store: true };
      const same = packCatalogCanonicalJson(existing.descriptor) === packCatalogCanonicalJson(descriptor);
      return { ...evidence(existing, head), result: same ? applied("already_applied", state(existing, head)) : conflict(state(existing, head)), store: same };
    }
    const rootId = await ctx.db.insert("publicProfileSnapshots", {
      profileKind: identity.profileKind,
      entityId: entityIdOf(identity),
      publicProfileSnapshotId: identity.publicProfileSnapshotId,
      contentSha256: identity.contentSha256,
      sourceIdentity: identity.sourceIdentity,
      dataAsOf: identity.dataAsOf,
      state: "staging",
      blockReasonCode: null,
      descriptor,
      profile: null,
      stagedAt: now,
      completedAt: null,
      deactivatedAt: null,
      terminalAt: null,
    });
    const root = (await ctx.db.get("publicProfileSnapshots", rootId))!;
    return { ...evidence(root, head), result: applied("applied", "publishing"), store: true };
  }),
});

export const applyBatch = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: (ctx, args) => run(ctx, args, "apply_profile_snapshot_batch", async ({ request, now }) => {
    const { publicProfileSnapshotId, batch } = request.body;
    const root = await loadProfileSnapshot(ctx, publicProfileSnapshotId);
    const profile = batch.profile;
    const head = await loadHead(ctx, profile.identity);
    if (root === null) return { ...NO_EVIDENCE, profileHead: profileHeadEvidence(head), result: refused("INCOMPLETE_CONTENTS", "waiting"), store: true };
    if (root.state === "blocked") return { ...evidence(root, head), result: refused(root.blockReasonCode ?? "INVALID_DOMAIN_DATA", "blocked"), store: true };
    if (root.profile !== null) {
      const same = packCatalogCanonicalJson(root.profile) === packCatalogCanonicalJson(profile);
      return { ...evidence(root, head), result: same ? applied("already_applied", state(root, head)) : conflict(state(root, head)), store: same };
    }
    const { identity, ...fields } = profile;
    const source = {
      profileKind: identity.profileKind,
      sourceIdentity: identity.sourceIdentity,
      dataAsOf: identity.dataAsOf,
      ...(identity.profileKind === "provider" ? { providerId: identity.providerId } : { publicCollectibleId: identity.publicCollectibleId }),
    };
    const body = { kind: "profile_batch", profile };
    const manifest = root.descriptor.batch;
    const invalid = packCatalogCanonicalJson(identity) !== packCatalogCanonicalJson(root.descriptor.identity) ||
      manifest.byteCount !== batch.byteCount || manifest.batchSha256 !== batch.batchSha256 ||
      batch.byteCount !== packCatalogCanonicalByteCount(body) ||
      batch.batchSha256 !== await hashPackCatalogValue(PROFILE_SNAPSHOT_HASH_DOMAIN, body) ||
      identity.contentSha256 !== await hashPackCatalogValue(PROFILE_SNAPSHOT_HASH_DOMAIN, { ...source, ...fields });
    if (invalid) {
      const blocked = await block(ctx, root, "INVALID_DOMAIN_DATA", now);
      return { ...evidence(blocked, head), result: refused("INVALID_DOMAIN_DATA", "blocked"), store: true };
    }
    await ctx.db.patch("publicProfileSnapshots", root._id, { profile });
    return { ...evidence({ ...root, profile }, head), result: applied("applied", "publishing"), store: true };
  }),
});

export const finalize = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: (ctx, args) => run(ctx, args, "finalize_profile_snapshot", async ({ request, now }) => {
    const identity = request.body.profile;
    const root = await loadProfileSnapshot(ctx, identity.publicProfileSnapshotId);
    const head = await loadHead(ctx, identity);
    if (root === null) return { ...NO_EVIDENCE, profileHead: profileHeadEvidence(head), result: refused("INCOMPLETE_CONTENTS", "waiting"), store: true };
    if (packCatalogCanonicalJson(root.descriptor.identity) !== packCatalogCanonicalJson(identity)) {
      return { ...evidence(root, head), result: refused("INVALID_DOMAIN_DATA", state(root, head)), store: true };
    }
    if (root.state === "blocked") return { ...evidence(root, head), result: refused(root.blockReasonCode ?? "INVALID_DOMAIN_DATA", "blocked"), store: true };
    if (root.state === "complete") return { ...evidence(root, head), result: applied("already_applied", state(root, head)), store: true };
    if (root.profile === null) return { ...evidence(root, head), result: refused("INCOMPLETE_CONTENTS", "publishing"), store: true };
    await ctx.db.patch("publicProfileSnapshots", root._id, { state: "complete", completedAt: now, terminalAt: now });
    const complete = { ...root, state: "complete" as const, completedAt: now, terminalAt: now };
    return { ...evidence(complete, head), result: applied("applied", state(complete, head)), store: true };
  }),
});

export const activate = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: (ctx, args) => run(ctx, args, "activate_profile_snapshot", async ({ request, now }) => {
    const { intent } = request.body;
    const root = await loadProfileSnapshot(ctx, intent.profile.publicProfileSnapshotId);
    const head = await loadHead(ctx, intent.profile);
    if (root === null || root.state === "staging") {
      return { ...evidence(root, head), result: refused("INCOMPLETE_CONTENTS", "publishing"), store: true };
    }
    if (root.state === "blocked" || root.profile === null) {
      return { ...evidence(root, head), result: refused(root.blockReasonCode ?? "INVALID_DOMAIN_DATA", "blocked"), store: true };
    }
    if (packCatalogCanonicalJson(root.descriptor.identity) !== packCatalogCanonicalJson(intent.profile)) {
      return { ...evidence(root, head), result: refused("INVALID_DOMAIN_DATA", state(root, head)), store: true };
    }
    if (Date.parse(intent.expiresAt) <= Date.parse(now)) {
      return { ...evidence(root, head), result: refused("OPERATION_EXPIRED", state(root, head)), store: true };
    }
    if (intent.expectedGeneration !== (head?.generation ?? 0)) {
      return { ...evidence(root, head), result: conflict(state(root, head)), store: true };
    }
    if (head?.activeProfileSnapshotId === root.publicProfileSnapshotId) {
      return { ...evidence(root, head), result: applied("already_active", "published"), store: true };
    }
    const common = {
      generation: (head?.generation ?? 0) + 1,
      activeProfileSnapshotId: root.publicProfileSnapshotId,
      previousProfileSnapshotId: head?.activeProfileSnapshotId ?? null,
      contentSha256: root.contentSha256,
      activatedAt: now,
    };
    const profile = root.profile;
    if (isProviderProfile(profile)) {
      const fields = { providerId: profile.identity.providerId, ...common };
      if (head === null) await ctx.db.insert("activeProviderProfileHeads", fields);
      else await ctx.db.replace("activeProviderProfileHeads", head._id as Doc<"activeProviderProfileHeads">["_id"], fields);
    } else {
      const fields = {
        publicCollectibleId: profile.identity.publicCollectibleId,
        ...common,
        searchText: profile.searchText,
        sortDisplayName: normalizePackCatalogSearchText(profile.displayName),
        publicCategoryId: profile.category.publicCategoryId,
      };
      if (head === null) await ctx.db.insert("activeCollectibleProfileHeads", fields);
      else await ctx.db.replace("activeCollectibleProfileHeads", head._id as Doc<"activeCollectibleProfileHeads">["_id"], fields);
    }
    if (head !== null) {
      const displaced = await loadProfileSnapshot(ctx, head.activeProfileSnapshotId);
      if (displaced !== null) await ctx.db.patch("publicProfileSnapshots", displaced._id, { deactivatedAt: now });
    }
    await ctx.db.patch("publicProfileSnapshots", root._id, { deactivatedAt: null });
    return { ...evidence(root, await loadHead(ctx, intent.profile)), result: applied("applied", "published"), store: true };
  }),
});

export const status = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: (ctx, args) => run(ctx, args, "profile_publication_status", async ({ request, now }) => {
    const { profile, publicProfileSnapshotId, operation } = request.body;
    const head = await loadHead(ctx, profile);
    const root = publicProfileSnapshotId === null ? null : await loadProfileSnapshot(ctx, publicProfileSnapshotId);
    const snapshot = root !== null && root.profileKind === profile.profileKind && root.entityId === entityIdOf(profile) ? root : null;
    return {
      ...evidence(snapshot, head),
      statusOperation: await describeOperation(ctx, operation, now),
      result: applied("applied", snapshot !== null ? state(snapshot, head) : head !== null ? "published" : "waiting"),
      store: false,
    };
  }),
});

export const blockSnapshot = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: (ctx, args) => run(ctx, args, "block_profile_snapshot", async ({ request, now }) => {
    const { profile, publicProfileSnapshotId, reasonCode } = request.body;
    const root = await loadProfileSnapshot(ctx, publicProfileSnapshotId);
    const head = await loadHead(ctx, profile);
    if (root === null || root.profileKind !== profile.profileKind || root.entityId !== entityIdOf(profile)) {
      return { ...NO_EVIDENCE, profileHead: profileHeadEvidence(head), result: refused("INCOMPLETE_CONTENTS", "waiting"), store: true };
    }
    if (root.state === "blocked") return { ...evidence(root, head), result: applied("already_applied", "blocked"), store: true };
    if (head?.activeProfileSnapshotId === root.publicProfileSnapshotId) return { ...evidence(root, head), result: conflict("published"), store: true };
    const blocked = await block(ctx, root, reasonCode, now);
    return { ...evidence(blocked, head), result: applied("applied", "blocked"), store: true };
  }),
});
