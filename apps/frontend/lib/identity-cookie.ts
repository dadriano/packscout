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
 * Pure string-building and every decision taken on the cookie live here, so
 * they can be tested without a browser. Writing the cookie stays with the
 * client sync component; the one read of `document.cookie` here is guarded on
 * `document` existing, and this module imports nothing from the provider SDK
 * so the landing surface can depend on it without booting authentication.
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

/**
 * Whether a `document.cookie` assignment stores a credential rather than
 * removing one. {@link buildIdentityCookieValue} answers a malformed or
 * already-expired token with the clearing string, so the caller cannot tell
 * "wrote the token" from "dropped it" by looking at its input.
 */
export function identityCookieAssignmentStores(
  assignment: string,
  secure: boolean,
): boolean {
  return assignment !== clearIdentityCookieValue(secure);
}

/**
 * The identity cookie's current value in this document, or null when none is
 * present.
 *
 * Presence alone proves nothing. The server renders the landing page for a
 * visitor whose cookie it *refused* — a revoked token, an expired one, a
 * value that is not even token-shaped — and that refused cookie is still
 * sitting here afterwards. Callers that route on the cookie need its value,
 * so they can tell the credential the gate already rejected from the one this
 * session has since written.
 */
export function readBrowserIdentityCookie(): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${ACCESS_IDENTITY_COOKIE}=`;
  for (const entry of document.cookie.split(";")) {
    const trimmed = entry.trim();
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return null;
}

// --- The hand-off log -------------------------------------------------------

/**
 * One completed assignment to the identity cookie in this document.
 *
 * The cookie is written asynchronously — the provider hands out a token, the
 * sync stores it — so anything that wants to act on "the browser now carries
 * a credential from *this* session" needs to know when the value changed, not
 * merely that some value exists. This log is that signal, and it lives here
 * rather than beside the sync component because the landing surface reads it
 * and must not pull the provider SDK into its bundle.
 *
 * The token is kept only so a reader can recognise the same credential twice.
 * It never leaves the page, it is the same value `document.cookie` already
 * exposes to every script here, and a clear drops it.
 */
export type IdentityCookieWrite = Readonly<{
  kind: "written" | "cleared";
  token: string | null;
  atMs: number;
  /** Monotonic per-document counter, so "later than what I saw" is decidable. */
  seq: number;
}>;

let lastIdentityCookieWrite: IdentityCookieWrite | null = null;
let identityCookieWriteCount = 0;
const identityCookieWriteListeners = new Set<() => void>();

/** Records an assignment and wakes every subscriber. */
export function recordIdentityCookieWrite(
  input: Readonly<{ kind: "written" | "cleared"; token: string | null; atMs: number }>,
): IdentityCookieWrite {
  identityCookieWriteCount += 1;
  const stored = input.kind === "written" ? input.token : null;
  lastIdentityCookieWrite = Object.freeze({
    kind: stored === null ? ("cleared" as const) : ("written" as const),
    token: stored,
    atMs: input.atMs,
    seq: identityCookieWriteCount,
  });
  for (const listener of identityCookieWriteListeners) listener();
  return lastIdentityCookieWrite;
}

/** The most recent assignment, or null when this document wrote none. */
export function readLastIdentityCookieWrite(): IdentityCookieWrite | null {
  return lastIdentityCookieWrite;
}

/** Subscribes to assignments. Shaped for `useSyncExternalStore`. */
export function subscribeToIdentityCookieWrites(
  listener: () => void,
): () => void {
  identityCookieWriteListeners.add(listener);
  return () => {
    identityCookieWriteListeners.delete(listener);
  };
}

/**
 * Whether a clear landed while an in-flight token fetch was outstanding.
 *
 * Signing out clears the cookie synchronously, but a refresh started moments
 * earlier is still awaiting its token and would write a live credential back
 * over the clear. The visitor would be told they signed out while the server
 * kept admitting them until the cookie's own lifetime ran out.
 */
export function identityWriteSupersededByClear(
  input: Readonly<{ seenSeq: number; latest: IdentityCookieWrite | null }>,
): boolean {
  return (
    input.latest !== null &&
    input.latest.seq > input.seenSeq &&
    input.latest.kind === "cleared"
  );
}

// --- The sign-in hand-off decision ------------------------------------------

/** How long the automatic hand-off waits once a session is established. */
export const IDENTITY_HANDOFF_TIMEOUT_MS = 6_000;

/**
 * How many times the hand-off may be attempted for one visit. A fresh
 * credential re-arms it, so this only bounds a pathological rewrite cycle.
 */
export const IDENTITY_HANDOFF_MAX_ATTEMPTS = 3;

export type IdentityHandoffDecision =
  | Readonly<{ kind: "wait" }>
  | Readonly<{ kind: "hand_off"; token: string }>
  | Readonly<{ kind: "give_up" }>;

const WAIT_FOR_IDENTITY: IdentityHandoffDecision = Object.freeze({
  kind: "wait",
});
const GIVE_UP_ON_IDENTITY: IdentityHandoffDecision = Object.freeze({
  kind: "give_up",
});

function handoffCredential(input: Readonly<{
  cookieToken: string | null;
  lastWrite: IdentityCookieWrite | null;
  mountedAtMs: number;
  attemptedTokens: readonly string[];
}>): string | null {
  const write = input.lastWrite;
  // Nothing this document wrote, or a clear: there is no current-session
  // credential to travel with.
  if (write === null || write.kind !== "written" || write.token === null) {
    return null;
  }
  // The credential must post-date the page. The server rendered this surface
  // from whatever cookie the browser held at the time — possibly one it
  // refused — so only a value written afterwards is one the gate has not
  // already seen and rejected.
  if (write.atMs < input.mountedAtMs) return null;
  // And it must be what the browser will actually send. A write the cookie
  // jar did not keep, or one something else has since replaced, is not a
  // credential this navigation would carry.
  const cookieToken = input.cookieToken;
  if (cookieToken === null || cookieToken !== write.token) return null;
  // The same shape check the gate applies before it spends a round trip.
  if (!identityTokenShapeValid(cookieToken)) return null;
  // Never resubmit a credential this hand-off already travelled with; that is
  // the loop protection, and keying it on the value rather than on a flag is
  // what lets a genuinely newer credential try again.
  if (input.attemptedTokens.includes(cookieToken)) return null;
  return cookieToken;
}

/**
 * Whether a freshly signed-in visitor may be handed to the server-side gate.
 *
 * The landing page is what a visitor sees when the gate refused their
 * credential, and that refused cookie is still in the browser while the page
 * renders. Navigating on its mere presence resubmits exactly the credential
 * that produced this page, so the gate refuses it again and the visitor lands
 * back here — with the one-shot guard already spent. This decides on the
 * value instead: hand off only with a credential this document wrote after
 * the page rendered, that the cookie jar actually carries, and that no
 * earlier attempt already used.
 *
 * The wait is bounded from `armedAtMs`, the moment the session became
 * established. Past that deadline nothing navigates on its own and the
 * surface's visible link is the way in, so a credential that arrives minutes
 * later never yanks someone mid-read.
 */
export function decideIdentityHandoff(input: Readonly<{
  cookieToken: string | null;
  lastWrite: IdentityCookieWrite | null;
  mountedAtMs: number;
  armedAtMs: number;
  nowMs: number;
  timeoutMs: number;
  attemptedTokens: readonly string[];
  maxAttempts: number;
}>): IdentityHandoffDecision {
  if (input.attemptedTokens.length >= input.maxAttempts) {
    return GIVE_UP_ON_IDENTITY;
  }
  if (input.nowMs - input.armedAtMs >= input.timeoutMs) {
    return GIVE_UP_ON_IDENTITY;
  }
  const token = handoffCredential(input);
  return token === null
    ? WAIT_FOR_IDENTITY
    : Object.freeze({ kind: "hand_off", token });
}
