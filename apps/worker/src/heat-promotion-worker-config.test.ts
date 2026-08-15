import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogPromotionWorkerConfiguration } from "./catalog-promotion-worker-config.ts";
import {
  HeatPromotionWorkerConfigurationError,
  readHeatPromotionWorkerConfiguration,
} from "./heat-promotion-worker-config.ts";

const publication: CatalogPromotionWorkerConfiguration = {
  convexBaseUrl: "https://convex.example",
  deploymentKey: "production-us",
  keyId: "catalog-publisher.v1",
  pollIntervalMilliseconds: 5_000,
  requestTimeoutMilliseconds: 10_000,
  secret: new Uint8Array(32).fill(7),
};

test("Heat reuses publication auth but owns exact-minute scheduling", () => {
  const config = readHeatPromotionWorkerConfiguration({}, publication);
  assert.equal(config.convexBaseUrl, publication.convexBaseUrl);
  assert.equal(config.deploymentKey, publication.deploymentKey);
  assert.equal(config.keyId, publication.keyId);
  assert.equal(config.secret, publication.secret);
  assert.equal(config.retentionBatchSize, 500);
  assert.equal(config.retentionMaximumBatchesPerCycle, 4);
  assert.equal("pollIntervalMilliseconds" in config, false);
});

test("Heat retention configuration is bounded independently", () => {
  const config = readHeatPromotionWorkerConfiguration({
    PACKSCOUT_HEAT_RETENTION_BATCH_SIZE: "1000",
    PACKSCOUT_HEAT_RETENTION_MAX_BATCHES_PER_CYCLE: "20",
  }, publication);
  assert.equal(config.retentionBatchSize, 1_000);
  assert.equal(config.retentionMaximumBatchesPerCycle, 20);
  for (const [name, value, code] of [
    ["PACKSCOUT_HEAT_RETENTION_BATCH_SIZE", "1001",
      "HEAT_RETENTION_BATCH_SIZE_INVALID"],
    ["PACKSCOUT_HEAT_RETENTION_MAX_BATCHES_PER_CYCLE", "0",
      "HEAT_RETENTION_MAXIMUM_BATCHES_INVALID"],
  ] as const) {
    assert.throws(
      () => readHeatPromotionWorkerConfiguration({ [name]: value }, publication),
      (error: unknown) => error instanceof HeatPromotionWorkerConfigurationError &&
        error.code === code,
    );
  }
});
