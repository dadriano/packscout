import { z } from "zod";

/**
 * One-time email-link token vocabulary. A link mailed to an address proves
 * control of that mailbox: the token inside it is purpose-scoped, subject-
 * bound, single-use, and expiring. These are the closed words every surface
 * shares — the purposes that exist, and the shape of a presented token — and
 * nothing here ever touches a token's secret material.
 *
 * The token splits into a lookup selector and a secret verifier
 * (`selector.verifier`), so redemption is an indexed lookup followed by a
 * constant-time hash comparison rather than a scan. Only the selector is
 * stored in plaintext; the verifier is stored as a hash, and the usable
 * composite exists only inside the link that was mailed.
 */

/**
 * The purposes a one-time link can be issued for. A token issued for one
 * purpose is rejected for any other; adding a flow means adding a purpose
 * word and its server-side lifetime, not a parallel token mechanism.
 */
export const emailLinkPurposeSchema = z.enum([
  "operator_password_reset",
  "operator_invitation",
]);

export type EmailLinkPurpose = z.infer<typeof emailLinkPurposeSchema>;

/** Every purpose, in declaration order. */
export const EMAIL_LINK_PURPOSES = Object.freeze(
  emailLinkPurposeSchema.options,
);

/** The selector is 16 random bytes as base64url: 22 characters, no padding. */
export const EMAIL_LINK_SELECTOR_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** The verifier is 32 random bytes as base64url: 43 characters, no padding. */
export const EMAIL_LINK_VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The verifier's stored form is a 32-byte HMAC digest as base64url — the same
 * 43-character alphabet as the verifier itself, and never the verifier.
 */
export const EMAIL_LINK_VERIFIER_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The shape of a presented token: `selector.verifier`. Redemption surfaces
 * validate the query parameter against this before doing anything else; a
 * value that cannot be a token is refused with the same outcome as any other
 * invalid token, never echoed, and never logged.
 */
export const emailLinkPresentedTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);

/** Exact length of a well-formed presented token (22 + 1 + 43). */
export const EMAIL_LINK_PRESENTED_TOKEN_LENGTH = 66;
