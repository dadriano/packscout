import { paginationOptsValidator } from "convex/server";
import { v, type Infer } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { toDirectoryRows } from "./productUserDirectory";
import {
  composeProductUserEffectiveAccess,
  findProductUserBySubject,
  formatProductUserSearchCursor,
  parseProductUserSearchCursor,
  productUserAccessDecisionOf,
  productUserAccessDecisionValidator,
  productUserAccessStateValidator,
  productUserDirectoryRowValidator,
  productUserEffectiveAccessValidator,
  productUserTimestamp,
  requireProductUserOperatorArgument,
  requireProductUserPageSize,
  requireProductUserSubjectArgument,
  type ProductUserAccessDecision,
  type ProductUserAccessState,
} from "./productUserRecords";

/**
 * The privileged closed-beta review surface for the admin integration:
 * operator decisions about a product identity's admission, and the queue of
 * identities waiting for one (closed-beta-access/003).
 *
 * These are internal functions: they are not part of the app's public API and
 * are unreachable from browsers, product clients, and any other authenticated
 * product caller. The only external entry point is the admin-integration HTTP
 * surface in `http.ts`, which authenticates its caller server-side with the
 * same deployment secret as the directory and allowlist operations.
 *
 * Every decision here is the reference implementation's reversible status
 * flip: approve admits, decline refuses, revoke returns an identity to
 * awaiting review, and nothing is ever deleted. Each operation is keyed by
 * the stable subject identity, records operator provenance, and reports the
 * previous and resulting decisions plus the resulting effective access —
 * the information the admin's audit conventions need (acting operator,
 * target subject, action, previous/resulting decision, timestamp, outcome).
 * Emitting the audit record itself belongs to the admin task that calls
 * these operations (closed-beta-access/010).
 *
 * Ordering rules that are deliberate and load-bearing:
 *
 * - An operator decision outranks automatic admission. Establishment and the
 *   allowlist's retroactive admission never re-evaluate a declined identity
 *   (closed-beta-access/001/002 enforce that from their side), and no write
 *   here happens implicitly — so a decline stays declined through any later
 *   allowlist addition until an operator deliberately reverses it.
 * - Revocation returns the identity to awaiting review, the same state as a
 *   fresh sign-up: it re-enters the queue and the normal admission machinery
 *   — including a still-matching allowlist entry — applies again. Locking a
 *   person out is `decline`; stopping automatic admission is removing the
 *   allowlist entry (closed-beta-access/002).
 *
 * The decisions maintained here are switch-independent, like the allowlist's
 * (a decision recorded while `PACKSCOUT_CLOSED_BETA` is off still binds when
 * the beta turns on), so the effective access reported to operators is the
 * composed decision-plus-standing answer rather than the enforcement-time
 * answer that short-circuits to admitted while the switch is off.
 *
 * Subjects and operator references are audit-relevant identifiers; every
 * refusal is a fixed string and neither is ever echoed into an error.
 */

/**
 * Per-segment bound on the queue scan. The review queue is worked from the
 * front, so a bound cuts off only the newest arrivals, and `queueTruncated`
 * says when it did. Two segments exist because records that predate the
 * closed beta carry no stored decision: they sit in the index's undefined
 * segment (ordered by creation time, which is when they were first seen)
 * and are merged into the awaiting-review queue by the derived decision
 * every read already reports for them.
 */
const QUEUE_SCAN_LIMIT = 200;

/**
 * Per-segment bound on the awaiting-review count. The count exists so the
 * admin can show that work is waiting without paging the whole queue; past
 * the bound it reports the bound and `truncated`, meaning "at least this
 * many".
 */
const AWAITING_REVIEW_COUNT_LIMIT = 500;

export const productUserAccessReviewActionValidator = v.union(
  v.literal("approve"),
  v.literal("decline"),
  v.literal("revoke"),
);

export type ProductUserAccessReviewAction = Infer<
  typeof productUserAccessReviewActionValidator
>;

/** The decision state each operation converges the identity onto. */
const REVIEW_ACTION_TARGET_STATE: Readonly<
  Record<ProductUserAccessReviewAction, ProductUserAccessState>
> = Object.freeze({
  approve: "approved",
  decline: "declined",
  revoke: "awaiting_review",
});

const reviewOutcomeFields = {
  action: productUserAccessReviewActionValidator,
  /** The stable subject identity the operation addressed. */
  subject: v.string(),
  /** The acting operator's admin-side reference, as validated. */
  operatorId: v.string(),
  /** When this operation ran — the audit timestamp for the attempt. */
  decidedAt: v.string(),
};

