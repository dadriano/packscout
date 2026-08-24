/**
 * The verified sign-in identity, as the authentication provider exposes it.
 *
 * The holding surface (closed-beta-access/008) shows the person which
 * address their access decision is about, so they can tell whether they
 * signed in with the one they expected. Honesty rules the extraction: only
 * attributes the provider itself verified are eligible — the linked email
 * address, the email a linked Google account authenticated, and the first
 * verified wallet — and nothing is inferred, normalized into existence, or
 * read from anywhere but the provider's own user object. The values are
 * self-scoped by construction: they come from the session's user object
 * inside the initialized provider tree, never from a read that could name
 * anyone else.
 *
 * The input type is structural on purpose. It names exactly the fields the
 * extraction may look at, so the provider's large user object can be handed
 * in directly while tests exercise the logic with plain literals.
 */

export type VerifiedSignInIdentity = Readonly<{
  /** The provider-verified email address, or null when none was exposed. */
  email: string | null;
  /** The provider-verified wallet address, or null when none was exposed. */
  walletAddress: string | null;
}>;

/** The fields of the provider's user object the extraction may read. */
export type ProviderVerifiedUser = Readonly<{
  email?: Readonly<{ address?: string | null }> | null;
  google?: Readonly<{ email?: string | null }> | null;
  wallet?: Readonly<{ address?: string | null }> | null;
}>;

/**
 * Display values are bounded defensively. Real addresses sit far below this;
 * anything at or past it is malformed and better not rendered than rendered
 * broken.
 */
const VERIFIED_ATTRIBUTE_MAX_LENGTH = 320;

function displayable(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > VERIFIED_ATTRIBUTE_MAX_LENGTH
    ? null
    : trimmed;
}

/**
 * Extracts the displayable verified attributes from a provider user object.
 *
 * A directly linked email wins over an OAuth-verified one when both exist,
 * matching how the person thinks of "the address I signed in with". Null in,
 * null out: no user object means no session, which is different from a
 * session that exposed no address — callers keep that distinction.
 */
export function verifiedIdentityFromProviderUser(
  user: ProviderVerifiedUser | null | undefined,
): VerifiedSignInIdentity | null {
  if (user === null || user === undefined) return null;
  return {
    email: displayable(user.email?.address) ?? displayable(user.google?.email),
    walletAddress: displayable(user.wallet?.address),
  };
}
