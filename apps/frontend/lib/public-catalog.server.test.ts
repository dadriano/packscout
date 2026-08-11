import assert from "node:assert/strict";
import { test } from "node:test";
import { publicCatalogLiveReadsConfigured } from "./public-catalog.server";

test("live public reads require a safe explicit Convex origin", () => {
  const original = process.env.NEXT_PUBLIC_CONVEX_URL;
  try {
    delete process.env.NEXT_PUBLIC_CONVEX_URL;
    assert.equal(publicCatalogLiveReadsConfigured(), false);
    process.env.NEXT_PUBLIC_CONVEX_URL = "javascript:alert(1)";
    assert.equal(publicCatalogLiveReadsConfigured(), false);
    process.env.NEXT_PUBLIC_CONVEX_URL = "https://user:secret@example.convex.cloud";
    assert.equal(publicCatalogLiveReadsConfigured(), false);
    process.env.NEXT_PUBLIC_CONVEX_URL = "https://example.convex.cloud/path";
    assert.equal(publicCatalogLiveReadsConfigured(), true);
    process.env.NEXT_PUBLIC_CONVEX_URL = "http://127.0.0.1:3210";
    assert.equal(publicCatalogLiveReadsConfigured(), true);
  } finally {
    if (original === undefined) delete process.env.NEXT_PUBLIC_CONVEX_URL;
    else process.env.NEXT_PUBLIC_CONVEX_URL = original;
  }
});
