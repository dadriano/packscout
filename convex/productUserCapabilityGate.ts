import { PRODUCT_USER_SUSPENDED_ERROR_CODE } from "@packscout/contracts";
import { ConvexError } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import {
  closedBetaIsOn,
  resolveProductUserEffectiveAccess,
} from "./productUserAccess";
import {
  refuseProductUser,
  requireActiveProductUserStanding,
  requireProductUserSubject,
  type ProductUserEffectiveAccess,
} from "./productUserRecords";
import { requireProductUserIdentity } from "./productUsers";

/**
 * The shared enforcement boundary for authenticated product capabilities.
 *
 * Every authenticated entry point passes through `requireAdmittedProductUser`
 * before performing any effect: the caller's effective access — the composed
 * switch + admission + standing answer from closed-beta-access/001 — is
 * re-resolved from the authoritative record inside the request's own
 * transaction, so a token or session established before a decision changed
 * carries no privilege from that earlier state, and an operator's approval,
 * decline, revocation, suspension, or reinstatement bites on the very next
 * call. This module composes `resolveProductUserEffectiveAccess`; it derives
 * no admission rule of its own.
 *
 * The gate is structural, not per-call diligence: identity acquisition is
 * deliberately confined (`ctx.auth` lives only in `productUsers.ts` and in
 * the catalog read model's own read-authorization boundary,
 * `publicCatalogReadAccess.ts` — closed-beta-access/005's sibling gate, which
 * composes the same resolution but returns no subject and authorizes reads
 * only — and `requireProductUserIdentity` is reachable only from the
 * access-path modules and this gate), and the enumeration test in
 * `productUserCapabilityGate.test.ts` scans every module's source and fails
 * the build when an authenticated entry point appears anywhere without this
 * boundary. A capability added next month cannot quietly skip the gate.
 *
 * While the beta switch is off, the resolution admits every caller, and the
 * gate preserves exactly today's behavior instead: write capabilities keep
 * the standing check they have always had (a suspended account cannot write),
 * and read capabilities keep refusing nothing (suspension stops what an
 * account can do, never hides what it owns). No new refusal exists in the
 * off position.
 *
 * Refusals are stable, distinguishable outcomes carrying a fixed reason code
 * and a fixed message — no personal data, no catalog content, no internals —
 * and are distinct from the ordinary authentication failures
 * (`AUTH_REQUIRED`, `AUTH_IDENTITY_INVALID`), so the frontend
 * (closed-beta-access/008) can say the right sentence for the person's actual
 * state. An undetermined resolution refuses; nothing here or anywhere else
 * converts undetermined into admitted.
 */

/**
 * The stable refusal code for each unadmitted effective-access reason. This
 * is the exact vocabulary closed-beta-access/008 maps to user-facing notices.
 *
 * `suspended` deliberately reuses the shared `ACCOUNT_SUSPENDED` code that
 * suspension enforcement has always raised, so a suspended account is one
 * stable outcome in both switch positions and the frontend needs exactly one
 * mapping for it.
 */
export const PRODUCT_USER_CAPABILITY_REFUSAL_CODES = Object.freeze({
  awaiting_review: "BETA_ACCESS_AWAITING_REVIEW",
  declined: "BETA_ACCESS_DECLINED",
  suspended: PRODUCT_USER_SUSPENDED_ERROR_CODE,
  undetermined: "BETA_ACCESS_UNDETERMINED",
} as const);

/**
 * Fixed refusal messages. They state the reason and nothing else: no
 * identity attributes, no operator, no decision provenance, no internals.
 */
const PRODUCT_USER_CAPABILITY_REFUSAL_MESSAGES = Object.freeze({
  awaiting_review: "This account's access request is awaiting review.",
  declined: "Access to the closed beta was declined for this account.",
  undetermined: "This account's access state could not be determined.",
} as const);

/**
 * The authenticated entry points that stay outside the admission gate, with
 * the reason each one must. The enumeration test asserts this list is exact —
 * these names, these modules, nothing else — so the exemption is a documented
 * contract rather than an accumulating habit.
 *
 * - `productUserAccess.ts` / `establishAccess` and `productUsers.ts` /
 *   `recordSignIn`: the establishment path. The closed beta admits people by
 *   recording exactly these contacts and putting them in front of an
 *   operator; gating them would refuse the very call that creates the record
 *   under review, so nobody could ever become approved — the gate would lock
 *   everyone out permanently.
 * - `productUserAccess.ts` / `getMyAccess`: the self-read the waiting,
 *   declined, and suspended surfaces render from (closed-beta-access/007 and
 *   008). It reveals only the caller's own composed access — the same fact a
 *   refusal states — and grants no product capability. Gating it would leave
 *   the product unable to tell the person which notice applies.
 * - `productUsers.ts` / `getMyStanding`: the pre-beta self-status read the
 *   suspension notice renders from. It reveals strictly less than
 *   `getMyAccess` (the caller's own standing only), reads no catalog or
 *   saved data, and belongs to the same class: status reads about oneself
 *   are how a refused account learns why.
 *
 * `getGateStatus` is not listed because it is not an authenticated entry
 * point at all: it answers the anonymous question "is the beta on?" and
 * consults no identity.
 */
