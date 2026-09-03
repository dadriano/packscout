import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACCESS_IDENTITY_COOKIE,
  buildIdentityCookieValue,
  clearIdentityCookieValue,
  decideIdentityHandoff,
  decodeIdentityTokenExpiryMs,
  IDENTITY_COOKIE_EXPIRY_MARGIN_SECONDS,
  IDENTITY_COOKIE_FALLBACK_AGE_SECONDS,
  IDENTITY_COOKIE_MAX_AGE_SECONDS,
  IDENTITY_COOKIE_REFRESH_INTERVAL_MS,
  identityCookieAssignmentStores,
  type IdentityCookieWrite,
  identityTokenShapeValid,
  identityWriteSupersededByClear,
  readBrowserIdentityCookie,
  readLastIdentityCookieWrite,
  recordIdentityCookieWrite,
  subscribeToIdentityCookieWrites,
} from "./identity-cookie";

const NOW_MS = 1_700_000_000_000;

function tokenWithPayload(payload: Record<string, unknown>): string {
  const segment = Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `eyJhbGciOiJFUzI1NiJ9.${segment}.c2lnbmF0dXJl`;
}

test("only compact bounded token shapes are valid", () => {
  assert.equal(identityTokenShapeValid(tokenWithPayload({ exp: 1 })), true);
  for (const invalid of [
    "",
    "a.b",
    "a.b.c.d",
    "spaces in.the.token",
    "semi;colon.b.c",
    `${"x".repeat(5000)}.y.z`,
  ]) {
    assert.equal(identityTokenShapeValid(invalid), false, invalid);
  }
});

test("token expiry is read without trusting anything else about the payload", () => {
  const expSeconds = Math.floor(NOW_MS / 1000) + 3600;
  assert.equal(
    decodeIdentityTokenExpiryMs(tokenWithPayload({ exp: expSeconds })),
    expSeconds * 1000,
  );
  assert.equal(decodeIdentityTokenExpiryMs(tokenWithPayload({})), null);
  assert.equal(decodeIdentityTokenExpiryMs(tokenWithPayload({ exp: "soon" })), null);
  assert.equal(decodeIdentityTokenExpiryMs("notb64.@@@@.sig"), null);
});

test("the cookie lives no longer than the token inside it", () => {
  const token = tokenWithPayload({ exp: Math.floor(NOW_MS / 1000) + 600 });
  const cookie = buildIdentityCookieValue({ token, nowMs: NOW_MS, secure: true });
  assert.equal(
    cookie,
    `${ACCESS_IDENTITY_COOKIE}=${token}; Path=/; Max-Age=540; SameSite=Lax; Secure`,
  );
});

test("a long-lived token is clamped to the provider token lifetime", () => {
  const token = tokenWithPayload({ exp: Math.floor(NOW_MS / 1000) + 86_400 });
  const cookie = buildIdentityCookieValue({ token, nowMs: NOW_MS, secure: true });
  assert.match(cookie, new RegExp(`Max-Age=${IDENTITY_COOKIE_MAX_AGE_SECONDS};`));
});

test("an expired or unreadable-expiry token becomes a clearing write, or a short-lived one", () => {
  const expired = tokenWithPayload({ exp: Math.floor(NOW_MS / 1000) - 10 });
  assert.equal(
    buildIdentityCookieValue({ token: expired, nowMs: NOW_MS, secure: false }),
    clearIdentityCookieValue(false),
  );
  const noExpiry = tokenWithPayload({ sub: "did:privy:abc" });
  assert.match(
    buildIdentityCookieValue({ token: noExpiry, nowMs: NOW_MS, secure: false }),
    new RegExp(`Max-Age=${IDENTITY_COOKIE_FALLBACK_AGE_SECONDS};`),
  );
});

test("a malformed token is never written", () => {
  assert.equal(
    buildIdentityCookieValue({ token: "not a token", nowMs: NOW_MS, secure: true }),
    clearIdentityCookieValue(true),
  );
});

test("clearing expires the cookie immediately with matching attributes", () => {
  assert.equal(
    clearIdentityCookieValue(true),
    `${ACCESS_IDENTITY_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; Secure`,
  );
  assert.equal(
    clearIdentityCookieValue(false),
    `${ACCESS_IDENTITY_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`,
  );
});

test("the refresh beats the cookie's own lifetime, so an open tab never lapses", () => {
  const usableLifetimeMs =
    (IDENTITY_COOKIE_MAX_AGE_SECONDS - IDENTITY_COOKIE_EXPIRY_MARGIN_SECONDS) *
    1_000;
  assert.ok(IDENTITY_COOKIE_REFRESH_INTERVAL_MS * 2 < usableLifetimeMs);
});

