import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CatalogPromotionWorkerConfigurationError,
  readCatalogPromotionWorkerConfiguration,
  type CatalogPromotionWorkerConfigurationErrorCode,
} from "./catalog-promotion-worker-config.ts";

const secret = Buffer.alloc(32, 9).toString("base64");

function environment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    PACKSCOUT_CATALOG_DEPLOYMENT_KEY: "production-us",
    PACKSCOUT_CONVEX_PUBLICATION_BASE_URL: "https://convex.example",
    PACKSCOUT_CONVEX_PUBLICATION_KEY_ID: "catalog-publisher.v1",
    PACKSCOUT_CONVEX_PUBLICATION_SECRET_BASE64: secret,
    ...overrides,
  };
}

function hasCode(code: CatalogPromotionWorkerConfigurationErrorCode) {
  return (error: unknown) =>
    error instanceof CatalogPromotionWorkerConfigurationError &&
    error.code === code;
}

test("catalog promotion config resolves a server-only sub-minute cadence", () => {
  const configuration = readCatalogPromotionWorkerConfiguration(environment());
  assert.equal(configuration.convexBaseUrl, "https://convex.example");
  assert.equal(configuration.deploymentKey, "production-us");
  assert.equal(configuration.keyId, "catalog-publisher.v1");
  assert.equal(configuration.pollIntervalMilliseconds, 5_000);
  assert.ok(configuration.pollIntervalMilliseconds < 60_000);
  assert.equal(configuration.requestTimeoutMilliseconds, 10_000);
  assert.deepEqual([...configuration.secret], [...Buffer.alloc(32, 9)]);
  assert.equal("organizationId" in configuration, false);
});

test("catalog promotion config accepts only a bounded p95-compatible cadence", () => {
  assert.equal(readCatalogPromotionWorkerConfiguration(environment({
    PACKSCOUT_CATALOG_PROMOTION_POLL_MS: "30000",
    PACKSCOUT_CONVEX_PUBLICATION_TIMEOUT_MS: "2500",
  })).pollIntervalMilliseconds, 30_000);
  for (const value of ["999", "30001", "not-a-number"]) {
    assert.throws(
      () => readCatalogPromotionWorkerConfiguration(environment({
        PACKSCOUT_CATALOG_PROMOTION_POLL_MS: value,
      })),
      hasCode("CATALOG_PROMOTION_POLL_INTERVAL_INVALID"),
    );
  }
});

test("catalog promotion config fails closed for destinations and signing secrets", () => {
  for (const value of [
    "http://convex.example",
    "https://user:password@convex.example",
    "https://convex.example/path",
  ]) {
    assert.throws(
      () => readCatalogPromotionWorkerConfiguration(environment({
        PACKSCOUT_CONVEX_PUBLICATION_BASE_URL: value,
      })),
      hasCode("CONVEX_PUBLICATION_URL_INVALID"),
    );
  }
  assert.throws(
    () => readCatalogPromotionWorkerConfiguration(environment({
      PACKSCOUT_CONVEX_PUBLICATION_SECRET_BASE64:
        Buffer.alloc(31).toString("base64"),
    })),
    hasCode("CONVEX_PUBLICATION_SECRET_INVALID"),
  );
  assert.throws(
    () => readCatalogPromotionWorkerConfiguration(environment({
      PACKSCOUT_CONVEX_PUBLICATION_KEY_ID: "unversioned-key",
    })),
    hasCode("CONVEX_PUBLICATION_KEY_ID_INVALID"),
  );
  assert.throws(
    () => readCatalogPromotionWorkerConfiguration(environment({
      PACKSCOUT_CATALOG_DEPLOYMENT_KEY: "tenant from request",
    })),
    hasCode("CATALOG_DEPLOYMENT_KEY_INVALID"),
  );
});
