import assert from "node:assert/strict";
import { test } from "node:test";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { config, proxy } from "./proxy";

function nonceFrom(policy: string): string {
  const match = policy.match(/'nonce-([^']+)'/);
  assert.ok(match, "response policy must contain a nonce source");
  return match[1]!;
}

test("sets one unpredictable nonce policy on both the Next request and response", () => {
  const first = proxy(new NextRequest("https://packscout.example/packs?q=private"));
  const second = proxy(new NextRequest("https://packscout.example/learn"));
  const firstPolicy = first.headers.get("content-security-policy");
  const secondPolicy = second.headers.get("content-security-policy");

  assert.ok(firstPolicy);
  assert.ok(secondPolicy);
  const firstNonce = nonceFrom(firstPolicy);
  const secondNonce = nonceFrom(secondPolicy);
  assert.notEqual(firstNonce, secondNonce);
  assert.equal(
    first.headers.get("x-middleware-request-content-security-policy"),
    firstPolicy,
  );
  assert.equal(first.headers.get("x-middleware-request-x-nonce"), firstNonce);
  assert.equal(first.headers.get("x-nonce"), null);
  assert.equal(firstPolicy.includes("private"), false);
});

test("matches document requests but skips APIs, Next assets, icons, and prefetches", () => {
  for (const url of [
    "https://packscout.example/",
    "https://packscout.example/packs",
    "https://packscout.example/learn/expected-value",
  ]) {
    assert.equal(unstable_doesMiddlewareMatch({ config, url }), true, url);
  }

  for (const url of [
    "https://packscout.example/api/health",
    "https://packscout.example/_next/static/chunks/main.js",
    "https://packscout.example/_next/image?url=%2Fpack.png",
    "https://packscout.example/favicon.ico",
  ]) {
    assert.equal(unstable_doesMiddlewareMatch({ config, url }), false, url);
  }

  assert.equal(
    unstable_doesMiddlewareMatch({
      config,
      url: "https://packscout.example/packs",
      headers: { "next-router-prefetch": "1" },
    }),
    false,
  );
  assert.equal(
    unstable_doesMiddlewareMatch({
      config,
      url: "https://packscout.example/packs",
      headers: { purpose: "prefetch" },
    }),
    false,
  );
});