/**
 * What a decision operation reports. `decided` states the authoritative
 * previous and resulting decisions plus the resulting effective access;
 * `changed: false` means the identity already held the target decision and
 * the stored decision — including its original provenance — was left intact.
 * `nothing_to_decide` means the subject has no directory record: deciding
 * about an identity that never signed in is not silently invented, and
 * pre-admitting someone is the allowlist's job (closed-beta-access/002).
 */
export const productUserAccessReviewResultValidator = v.union(
  v.object({
    ...reviewOutcomeFields,
    outcome: v.literal("decided"),
    /** False when the identity already held the target decision. */
    changed: v.boolean(),
    previous: productUserAccessDecisionValidator,
    resulting: productUserAccessDecisionValidator,
    /**
     * The composed decision-plus-standing answer for the resulting record,
     * independent of the deployment switch (see the module note).
     */
    effectiveAccess: productUserEffectiveAccessValidator,
  }),
  v.object({
    ...reviewOutcomeFields,
    outcome: v.literal("nothing_to_decide"),
  }),
);

export type ProductUserAccessReviewResult = Infer<
  typeof productUserAccessReviewResultValidator
>;

/**
 * Applies one operator decision, the shared body of all three operations.
 *
 * It is idempotent and convergent by construction. Convex runs each mutation
 * as a serializable transaction, so two operators acting at once are
 * ordered; whichever runs second observes the first's write, and both are
 * told the authoritative decision that resulted. Repeating an operation
 * whose target state already holds changes nothing and says so — the stored
 * decision keeps its original provenance (an allowlist admission stays an
 * allowlist admission), because the authoritative decision is the one that
 * actually moved the state.
 */
async function decideProductUserAccess(
  ctx: MutationCtx,
  action: ProductUserAccessReviewAction,
  args: { subject: string; operatorId: string },
): Promise<ProductUserAccessReviewResult> {
  const subject = requireProductUserSubjectArgument(args.subject);
  const operatorId = requireProductUserOperatorArgument(args.operatorId);
  const decidedAt = productUserTimestamp(Date.now());
  const existing = await findProductUserBySubject(ctx, subject);
  if (existing === null) {
    return { outcome: "nothing_to_decide", action, subject, operatorId, decidedAt };
  }

  const previous = productUserAccessDecisionOf(existing);
  const targetState = REVIEW_ACTION_TARGET_STATE[action];
  if (previous.state === targetState) {
    return {
      outcome: "decided",
      action,
      subject,
      operatorId,
      decidedAt,
      changed: false,
      previous,
      resulting: previous,
      effectiveAccess: composeProductUserEffectiveAccess(existing),
    };
  }

  const resulting: ProductUserAccessDecision = {
    state: targetState,
    decidedBy: "operator",
    operatorId,
    decidedAt,
  };
  await ctx.db.patch("productUsers", existing._id, { access: resulting });
  return {
    outcome: "decided",
    action,
    subject,
    operatorId,
    decidedAt,
    changed: true,
    previous,
    resulting,
    effectiveAccess: composeProductUserEffectiveAccess({
      ...existing,
      access: resulting,
    }),
  };
}

const reviewOperationArguments = {
  subject: v.string(),
  operatorId: v.string(),
};

/** Admits the identity: its decision becomes operator-approved. */
export const approveAccess = internalMutation({
  args: reviewOperationArguments,
  returns: productUserAccessReviewResultValidator,
  handler: async (ctx, args) =>
    await decideProductUserAccess(ctx, "approve", args),
});

/**
 * Refuses the identity: its decision becomes operator-declined, and stays
 * declined through any later allowlist addition until an operator reverses
 * it (with `approveAccess`, or `revokeAccess` to return it to review).
 */
export const declineAccess = internalMutation({
  args: reviewOperationArguments,
  returns: productUserAccessReviewResultValidator,
  handler: async (ctx, args) =>
    await decideProductUserAccess(ctx, "decline", args),
});

/**
 * Returns the identity to awaiting review with operator provenance. The
 * revocation bites on the person's very next request because every
 * enforcement path re-resolves effective access from this record
 * (closed-beta-access/001/004); nothing about the record or its saved items
 * is deleted.
 */
export const revokeAccess = internalMutation({
  args: reviewOperationArguments,
  returns: productUserAccessReviewResultValidator,
  handler: async (ctx, args) =>
    await decideProductUserAccess(ctx, "revoke", args),
});

