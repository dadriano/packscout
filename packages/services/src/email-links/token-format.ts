import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  EMAIL_LINK_SELECTOR_PATTERN,
  EMAIL_LINK_VERIFIER_PATTERN,
  type EmailLinkPurpose,
} from "@packscout/contracts";

/**
 * The token's physical form and its cryptography. A token is
 * `selector.verifier`: the selector (16 random bytes, base64url) is the
 * indexed lookup half stored in plaintext, and the verifier (32 random
 * bytes, base64url) is the secret half that exists in storage only as a
 * purpose-separated HMAC digest. Verification recomputes the digest and
 * compares in constant time, so neither the lookup nor the comparison leaks
 * which half was wrong — and because the purpose is bound into the digest, a
 * token presented for the wrong purpose fails the same comparison the same
 * way as a wrong verifier.
 */

export const EMAIL_LINK_SELECTOR_BYTE_LENGTH = 16;
export const EMAIL_LINK_VERIFIER_BYTE_LENGTH = 32;

/** The randomness a token issuer draws on; injectable for deterministic tests. */
export interface EmailLinkRandomness {
  uuid(): string;
  bytes(length: number): Buffer;
}

export const nodeEmailLinkRandomness: EmailLinkRandomness = {
  uuid: randomUUID,
  bytes: (length) => randomBytes(length),
};

export interface GeneratedEmailLinkToken {
  readonly selector: string;
  readonly verifier: string;
  /** The presented composite, `selector.verifier` — the only usable form. */
  readonly presented: string;
}

export function generateEmailLinkToken(
  randomness: EmailLinkRandomness,
): GeneratedEmailLinkToken {
  const selector = randomness
    .bytes(EMAIL_LINK_SELECTOR_BYTE_LENGTH)
    .toString("base64url");
  const verifier = randomness
    .bytes(EMAIL_LINK_VERIFIER_BYTE_LENGTH)
    .toString("base64url");
  if (
    !EMAIL_LINK_SELECTOR_PATTERN.test(selector) ||
    !EMAIL_LINK_VERIFIER_PATTERN.test(verifier)
  ) {
    throw new Error("Email link randomness produced an out-of-shape token.");
  }
  return { selector, verifier, presented: `${selector}.${verifier}` };
}

export interface ParsedEmailLinkToken {
  readonly selector: string;
  readonly verifier: string;
}

/**
 * Splits a presented value into its halves, or null when it cannot be a
 * token. Callers treat null exactly like a failed comparison — same
 * rejection, same remaining work — so malformedness is not observable.
 */
export function parsePresentedEmailLinkToken(
  value: unknown,
): ParsedEmailLinkToken | null {
  if (typeof value !== "string") return null;
  const separator = value.indexOf(".");
  if (separator === -1) return null;
  const selector = value.slice(0, separator);
  const verifier = value.slice(separator + 1);
  if (
    !EMAIL_LINK_SELECTOR_PATTERN.test(selector) ||
    !EMAIL_LINK_VERIFIER_PATTERN.test(verifier)
  ) {
    return null;
  }
  return { selector, verifier };
}

/**
 * The keyed digest a verifier is stored and checked as. Purpose separation
 * lives inside the MAC input, so digests for different purposes are
 * unrelated even for an identical verifier, and the secret keys the whole
 * construction: a database read yields nothing usable without it.
 */
export interface EmailLinkVerifierDigest {
  digest(purpose: EmailLinkPurpose, verifier: string): string;
  /** Constant-time comparison of a candidate verifier against a stored digest. */
  matches(
    purpose: EmailLinkPurpose,
    verifier: string,
    storedDigest: string,
  ): boolean;
}

export const EMAIL_LINK_SECRET_MINIMUM_BYTES = 32;

function assertSecretStrength(secret: string): void {
  if (Buffer.byteLength(secret, "utf8") < EMAIL_LINK_SECRET_MINIMUM_BYTES) {
    throw new Error(
      "Email link token secret must contain at least 32 bytes.",
    );
  }
}

export function createEmailLinkVerifierDigest(
  secret: string,
): EmailLinkVerifierDigest {
  assertSecretStrength(secret);
  const digest = (purpose: EmailLinkPurpose, verifier: string): string =>
    createHmac("sha256", secret)
      .update(`email-link-verifier:${purpose}`)
      .update("\0")
      .update(verifier)
      .digest("base64url");
  return {
    digest,
    matches(purpose, verifier, storedDigest) {
      const actual = Buffer.from(digest(purpose, verifier));
      const stored = Buffer.from(storedDigest);
      return actual.length === stored.length && timingSafeEqual(actual, stored);
    },
  };
}

/**
 * Maps an address or requesting source to its purpose-scoped rate bucket.
 * The raw value never becomes a bucket key: it is HMAC'd under the same
 * secret with its own purpose separation, so the shared rate-limit table
 * stores no addresses and no network identifiers.
 */
export interface EmailLinkBucketKeyer {
  addressKey(purpose: EmailLinkPurpose, addressNormalized: string): string;
  sourceKey(purpose: EmailLinkPurpose, source: string): string;
}

export interface EmailLinkTokenSecurity {
  readonly verifierDigest: EmailLinkVerifierDigest;
  readonly bucketKeyer: EmailLinkBucketKeyer;
  readonly randomness: EmailLinkRandomness;
}

/**
 * The production composition of the mechanism's cryptography from one
 * secret, mirroring the admin's `createNodeAuthSecurity` shape: the service
 * receives these as dependencies and never touches the secret itself.
 */
export function createEmailLinkTokenSecurity(
  secret: string,
): EmailLinkTokenSecurity {
  assertSecretStrength(secret);
  const bucketDigest = (scope: string, value: string): string =>
    createHmac("sha256", secret)
      .update(`email-link-rate:${scope}`)
      .update("\0")
      .update(value)
      .digest("base64url");
  return {
    verifierDigest: createEmailLinkVerifierDigest(secret),
    bucketKeyer: {
      addressKey: (purpose, addressNormalized) =>
        `email_link:${purpose}:address:${bucketDigest(`${purpose}:address`, addressNormalized)}`,
      sourceKey: (purpose, source) =>
        `email_link:${purpose}:source:${bucketDigest(`${purpose}:source`, source)}`,
    },
    randomness: nodeEmailLinkRandomness,
  };
}
