import assert from "node:assert/strict";
import test from "node:test";
import {
  createPrivyClientConfig,
  resolvePublicAuthConfiguration,
} from "./auth-config";

test("enables auth only for one bounded app ID and one exact Convex origin", () => {
  assert.deepEqual(
    resolvePublicAuthConfiguration({
      privyAppId: "cm1234567890_packscout",
      convexUrl: "https://abundant-puffin-373.convex.cloud/",
    }),
    {
      status: "configured",
      privyAppId: "cm1234567890_packscout",
      convexUrl: "https://abundant-puffin-373.convex.cloud",
    },
  );

  for (const input of [
    {},
    { privyAppId: "too-short", convexUrl: undefined },
    {
      privyAppId: " cm1234567890_packscout",
      convexUrl: "https://abundant-puffin-373.convex.cloud",
    },
    {
      privyAppId: "cm1234567890_packscout",
      convexUrl: " https://abundant-puffin-373.convex.cloud",
    },
    {
      privyAppId: "cm1234567890_packscout",
      convexUrl: "https://user:secret@abundant-puffin-373.convex.cloud",
    },
    {
      privyAppId: "cm1234567890_packscout",
      convexUrl: "https://abundant-puffin-373.convex.cloud/path",
    },
    {
      privyAppId: "cm1234567890_packscout",
      convexUrl: "https://abundant-puffin-373.convex.cloud?debug=true",
    },
  ]) {
    assert.deepEqual(resolvePublicAuthConfiguration(input), {
      status: "unavailable",
    });
  }
});

test("Privy config exposes email and Google without creating or connecting wallets", () => {
  const config = createPrivyClientConfig("abcdefghijklmnopqrstuvwx");

  assert.deepEqual(config.loginMethods, ["email", "google"]);
  assert.equal(config.embeddedWallets?.ethereum?.createOnLogin, "off");
  assert.equal(config.embeddedWallets?.solana?.createOnLogin, "off");
  assert.equal(config.embeddedWallets?.showWalletUIs, false);
  assert.equal(config.externalWallets?.disableAllExternalWallets, true);
  assert.equal(config.externalWallets?.walletConnect?.enabled, false);
  assert.equal(config.scriptNonce, "abcdefghijklmnopqrstuvwx");
  assert.equal(config.loginMethods?.includes("wallet"), false);
});
