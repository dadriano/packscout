import type { UserIdentity } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  defaultProductUserAccessDecision,
  deriveProductUserAttributes,
  findProductUserBySubject,
  productUserAccessDecisionOf,
  productUserStandingValidator,
  productUserTimestamp,
  productUserTimestampMilliseconds,
  productUserWalletAddressKey,
  refuseProductUser,
  requireProductUserSubject,
  type ProductUserIdentityAttributes,
} from "./productUserRecords";

/**
 * The durable product-user directory.
 *
 * Product sign-in uses a hosted third-party token, so there is no registration
 * form: the record is established the first time an authenticated identity
 * touches the product backend and refreshed on later sign-ins. Recording is a
 * separate best-effort call, so a failed write never blocks the session or the
 * caller's saved-item capabilities.
 *
 * Privileged operator reads live in `productUserDirectory.ts` as internal
 * functions and are not part of this public API.
 *
 * Establishment also stamps the closed-beta admission default (awaiting
 * review) on records that lack a decision; the composed admission answer and
 * its public surface live in `productUserAccess.ts`.
 */

/**
 * Repeat sign-ins inside this window keep the stored `lastSeenAt`, bounding
 * write amplification from clients that re-establish sessions in a loop.
 * Newly exposed identity attributes are still written immediately.
 */
const LAST_SEEN_REFRESH_MILLISECONDS = 60_000;

export async function requireProductUserIdentity(
  ctx: Pick<QueryCtx, "auth">,
): Promise<UserIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) refuseProductUser("AUTH_REQUIRED");
  return identity;
}

/**
 * Merges freshly verified attributes over the stored record. A sign-in that no
 * longer exposes an attribute never erases what the directory already knows.
 */
function mergeAttributes(
  existing: Doc<"productUsers">,
  attributes: ProductUserIdentityAttributes,
): ProductUserIdentityAttributes {
  const walletAddress = attributes.walletAddress ?? existing.walletAddress;
  return {
    subject: existing.subject,
    authMethod: attributes.authMethod,
    email: attributes.email ?? existing.email,
    walletAddress,
    walletAddressKey: productUserWalletAddressKey(walletAddress),
  };
}

function attributesChanged(
  existing: Doc<"productUsers">,
  merged: ProductUserIdentityAttributes,
): boolean {
  return (
    existing.authMethod !== merged.authMethod ||
    existing.email !== merged.email ||
    existing.walletAddress !== merged.walletAddress ||
    existing.walletAddressKey !== merged.walletAddressKey
  );
}

function lastSeenIsStale(
  existing: Doc<"productUsers">,
  nowMilliseconds: number,
): boolean {
  const storedMilliseconds = productUserTimestampMilliseconds(
    existing.lastSeenAt,
  );
  if (storedMilliseconds === null) return true;
  return (
    nowMilliseconds - storedMilliseconds >= LAST_SEEN_REFRESH_MILLISECONDS ||
    nowMilliseconds < storedMilliseconds
  );
}

/**
 * Creates or refreshes the caller's directory record, the single write path
 * both `recordSignIn` and the access establishment call share.
 *
 * A new record starts with the default admission decision (awaiting review); a
 * record from before the closed beta existed has that same default
 * materialized on its next contact. An existing decision is never altered
 * here, so a repeat contact can never return an approved account to awaiting
 * review — decisions move only through the allowlist and operator paths.
 */
export async function establishProductUserRecord(
  ctx: MutationCtx,
  identity: UserIdentity,
): Promise<{ created: boolean; standing: "active" | "suspended" }> {
  const attributes = deriveProductUserAttributes(identity);
  const existing = await findProductUserBySubject(ctx, attributes.subject);
  const nowMilliseconds = Date.now();
  const observedAt = productUserTimestamp(nowMilliseconds);

  if (existing === null) {
    await ctx.db.insert("productUsers", {
      ...attributes,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      standing: "active",
      access: defaultProductUserAccessDecision(observedAt),
    });
    return { created: true, standing: "active" };
  }

  const merged = mergeAttributes(existing, attributes);
  const decisionMissing = existing.access === undefined;
  if (
    attributesChanged(existing, merged) ||
    lastSeenIsStale(existing, nowMilliseconds) ||
    decisionMissing
  ) {
    await ctx.db.patch("productUsers", existing._id, {
      authMethod: merged.authMethod,
      email: merged.email,
      walletAddress: merged.walletAddress,
      walletAddressKey: merged.walletAddressKey,
      lastSeenAt: observedAt,
      // Materializes exactly the decision the record already reads as.
      ...(decisionMissing
        ? { access: productUserAccessDecisionOf(existing) }
        : {}),
    });
  }
  return { created: false, standing: existing.standing };
}

/**
 * Establishes or refreshes the caller's own directory record. Every stored
 * value is derived from the verified identity; the mutation takes no
 * identity-bearing arguments.
 */
export const recordSignIn = mutation({
  args: {},
  returns: v.object({
    created: v.boolean(),
    standing: productUserStandingValidator,
  }),
  handler: async (ctx) => {
    const identity = await requireProductUserIdentity(ctx);
    return await establishProductUserRecord(ctx, identity);
  },
});

/**
 * The caller's own account standing, and nothing about anyone else. Identities
 * that own saved items but have no record yet read as `active`: a missing
 * record is an unrecorded sign-up, never a suspension.
 */
export const getMyStanding = query({
  args: {},
  returns: v.object({ standing: productUserStandingValidator }),
  handler: async (ctx) => {
    const identity = await requireProductUserIdentity(ctx);
    const subject = requireProductUserSubject(identity.tokenIdentifier);
    const existing = await findProductUserBySubject(ctx, subject);
    return { standing: existing?.standing ?? "active" };
  },
});