export const PRODUCT_USER_ACCESS_PATH_EXEMPT_ENTRY_POINTS = Object.freeze({
  "productUsers.ts": Object.freeze(["recordSignIn", "getMyStanding"] as const),
  "productUserAccess.ts": Object.freeze([
    "establishAccess",
    "getMyAccess",
  ] as const),
});

type UnadmittedReason = Extract<
  ProductUserEffectiveAccess,
  { admitted: false }
>["reason"];

function refuseUnadmittedProductUser(reason: UnadmittedReason): never {
  if (reason === "suspended") {
    refuseProductUser(PRODUCT_USER_SUSPENDED_ERROR_CODE);
  }
  throw new ConvexError({
    code: PRODUCT_USER_CAPABILITY_REFUSAL_CODES[reason],
    message: PRODUCT_USER_CAPABILITY_REFUSAL_MESSAGES[reason],
  });
}

/**
 * What the capability enforced before the closed beta existed, preserved
 * verbatim while the switch is off. This is a description of today's
 * behavior, not a policy knob: writes have always required active standing,
 * and reads have never refused anyone.
 */
export type ProductUserCapability = Readonly<{
  whileBetaOff: "require_active_standing" | "no_refusals";
}>;

/**
 * A capability that mutates the caller's own product data. While the beta is
 * off it keeps the standing gate authenticated writes have always had.
 */
export const PRODUCT_USER_WRITE_CAPABILITY: ProductUserCapability =
  Object.freeze({ whileBetaOff: "require_active_standing" });

/**
 * A capability that reads the caller's own product data. While the beta is
 * off it refuses nothing, exactly as today: suspension stops what an account
 * can do and never hides what it already owns. While the beta is on, reading
 * is a product capability like any other and the composed gate governs it.
 */
export const PRODUCT_USER_READ_CAPABILITY: ProductUserCapability =
  Object.freeze({ whileBetaOff: "no_refusals" });

/**
 * The one boundary every authenticated capability passes through, before any
 * effect. Returns the caller's owner key (the Convex-verified
 * `tokenIdentifier`) so capabilities never touch `ctx.auth` themselves.
 *
 * Order of enforcement:
 *
 * 1. Authentication — an anonymous caller refuses `AUTH_REQUIRED`, and a
 *    malformed verified identity refuses `AUTH_IDENTITY_INVALID`; both are
 *    ordinary authentication failures, deliberately distinct from every
 *    admission refusal.
 * 2. Effective access, re-resolved from the authoritative record at request
 *    time via `resolveProductUserEffectiveAccess` — which already composes
 *    the beta switch (off resolves to admitted), the admission decision, and
 *    standing, and maps an unreadable record to `undetermined`. An
 *    unadmitted resolution refuses with that reason's stable code and
 *    commits no effect; refusal never deletes or mutates anything, so a
 *    later admission restores every capability with the data intact.
 * 3. While the beta is off (and only then), the capability's pre-beta
 *    posture: the legacy standing check for writes, nothing for reads.
 *
 * This helper reads and never writes — it must be callable from queries — so
 * it establishes no record. Establishment belongs to the access path
 * (`establishAccess` / `recordSignIn`); an identity that skipped it simply
 * resolves to awaiting review here and is refused while the beta is on.
 */
export async function requireAdmittedProductUser(
  ctx: Pick<QueryCtx, "auth" | "db">,
  capability: ProductUserCapability,
): Promise<string> {
  const identity = await requireProductUserIdentity(ctx);
  const subject = requireProductUserSubject(identity.tokenIdentifier);
  const access = await resolveProductUserEffectiveAccess(ctx, subject);
  if (!access.admitted) {
    refuseUnadmittedProductUser(access.reason);
  }
  if (
    !closedBetaIsOn() &&
    capability.whileBetaOff === "require_active_standing"
  ) {
    await requireActiveProductUserStanding(ctx, subject);
  }
  return subject;
}
