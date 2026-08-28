import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ADMIN_PUBLIC_ORIGIN_VARIABLE,
  PRODUCT_PUBLIC_ORIGIN_VARIABLE,
  resolveMessageCatalogueOrigins,
  validatedPublicMessageOrigin,
} from "./origins.ts";

test("resolves both configured origins from the environment", () => {
  const origins = resolveMessageCatalogueOrigins({
    [PRODUCT_PUBLIC_ORIGIN_VARIABLE]: "https://packscout.io",
    [ADMIN_PUBLIC_ORIGIN_VARIABLE]: "https://admin.packscout.io",
  });
  assert.deepEqual(origins, {
    productOrigin: "https://packscout.io",
    adminOrigin: "https://admin.packscout.io",
  });
});

test("an unconfigured environment resolves to null origins", () => {
  assert.deepEqual(resolveMessageCatalogueOrigins({}), {
    productOrigin: null,
    adminOrigin: null,
  });
  assert.deepEqual(
    resolveMessageCatalogueOrigins({
      [PRODUCT_PUBLIC_ORIGIN_VARIABLE]: "   ",
      [ADMIN_PUBLIC_ORIGIN_VARIABLE]: "",
    }),
    { productOrigin: null, adminOrigin: null },
  );
});

test("a configured origin must be an origin and nothing else", () => {
  for (const rejected of [
    "https://packscout.io/",
    "https://packscout.io/path",
    "https://packscout.io?query=1",
    "https://packscout.io#fragment",
    "https://user:pass@packscout.io",
    "not a url",
    "packscout.io",
  ]) {
    assert.equal(
      validatedPublicMessageOrigin(rejected, "production"),
      null,
      `expected rejection for ${JSON.stringify(rejected)}`,
    );
  }
  assert.equal(
    validatedPublicMessageOrigin("https://packscout.io", "production"),
    "https://packscout.io",
  );
});

test("plain HTTP is allowed only for localhost outside production", () => {
  assert.equal(
    validatedPublicMessageOrigin("http://localhost:3000", "development"),
    "http://localhost:3000",
  );
  assert.equal(
    validatedPublicMessageOrigin("http://127.0.0.1:3000", undefined),
    "http://127.0.0.1:3000",
  );
  assert.equal(
    validatedPublicMessageOrigin("http://localhost:3000", "production"),
    null,
  );
  assert.equal(
    validatedPublicMessageOrigin("http://packscout.io", "development"),
    null,
  );
});
