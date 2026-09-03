import assert from "node:assert/strict";
import test from "node:test";
import {
  readPromotionJobLivenessProcessConfiguration,
} from "./promotion-job-liveness-process-config.ts";

const key = Buffer.alloc(32, 4).toString("base64");

function environment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PACKSCOUT_CENTRAL_DATABASE_URL: "postgresql://role:secret@central/db",
    PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64: key,
    PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION: "2",
    PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS:
      "provider-a.example,*.provider-b.example",
    PACKSCOUT_PROMOTION_SYSTEM_CONDITION_WEBHOOK_URL:
      "https://conditions.example",
    PACKSCOUT_PROMOTION_SYSTEM_CONDITION_WEBHOOK_TOKEN_BASE64: key,
  };
}

test("production configuration composes central routing with bounded dynamic capacity", () => {
  const configuration = readPromotionJobLivenessProcessConfiguration({
    ...environment(),
    PACKSCOUT_PROMOTION_LIVENESS_RUN_MODE: "once",
    PACKSCOUT_PROMOTION_LIVENESS_PROVIDER_CONCURRENCY: "12",
    PACKSCOUT_PROMOTION_LIVENESS_MAXIMUM_CACHED_PROVIDERS: "24",
  });
  assert.equal(configuration.mode, "once");
  assert.equal(configuration.providerCredentialKey.version, 2);
  assert.deepEqual(configuration.providerDestinations, {
    allowedHosts: ["provider-a.example", "*.provider-b.example"],
    allowedPorts: [5_432],
    allowedSslModes: ["verify-full"],
  });
  assert.equal(configuration.evaluator.providerConcurrency, 12);
  assert.equal(configuration.evaluator.maximumProviders, 4_096);
  assert.equal(configuration.gateway.maximumCachedProviders, 24);
});

test("direct provider and publication credentials are refused", () => {
  for (const [name, value] of [
    ["PACKSCOUT_DATABASE_URL", "postgresql://shared/db"],
    [
      "PACKSCOUT_PROMOTION_EVALUATOR_WATCHDOG_DATABASE_URL",
      "postgresql://watchdog/db",
    ],
    ["PACKSCOUT_PROVIDER_DATABASE_URL", "postgresql://provider/db"],
    ["PACKSCOUT_PROMOTION_PROVIDER_BOOTSTRAP_TOKEN_BASE64", key],
    ["PACKSCOUT_PROMOTION_MANIFEST_PROOF_TOKEN_BASE64", key],
    ["PACKSCOUT_PROMOTION_MANIFEST_SECRET_BASE64", key],
  ]) {
    assert.throws(
      () => readPromotionJobLivenessProcessConfiguration({
        ...environment(),
        [name]: value,
      }),
      { code: "PROMOTION_JOB_LIVENESS_AUTHORITY_CONFLICT" },
      name,
    );
  }
});

test("production destinations, bounds, and sink credentials fail closed", () => {
  assert.throws(
    () => readPromotionJobLivenessProcessConfiguration({
      ...environment(),
      NODE_ENV: undefined,
    }),
    { code: "PROMOTION_JOB_LIVENESS_ENVIRONMENT_INVALID" },
  );
  assert.throws(
    () => readPromotionJobLivenessProcessConfiguration({
      ...environment(),
      PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS: undefined,
    }),
    { code: "PROMOTION_JOB_LIVENESS_PROVIDER_DESTINATION_INVALID" },
  );
  assert.throws(
    () => readPromotionJobLivenessProcessConfiguration({
      ...environment(),
      PACKSCOUT_PROMOTION_LIVENESS_ROSTER_PAGE_SIZE: "500",
      PACKSCOUT_PROMOTION_LIVENESS_MAXIMUM_PROVIDERS: "100",
    }),
    { code: "PROMOTION_JOB_LIVENESS_BOUNDS_INVALID" },
  );
  assert.throws(
    () => readPromotionJobLivenessProcessConfiguration({
      ...environment(),
      PACKSCOUT_PROMOTION_SYSTEM_CONDITION_WEBHOOK_URL: "http://unsafe.test/x",
    }),
    { code: "PROMOTION_JOB_LIVENESS_SYSTEM_SINK_INVALID" },
  );
  assert.throws(
    () => readPromotionJobLivenessProcessConfiguration({
      ...environment(),
      PACKSCOUT_PROMOTION_SYSTEM_CONDITION_WEBHOOK_URL:
        "https://conditions.example/uncontrolled-path",
    }),
    { code: "PROMOTION_JOB_LIVENESS_SYSTEM_SINK_INVALID" },
  );
});
