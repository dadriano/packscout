import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import {
  findProductUserBySubject,
  productUserTimestamp,
  refuseProductUser,
  requireProductUserSubjectArgument,
  type ProductUserWelcomeMarker,
} from "./productUserRecords";

/**
 * The welcome dispatcher's half of the once-ever marker (messaging/007):
 * bounded discovery-and-claim of identities whose first admitted session has
 * armed a welcome, and settlement once the message is durably enqueued.
 *
 * These are internal functions, unreachable from browsers and product
 * clients. The only external entry point is the admin-integration HTTP
 * surface in `http.ts`, authenticated server-side with the same deployment
 * secret as the directory, allowlist, and review operations — the existing
 * server-to-server operator integration, so no new inbound path into the
 * delivery layer exists and the delivery layer opens no inbound path here.
 *
 * Why claim-then-settle rather than a single "send" operation: the message
 * queue lives with the platform's other operational records in a different
 * runtime, so enqueueing cannot be transactional with this marker. The claim
 * (an atomic Convex mutation) makes concurrent discovery safe — two
 * dispatcher passes can never hold the same identity, because whichever
 * mutation runs second finds the marker already `claimed` with an unexpired
 * lease. The claim expiry makes crashes safe — a dispatcher that dies
 * between claiming and enqueueing leaves a claim that lapses back into
 * discovery, so the identity is retried later rather than stranded. And the
 * outbox's idempotency key (derived from the subject) makes the overlap
 * safe — however many times claim-and-enqueue repeats across crashes and
 * expiries, the duplicate enqueues converge on one intent and one message.
 *
 * A claim deliberately does not re-check effective access: `due` records the
 * durable fact that the identity's first admitted session happened, and a
 * revocation racing the dispatcher does not unmake that fact. This is also
 * what keeps re-admission silent: the marker is already past `due`.
 */

/** Most identities one dispatcher pass may claim; mirrors the page bound. */
export const PRODUCT_USER_WELCOME_CLAIM_MAX_BATCH = 20;

/** Claim lease bounds; the default covers a claim-enqueue-settle round trip
 * with a worker restart in between, without parking an identity for long. */
export const PRODUCT_USER_WELCOME_CLAIM_MIN_LEASE_MILLISECONDS = 1_000;
export const PRODUCT_USER_WELCOME_CLAIM_MAX_LEASE_MILLISECONDS = 900_000;
export const PRODUCT_USER_WELCOME_CLAIM_DEFAULT_LEASE_MILLISECONDS = 300_000;

const claimedWelcomeValidator = v.object({
  /** The stable subject identity the outbox idempotency key derives from. */
  subject: v.string(),
  /** The verified address to welcome; null settles as not applicable. */
  email: v.union(v.string(), v.null()),
});

function requireClaimLimit(limit: number): number {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > PRODUCT_USER_WELCOME_CLAIM_MAX_BATCH
  ) {
    refuseProductUser("PRODUCT_USER_WELCOME_REQUEST_INVALID");
  }
  return limit;
}

function requireClaimLease(leaseMilliseconds: number | undefined): number {
  const resolved =
    leaseMilliseconds ?? PRODUCT_USER_WELCOME_CLAIM_DEFAULT_LEASE_MILLISECONDS;
  if (
    !Number.isInteger(resolved) ||
    resolved < PRODUCT_USER_WELCOME_CLAIM_MIN_LEASE_MILLISECONDS ||
    resolved > PRODUCT_USER_WELCOME_CLAIM_MAX_LEASE_MILLISECONDS
  ) {
    refuseProductUser("PRODUCT_USER_WELCOME_REQUEST_INVALID");
  }
  return resolved;
}

/**
 * Claims up to `limit` identities whose welcome is due, moving each marker
 * `due` (or lapsed `claimed`) → `claimed` with a fresh expiry, and returns
 * what the dispatcher needs to enqueue: subject and verified email. Runs as
 * one atomic mutation, so concurrent dispatcher passes claim disjoint sets;
 * a pass that then fails partway leaves only claims, and every claim either
 * settles or lapses back into discovery at its expiry — no identity can end
 * up unclaimed-and-unsent or claimed-and-never-sent in a way a later pass
 * cannot resolve.
 *
 * Fairness and bounds: due identities are served oldest-armed first (index
 * order), lapsed claims oldest-expiry first, and one pass never touches more
 * than the bounded batch.
 */
