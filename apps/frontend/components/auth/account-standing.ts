import { PRODUCT_USER_SUSPENDED_ERROR_CODE } from "@packscout/contracts";

/**
 * How the product learns that an account is suspended, and what it says.
 *
 * Enforcement is entirely server-side: the backend re-reads the authoritative
 * record on every authenticated write, so nothing here grants or withholds a
 * capability. These helpers exist only so the person sees a plain explanation
 * instead of a failed action they cannot account for.
 *
 * There are two arrivals for the same fact, and they are not equal. The
 * authenticated self-standing read is live: it answers at session
 * establishment and keeps answering as the record changes. The refusal a
 * blocked write carries is a single point in time, and it exists only to cover
 * the gap before that read has said anything. So the live read governs
 * whenever it has an answer, and the refusal speaks only into its silence —
 * otherwise one blocked save would go on describing an account long after an
 * operator reinstated it. Neither exposes an operator, a reason, or anything
 * about the backend.
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
 * The live standing read decides on its own once it has answered, so an
 * authoritative "active" retires an earlier refusal: reinstatement reaches the
 * person as soon as the record changes, with no reload and no second save
 * attempt to prove it. Only while that read is silent does the refusal stand
 * in for it, which is the moment it was there for.
 *
 * A signed-out visitor is never told anything: standing is a fact about an
 * account, and there is no account in view.
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
  const suspended = input.standing === "unknown"
    ? input.refusedAsSuspended
    : input.standing === "suspended";
  return suspended ? SUSPENDED_ACCOUNT_NOTICE : null;
}
