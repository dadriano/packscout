import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  readManifestReconciliationJobProcessConfiguration,
  readProviderPromotionJobProcessConfiguration,
} from "./distributed-promotion-job-process-config.ts";

const providerId = "00000000-0000-4000-8000-000000000551";
const credential = Buffer.alloc(32, 3).toString("base64");
const manualPublicKeyPem = generateKeyPairSync("ed25519").publicKey.export({
  format: "pem",
  type: "spki",
}).toString();

function common(): NodeJS.ProcessEnv {
  return {
    PACKSCOUT_CONVEX_PUBLICATION_BASE_URL: "https://convex.example",
    PACKSCOUT_CATALOG_DEPLOYMENT_KEY: "production-us",
    PACKSCOUT_DISTRIBUTED_PROMOTION_MANUAL_PUBLIC_KEY_PEM: manualPublicKeyPem,
  };
}

function provider(): NodeJS.ProcessEnv {
  return {
    ...common(),
    PACKSCOUT_PROMOTION_PROVIDER_ID: providerId,
    PACKSCOUT_PROMOTION_PROVIDER_KEY_ID: "provider.alpha.v1",
    PACKSCOUT_PROMOTION_PROVIDER_SECRET_BASE64: credential,
    PACKSCOUT_PROMOTION_PROVIDER_AUTHORITY_VERSION: "provider-alpha-v1",
    PACKSCOUT_PROVIDER_DATABASE_URL: "postgresql://role:secret@db/a",
    PACKSCOUT_PROMOTION_PROVIDER_BOOTSTRAP_BASE_URL:
      "https://promotion-gateway.example",
    PACKSCOUT_PROMOTION_PROVIDER_BOOTSTRAP_TOKEN_BASE64: credential,
  };
}

function manifest(): NodeJS.ProcessEnv {
  return {
    ...common(),
    PACKSCOUT_PROMOTION_MANIFEST_KEY_ID: "manifest.v1",
    PACKSCOUT_PROMOTION_MANIFEST_SECRET_BASE64: credential,
    PACKSCOUT_PROMOTION_MANIFEST_AUTHORITY_VERSION: "manifest-v1",
    PACKSCOUT_CENTRAL_DATABASE_URL: "postgresql://role:secret@db/central",
  };
}

test("role process configuration is isolated and trigger modes are exact", () => {
  const providerConfiguration = readProviderPromotionJobProcessConfiguration({
    ...provider(),
    PACKSCOUT_PROMOTION_RUN_MODE: "manual",
    PACKSCOUT_DISTRIBUTED_PROMOTION_MANUAL_COMMAND_ATTESTATION:
      "protected.operator.command",
  }, "provider-worker");
  assert.equal(providerConfiguration.authority.kind, "provider_publication");
  assert.equal(providerConfiguration.mode, "manual");
  assert.equal(
    providerConfiguration.manualCommandIdentity,
    "protected.operator.command",
  );
  assert.equal(
    providerConfiguration.bootstrapGateway.baseUrl,
    "https://promotion-gateway.example",
  );
  assert.equal(
    providerConfiguration.listenDatabaseUrl,
    providerConfiguration.databaseUrl,
  );

  const manifestConfiguration =
    readManifestReconciliationJobProcessConfiguration({
      ...manifest(),
      PACKSCOUT_PROMOTION_RUN_MODE: "continuation",
      PACKSCOUT_PROMOTION_CONTINUATION_GENERATION: "17",
    }, "manifest-worker");
  assert.equal(
    manifestConfiguration.authority.kind,
    "manifest_reconciliation",
  );
  assert.equal(manifestConfiguration.continuationGeneration, 17n);
});

test("Neon pooling disables optional LISTEN unless a direct URL is configured", () => {
  const pooled =
    "postgresql://role:secret@ep-alpha-pooler.us-west-2.aws.neon.tech/a";
  const withoutListen = readProviderPromotionJobProcessConfiguration({
    ...provider(),
    PACKSCOUT_PROVIDER_DATABASE_URL: pooled,
  }, "provider-worker");
  assert.equal(withoutListen.databaseUrl, pooled);
  assert.equal(withoutListen.listenDatabaseUrl, null);

  const manifestWithoutListen =
    readManifestReconciliationJobProcessConfiguration({
      ...manifest(),
      PACKSCOUT_CENTRAL_DATABASE_URL: pooled,
    }, "manifest-worker");
  assert.equal(manifestWithoutListen.databaseUrl, pooled);
  assert.equal(manifestWithoutListen.listenDatabaseUrl, null);

  const configured = readProviderPromotionJobProcessConfiguration({
    ...provider(),
    PACKSCOUT_PROVIDER_DATABASE_URL: pooled,
    PACKSCOUT_PROVIDER_DATABASE_LISTEN_URL:
      "postgresql://role:secret@ep-alpha.us-west-2.aws.neon.tech/a",
  }, "provider-worker");
  assert.equal(
    configured.listenDatabaseUrl,
    "postgresql://role:secret@ep-alpha.us-west-2.aws.neon.tech/a",
  );
  assert.throws(
    () => readProviderPromotionJobProcessConfiguration({
      ...provider(),
      PACKSCOUT_PROVIDER_DATABASE_URL: pooled,
      PACKSCOUT_PROVIDER_DATABASE_LISTEN_URL: pooled,
    }, "provider-worker"),
    { code: "DISTRIBUTED_PROMOTION_PROCESS_LISTEN_DATABASE_URL_INVALID" },
  );
});

test("cross-role databases and incomplete protected triggers fail closed", () => {
  assert.throws(
    () => readProviderPromotionJobProcessConfiguration({
      ...provider(),
      PACKSCOUT_CENTRAL_DATABASE_URL: "postgresql://role:secret@db/central",
    }, "provider-worker"),
    { code: "DISTRIBUTED_PROMOTION_PROCESS_ROLE_CONFLICT" },
  );
  assert.throws(
    () => readManifestReconciliationJobProcessConfiguration({
      ...manifest(),
      PACKSCOUT_PROVIDER_DATABASE_URL: "postgresql://role:secret@db/provider",
    }, "manifest-worker"),
    { code: "DISTRIBUTED_PROMOTION_PROCESS_ROLE_CONFLICT" },
  );
  assert.throws(
    () => readProviderPromotionJobProcessConfiguration({
      ...provider(),
      PACKSCOUT_PROMOTION_RUN_MODE: "manual",
    }, "provider-worker"),
    { code: "DISTRIBUTED_PROMOTION_PROCESS_TRIGGER_INVALID" },
  );
  assert.throws(
    () => readProviderPromotionJobProcessConfiguration({
      ...provider(),
      PACKSCOUT_DISTRIBUTED_PROMOTION_MANUAL_PUBLIC_KEY_PEM:
        "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
    }, "provider-worker"),
    { code: "DISTRIBUTED_PROMOTION_PROCESS_MANUAL_PUBLIC_KEY_INVALID" },
  );
  assert.throws(
    () => readManifestReconciliationJobProcessConfiguration({
      ...manifest(),
      PACKSCOUT_PROMOTION_MANIFEST_PROOF_BASE_URL:
        "https://legacy-proof-gateway.example",
    }, "manifest-worker"),
    { code: "DISTRIBUTED_PROMOTION_PROCESS_ROLE_CONFLICT" },
  );
});
