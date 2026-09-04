import type { PackCatalogPublicationOperationKind, PackCatalogPublicationReceipt } from "@packscout/contracts";
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
  refused,
  storePackCatalogReceipt,
  type ReceiptOutcome,
} from "./packCatalogOperationStore";
import {
  EXECUTION_ARGS,
  loadPackHead,
  loadPackSnapshot,
  packHeadEvidence,
  packHeadFields,
} from "./packCatalogStoreSupport";

/**
 * Fenced per-pack recovery (pack-version-publication/005, tech-003). Holding a
 * head increments its publication epoch so every activation prepared under
 * the old epoch is refused; retained activation may select only the exact
 * immediate previous complete snapshot while held; resume releases only the
 * exact held generation and epoch. Each command touches one pack head.
 */

type Kind = Extract<PackCatalogPublicationOperationKind,
  "hold_pack_head" | "activate_retained_pack_snapshot" | "resume_pack_head">;

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

function evidence(head: Doc<"activePackHeads"> | null, snapshotId: string | null = head?.activeSnapshot.publicPackSnapshotId ?? null) {
  return { snapshotId, snapshotState: head === null ? null : "complete" as const, packHead: packHeadEvidence(head), profileHead: null, statusOperation: null };
}

function expectationMatches(
  head: Doc<"activePackHeads">,
  expectation: { readonly expectedGeneration: number; readonly expectedPublicationEpoch: number },
): boolean {
  return head.generation === expectation.expectedGeneration &&
    head.publicationEpoch === expectation.expectedPublicationEpoch;
}

export const hold = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: (ctx, args) => run(ctx, args, "hold_pack_head", async (authorized) => {
    const { request } = authorized;
    const head = await loadPackHead(ctx, request.body.publicRepackId);
    assertProviderScope(authorized, head?.providerId);
    if (head === null || head.held || !expectationMatches(head, request.body)) {
      return { ...evidence(head), result: conflict(head === null ? "waiting" : "published"), store: true };
    }
    await ctx.db.patch("activePackHeads", head._id, {
      held: true,
      holdReason: "OPERATOR_HOLD",
      publicationEpoch: head.publicationEpoch + 1,
    });
    return { ...evidence(await loadPackHead(ctx, head.publicRepackId)), result: applied("applied", "published"), store: true };
  }),
});

export const activateRetained = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: (ctx, args) => run(ctx, args, "activate_retained_pack_snapshot", async (authorized) => {
    const { request, now } = authorized;
    const head = await loadPackHead(ctx, request.body.publicRepackId);
    assertProviderScope(authorized, head?.providerId);
    if (head === null || !head.held || !expectationMatches(head, request.body) ||
      head.previousSnapshot === null || head.previousSnapshot.publicPackSnapshotId !== request.body.targetSnapshotId) {
      return { ...evidence(head, request.body.targetSnapshotId), result: conflict(head === null ? "waiting" : "published"), store: true };
    }
    const target = await loadPackSnapshot(ctx, request.body.targetSnapshotId);
    if (target === null || target.state !== "complete") {
      return { ...evidence(head, request.body.targetSnapshotId), result: refused(target?.state === "blocked" ? target.blockReasonCode ?? "INVALID_DOMAIN_DATA" : "INCOMPLETE_CONTENTS", "blocked"), store: true };
    }
    await ctx.db.replace("activePackHeads", head._id, packHeadFields({
      root: target,
      previous: head,
      generation: head.generation + 1,
      publicationEpoch: head.publicationEpoch,
      held: true,
      latestAcceptedPackPublicationSequence: head.latestAcceptedPackPublicationSequence,
      activatedAt: now,
    }));
    const displaced = await loadPackSnapshot(ctx, head.activeSnapshot.publicPackSnapshotId);
    if (displaced !== null) await ctx.db.patch("publicPackSnapshots", displaced._id, { deactivatedAt: now, displacedBy: "rollback" });
    await ctx.db.patch("publicPackSnapshots", target._id, { deactivatedAt: null, displacedBy: null });
    return { ...evidence(await loadPackHead(ctx, head.publicRepackId)), result: applied("applied", "published"), store: true };
  }),
});

export const resume = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: (ctx, args) => run(ctx, args, "resume_pack_head", async (authorized) => {
    const { request } = authorized;
    const head = await loadPackHead(ctx, request.body.publicRepackId);
    assertProviderScope(authorized, head?.providerId);
    if (head === null || !head.held || !expectationMatches(head, request.body)) {
      return { ...evidence(head), result: conflict(head === null ? "waiting" : "published"), store: true };
    }
    await ctx.db.patch("activePackHeads", head._id, { held: false, holdReason: null });
    return { ...evidence(await loadPackHead(ctx, head.publicRepackId)), result: applied("applied", "published"), store: true };
  }),
});
