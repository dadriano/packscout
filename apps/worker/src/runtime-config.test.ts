import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProviderWorkerConfigurationError,
  readProviderWorkerConfiguration,
  type ProviderWorkerConfigurationErrorCode,
} from "./runtime-config.ts";

const credentialKey = Buffer.alloc(32, 3).toString("base64");
const actorKey = Buffer.alloc(32, 7).toString("base64");

function validEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PACKSCOUT_DATABASE_URL: "postgresql://worker:password@db.test/packscout",
    PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64: actorKey,
    PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64: credentialKey,
    PACKSCOUT_PUBLIC_ORGANIZATION_ID:
      "54000000-0000-4000-8000-000000000001",
    ...overrides,
  };
}

function hasConfigurationCode(code: ProviderWorkerConfigurationErrorCode) {
  return (error: unknown) =>
    error instanceof ProviderWorkerConfigurationError && error.code === code;
}

test("worker configuration validates production defaults and bounded overrides", () => {
  const configuration = readProviderWorkerConfiguration(
    validEnvironment({
      PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION: "4",
      PACKSCOUT_WORKER_DATABASE_POOL_MAX: "9",
      PACKSCOUT_WORKER_ID: "worker:production:1",
      PACKSCOUT_WORKER_MAX_CLAIMS_PER_CYCLE: "12",
      PACKSCOUT_WORKER_POLL_MS: "2500",
      PACKSCOUT_WORKER_RETENTION_BATCH_SIZE: "250",
      PACKSCOUT_WORKER_RETENTION_MAX_BATCHES_PER_CYCLE: "8",
      PACKSCOUT_WORKER_RETENTION_ORGANIZATION_DISCOVERY_LIMIT: "40",
      PACKSCOUT_ESTIMATED_EV_VERIFIED_USD_STABLECOINS: "USDC,USDT",
    }),
    "fallback:1",
  );

  assert.equal(configuration.environment, "production");
  assert.equal(configuration.workerId, "worker:production:1");
  assert.equal(configuration.pollIntervalMilliseconds, 2_500);
  assert.equal(
    configuration.publicOrganizationId,
    "54000000-0000-4000-8000-000000000001",
  );
  assert.equal(configuration.maximumClaimsPerCycle, 12);
  assert.equal(configuration.retentionBatchSize, 250);
  assert.equal(configuration.retentionMaximumBatchesPerCycle, 8);
  assert.equal(configuration.retentionOrganizationDiscoveryLimit, 40);
  assert.equal(configuration.databasePoolMaximum, 9);
  assert.equal(configuration.credentialKeyVersion, 4);
  assert.deepEqual(configuration.estimatedEvVerifiedUsdStablecoins, [
    "USDC",
    "USDT",
  ]);
  assert.deepEqual([...configuration.credentialKey], [...Buffer.alloc(32, 3)]);
  assert.deepEqual(
    [...configuration.actorPseudonymKey],
    [...Buffer.alloc(32, 7)],
  );
});

test("worker configuration selects the local endpoint policy explicitly", () => {
  const configuration = readProviderWorkerConfiguration(
    validEnvironment({ NODE_ENV: "development" }),
    "local-host:123:worker",
  );

  assert.equal(configuration.environment, "local");
  assert.equal(configuration.workerId, "local-host:123:worker");
  assert.equal(configuration.pollIntervalMilliseconds, 1_000);
  assert.equal(configuration.maximumClaimsPerCycle, 25);
  assert.equal(configuration.retentionBatchSize, 100);
  assert.equal(configuration.retentionMaximumBatchesPerCycle, 5);
  assert.equal(configuration.retentionOrganizationDiscoveryLimit, 25);
  assert.deepEqual(configuration.estimatedEvVerifiedUsdStablecoins, []);
});

test("worker configuration fails closed for invalid secrets and destinations", () => {
  assert.throws(
    () =>
      readProviderWorkerConfiguration(
        validEnvironment({ PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64: "short" }),
        "worker:1",
      ),
    hasConfigurationCode("CREDENTIAL_KEY_INVALID"),
  );
  assert.throws(
    () =>
      readProviderWorkerConfiguration(
        validEnvironment({ PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64: undefined }),
        "worker:1",
      ),
    hasConfigurationCode("ACTOR_KEY_INVALID"),
  );
  assert.throws(
    () =>
      readProviderWorkerConfiguration(
        validEnvironment({ PACKSCOUT_DATABASE_URL: "https://db.test" }),
        "worker:1",
      ),
    hasConfigurationCode("DATABASE_URL_INVALID"),
  );
  for (const publicOrganizationId of [undefined, "organization-from-request"]) {
    assert.throws(
      () =>
        readProviderWorkerConfiguration(
          validEnvironment({
            PACKSCOUT_PUBLIC_ORGANIZATION_ID: publicOrganizationId,
          }),
          "worker:1",
        ),
      hasConfigurationCode("PUBLIC_ORGANIZATION_ID_INVALID"),
    );
  }
});

test("worker configuration rejects ambiguous environments and unsafe bounds", () => {
  assert.throws(
    () =>
      readProviderWorkerConfiguration(
        validEnvironment({ NODE_ENV: "staging" }),
        "worker:1",
      ),
    hasConfigurationCode("NODE_ENV_INVALID"),
  );
  assert.throws(
    () =>
      readProviderWorkerConfiguration(
        validEnvironment({ PACKSCOUT_WORKER_POLL_MS: "99" }),
        "worker:1",
      ),
    hasConfigurationCode("POLL_INTERVAL_INVALID"),
  );
  assert.throws(
    () =>
      readProviderWorkerConfiguration(
        validEnvironment({ PACKSCOUT_WORKER_ID: "worker id with spaces" }),
        "worker:1",
      ),
    hasConfigurationCode("WORKER_ID_INVALID"),
  );
  assert.throws(
    () =>
      readProviderWorkerConfiguration(
        validEnvironment({ PACKSCOUT_WORKER_RETENTION_BATCH_SIZE: "1001" }),
        "worker:1",
      ),
    hasConfigurationCode("RETENTION_BATCH_SIZE_INVALID"),
  );
  assert.throws(
    () =>
      readProviderWorkerConfiguration(
        validEnvironment({
          PACKSCOUT_WORKER_RETENTION_MAX_BATCHES_PER_CYCLE: "0",
        }),
        "worker:1",
      ),
    hasConfigurationCode("RETENTION_MAX_BATCHES_INVALID"),
  );
  assert.throws(
    () =>
      readProviderWorkerConfiguration(
        validEnvironment({
          PACKSCOUT_WORKER_RETENTION_ORGANIZATION_DISCOVERY_LIMIT: "101",
        }),
        "worker:1",
      ),
    hasConfigurationCode("RETENTION_DISCOVERY_LIMIT_INVALID"),
  );
  for (const value of ["usdc", "USDC, USDT", "USD", "USDC,USDC", "USDC,"]) {
    assert.throws(
      () =>
        readProviderWorkerConfiguration(
          validEnvironment({
            PACKSCOUT_ESTIMATED_EV_VERIFIED_USD_STABLECOINS: value,
          }),
          "worker:1",
        ),
      hasConfigurationCode("ESTIMATED_EV_STABLECOINS_INVALID"),
    );
  }
});
