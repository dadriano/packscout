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
  betaAllowlistApprovedDecision,
  findBetaAllowlistMatch,
} from "./betaAllowlistRecords";
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
  welcomeMarkerAtEstablishment,
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
 * review) on records that lack a decision and consults the beta allowlist so
 * invited identities are admitted at sign-in; the composed admission answer
 * and its public surface live in `productUserAccess.ts`, and the allowlist
 * itself in `betaAllowlist.ts`.
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
 * Establishment is also where the beta allowlist admits invited identities
 * (closed-beta-access/002): an undecided identity whose verified identifiers
 * match an entry is approved on the spot, with provenance naming the entry.
 * Only identifiers the auth provider verified ever reach the match — every
 * attribute here derives from the Convex-verified identity, and no caller
 * argument exists — so a self-asserted or unverified attribute can never
 * admit anyone.
 *
 * A new record otherwise starts with the default admission decision (awaiting
 * review); a record from before the closed beta existed has that same default
 * materialized on its next contact. An approved decision is never altered
 * here, and a declined one is never overturned — an operator's explicit
 * decline outranks the allowlist, so a declined identity stays declined no
 * matter what the list says. Decisions move only through the allowlist and
 * operator paths.
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
    const invitation = await findBetaAllowlistMatch(ctx, attributes);
    const access =
      invitation === null
        ? defaultProductUserAccessDecision(observedAt)
        : betaAllowlistApprovedDecision(invitation._id, observedAt);
    // A new record admitted at its very first contact (allowlist match) is
    // having its first admitted session right now, so the welcome marker is
    // armed here (messaging/007). An awaiting record stays markerless: not
    // yet due.
    const welcome = welcomeMarkerAtEstablishment({
      existingMarker: undefined,
      decision: access,
      standing: "active",
      admittedByThisEstablishment: invitation !== null,
      previousLastSeenAt: null,
      email: attributes.email,
      observedAt,
    });
    await ctx.db.insert("productUsers", {
      ...attributes,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      standing: "active",
      access,
      ...(welcome === undefined ? {} : { welcome }),
    });
    return { created: true, standing: "active" };
  }

  const merged = mergeAttributes(existing, attributes);
  const decisionMissing = existing.access === undefined;
  // Only an undecided identity consults the allowlist, on its merged (stored
  // plus freshly verified) identifiers, so an entry added while it waited or
  // an identifier verified on this very contact admits it now. Approved and
  // declined identities skip the lookup entirely: neither is ever
  // re-evaluated here.
  const invitation =
    productUserAccessDecisionOf(existing).state === "awaiting_review"
      ? await findBetaAllowlistMatch(ctx, merged)
      : null;
  const resultingAccess =
    invitation !== null
      ? betaAllowlistApprovedDecision(invitation._id, observedAt)
      : productUserAccessDecisionOf(existing);
  // The welcome marker arms only here, at an admitted establishment contact
  // (messaging/007): approved during this contact or between contacts means
  // this is the identity's first admitted session; approved with a contact
  // already behind it means it predates the marker machinery and is
  // grandfathered. The rule and its consequences are documented on
  // `welcomeMarkerAtEstablishment`. A returned marker forces the patch even
  // inside the last-seen refresh window; an existing marker never changes.
  const welcome = welcomeMarkerAtEstablishment({
    existingMarker: existing.welcome,
    decision: resultingAccess,
    standing: existing.standing,
    admittedByThisEstablishment: invitation !== null,
    previousLastSeenAt: existing.lastSeenAt,
    email: merged.email,
    observedAt,
  });
  if (
    attributesChanged(existing, merged) ||
    lastSeenIsStale(existing, nowMilliseconds) ||
    decisionMissing ||
    invitation !== null ||
    welcome !== undefined
  ) {
    await ctx.db.patch("productUsers", existing._id, {
      authMethod: merged.authMethod,
      email: merged.email,
      walletAddress: merged.walletAddress,
      walletAddressKey: merged.walletAddressKey,
      lastSeenAt: observedAt,
      // An allowlist match decides the waiting identity now; otherwise a
      // legacy record materializes exactly the decision it already reads as.
      ...(invitation !== null
        ? { access: resultingAccess }
        : decisionMissing
          ? { access: resultingAccess }
          : {}),
      ...(welcome === undefined ? {} : { welcome }),
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
