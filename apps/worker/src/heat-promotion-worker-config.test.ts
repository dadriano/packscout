import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HeatPromotionWorkerConfigurationError,
  readHeatPromotionWorkerConfiguration,
} from "./heat-promotion-worker-config.ts";

const heatEnvironment = {
  PACKSCOUT_CONVEX_PUBLICATION_BASE_URL: "https://convex.example",
  PACKSCOUT_CATALOG_DEPLOYMENT_KEY: "production-us",
  PACKSCOUT_CONVEX_PUBLICATION_KEY_ID: "heat-publisher.v1",
  PACKSCOUT_CONVEX_PUBLICATION_SECRET_BASE64:
    Buffer.from(new Uint8Array(32).fill(7)).toString("base64"),
};

test("Heat owns the shared Convex target, auth, and cadence", () => {
  const config = readHeatPromotionWorkerConfiguration(heatEnvironment);
  assert.equal(config.convexBaseUrl, "https://convex.example");
  assert.equal(config.deploymentKey, "production-us");
  assert.equal(config.keyId, "heat-publisher.v1");
  assert.deepEqual(config.secret, new Uint8Array(32).fill(7));
  assert.equal(config.requestTimeoutMilliseconds, 10_000);
  assert.equal(config.retentionBatchSize, 500);
  assert.equal(config.retentionMaximumBatchesPerCycle, 4);
  assert.equal("pollIntervalMilliseconds" in config, false);
});

test("Heat retention configuration is bounded independently", () => {
  const config = readHeatPromotionWorkerConfiguration({
    ...heatEnvironment,
    PACKSCOUT_HEAT_RETENTION_BATCH_SIZE: "1000",
    PACKSCOUT_HEAT_RETENTION_MAX_BATCHES_PER_CYCLE: "20",
  });
  assert.equal(config.retentionBatchSize, 1_000);
  assert.equal(config.retentionMaximumBatchesPerCycle, 20);
  for (const [name, value, code] of [
    ["PACKSCOUT_HEAT_RETENTION_BATCH_SIZE", "1001",
      "HEAT_RETENTION_BATCH_SIZE_INVALID"],
    ["PACKSCOUT_HEAT_RETENTION_MAX_BATCHES_PER_CYCLE", "0",
      "HEAT_RETENTION_MAXIMUM_BATCHES_INVALID"],
  ] as const) {
    assert.throws(
      () => readHeatPromotionWorkerConfiguration({
        ...heatEnvironment,
        [name]: value,
      }),
      (error: unknown) => error instanceof HeatPromotionWorkerConfigurationError &&
        error.code === code,
    );
  }
});

test("Heat requires a bounded canonical target and credential", () => {
  for (const [environment, code] of [
    [{
      ...heatEnvironment,
      PACKSCOUT_CONVEX_PUBLICATION_BASE_URL: "http://convex.example",
    }, "HEAT_PUBLICATION_URL_INVALID"],
    [{
      ...heatEnvironment,
      PACKSCOUT_CATALOG_DEPLOYMENT_KEY: "bad key",
    }, "HEAT_DEPLOYMENT_KEY_INVALID"],
    [{
      ...heatEnvironment,
      PACKSCOUT_CONVEX_PUBLICATION_TIMEOUT_MS: "30001",
    }, "HEAT_REQUEST_TIMEOUT_INVALID"],
    [{
      ...heatEnvironment,
      PACKSCOUT_CONVEX_PUBLICATION_KEY_ID: "bad key",
    }, "HEAT_PUBLICATION_KEY_ID_INVALID"],
    [{
      ...heatEnvironment,
      PACKSCOUT_CONVEX_PUBLICATION_SECRET_BASE64: "not-base64",
    }, "HEAT_PUBLICATION_SECRET_INVALID"],
    [{
      ...heatEnvironment,
      PACKSCOUT_CONVEX_PUBLICATION_SECRET_BASE64:
        Buffer.from(new Uint8Array(31)).toString("base64"),
    }, "HEAT_PUBLICATION_SECRET_INVALID"],
  ] as const) {
    assert.throws(
      () => readHeatPromotionWorkerConfiguration(environment),
      (error: unknown) =>
        error instanceof HeatPromotionWorkerConfigurationError &&
        error.code === code,
    );
  }
});
