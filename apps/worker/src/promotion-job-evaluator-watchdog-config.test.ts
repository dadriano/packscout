import assert from "node:assert/strict";
import test from "node:test";
import {
  readPromotionJobEvaluatorWatchdogConfiguration,
} from "./promotion-job-evaluator-watchdog-config.ts";

const secret = Buffer.alloc(32, 7).toString("base64");

function environment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PACKSCOUT_PROMOTION_EVALUATOR_WATCHDOG_DATABASE_URL:
      "postgresql://watchdog:read-only@central.example/packscout",
    PACKSCOUT_PROMOTION_SYSTEM_CONDITION_WEBHOOK_URL:
      "https://conditions.example",
    PACKSCOUT_PROMOTION_SYSTEM_CONDITION_WEBHOOK_TOKEN_BASE64: secret,
  };
}

test("watchdog accepts only its dedicated read-only central credential", () => {
  const configuration = readPromotionJobEvaluatorWatchdogConfiguration(
    environment(),
  );
  assert.match(configuration.databaseUrl, /^postgresql:\/\/watchdog:/u);
  assert.equal(configuration.systemSink.baseUrl, "https://conditions.example");
  assert.equal(configuration.systemSink.timeoutMilliseconds, 10_000);

  for (const forbidden of [
    "PACKSCOUT_CENTRAL_DATABASE_URL",
    "PACKSCOUT_PROVIDER_DATABASE_URL",
    "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64",
    "PACKSCOUT_PROMOTION_PROVIDER_SECRET_BASE64",
    "PACKSCOUT_PROMOTION_MANIFEST_SECRET_BASE64",
  ]) {
    assert.throws(
      () => readPromotionJobEvaluatorWatchdogConfiguration({
        ...environment(),
        [forbidden]: "forbidden-authority",
      }),
      { code: "PROMOTION_JOB_EVALUATOR_WATCHDOG_CONFIGURATION_INVALID" },
      forbidden,
    );
  }
});

test("watchdog fails closed on missing scope, unsafe sink, or malformed secrets", () => {
  for (const overrides of [
    { NODE_ENV: undefined },
    { PACKSCOUT_PROMOTION_EVALUATOR_WATCHDOG_DATABASE_URL: undefined },
    { PACKSCOUT_PROMOTION_SYSTEM_CONDITION_WEBHOOK_URL: "http://unsafe.test" },
    { PACKSCOUT_PROMOTION_SYSTEM_CONDITION_WEBHOOK_URL:
      "https://conditions.example/arbitrary-path" },
    { PACKSCOUT_PROMOTION_SYSTEM_CONDITION_WEBHOOK_TOKEN_BASE64: "short" },
  ]) {
    assert.throws(
      () => readPromotionJobEvaluatorWatchdogConfiguration({
        ...environment(),
        ...overrides,
      }),
      { code: "PROMOTION_JOB_EVALUATOR_WATCHDOG_CONFIGURATION_INVALID" },
    );
  }
});
