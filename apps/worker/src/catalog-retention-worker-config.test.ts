import assert from "node:assert/strict";
import { test } from "node:test";
import type { HeatPromotionWorkerConfiguration } from
  "./heat-promotion-worker-config.ts";
import type { PromotionV2WorkerConfiguration } from
  "./promotion-v2-worker-config.ts";
import {
  CatalogRetentionWorkerConfigurationError,
  assertCatalogRetentionCredentialRoleIsolation,
  readCatalogRetentionWorkerConfiguration,
} from "./catalog-retention-worker-config.ts";

const credential = (keyId: string, byte: number) => ({
  keyId,
  secret: new Uint8Array(32).fill(byte),
});
const promotion: PromotionV2WorkerConfiguration = {
  convexBaseUrl: "https://convex.example",
  deploymentKey: "production-us",
  providerCredentials: [{ platformKey: "alpha", ...credential("provider.alpha.v1", 1) }],
  manifestPublishCredential: credential("manifest.publish.v1", 2),
  manifestClearCredential: credential("manifest.clear.v1", 3),
  pollIntervalMilliseconds: 5_000,
  requestTimeoutMilliseconds: 10_000,
};
const heat: HeatPromotionWorkerConfiguration = {
  convexBaseUrl: promotion.convexBaseUrl,
  deploymentKey: promotion.deploymentKey,
  ...credential("heat.v1", 4),
  requestTimeoutMilliseconds: 10_000,
  retentionBatchSize: 500,
  retentionMaximumBatchesPerCycle: 4,
};
const environment: NodeJS.ProcessEnv = {
  PACKSCOUT_CATALOG_RETENTION_KEY_ID: "retention.v1",
  PACKSCOUT_CATALOG_RETENTION_SECRET_BASE64:
    Buffer.from(new Uint8Array(32).fill(5)).toString("base64"),
};

test("reads a dedicated bounded catalog-retention credential and cadence", () => {
  const configuration = readCatalogRetentionWorkerConfiguration(
    environment, promotion,
  );
  assert.equal(configuration.keyId, "retention.v1");
  assert.equal(configuration.intervalMilliseconds, 3_600_000);
  assert.equal(configuration.continuationIntervalMilliseconds, 1_000);
  assert.equal(configuration.maximumDocuments, 90);
  assert.equal(configuration.maximumPostgresRowsPerStep, 100);
  assert.equal(configuration.maximumStepsPerCycle, 25);
  assert.doesNotThrow(() => assertCatalogRetentionCredentialRoleIsolation({
    promotion, heat, retention: configuration,
  }));
});

test("retention cadence and destructive batch limits fail closed", () => {
  for (const [name, value, code] of [
    ["PACKSCOUT_CATALOG_RETENTION_INTERVAL_MS", "59999",
      "CATALOG_RETENTION_INTERVAL_INVALID"],
    ["PACKSCOUT_CATALOG_RETENTION_CONTINUATION_INTERVAL_MS", "60001",
      "CATALOG_RETENTION_CONTINUATION_INTERVAL_INVALID"],
    ["PACKSCOUT_CATALOG_RETENTION_MAXIMUM_DOCUMENTS", "91",
      "CATALOG_RETENTION_MAXIMUM_DOCUMENTS_INVALID"],
    ["PACKSCOUT_CATALOG_RETENTION_MAXIMUM_POSTGRES_ROWS", "9",
      "CATALOG_RETENTION_MAXIMUM_POSTGRES_ROWS_INVALID"],
    ["PACKSCOUT_CATALOG_RETENTION_MAXIMUM_STEPS_PER_CYCLE", "101",
      "CATALOG_RETENTION_MAXIMUM_STEPS_INVALID"],
  ] as const) {
    assert.throws(
      () => readCatalogRetentionWorkerConfiguration({
        ...environment, [name]: value,
      }, promotion),
      (error: unknown) =>
        error instanceof CatalogRetentionWorkerConfigurationError &&
        error.code === code,
    );
  }
});

test("every publication role is isolated by key ID and exact secret bytes", () => {
  const configuration = readCatalogRetentionWorkerConfiguration(
    environment, promotion,
  );
  for (const retention of [
    { ...configuration, keyId: heat.keyId },
    { ...configuration, secret: heat.secret },
    { ...configuration, keyId: promotion.providerCredentials[0]!.keyId },
    { ...configuration, secret: promotion.manifestPublishCredential.secret },
  ]) {
    assert.throws(
      () => assertCatalogRetentionCredentialRoleIsolation({
        promotion, heat, retention,
      }),
      (error: unknown) =>
        error instanceof CatalogRetentionWorkerConfigurationError &&
        error.code === "CATALOG_RETENTION_CREDENTIAL_ROLE_CONFLICT",
    );
  }
  assert.throws(
    () => assertCatalogRetentionCredentialRoleIsolation({
      promotion,
      heat: { ...heat, secret: promotion.manifestClearCredential.secret },
      retention: configuration,
    }),
    CatalogRetentionWorkerConfigurationError,
  );
});
