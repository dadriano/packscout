import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACCESS_IDENTITY_COOKIE,
  buildIdentityCookieValue,
  clearIdentityCookieValue,
  decodeIdentityTokenExpiryMs,
  IDENTITY_COOKIE_FALLBACK_AGE_SECONDS,
  IDENTITY_COOKIE_MAX_AGE_SECONDS,
  identityTokenShapeValid,
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
