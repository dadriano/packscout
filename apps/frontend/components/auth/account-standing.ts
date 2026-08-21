import { PRODUCT_USER_SUSPENDED_ERROR_CODE } from "@packscout/contracts";

/**
 * How the product learns that an account is suspended, and what it says.
 *
 * Enforcement is entirely server-side: the backend re-reads the authoritative
 * record on every authenticated write, so nothing here grants or withholds a
 * capability. These helpers exist only so the person sees a plain explanation
 * instead of a failed action they cannot account for.
 *
 * There are two arrivals for the same fact. The authenticated self-standing
 * read tells the product at session establishment and stays live afterwards;
 * the refusal a blocked write carries covers the moment in between. Either is
 * enough to explain what is happening, and neither exposes an operator, a
 * reason, or anything about the backend.
 *
 * Public browsing is untouched by all of this by design: a suspended visitor
 * reads the catalogue exactly as a signed-out one does.
 */

export type AccountStanding = "active" | "suspended";

export const SUSPENDED_ACCOUNT_NOTICE =
  "Your account is suspended, so saving is turned off for now. Everything you saved is still here, and you can keep browsing PackScout as usual.";

/**
 * The stable code a refused Convex call carries, when it carries one. The
 * value is read defensively: a transport failure, a thrown string, or a
 * payload of another shape simply has no code.
 */
export function readRefusalCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const data = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

/** Whether a rejected write was refused because the account is suspended. */
export function isSuspendedAccountRefusal(error: unknown): boolean {
  return readRefusalCode(error) === PRODUCT_USER_SUSPENDED_ERROR_CODE;
}

/**
 * The account-level notice to show, or null when there is nothing to say.
 *
 * Both inputs are positive evidence of suspension, so either raises the
 * notice. A signed-out visitor is never told anything: standing is a fact
 * about an account, and there is no account in view.
 */
export function presentAccountStandingNotice(
  input: Readonly<{
    signedIn: boolean;
    /** "unknown" while the self-standing read has not answered yet. */
    standing: AccountStanding | "unknown";
    /** True once an authenticated write was refused as suspended. */
    refusedAsSuspended: boolean;
  }>,
): string | null {
  if (!input.signedIn) return null;
  return input.standing === "suspended" || input.refusedAsSuspended
    ? SUSPENDED_ACCOUNT_NOTICE
    : null;
}
