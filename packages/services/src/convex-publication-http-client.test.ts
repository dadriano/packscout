import assert from "node:assert/strict";
import { test } from "node:test";
import { SignedConvexPublicationHttpClient } from "./convex-publication-http-client.ts";

const VALID_KEY_ID = "local-buyback-ev-simulation.v1";
const VALID_SECRET = Buffer.alloc(32, 7);

function build(baseUrl: string): SignedConvexPublicationHttpClient {
  return new SignedConvexPublicationHttpClient({
    baseUrl,
    keyId: VALID_KEY_ID,
    secret: VALID_SECRET,
  });
}

test("the publication base URL accepts https and loopback http only", () => {
  assert.doesNotThrow(() => build("https://example.convex.site/"));
  assert.doesNotThrow(() => build("http://127.0.0.1:3211/"));
  assert.doesNotThrow(() => build("http://localhost:3211/"));

  for (const rejected of [
    "http://packscout.example/",
    "http://10.0.0.8:3211/",
    "http://127.0.0.1.evil.example/",
    "https://user:secret@example.convex.site/",
    "https://example.convex.site/publish",
    "https://example.convex.site/?q=1",
  ]) {
    assert.throws(
      () => build(rejected),
      RangeError,
      `expected rejection for ${rejected}`,
    );
  }
});
