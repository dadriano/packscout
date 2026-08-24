import { v } from "convex/values";
import { env, type QueryCtx } from "./_generated/server";
import {
  closedBetaIsOn,
  resolveProductUserEffectiveAccess,
} from "./productUserAccess";
import { requireProductUserSubject } from "./productUserRecords";

/**
 * The closed-beta gate on the public catalog read model (closed-beta-access/005).
 *
 * PackScout's catalog reads were unauthenticated by design: the site renders
 * on the server against this read model with no credential, and the backend's
 * address ships to every browser. While the beta is on, that open door
 * narrows to exactly two callers:
 *
 * 1. An authenticated product identity whose effective access is admitted —
 *    resolved through `resolveProductUserEffectiveAccess` from
 *    closed-beta-access/001, never re-derived here. The resolution is one
 *    indexed read inside the same query transaction, so gating adds no extra
 *    round trip per read.
 * 2. PackScout's own server rendering path presenting the server-held
 *    catalog-read credential. The credential authorizes the *server*, not the
 *    visitor: deciding which visitors receive a rendered page belongs to the
 *    frontend gate (closed-beta-access/007).
 *
 * Everyone else is refused. The refusal itself is owned by the callers, which
 * answer with the existing non-leaking `publicReadError("RELEASE_UNAVAILABLE")`
 * — indistinguishable from "no release is active", carrying no catalog
 * fields, no admission reason, and no internal error detail.
 *
 * The credential is server-side deployment configuration on both ends: the
 * Convex env var `PACKSCOUT_CATALOG_READ_TOKEN` checked here, mirrored by the
 * frontend server environment variable of the same name, presented as a
 * query argument only ever attached by server-only code (query arguments are
 * not embedded in browser bundles or page markup). It follows the
 * `PACKSCOUT_ADMIN_DIRECTORY_TOKEN` handling pattern: length-bounded, compared
 * in constant time, never logged or echoed, and fail-closed — an absent or
 * too-short configured secret authorizes nobody.
 *
 * While the beta switch is off every check short-circuits to authorized, so
 * catalog reads are public exactly as before with no credential required.
 */

/** Shortest accepted catalog-read credential. Anything shorter fails closed. */
export const CATALOG_READ_TOKEN_MINIMUM_LENGTH = 32;
/** Transport bound mirroring the admin integration's bearer-token ceiling. */
export const CATALOG_READ_TOKEN_MAXIMUM_LENGTH = 512;

/**
 * The argument every catalog read accepts for the server credential. It is
 * optional and `v.any()` on purpose: existing public callers' argument shapes
 * stay valid while the beta is off, and a malformed value from a stranger is
 * refused in-band with the stable public-read vocabulary instead of leaking a
 * validator exception.
 */
export const catalogReadTokenArg = {
  catalogReadToken: v.optional(v.any()),
};

/**
 * Length-checked, difference-accumulating comparison, matching the
 * `PACKSCOUT_ADMIN_DIRECTORY_TOKEN` secret-comparison shape in `http.ts`:
 * length first, then every remaining character contributes to one constant
 * result.
 */
function secretsMatch(presented: string, configured: string): boolean {
  if (presented.length !== configured.length) return false;
  let difference = 0;
  for (let index = 0; index < presented.length; index += 1) {
    difference |= presented.charCodeAt(index) ^ configured.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * The deployment-held catalog-read credential, or null when this deployment
 * has none worth honoring. The token is deployment configuration, never
 * repository content; the cast mirrors the established pattern for
 * deployment-only secrets.
 */
function configuredCatalogReadToken(): string | null {
  const configuredEnvironment = env as typeof env & {
    readonly PACKSCOUT_CATALOG_READ_TOKEN?: string;
  };
  const configured =
    configuredEnvironment.PACKSCOUT_CATALOG_READ_TOKEN?.trim() ?? "";
  return configured.length >= CATALOG_READ_TOKEN_MINIMUM_LENGTH &&
      configured.length <= CATALOG_READ_TOKEN_MAXIMUM_LENGTH
    ? configured
    : null;
}

/**
 * Whether a presented credential authorizes the server rendering path.
 * Fail-closed on both sides: an unconfigured or out-of-bounds deployment
 * secret authorizes nothing, and a presented value is bounds-checked before
 * it is compared.
 */
function serverCredentialAuthorizes(presented: unknown): boolean {
  if (typeof presented !== "string") return false;
  if (
    presented.length < CATALOG_READ_TOKEN_MINIMUM_LENGTH ||
    presented.length > CATALOG_READ_TOKEN_MAXIMUM_LENGTH
  ) {
    return false;
  }
  const configured = configuredCatalogReadToken();
  return configured === null ? false : secretsMatch(presented, configured);
}

/**
 * Whether the caller is an authenticated product identity whose effective
 * access is admitted. Every failure — no identity, a malformed identity key,
 * an unreadable record — reads as not admitted; nothing here throws, so no
 * internal detail can escape through a catalog read.
 */
async function identityIsAdmitted(
  ctx: Pick<QueryCtx, "auth" | "db">,
): Promise<boolean> {
  let subject: string;
  try {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) return false;
    subject = requireProductUserSubject(identity.tokenIdentifier);
  } catch {
    return false;
  }
  try {
    const access = await resolveProductUserEffectiveAccess(ctx, subject);
    return access.admitted;
  } catch {
    return false;
  }
}

/**
 * The two-caller check every catalog read runs before touching data. True for
 * an admitted authenticated identity, for the server rendering path
 * presenting the deployment credential, and for everyone while the beta
 * switch is off; false for every other caller while it is on.
 */
export async function catalogReadAuthorized(
  ctx: Pick<QueryCtx, "auth" | "db">,
  presentedCredential: unknown,
): Promise<boolean> {
  if (!closedBetaIsOn()) return true;
  if (serverCredentialAuthorizes(presentedCredential)) return true;
  return await identityIsAdmitted(ctx);
}
