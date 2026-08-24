import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { env, mutation, query, type QueryCtx } from "./_generated/server";
import {
  composeProductUserEffectiveAccess,
  findProductUserBySubject,
  productUserEffectiveAccessValidator,
  requireProductUserSubject,
  type ProductUserEffectiveAccess,
} from "./productUserRecords";
import {
  establishProductUserRecord,
  requireProductUserIdentity,
} from "./productUsers";

/**
 * The closed-beta admission surface: the one place that answers "may this
 * visitor use PackScout?".
 *
 * Admission is a dimension of the product-user record separate from standing,
 * and the two never reach consumers separately: every caller gets the composed
 * effective access — admitted only when access is approved and standing is not
 * suspended — with a reason it can act on. The answer is re-resolved from the
 * database on every call, never trusted from a token, cookie, or cached
 * session, so a decision change bites on the very next request.
 *
 * The beta itself is a server-side deployment switch (`PACKSCOUT_CLOSED_BETA`)
 * read at request time. While it is off, effective access resolves to admitted
 * for every caller — including anonymous ones — and the product is fully
 * public with no code change. No client input can influence the switch: none
 * of these functions accepts an argument.
 *
 * Identity attributes are personal data; every refusal here is a fixed string
 * and nothing derived from an identity is logged or echoed.
 */

/**
 * True when this deployment closes PackScout to unadmitted callers. Read
 * dynamically inside each call so the switch is pure deployment state; the
 * cast mirrors the established pattern for deployment-only configuration.
 */
export function closedBetaIsOn(): boolean {
  const configuredEnv = env as typeof env & {
    readonly PACKSCOUT_CLOSED_BETA?: "1";
  };
  return configuredEnv.PACKSCOUT_CLOSED_BETA === "1";
}

const ADMITTED_ACCESS: ProductUserEffectiveAccess = Object.freeze({
  admitted: true,
  reason: "approved",
});

const UNDETERMINED_ACCESS: ProductUserEffectiveAccess = Object.freeze({
  admitted: false,
  reason: "undetermined",
});

/**
 * The failures that mean "the admission state could not be established or
 * read" — a malformed identity key, or a subject that impossibly holds
 * duplicate records. Both are raised before any write, so mapping them to an
 * outcome commits nothing partial. Anything else propagates untouched.
 */
function isAccessResolutionFailure(error: unknown): boolean {
  if (!(error instanceof ConvexError)) return false;
  const code = (error.data as { code?: unknown } | null)?.code;
  return (
    code === "PRODUCT_USER_STATE_CONFLICT" || code === "AUTH_IDENTITY_INVALID"
  );
}

/**
 * What a failed establishment or read resolves to. While the beta is on, an
 * unknown state is `undetermined` — explicitly not admitted, never coerced
 * into entry. While it is off, admission does not depend on the record at
 * all, so a failure cannot make the answer unknown: everyone is admitted.
 */
function effectiveAccessAfterFailure(): ProductUserEffectiveAccess {
  return closedBetaIsOn() ? UNDETERMINED_ACCESS : ADMITTED_ACCESS;
}

/**
 * The effective-access resolution, keyed by the stable subject identity. This
 * is the only admission answer consumers use — enforcement tasks compose no
 * rule of their own on top of it. An identity with no record resolves to
 * awaiting review (absence means "not yet let in"), and an unreadable state
 * resolves to undetermined; neither is ever admitted while the beta is on.
 */
export async function resolveProductUserEffectiveAccess(
  ctx: Pick<QueryCtx, "db">,
  subject: string,
): Promise<ProductUserEffectiveAccess> {
  if (!closedBetaIsOn()) return ADMITTED_ACCESS;
  try {
    return composeProductUserEffectiveAccess(
      await findProductUserBySubject(ctx, subject),
    );
  } catch (error) {
    if (isAccessResolutionFailure(error)) return UNDETERMINED_ACCESS;
    throw error;
  }
}

/**
 * Establishes the caller's admission decision on the authenticated request
 * path and returns the current effective access. First contact records the
 * identity as awaiting review with default provenance; repeat contacts
 * refresh identity attributes and last-seen without altering an existing
 * decision. Establishment failures resolve to an explicit outcome instead of
 * an unobserved side effect. Requires authentication; the anonymous question
 * ("is the beta on?") is `getGateStatus`.
 */
export const establishAccess = mutation({
  args: {},
  returns: productUserEffectiveAccessValidator,
  handler: async (ctx) => {
    const identity = await requireProductUserIdentity(ctx);
    try {
      await establishProductUserRecord(ctx, identity);
      return await resolveProductUserEffectiveAccess(
        ctx,
        requireProductUserSubject(identity.tokenIdentifier),
      );
    } catch (error) {
      if (isAccessResolutionFailure(error)) {
        return effectiveAccessAfterFailure();
      }
      throw error;
    }
  },
});

/**
 * The caller's own effective access and reason, and nothing else — no other
 * user's state, no counts, no operator data. Resolved from the database on
 * every read, so a decision change is reflected promptly without signing out
 * and back in.
 */
export const getMyAccess = query({
  args: {},
  returns: productUserEffectiveAccessValidator,
  handler: async (ctx) => {
    const identity = await requireProductUserIdentity(ctx);
    try {
      return await resolveProductUserEffectiveAccess(
        ctx,
        requireProductUserSubject(identity.tokenIdentifier),
      );
    } catch (error) {
      if (isAccessResolutionFailure(error)) {
        return effectiveAccessAfterFailure();
      }
      throw error;
    }
  },
});

/**
 * The one thing an unauthenticated caller may learn: whether the closed beta
 * is currently on. No identity, no counts, no catalog data — and deliberately
 * independent of the catalog read model, because the signed-out landing
 * experience keeps depending on this read after that model is closed.
 */
export const getGateStatus = query({
  args: {},
  returns: v.object({ closedBetaActive: v.boolean() }),
  handler: async () => ({ closedBetaActive: closedBetaIsOn() }),
});
