/**
 * The identity cookie: how the browser hands the server a verifiable session.
 *
 * PackScout's authentication lives in the browser — the hosted provider keeps
 * the session and issues short-lived identity tokens the product backend
 * verifies directly. Server rendering has no request-scoped credential of its
 * own, so the closed-beta gate (closed-beta-access/007) needs one: after the
 * client establishes a session, it places the provider-issued token in this
 * cookie, and the server resolves the visitor's effective access from it on
 * every gated request.
 *
 * The cookie is transport, never trust. The server treats its value as an
 * unverified claim and asks the product backend to verify it per request; a
 * forged or expired value resolves to signed-out or fail-closed, never to
 * admission. Because the client writes it, it cannot be HttpOnly — which
 * grants scripts nothing new, since the provider already exposes the same
 * token to the page. `SameSite=Lax` keeps it off cross-site subrequests, and
 * its lifetime is derived from the token's own expiry so the cookie dies no
 * later than the credential inside it.
 *
 * Pure string-building lives here so it can be tested without a browser; the
 * one place that touches `document.cookie` is the client sync component.
 */

export const ACCESS_IDENTITY_COOKIE = "packscout-identity";

/**
 * Compact JWS shape: three non-empty base64url segments. Anything else is
 * discarded before it travels or gets parsed — the cookie carries exactly one
 * kind of value.
 */
const IDENTITY_TOKEN_PATTERN =
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Browsers cap a cookie around 4KB; provider tokens sit far below this. A
 * value at or past the cap is malformed or hostile, not a session.
 */
export const IDENTITY_TOKEN_MAX_LENGTH = 4096;

/**
 * The ceiling on cookie lifetime, matching the provider's own token lifetime.
 * The real Max-Age comes from the token's `exp`; this only bounds it when a
 * token claims longer.
 */
export const IDENTITY_COOKIE_MAX_AGE_SECONDS = 3_600;

/**
 * The fallback lifetime when a token carries no readable expiry. Short on
 * purpose: an unreadable claim gets the benefit of minutes, not hours.
 */
export const IDENTITY_COOKIE_FALLBACK_AGE_SECONDS = 900;

/**
 * Safety margin subtracted from the token's remaining life, so the cookie
 * expires in the browser before the token expires at the verifier and the
 * server rarely sees a stale credential.
 */
export const IDENTITY_COOKIE_EXPIRY_MARGIN_SECONDS = 60;

/**
 * How often the signed-in client refreshes the cookie while a tab stays open.
 * Well inside the token lifetime, so an admitted visitor navigating after a
 * long-lived tab still presents a live credential.
 */
export const IDENTITY_COOKIE_REFRESH_INTERVAL_MS = 10 * 60_000;

export function identityTokenShapeValid(token: string): boolean {
  return (
    token.length > 0 &&
    token.length < IDENTITY_TOKEN_MAX_LENGTH &&
    IDENTITY_TOKEN_PATTERN.test(token)
  );
}

/**
 * Reads the token's `exp` claim in milliseconds, without verifying anything.
 * Verification is the backend's job; this only shortens the cookie's browser
 * lifetime to match the credential. Unreadable payloads return null.
 */
export function decodeIdentityTokenExpiryMs(token: string): number | null {
  if (!identityTokenShapeValid(token)) return null;
  const payloadSegment = token.split(".")[1];
  if (!payloadSegment) return null;
  try {
    const base64 = payloadSegment.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = JSON.parse(
      typeof atob === "function"
        ? atob(base64)
        : Buffer.from(base64, "base64").toString("utf8"),
    ) as { exp?: unknown };
    if (typeof decoded.exp !== "number" || !Number.isFinite(decoded.exp)) {
      return null;
    }
    return decoded.exp * 1_000;
  } catch {
    return null;
  }
}

function cookieAttributes(secure: boolean, maxAgeSeconds: number): string {
  return `Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/**
 * The `document.cookie` assignment string that removes the identity cookie.
 */
export function clearIdentityCookieValue(secure: boolean): string {
  return `${ACCESS_IDENTITY_COOKIE}=; ${cookieAttributes(secure, 0)}`;
}

/**
 * The `document.cookie` assignment string that stores a session token, or the
 * clearing string when the token is malformed or already expired. Lifetime is
 * the token's remaining life minus a safety margin, clamped to the provider's
 * token lifetime; a token with no readable expiry gets the short fallback.
 */
export function buildIdentityCookieValue(input: Readonly<{
  token: string;
  nowMs: number;
  secure: boolean;
}>): string {
  if (!identityTokenShapeValid(input.token)) {
    return clearIdentityCookieValue(input.secure);
  }
  const expiryMs = decodeIdentityTokenExpiryMs(input.token);
  const maxAgeSeconds = expiryMs === null
    ? IDENTITY_COOKIE_FALLBACK_AGE_SECONDS
    : Math.min(
      IDENTITY_COOKIE_MAX_AGE_SECONDS,
      Math.floor((expiryMs - input.nowMs) / 1_000) -
        IDENTITY_COOKIE_EXPIRY_MARGIN_SECONDS,
    );
  if (maxAgeSeconds <= 0) return clearIdentityCookieValue(input.secure);
  return `${ACCESS_IDENTITY_COOKIE}=${input.token}; ${cookieAttributes(input.secure, maxAgeSeconds)}`;
}