export const claimDueWelcomes = internalMutation({
  args: {
    limit: v.number(),
    leaseMilliseconds: v.optional(v.number()),
  },
  returns: v.object({ claims: v.array(claimedWelcomeValidator) }),
  handler: async (ctx, args) => {
    const limit = requireClaimLimit(args.limit);
    const leaseMilliseconds = requireClaimLease(args.leaseMilliseconds);
    const nowMilliseconds = Date.now();
    const claimedAt = productUserTimestamp(nowMilliseconds);
    const claimExpiresAt = productUserTimestamp(
      nowMilliseconds + leaseMilliseconds,
    );

    const due = await ctx.db
      .query("productUsers")
      .withIndex("by_welcome_state_and_welcome_claim_expires_at", (index) =>
        index.eq("welcome.state", "due"),
      )
      .take(limit);
    const lapsed =
      due.length < limit
        ? await ctx.db
            .query("productUsers")
            .withIndex(
              "by_welcome_state_and_welcome_claim_expires_at",
              (index) =>
                index
                  .eq("welcome.state", "claimed")
                  .lte("welcome.claimExpiresAt", claimedAt),
            )
            .take(limit - due.length)
        : [];

    const claims: { subject: string; email: string | null }[] = [];
    for (const document of [...due, ...lapsed]) {
      const marker = document.welcome;
      // The index guarantees a due or claimed marker; anything else is an
      // impossible state this mutation refuses to paper over.
      if (marker === undefined || marker.state === "sent" ||
          marker.state === "not_applicable") {
        refuseProductUser("PRODUCT_USER_STATE_CONFLICT");
      }
      await ctx.db.patch("productUsers", document._id, {
        welcome: {
          state: "claimed",
          dueAt: marker.dueAt,
          claimedAt,
          claimExpiresAt,
        },
      });
      claims.push({ subject: document.subject, email: document.email });
    }
    return { claims };
  },
});

const settledStateValidator = v.union(
  v.literal("sent"),
  v.literal("not_applicable"),
);

/**
 * Settles one claimed welcome. `sent` records that the message was durably
 * enqueued with the delivery layer (delivery itself is the outbox's job);
 * `no_verified_email` records the normal skip for an identity that cannot be
 * reached, never retried. Both are terminal, so settlement is idempotent and
 * convergent: a repeat — or a settlement from a dispatcher whose claim
 * lapsed and was reclaimed — reports the marker's final state without
 * rewriting it, and the outbox idempotency key has already converged any
 * duplicate enqueues onto one message. A still-`due` marker may settle too:
 * a dispatcher whose claim lapsed after it durably enqueued is stating a
 * truth the marker should keep.
 */
export const settleWelcome = internalMutation({
  args: {
    subject: v.string(),
    outcome: v.union(v.literal("sent"), v.literal("no_verified_email")),
  },
  returns: v.union(
    v.object({
      outcome: v.literal("settled"),
      state: settledStateValidator,
    }),
    v.object({
      outcome: v.literal("already_settled"),
      state: settledStateValidator,
    }),
    v.object({ outcome: v.literal("nothing_to_settle") }),
  ),
  handler: async (ctx, args) => {
    const subject = requireProductUserSubjectArgument(args.subject);
    const existing = await findProductUserBySubject(ctx, subject);
    const marker = existing?.welcome;
    if (existing === null || marker === undefined) {
      // Settling an identity that was never armed is reported, not invented.
      return { outcome: "nothing_to_settle" as const };
    }
    if (marker.state === "sent" || marker.state === "not_applicable") {
      return { outcome: "already_settled" as const, state: marker.state };
    }
    const settledAt = productUserTimestamp(Date.now());
    const settled: ProductUserWelcomeMarker =
      args.outcome === "sent"
        ? { state: "sent", dueAt: marker.dueAt, sentAt: settledAt }
        : {
            state: "not_applicable",
            reason: "no_verified_email",
            recordedAt: settledAt,
          };
    await ctx.db.patch("productUsers", existing._id, { welcome: settled });
    return { outcome: "settled" as const, state: settled.state };
  },
});
