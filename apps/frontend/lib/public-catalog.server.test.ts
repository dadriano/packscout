import assert from "node:assert/strict";
import { test } from "node:test";
import { publicCatalogReadsConfigured } from "./public-catalog.server";

test("public Convex reads require a safe explicit deployment origin", () => {
  assert.equal(publicCatalogReadsConfigured({ NODE_ENV: "development" }), false);
  assert.equal(
    publicCatalogReadsConfigured({
      NODE_ENV: "development",
      NEXT_PUBLIC_CONVEX_URL: "https://example.convex.cloud",
    }),
    true,
  );
  assert.equal(
    publicCatalogReadsConfigured({
      NODE_ENV: "development",
      NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:3210",
    }),
    true,
  );

  for (const value of [
    "javascript:alert(1)",
    "https://user:secret@example.convex.cloud",
    "https://example.convex.cloud/path",
    "https://example.convex.cloud?query=1",
    "https://example.convex.cloud#fragment",
    "https://example.convex.cloud:443",
    "https://example.convex.cloud:8443",
    "https://nested.example.convex.cloud",
    "https://example.convex.site",
    "http://example.convex.cloud",
    "http://127.0.0.1:3210/path",
    "http://localhost:3210?query=1",
  ]) {
    assert.equal(
      publicCatalogReadsConfigured({
        NODE_ENV: "development",
        NEXT_PUBLIC_CONVEX_URL: value,
      }),
      false,
      value,
    );
  }
});
