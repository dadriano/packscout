import assert from "node:assert/strict";
import test from "node:test";
import {
  convexAuthSessionKey,
  fetchPrivyAccessTokenForConvex,
} from "./convex-auth-adapter";

test("changes the Convex auth generation when Privy swaps authenticated users", () => {
  const userA = convexAuthSessionKey({
    ready: true,
    authenticated: true,
    userId: "did:privy:user-a",
  });
  const userB = convexAuthSessionKey({
    ready: true,
    authenticated: true,
    userId: "did:privy:user-b",
  });

  assert.notEqual(userA, userB);
  assert.equal(
    convexAuthSessionKey({ ready: true, authenticated: false }),
    "signed-out",
  );
});

test("requests a fresh Privy token check for every Convex token request", async () => {
  let calls = 0;
  const getAccessToken = async () => {
    calls += 1;
    return `token-${calls}`;
  };
  const input = { ready: true, authenticated: true, getAccessToken };

  assert.equal(
    await fetchPrivyAccessTokenForConvex(input, { forceRefreshToken: false }),
    "token-1",
  );
  assert.equal(
    await fetchPrivyAccessTokenForConvex(input, { forceRefreshToken: true }),
    "token-2",
  );
  assert.equal(calls, 2);
});

test("never requests a token before Privy is ready or for a signed-out buyer", async () => {
  let calls = 0;
  const getAccessToken = async () => {
    calls += 1;
    return "unexpected";
  };

  assert.equal(
    await fetchPrivyAccessTokenForConvex(
      { ready: false, authenticated: true, getAccessToken },
      { forceRefreshToken: true },
    ),
    null,
  );
  assert.equal(
    await fetchPrivyAccessTokenForConvex(
      { ready: true, authenticated: false, getAccessToken },
      { forceRefreshToken: false },
    ),
    null,
  );
  assert.equal(calls, 0);
});
