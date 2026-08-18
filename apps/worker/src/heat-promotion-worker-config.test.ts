import assert from "node:assert/strict";
import { test } from "node:test";
import type { PromotionV2WorkerConfiguration } from
  "./promotion-v2-worker-config.ts";
import {
  HeatPromotionWorkerConfigurationError,
  readHeatPromotionWorkerConfiguration,
} from "./heat-promotion-worker-config.ts";

const promotion: PromotionV2WorkerConfiguration = {
  convexBaseUrl: "https://convex.example",
  deploymentKey: "production-us",
  providerCredentials: [{
    platformKey: "alpha",
    keyId: "provider-alpha.v1",
    secret: new Uint8Array(32).fill(1),
  }],
  manifestPublishCredential: {
    keyId: "manifest-publish.v1",
    secret: new Uint8Array(32).fill(2),
  },
  manifestClearCredential: {
    keyId: "manifest-clear.v1",
    secret: new Uint8Array(32).fill(3),
  },
  pollIntervalMilliseconds: 5_000,
  requestTimeoutMilliseconds: 10_000,
};

const heatEnvironment = {
  PACKSCOUT_CONVEX_PUBLICATION_KEY_ID: "heat-publisher.v1",
  PACKSCOUT_CONVEX_PUBLICATION_SECRET_BASE64:
    Buffer.from(new Uint8Array(32).fill(7)).toString("base64"),
};

test("Heat shares Promotion V2 deployment but owns auth and cadence", () => {
  const config = readHeatPromotionWorkerConfiguration(
    heatEnvironment,
    promotion,
  );
  assert.equal(config.convexBaseUrl, promotion.convexBaseUrl);
  assert.equal(config.deploymentKey, promotion.deploymentKey);
  assert.equal(config.keyId, "heat-publisher.v1");
  assert.deepEqual(config.secret, new Uint8Array(32).fill(7));
  assert.equal(config.retentionBatchSize, 500);
  assert.equal(config.retentionMaximumBatchesPerCycle, 4);
  assert.equal("pollIntervalMilliseconds" in config, false);
});

test("Heat retention configuration is bounded independently", () => {
  const config = readHeatPromotionWorkerConfiguration({
    ...heatEnvironment,
    PACKSCOUT_HEAT_RETENTION_BATCH_SIZE: "1000",
    PACKSCOUT_HEAT_RETENTION_MAX_BATCHES_PER_CYCLE: "20",
  }, promotion);
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
      }, promotion),
      (error: unknown) => error instanceof HeatPromotionWorkerConfigurationError &&
        error.code === code,
    );
  }
});

test("Heat requires its own bounded canonical credential", () => {
  for (const [environment, code] of [
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
      () => readHeatPromotionWorkerConfiguration(environment, promotion),
      (error: unknown) =>
        error instanceof HeatPromotionWorkerConfigurationError &&
        error.code === code,
    );
  }
});