const accessQueuePageValidator = v.object({
  page: v.array(productUserDirectoryRowValidator),
  isDone: v.boolean(),
  /** Opaque cursor for the next page; null when the listing is exhausted. */
  continueCursor: v.union(v.string(), v.null()),
  /** True when a segment scan hit its bound and cut off newest arrivals. */
  queueTruncated: v.boolean(),
});

/**
 * When the record entered its current decision state — the queue position.
 * The stored decision's own timestamp for stamped records; for records that
 * predate the closed beta, the derived default decision is dated at
 * `firstSeenAt`, which is when they started waiting.
 */
function queuePositionOf(document: Doc<"productUsers">): string {
  return productUserAccessDecisionOf(document).decidedAt;
}

/**
 * Oldest decision first, then oldest document, then document ID — the merge
 * order of the two index segments, so pagination windows are stable.
 */
function compareQueuePosition(
  left: Doc<"productUsers">,
  right: Doc<"productUsers">,
): number {
  const leftPosition = queuePositionOf(left);
  const rightPosition = queuePositionOf(right);
  if (leftPosition !== rightPosition) {
    return leftPosition < rightPosition ? -1 : 1;
  }
  if (left._creationTime !== right._creationTime) {
    return left._creationTime < right._creationTime ? -1 : 1;
  }
  if (left._id === right._id) return 0;
  return left._id < right._id ? -1 : 1;
}

/**
 * One bounded, ascending scan of a decision-state segment. Passing
 * `undefined` selects the records that predate the closed beta and carry no
 * stored decision; within that segment the index orders by creation time,
 * which is when those records were first seen.
 */
async function scanQueueSegment(
  ctx: Pick<QueryCtx, "db">,
  state: ProductUserAccessState | undefined,
  limit: number,
): Promise<Doc<"productUsers">[]> {
  return await ctx.db
    .query("productUsers")
    .withIndex("by_access_state_and_access_decided_at", (index) =>
      index.eq("access.state", state),
    )
    .take(limit);
}

/**
 * One bounded page of identities in a decision state, oldest-request-first,
 * so nobody is buried by newer arrivals.
 *
 * The rows are the directory's own rows — identity, standing, saved-item
 * counts, and the access decision with its provenance — so one admin screen
 * can show the whole picture. Pagination is the directory search's offset
 * cursor over a merged, bounded window; the caller passes cursors back
 * unchanged. The awaiting-review queue merges the segment of records that
 * predate the closed beta, which are awaiting review by definition.
 */
export const listAccessQueuePage = internalQuery({
  args: {
    accessState: productUserAccessStateValidator,
    paginationOpts: paginationOptsValidator,
  },
  returns: accessQueuePageValidator,
  handler: async (ctx, args) => {
    const pageSize = requireProductUserPageSize(args.paginationOpts.numItems);
    const offset = parseProductUserSearchCursor(args.paginationOpts.cursor);
    const stamped = await scanQueueSegment(
      ctx,
      args.accessState,
      QUEUE_SCAN_LIMIT,
    );
    const legacy =
      args.accessState === "awaiting_review"
        ? await scanQueueSegment(ctx, undefined, QUEUE_SCAN_LIMIT)
        : [];
    const ordered = [...stamped, ...legacy].sort(compareQueuePosition);
    const documents = ordered.slice(offset, offset + pageSize);
    const nextOffset = offset + documents.length;
    const isDone = nextOffset >= ordered.length;
    return {
      page: await toDirectoryRows(ctx, documents),
      isDone,
      continueCursor: isDone ? null : formatProductUserSearchCursor(nextOffset),
      queueTruncated:
        stamped.length === QUEUE_SCAN_LIMIT ||
        legacy.length === QUEUE_SCAN_LIMIT,
    };
  },
});

/**
 * How many identities are awaiting review, bounded. `truncated` means the
 * bound was hit and the real number is at least the reported one. Counts
 * both stored awaiting-review decisions and the records that predate the
 * closed beta, which read as awaiting review.
 */
export const countAwaitingReview = internalQuery({
  args: {},
  returns: v.object({ count: v.number(), truncated: v.boolean() }),
  handler: async (ctx) => {
    const stamped = await scanQueueSegment(
      ctx,
      "awaiting_review",
      AWAITING_REVIEW_COUNT_LIMIT,
    );
    const legacy = await scanQueueSegment(
      ctx,
      undefined,
      AWAITING_REVIEW_COUNT_LIMIT,
    );
    return {
      count: stamped.length + legacy.length,
      truncated:
        stamped.length === AWAITING_REVIEW_COUNT_LIMIT ||
        legacy.length === AWAITING_REVIEW_COUNT_LIMIT,
    };
  },
});
