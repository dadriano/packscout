import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { publicReadError } from "@packscout/contracts";
import {
  CATALOG_READ_TOKEN_MAXIMUM_LENGTH,
  CATALOG_READ_TOKEN_MINIMUM_LENGTH,
  catalogReadArguments,
  readCatalogReadCredential,
} from "./catalog-read-access.server";
import {
  publicRepackReadsConfigured,
  readPublicCatalogRecordUpdateStatus,
  readPublicShellStatus,
} from "./public-repacks.server";

const VALID_CREDENTIAL = "catalog-read-credential-0123456789abcdef";

test("public Convex reads require a safe explicit deployment origin", () => {
  assert.equal(publicRepackReadsConfigured({ NODE_ENV: "development" }), false);
  assert.equal(
    publicRepackReadsConfigured({
      NODE_ENV: "development",
      NEXT_PUBLIC_CONVEX_URL: "https://example.convex.cloud",
    }),
    true,
  );
  assert.equal(
    publicRepackReadsConfigured({
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
      publicRepackReadsConfigured({
        NODE_ENV: "development",
        NEXT_PUBLIC_CONVEX_URL: value,
      }),
      false,
      value,
    );
  }
});

test("the catalog-read credential is honored only inside the backend's bounds", () => {
  assert.equal(readCatalogReadCredential({}), null);
  assert.equal(
    readCatalogReadCredential({ PACKSCOUT_CATALOG_READ_TOKEN: "" }),
    null,
  );
  assert.equal(
    readCatalogReadCredential({ PACKSCOUT_CATALOG_READ_TOKEN: "too-short" }),
    null,
  );
  assert.equal(
    readCatalogReadCredential({
      PACKSCOUT_CATALOG_READ_TOKEN: "a".repeat(
        CATALOG_READ_TOKEN_MINIMUM_LENGTH - 1,
      ),
    }),
    null,
  );
  assert.equal(
    readCatalogReadCredential({
      PACKSCOUT_CATALOG_READ_TOKEN: "a".repeat(
        CATALOG_READ_TOKEN_MAXIMUM_LENGTH + 1,
      ),
    }),
    null,
  );
  const minimum = "a".repeat(CATALOG_READ_TOKEN_MINIMUM_LENGTH);
  assert.equal(
    readCatalogReadCredential({ PACKSCOUT_CATALOG_READ_TOKEN: minimum }),
    minimum,
  );
  const maximum = "a".repeat(CATALOG_READ_TOKEN_MAXIMUM_LENGTH);
  assert.equal(
    readCatalogReadCredential({ PACKSCOUT_CATALOG_READ_TOKEN: maximum }),
    maximum,
  );
  // Outer whitespace is stripped before the bounds apply, matching the
  // backend's own trim-then-measure acceptance.
  assert.equal(
    readCatalogReadCredential({
      PACKSCOUT_CATALOG_READ_TOKEN: `  ${VALID_CREDENTIAL}  `,
    }),
    VALID_CREDENTIAL,
  );
});

test("catalog read arguments carry the credential exactly when one is configured", () => {
  const input = Object.freeze({ currentTime: 1_724_000_000_000 });

  const withoutCredential = catalogReadArguments(input, {});
  assert.deepEqual(withoutCredential, { currentTime: 1_724_000_000_000 });
  assert.equal("catalogReadToken" in withoutCredential, false);

  const malformed = catalogReadArguments(input, {
    PACKSCOUT_CATALOG_READ_TOKEN: "too-short",
  });
  assert.equal("catalogReadToken" in malformed, false);

  const withCredential = catalogReadArguments(input, {
    PACKSCOUT_CATALOG_READ_TOKEN: VALID_CREDENTIAL,
  });
  assert.deepEqual(withCredential, {
    currentTime: 1_724_000_000_000,
    catalogReadToken: VALID_CREDENTIAL,
  });
  // The caller's own arguments object is never mutated.
  assert.deepEqual(input, { currentTime: 1_724_000_000_000 });
});

test("every catalog request presents its arguments through the credential wrapper", () => {
  const source = readFileSync(
    new URL("./public-repacks.server.ts", import.meta.url),
    "utf8",
  );
  const fetchCalls = source.match(/fetchQuery\(/gu) ?? [];
  const actionCalls = source.match(/fetchAction\(/gu) ?? [];
  assert.equal(
    fetchCalls.length,
    1,
    "collectible search remains the one time-insensitive query",
  );
  assert.equal(
    actionCalls.length,
    6,
    "record-update, shell, dashboard, list, detail, and desired-match reads are trusted-clock actions",
  );
  const wrapped = source.match(/catalogReadArguments\(\{/gu) ?? [];
  assert.equal(
    wrapped.length,
    fetchCalls.length + actionCalls.length,
    "every catalog request routes its arguments through catalogReadArguments",
  );
  assert.equal(
    source.includes("Date.now()"),
    false,
    "the frontend cannot supply the public confidence clock",
  );
  // The credential stays server-side: never a NEXT_PUBLIC_ variable, and the
  // module never logs anything the token could travel through.
  assert.equal(source.includes("NEXT_PUBLIC_PACKSCOUT_CATALOG_READ_TOKEN"), false);
  assert.equal(source.includes("console."), false);
});

test("a rendering path without a usable backend degrades to the existing unavailable state", async () => {
  const savedConvexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const savedToken = process.env.PACKSCOUT_CATALOG_READ_TOKEN;
  try {
    // No backend origin at all: the bounded unavailable result, no throw.
    delete process.env.NEXT_PUBLIC_CONVEX_URL;
    delete process.env.PACKSCOUT_CATALOG_READ_TOKEN;
    assert.deepEqual(
      await readPublicShellStatus(),
      publicReadError("RELEASE_UNAVAILABLE"),
    );
    assert.deepEqual(
      await readPublicCatalogRecordUpdateStatus(),
      publicReadError("RELEASE_UNAVAILABLE"),
    );

    // A configured but unreachable backend — the same read with the
    // credential present — still resolves to the same bounded state.
    process.env.NEXT_PUBLIC_CONVEX_URL = "http://127.0.0.1:9";
    process.env.PACKSCOUT_CATALOG_READ_TOKEN = VALID_CREDENTIAL;
    assert.deepEqual(
      await readPublicShellStatus(),
      publicReadError("RELEASE_UNAVAILABLE"),
    );
    assert.deepEqual(
      await readPublicCatalogRecordUpdateStatus(),
      publicReadError("RELEASE_UNAVAILABLE"),
    );
  } finally {
    if (savedConvexUrl === undefined) delete process.env.NEXT_PUBLIC_CONVEX_URL;
    else process.env.NEXT_PUBLIC_CONVEX_URL = savedConvexUrl;
    if (savedToken === undefined) delete process.env.PACKSCOUT_CATALOG_READ_TOKEN;
    else process.env.PACKSCOUT_CATALOG_READ_TOKEN = savedToken;
  }
});
