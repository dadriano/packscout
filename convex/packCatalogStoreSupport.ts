import {
  compareCanonicalStrings,
  normalizePackCatalogSearchText,
  type PublicationWorkState,
} from "@packscout/contracts";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { refusePackCatalog } from "./packCatalogErrors";

/** Shared row loaders, evidence projections, and head construction for the V1 store. */

export const EXECUTION_ARGS = {
  bodyJson: v.string(),
  requestDigest: v.string(),
  authenticatedKeyId: v.string(),
} as const;

type Ctx = QueryCtx | MutationCtx;

function unique<T>(rows: readonly T[]): T | null {
  if (rows.length > 1) refusePackCatalog("PACK_CATALOG_STATE_CONFLICT");
  return rows[0] ?? null;
}

/** Provider-local publication sequences are decimal strings; compare numerically. */
export function comparePublicationSequences(left: string, right: string): number {
  return left.length - right.length || compareCanonicalStrings(left, right);
}

export async function loadPackSnapshot(
  ctx: Ctx,
  publicPackSnapshotId: string,
): Promise<Doc<"publicPackSnapshots"> | null> {
  return unique(await ctx.db
    .query("publicPackSnapshots")
    .withIndex("by_public_pack_snapshot_id", (index) =>
      index.eq("publicPackSnapshotId", publicPackSnapshotId))
    .take(2));
}

export async function loadPackHead(
  ctx: Ctx,
  publicRepackId: string,
): Promise<Doc<"activePackHeads"> | null> {
  return unique(await ctx.db
    .query("activePackHeads")
    .withIndex("by_public_repack_id", (index) => index.eq("publicRepackId", publicRepackId))
    .take(2));
}

export async function loadProviderProfileHead(
  ctx: Ctx,
  providerId: string,
): Promise<Doc<"activeProviderProfileHeads"> | null> {
  return unique(await ctx.db
    .query("activeProviderProfileHeads")
    .withIndex("by_provider_id", (index) => index.eq("providerId", providerId))
    .take(2));
}

export async function loadCollectibleProfileHead(
  ctx: Ctx,
  publicCollectibleId: string,
): Promise<Doc<"activeCollectibleProfileHeads"> | null> {
  return unique(await ctx.db
    .query("activeCollectibleProfileHeads")
    .withIndex("by_public_collectible_id", (index) =>
      index.eq("publicCollectibleId", publicCollectibleId))
    .take(2));
}

export async function loadProfileSnapshot(
  ctx: Ctx,
  publicProfileSnapshotId: string,
): Promise<Doc<"publicProfileSnapshots"> | null> {
  return unique(await ctx.db
    .query("publicProfileSnapshots")
    .withIndex("by_public_profile_snapshot_id", (index) =>
      index.eq("publicProfileSnapshotId", publicProfileSnapshotId))
    .take(2));
}

export function packSnapshotIdentityOf(root: Doc<"publicPackSnapshots">) {
  return {
    providerId: root.providerId,
    publicRepackId: root.publicRepackId,
    publicPackSnapshotId: root.publicPackSnapshotId,
    contentSha256: root.contentSha256,
    summarySha256: root.summarySha256,
    dataAsOf: root.dataAsOf,
    evMethodIdentity: root.evMethodIdentity,
    evPolicyIdentity: root.evPolicyIdentity,
  };
}

export function packHeadEvidence(head: Doc<"activePackHeads"> | null) {
  return head === null ? null : {
    generation: head.generation,
    publicationEpoch: head.publicationEpoch,
    held: head.held,
    activeSnapshotId: head.activeSnapshot.publicPackSnapshotId,
    previousSnapshotId: head.previousSnapshot?.publicPackSnapshotId ?? null,
    latestAcceptedPackPublicationSequence: head.latestAcceptedPackPublicationSequence,
    activatedAt: head.activatedAt,
  };
}

export function profileHeadEvidence(
  head: Doc<"activeProviderProfileHeads"> | Doc<"activeCollectibleProfileHeads"> | null,
) {
  return head === null ? null : {
    generation: head.generation,
    activeProfileSnapshotId: head.activeProfileSnapshotId,
    previousProfileSnapshotId: head.previousProfileSnapshotId,
    activatedAt: head.activatedAt,
  };
}

/** The P01 durable work state one pack snapshot is in, relative to its head. */
export function packSnapshotWorkState(
  root: Doc<"publicPackSnapshots">,
  head: Doc<"activePackHeads"> | null,
): PublicationWorkState {
  if (root.state === "staging") return "publishing";
  if (root.state === "blocked") return "blocked";
  if (head?.activeSnapshot.publicPackSnapshotId === root.publicPackSnapshotId) return "published";
  if (root.deactivatedAt !== null) return root.displacedBy === "rollback" ? "rolled_back" : "superseded";
  return "ready";
}

export function profileSnapshotWorkState(
  root: Doc<"publicProfileSnapshots">,
  activeProfileSnapshotId: string | null,
): PublicationWorkState {
  if (root.state === "staging") return "publishing";
  if (root.state === "blocked") return "blocked";
  if (activeProfileSnapshotId === root.publicProfileSnapshotId) return "published";
  return root.deactivatedAt !== null ? "superseded" : "ready";
}

/** Head fields for activating one complete snapshot; the caller supplies the concurrency evidence. */
export function packHeadFields(input: {
  readonly root: Doc<"publicPackSnapshots">;
  readonly previous: Doc<"activePackHeads"> | null;
  readonly generation: number;
  readonly publicationEpoch: number;
  readonly held: boolean;
  readonly latestAcceptedPackPublicationSequence: string;
  readonly activatedAt: string;
}) {
  const header = input.root.header;
  const summary = header.summaryProjection;
  return {
    providerId: input.root.providerId,
    publicRepackId: input.root.publicRepackId,
    generation: input.generation,
    publicationEpoch: input.publicationEpoch,
    held: input.held,
    holdReason: input.held ? "OPERATOR_HOLD" as const : null,
    latestAcceptedPackPublicationSequence: input.latestAcceptedPackPublicationSequence,
    activeSnapshot: packSnapshotIdentityOf(input.root),
    previousSnapshot: input.previous?.activeSnapshot ?? null,
    indexableSummary: summary,
    activatedAt: input.activatedAt,
    normalizedText: header.searchProjection.normalizedText,
    aliases: header.searchProjection.aliases,
    categoryIds: header.searchProjection.categoryIds,
    availability: summary.lifecycle.availability,
    retirement: summary.lifecycle.retirement,
    sortTitle: normalizePackCatalogSearchText(summary.title),
    sortPrice: summary.price.minorUnits,
    sortEv: summary.ev.status === "available" ? summary.ev.amount.minorUnits : -1,
    sortTopChase: summary.topChase?.amount.minorUnits ?? -1,
  };
}
