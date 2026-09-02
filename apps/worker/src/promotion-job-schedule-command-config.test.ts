import assert from "node:assert/strict";
import test from "node:test";
import {
  readManifestPromotionScheduleCommandConfiguration,
  readProviderPromotionScheduleCommandConfiguration,
} from "./promotion-job-schedule-command-config.ts";

const PROVIDER_ID = "00000000-0000-4000-8000-000000000551";

function activation(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PACKSCOUT_PROMOTION_SCHEDULE_COMMAND_ENVIRONMENT: "production",
    PACKSCOUT_PROMOTION_SCHEDULE_COMMAND_ACTION: "activate",
    PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_LIFECYCLE: "pending_activation",
    PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_EPOCH: "0",
    PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_BASELINE_AT: "none",
    PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_ACTIVATED_AT: "none",
    PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_PAUSED_AT: "none",
    PACKSCOUT_PROMOTION_SCHEDULE_EFFECTIVE_AT:
      "2026-09-01T12:00:00.000Z",
    PACKSCOUT_PROMOTION_SCHEDULE_ACTIVATION_BASELINE_AT:
      "2026-09-01T12:00:00.000Z",
  };
}

function provider(): NodeJS.ProcessEnv {
  return {
    ...activation(),
    PACKSCOUT_PROVIDER_PROMOTION_SCHEDULE_DATABASE_URL:
      "postgresql://schedule:secret@provider.example/packscout_alpha",
    PACKSCOUT_PROVIDER_PROMOTION_SCHEDULE_PROVIDER_ID: PROVIDER_ID,
    PACKSCOUT_PROVIDER_PROMOTION_SCHEDULE_PROVIDER_KEY: "alpha",
  };
}

function manifest(): NodeJS.ProcessEnv {
  return {
    ...activation(),
    PACKSCOUT_MANIFEST_RECONCILIATION_SCHEDULE_DATABASE_URL:
      "postgresql://schedule:secret@central.example/packscout",
  };
}

test("reads isolated provider and manifest activation commands", () => {
  const providerConfiguration =
    readProviderPromotionScheduleCommandConfiguration(provider());
  assert.equal(providerConfiguration.authority, "provider_publication");
  assert.equal(providerConfiguration.providerId, PROVIDER_ID);
  assert.equal(providerConfiguration.providerKey, "alpha");
  assert.equal(providerConfiguration.expected.scheduleEpoch, 0n);
  assert.equal(
    providerConfiguration.activationBaselineAt?.toISOString(),
    "2026-09-01T12:00:00.000Z",
  );

  const manifestConfiguration =
    readManifestPromotionScheduleCommandConfiguration(manifest());
  assert.equal(manifestConfiguration.authority, "manifest_reconciliation");
  assert.equal(Reflect.has(manifestConfiguration, "providerId"), false);
  assert.equal(Reflect.has(manifestConfiguration, "providerKey"), false);
});

test("reads an exact active baseline for pause without activation inputs", () => {
  const configuration = readProviderPromotionScheduleCommandConfiguration({
    ...provider(),
    PACKSCOUT_PROMOTION_SCHEDULE_COMMAND_ACTION: "pause",
    PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_LIFECYCLE: "active",
    PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_EPOCH: "7",
    PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_BASELINE_AT:
      "2026-09-01T12:00:00.000Z",
    PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_ACTIVATED_AT:
      "2026-09-01T12:00:01.000Z",
    PACKSCOUT_PROMOTION_SCHEDULE_EFFECTIVE_AT:
      "2026-09-01T12:05:00.000Z",
    PACKSCOUT_PROMOTION_SCHEDULE_ACTIVATION_BASELINE_AT: "none",
  });
  assert.equal(configuration.action, "pause");
  assert.equal(configuration.expected.scheduleEpoch, 7n);
  assert.equal(configuration.expected.pausedAt, null);
});

test("refuses cross-role, shared, and legacy authority", () => {
  assert.throws(
    () => readProviderPromotionScheduleCommandConfiguration({
      ...provider(),
      PACKSCOUT_MANIFEST_RECONCILIATION_SCHEDULE_DATABASE_URL:
        "postgresql://schedule:secret@central.example/packscout",
    }),
    { code: "PROMOTION_JOB_SCHEDULE_COMMAND_ROLE_CONFLICT" },
  );
  assert.throws(
    () => readProviderPromotionScheduleCommandConfiguration({
      ...provider(),
      PACKSCOUT_PROMOTION_PROVIDER_SECRET_BASE64: "protected",
    }),
    { code: "PROMOTION_JOB_SCHEDULE_COMMAND_SHARED_AUTHORITY_CONFIGURED" },
  );
  assert.throws(
    () => readManifestPromotionScheduleCommandConfiguration({
      ...manifest(),
      PACKSCOUT_CATALOG_PLATFORM_KEY: "legacy",
    }),
    { code: "PROMOTION_JOB_SCHEDULE_COMMAND_LEGACY_AUTHORITY_CONFIGURED" },
  );
});

test("refuses an inexact scope or inconsistent control baseline", () => {
  assert.throws(
    () => readProviderPromotionScheduleCommandConfiguration({
      ...provider(),
      NODE_ENV: "development",
    }),
    { code: "PROMOTION_JOB_SCHEDULE_COMMAND_ENVIRONMENT_INVALID" },
  );
  assert.throws(
    () => readProviderPromotionScheduleCommandConfiguration({
      ...provider(),
      PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_EPOCH: "1",
    }),
    { code: "PROMOTION_JOB_SCHEDULE_COMMAND_BASELINE_INVALID" },
  );
  assert.throws(
    () => readProviderPromotionScheduleCommandConfiguration({
      ...provider(),
      PACKSCOUT_PROMOTION_SCHEDULE_ACTIVATION_BASELINE_AT:
        "2026-09-01T12:00:00Z",
    }),
    { code: "PROMOTION_JOB_SCHEDULE_COMMAND_BASELINE_INVALID" },
  );
});
