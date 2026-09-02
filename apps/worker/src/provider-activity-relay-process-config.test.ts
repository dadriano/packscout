import assert from "node:assert/strict";
import test from "node:test";
import {
  readProviderActivityRelayProcessConfiguration,
} from "./provider-activity-relay-process-config.ts";

const key = Buffer.alloc(32, 7).toString("base64");

function environment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PACKSCOUT_CENTRAL_DATABASE_URL:
      "postgresql://relay_role:secret@central.example/packscout",
    PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64: key,
    PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION: "3",
    PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS:
      "provider-a.example,*.provider-b.example",
  };
}

test("production relay config uses a dynamic roster with bounded capacity", () => {
  const configuration = readProviderActivityRelayProcessConfiguration({
    ...environment(),
    PACKSCOUT_PROMOTION_RELAY_RUN_MODE: "once",
    PACKSCOUT_PROMOTION_RELAY_PROVIDER_CONCURRENCY: "12",
    PACKSCOUT_PROMOTION_RELAY_MAXIMUM_CACHED_PROVIDERS: "24",
    PACKSCOUT_PROMOTION_RELAY_MAXIMUM_PROVIDERS_PER_CYCLE: "600",
    PACKSCOUT_PROMOTION_RELAY_POLL_MS: "250",
  });

  assert.equal(configuration.mode, "once");
  assert.equal(configuration.providerCredentialKey.version, 3);
  assert.equal(configuration.providerCredentialKey.bytes.byteLength, 32);
  assert.deepEqual(configuration.providerDestinations, {
    allowedHosts: ["provider-a.example", "*.provider-b.example"],
    allowedPorts: [5_432],
    allowedSslModes: ["verify-full"],
  });
  assert.deepEqual(configuration.relay, {
    pollMilliseconds: 250,
    batchSize: 25,
    maximumProvidersPerCycle: 600,
    maximumConcurrentProviders: 12,
    baseBackoffMilliseconds: 1_000,
    maximumBackoffMilliseconds: 60_000,
  });
  assert.equal(configuration.gateway.maximumCachedProviders, 24);
  assert.equal("providerId" in configuration, false);
});

test("provider, manifest, and Convex mutation authorities are refused", () => {
  for (const [name, value] of [
    ["PACKSCOUT_DATABASE_URL", "postgresql://shared.example/database"],
    ["PACKSCOUT_PROVIDER_DATABASE_URL", "postgresql://provider.example/db"],
    ["PACKSCOUT_PROMOTION_PROVIDER_ID", "71000000-0000-4000-8000-000000000002"],
    ["PACKSCOUT_PROMOTION_PROVIDER_SECRET_BASE64", key],
    ["PACKSCOUT_PROMOTION_MANIFEST_SECRET_BASE64", key],
    ["PACKSCOUT_CONVEX_PUBLICATION_SECRET_BASE64", key],
    ["CONVEX_DEPLOY_KEY", "prod:deployment|secret"],
  ] as const) {
    assert.throws(
      () => readProviderActivityRelayProcessConfiguration({
        ...environment(),
        [name]: value,
      }),
      { code: "PROVIDER_ACTIVITY_RELAY_AUTHORITY_CONFLICT" },
      name,
    );
  }
});

test("caller-selected provider and database routing is refused", () => {
  for (const [name, value] of [
    ["PACKSCOUT_PROMOTION_RELAY_PROVIDER_ID", "71000000-0000-4000-8000-000000000002"],
    ["PACKSCOUT_PROMOTION_RELAY_PROVIDER_KEY", "provider_a"],
    ["PACKSCOUT_PROMOTION_RELAY_PROVIDER_DATABASE_URL", "postgresql://host/db"],
    ["PACKSCOUT_PROMOTION_PROVIDER_BOOTSTRAP_BASE_URL", "https://gateway.example"],
    ["PACKSCOUT_PROMOTION_MANIFEST_PROOF_BASE_URL", "https://gateway.example"],
  ] as const) {
    assert.throws(
      () => readProviderActivityRelayProcessConfiguration({
        ...environment(),
        [name]: value,
      }),
      { code: "PROVIDER_ACTIVITY_RELAY_AUTHORITY_CONFLICT" },
      name,
    );
  }
});

test("production destinations and relay bounds fail closed", () => {
  assert.throws(
    () => readProviderActivityRelayProcessConfiguration({
      ...environment(),
      NODE_ENV: undefined,
    }),
    { code: "PROVIDER_ACTIVITY_RELAY_ENVIRONMENT_INVALID" },
  );
  assert.throws(
    () => readProviderActivityRelayProcessConfiguration({
      ...environment(),
      PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS: undefined,
    }),
    { code: "PROVIDER_ACTIVITY_RELAY_PROVIDER_DESTINATION_INVALID" },
  );
  assert.throws(
    () => readProviderActivityRelayProcessConfiguration({
      ...environment(),
      PACKSCOUT_PROMOTION_RELAY_PROVIDER_ALLOWED_PORTS: "5432,6432",
    }),
    { code: "PROVIDER_ACTIVITY_RELAY_PROVIDER_DESTINATION_INVALID" },
  );
  assert.throws(
    () => readProviderActivityRelayProcessConfiguration({
      ...environment(),
      PACKSCOUT_PROMOTION_RELAY_PROVIDER_ALLOWED_SSL_MODES: "require",
    }),
    { code: "PROVIDER_ACTIVITY_RELAY_PROVIDER_DESTINATION_INVALID" },
  );
  assert.throws(
    () => readProviderActivityRelayProcessConfiguration({
      ...environment(),
      PACKSCOUT_PROMOTION_RELAY_PROVIDER_CONCURRENCY: "17",
      PACKSCOUT_PROMOTION_RELAY_MAXIMUM_CACHED_PROVIDERS: "16",
    }),
    { code: "PROVIDER_ACTIVITY_RELAY_BOUNDS_INVALID" },
  );
  assert.throws(
    () => readProviderActivityRelayProcessConfiguration({
      ...environment(),
      PACKSCOUT_PROMOTION_RELAY_RUN_MODE: "manual",
    }),
    { code: "PROVIDER_ACTIVITY_RELAY_RUN_MODE_INVALID" },
  );
});

test("database URL and encrypted credential key are strictly validated", () => {
  assert.throws(
    () => readProviderActivityRelayProcessConfiguration({
      ...environment(),
      PACKSCOUT_CENTRAL_DATABASE_URL: "https://central.example/not-postgres",
    }),
    { code: "PROVIDER_ACTIVITY_RELAY_CENTRAL_DATABASE_INVALID" },
  );
  assert.throws(
    () => readProviderActivityRelayProcessConfiguration({
      ...environment(),
      PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64:
        Buffer.alloc(31, 7).toString("base64"),
    }),
    { code: "PROVIDER_ACTIVITY_RELAY_PROVIDER_CREDENTIAL_INVALID" },
  );
});
