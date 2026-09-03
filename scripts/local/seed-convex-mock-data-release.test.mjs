import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertLocalConvexDeployment,
  assertNoCloudDeployKey,
  localCatalogReadCredential,
  parseEnvironmentFile,
  requireLoopbackConvexUrl,
} from "./seed-convex-mock-data-release.mjs";

test("local mock data release accepts only loopback Convex URLs", () => {
  assert.equal(
    requireLoopbackConvexUrl({ CONVEX_URL: "http://127.0.0.1:3210" }),
    "http://127.0.0.1:3210",
  );
  assert.equal(
    requireLoopbackConvexUrl({
      NEXT_PUBLIC_CONVEX_URL: "http://localhost:3210",
    }),
    "http://localhost:3210",
  );
  for (const value of [
    "https://example.convex.cloud",
    "http://192.168.1.5:3210",
    "http://[::1]:3210",
    "http://user:secret@127.0.0.1:3210",
    "http://127.0.0.1:3210/path",
  ]) {
    assert.throws(() => requireLoopbackConvexUrl({ CONVEX_URL: value }));
  }
});

test("local environment parsing is strict and does not expand secrets", () => {
  assert.deepEqual(
    parseEnvironmentFile(
      "# local only\nCONVEX_URL='http://127.0.0.1:3210'\nTOKEN=$NOT_EXPANDED\n",
    ),
    {
      CONVEX_URL: "http://127.0.0.1:3210",
      TOKEN: "$NOT_EXPANDED",
    },
  );
  assert.throws(() => parseEnvironmentFile("not an assignment"));
});

test("local mock data release tooling refuses cloud deploy keys", () => {
  assert.doesNotThrow(() => assertNoCloudDeployKey({}));
  assert.throws(() =>
    assertNoCloudDeployKey({ CONVEX_DEPLOY_KEY: "dev:redacted|redacted" }),
  );
  assert.throws(() =>
    assertNoCloudDeployKey({
      CONVEX_DEPLOYMENT_TOKEN: "dev:redacted|redacted",
    }),
  );
});

test("local mock tooling requires an explicit local deployment selection", () => {
  for (const deployment of ["anonymous:agent", "local:team-project-dev"]) {
    assert.doesNotThrow(() =>
      assertLocalConvexDeployment({ CONVEX_DEPLOYMENT: deployment }),
    );
  }
  for (const deployment of [undefined, "dev:cloud", "prod:live"]) {
    assert.throws(() =>
      assertLocalConvexDeployment({ CONVEX_DEPLOYMENT: deployment }),
    );
  }
  assert.throws(() =>
    assertLocalConvexDeployment({
      CONVEX_DEPLOYMENT: "local:agent",
      CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:4000",
    }),
  );
});

test("the local catalog-read credential mirrors only bounded values", () => {
  assert.equal(localCatalogReadCredential({}), null);
  assert.equal(
    localCatalogReadCredential({ PACKSCOUT_CATALOG_READ_TOKEN: "" }),
    null,
  );
  assert.equal(
    localCatalogReadCredential({ PACKSCOUT_CATALOG_READ_TOKEN: "   " }),
    null,
  );
  const bounded = "catalog-read-credential-0123456789abcdef";
  assert.equal(
    localCatalogReadCredential({ PACKSCOUT_CATALOG_READ_TOKEN: bounded }),
    bounded,
  );
  assert.equal(
    localCatalogReadCredential({
      PACKSCOUT_CATALOG_READ_TOKEN: `  ${bounded}  `,
    }),
    bounded,
  );
  assert.throws(() =>
    localCatalogReadCredential({ PACKSCOUT_CATALOG_READ_TOKEN: "too-short" }),
  );
  assert.throws(() =>
    localCatalogReadCredential({
      PACKSCOUT_CATALOG_READ_TOKEN: "a".repeat(513),
    }),
  );
});