test("a clearing assignment is distinguishable from one that stores a credential", () => {
  const token = tokenWithPayload({ exp: Math.floor(NOW_MS / 1000) + 600 });
  const stored = buildIdentityCookieValue({ token, nowMs: NOW_MS, secure: true });
  assert.equal(identityCookieAssignmentStores(stored, true), true);
  assert.equal(
    identityCookieAssignmentStores(clearIdentityCookieValue(true), true),
    false,
  );
  // An expired token is offered to the builder but never stored, so the write
  // log must not claim a credential the cookie jar does not hold.
  const expired = tokenWithPayload({ exp: Math.floor(NOW_MS / 1000) - 10 });
  const refused = buildIdentityCookieValue({
    token: expired,
    nowMs: NOW_MS,
    secure: true,
  });
  assert.equal(identityCookieAssignmentStores(refused, true), false);
});

test("the identity cookie is read by value, not by presence", () => {
  const token = tokenWithPayload({ exp: 1 });
  const documentStub = { cookie: "" };
  const globals = globalThis as { document?: unknown };
  const restore = globals.document;
  globals.document = documentStub;
  try {
    assert.equal(readBrowserIdentityCookie(), null);
    documentStub.cookie = `theme=dark; ${ACCESS_IDENTITY_COOKIE}=${token}; other=1`;
    assert.equal(readBrowserIdentityCookie(), token);
    // A cookie whose name merely starts the same way is not this cookie.
    documentStub.cookie = `${ACCESS_IDENTITY_COOKIE}-other=${token}`;
    assert.equal(readBrowserIdentityCookie(), null);
    // A cleared cookie can linger as an empty value; that is not a credential.
    documentStub.cookie = `${ACCESS_IDENTITY_COOKIE}=`;
    assert.equal(readBrowserIdentityCookie(), "");
  } finally {
    if (restore === undefined) delete globals.document;
    else globals.document = restore;
  }
});

test("the write log reports the latest assignment and wakes subscribers", () => {
  const token = tokenWithPayload({ exp: 1 });
  let woken = 0;
  const unsubscribe = subscribeToIdentityCookieWrites(() => {
    woken += 1;
  });
  const written = recordIdentityCookieWrite({
    kind: "written",
    token,
    atMs: NOW_MS,
  });
  assert.equal(woken, 1);
  assert.deepEqual(readLastIdentityCookieWrite(), written);
  assert.equal(written.token, token);
  const cleared = recordIdentityCookieWrite({
    kind: "cleared",
    token,
    atMs: NOW_MS + 1,
  });
  assert.equal(woken, 2);
  // A clear never retains the credential it removed.
  assert.equal(cleared.token, null);
  assert.equal(cleared.kind, "cleared");
  assert.ok(cleared.seq > written.seq);
  unsubscribe();
  recordIdentityCookieWrite({ kind: "cleared", token: null, atMs: NOW_MS + 2 });
  assert.equal(woken, 2);
});

test("a sign-out that lands mid-refresh supersedes the write that was in flight", () => {
  const cleared: IdentityCookieWrite = {
    kind: "cleared",
    token: null,
    atMs: NOW_MS,
    seq: 7,
  };
  assert.equal(
    identityWriteSupersededByClear({ seenSeq: 6, latest: cleared }),
    true,
  );
  // A clear the refresh already knew about does not cancel it.
  assert.equal(
    identityWriteSupersededByClear({ seenSeq: 7, latest: cleared }),
    false,
  );
  assert.equal(
    identityWriteSupersededByClear({
      seenSeq: 6,
      latest: { ...cleared, kind: "written", token: "a.b.c" },
    }),
    false,
  );
  assert.equal(
    identityWriteSupersededByClear({ seenSeq: 0, latest: null }),
    false,
  );
});

// --- The sign-in hand-off ---------------------------------------------------

const MOUNTED_AT_MS = 50_000;
const ARMED_AT_MS = 52_000;
const HANDOFF_TIMEOUT_MS = 6_000;
const FRESH_TOKEN = tokenWithPayload({ exp: 1, sub: "fresh" });
const REFUSED_TOKEN = tokenWithPayload({ exp: 1, sub: "refused" });

function handoffInput(
  overrides: Partial<Parameters<typeof decideIdentityHandoff>[0]> = {},
): Parameters<typeof decideIdentityHandoff>[0] {
  return {
    cookieToken: FRESH_TOKEN,
    lastWrite: {
      kind: "written",
      token: FRESH_TOKEN,
      atMs: MOUNTED_AT_MS + 500,
      seq: 3,
    },
    mountedAtMs: MOUNTED_AT_MS,
    armedAtMs: ARMED_AT_MS,
    nowMs: ARMED_AT_MS + 100,
    timeoutMs: HANDOFF_TIMEOUT_MS,
    attemptedTokens: [],
    maxAttempts: 3,
    ...overrides,
  };
}

test("a credential this session wrote after the page rendered is handed off", () => {
  assert.deepEqual(decideIdentityHandoff(handoffInput()), {
    kind: "hand_off",
    token: FRESH_TOKEN,
  });
});

