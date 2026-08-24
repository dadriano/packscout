import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedIdentityFromProviderUser } from "./verified-identity";

test("no user object means no session, which is different from a session exposing nothing", () => {
  assert.equal(verifiedIdentityFromProviderUser(null), null);
  assert.equal(verifiedIdentityFromProviderUser(undefined), null);
  // A real session that exposed no address is an object saying so.
  assert.deepEqual(verifiedIdentityFromProviderUser({}), {
    email: null,
    walletAddress: null,
  });
});

test("only provider-verified attributes are extracted, nothing inferred", () => {
  assert.deepEqual(
    verifiedIdentityFromProviderUser({
      email: { address: "collector@example.com" },
      wallet: { address: "0xAbCd" },
    }),
    { email: "collector@example.com", walletAddress: "0xAbCd" },
  );
});

test("a directly linked email wins over an OAuth-verified one", () => {
  assert.deepEqual(
    verifiedIdentityFromProviderUser({
      email: { address: "linked@example.com" },
      google: { email: "oauth@example.com" },
    }),
    { email: "linked@example.com", walletAddress: null },
  );
  // With no linked email, the OAuth-verified one is what the person used.
  assert.deepEqual(
    verifiedIdentityFromProviderUser({
      google: { email: "oauth@example.com" },
    }),
    { email: "oauth@example.com", walletAddress: null },
  );
});

test("wallet casing is preserved verbatim — checksummed addresses are case-sensitive", () => {
  const identity = verifiedIdentityFromProviderUser({
    wallet: { address: "0xAbC123deF" },
  });
  assert.equal(identity?.walletAddress, "0xAbC123deF");
});

test("blank, padded, and absurd values do not render", () => {
  assert.deepEqual(
    verifiedIdentityFromProviderUser({
      email: { address: "   " },
      google: { email: "  padded@example.com  " },
      wallet: { address: "x".repeat(400) },
    }),
    { email: "padded@example.com", walletAddress: null },
  );
});