test("the credential the landing page was rendered from is never resubmitted", () => {
  // The gate serves this page precisely when it refused the cookie the
  // browser still holds. Handing that value back gets the same refusal, and
  // a one-shot guard spent on it strands a visitor who is signed in.
  const refusedBeforeThisPage = decideIdentityHandoff(
    handoffInput({
      cookieToken: REFUSED_TOKEN,
      lastWrite: {
        kind: "written",
        token: REFUSED_TOKEN,
        atMs: MOUNTED_AT_MS - 1,
        seq: 1,
      },
    }),
  );
  assert.deepEqual(refusedBeforeThisPage, { kind: "wait" });
  // Nothing this document wrote at all is the same situation: the cookie in
  // the jar is whatever the server already saw.
  assert.deepEqual(
    decideIdentityHandoff(
      handoffInput({ cookieToken: REFUSED_TOKEN, lastWrite: null }),
    ),
    { kind: "wait" },
  );
});

test("a stale cookie that a fresh write replaces re-arms the hand-off", () => {
  // The sequence the reviewer described end to end: the page renders from a
  // refused cookie, the sync replaces it, and the hand-off runs on the new
  // value rather than staying disarmed.
  const stale = handoffInput({
    cookieToken: REFUSED_TOKEN,
    lastWrite: {
      kind: "written",
      token: REFUSED_TOKEN,
      atMs: MOUNTED_AT_MS - 1,
      seq: 1,
    },
  });
  assert.deepEqual(decideIdentityHandoff(stale), { kind: "wait" });
  assert.deepEqual(
    decideIdentityHandoff({
      ...stale,
      cookieToken: FRESH_TOKEN,
      lastWrite: {
        kind: "written",
        token: FRESH_TOKEN,
        atMs: MOUNTED_AT_MS + 10,
        seq: 2,
      },
    }),
    { kind: "hand_off", token: FRESH_TOKEN },
  );
});

test("a credential already handed off with is not tried twice, but a newer one is", () => {
  assert.deepEqual(
    decideIdentityHandoff(handoffInput({ attemptedTokens: [FRESH_TOKEN] })),
    { kind: "wait" },
  );
  const newer = tokenWithPayload({ exp: 1, sub: "newer" });
  assert.deepEqual(
    decideIdentityHandoff(
      handoffInput({
        attemptedTokens: [FRESH_TOKEN],
        cookieToken: newer,
        lastWrite: {
          kind: "written",
          token: newer,
          atMs: MOUNTED_AT_MS + 900,
          seq: 4,
        },
      }),
    ),
    { kind: "hand_off", token: newer },
  );
});

test("the hand-off travels only with the credential the browser will actually send", () => {
  // Written, then replaced or dropped by something else: the navigation would
  // not carry the value the log describes.
  assert.deepEqual(
    decideIdentityHandoff(handoffInput({ cookieToken: null })),
    { kind: "wait" },
  );
  assert.deepEqual(
    decideIdentityHandoff(handoffInput({ cookieToken: REFUSED_TOKEN })),
    { kind: "wait" },
  );
  // A clear is not a credential, however recent.
  assert.deepEqual(
    decideIdentityHandoff(
      handoffInput({
        cookieToken: null,
        lastWrite: {
          kind: "cleared",
          token: null,
          atMs: MOUNTED_AT_MS + 500,
          seq: 5,
        },
      }),
    ),
    { kind: "wait" },
  );
  // And it must survive the same shape check the gate applies.
  assert.deepEqual(
    decideIdentityHandoff(
      handoffInput({
        cookieToken: "not a token",
        lastWrite: {
          kind: "written",
          token: "not a token",
          atMs: MOUNTED_AT_MS + 500,
          seq: 6,
        },
      }),
    ),
    { kind: "wait" },
  );
});

test("the wait is bounded from the moment the session was established", () => {
  // Past the deadline nothing navigates on its own — not even with a usable
  // credential — so the surface's visible link stays the way in and no one is
  // yanked away minutes after they stopped waiting.
  assert.deepEqual(
    decideIdentityHandoff(
      handoffInput({ nowMs: ARMED_AT_MS + HANDOFF_TIMEOUT_MS }),
    ),
    { kind: "give_up" },
  );
  assert.deepEqual(
    decideIdentityHandoff(
      handoffInput({
        nowMs: ARMED_AT_MS + HANDOFF_TIMEOUT_MS - 1,
        cookieToken: null,
      }),
    ),
    { kind: "wait" },
  );
  // The deadline runs from arming, not from mount, so a slow provider boot
  // does not spend the window before a session even exists.
  assert.deepEqual(
    decideIdentityHandoff(
      handoffInput({ mountedAtMs: 0, nowMs: ARMED_AT_MS + 10 }),
    ),
    { kind: "hand_off", token: FRESH_TOKEN },
  );
});

test("repeated hand-offs are capped so a rewrite cycle cannot loop", () => {
  assert.deepEqual(
    decideIdentityHandoff(
      handoffInput({ attemptedTokens: ["a.b.c", "d.e.f"], maxAttempts: 2 }),
    ),
    { kind: "give_up" },
  );
});
