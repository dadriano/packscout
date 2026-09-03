import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ClutchpacksDataforrestActivationError,
  assertDataforrestTokenAbsentFromFileEnvironment,
  assertNoClutchpacksActivationArguments,
  clutchpacksDataforrestConfiguration,
  readClutchpacksDataforrestActivationEnvironment,
  safeClutchpacksDataforrestActivationError,
  safeClutchpacksDataforrestSnapshotError,
  takeClutchpacksDataforrestToken,
  takeOptionalClutchpacksDataforrestToken,
} from "./activate-clutchpacks-dataforrest-source-plan.mjs";

const token = "live-token-that-must-never-be-printed";

function fileEnvironment(overrides = {}) {
  return {
    PACKSCOUT_CENTRAL_DATABASE_URL:
      "postgresql://packscout_control_app:local-password@127.0.0.1:55431/packscout",
    PACKSCOUT_PROVIDER_DATABASE_URL:
      "postgresql://packscout_clutchpacks_app:local-password@127.0.0.1:55432/packscout_clutchpacks",
    PACKSCOUT_PROVIDER_ID: "14787a87-77c0-5771-bfe1-cd5507bf2881",
    PACKSCOUT_PROVIDER_KEY: "clutchpacks",
    PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64:
      Buffer.alloc(32, 7).toString("base64"),
    PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION: "1",
    ...overrides,
  };
}

function hasCode(code) {
  return (error) =>
    error instanceof ClutchpacksDataforrestActivationError &&
    error.code === code && !error.message.includes(token);
}

test("activation token is process-only, bounded, and removed immediately", () => {
  const environment = { PACKSCOUT_DATA_API_TOKEN: token };
  assert.equal(takeClutchpacksDataforrestToken(environment), token);
  assert.equal(environment.PACKSCOUT_DATA_API_TOKEN, undefined);

  for (const candidate of [undefined, "", ` ${token}`, `${token}\n`]) {
    const invalid = candidate === undefined
      ? {}
      : { PACKSCOUT_DATA_API_TOKEN: candidate };
    assert.throws(
      () => takeClutchpacksDataforrestToken(invalid),
      hasCode("DATAFORREST_TOKEN_REQUIRED"),
    );
    assert.equal(invalid.PACKSCOUT_DATA_API_TOKEN, undefined);
  }
});

test("the exact local profile upgrade may omit a process token", () => {
  assert.equal(takeOptionalClutchpacksDataforrestToken({}), null);
  const environment = { PACKSCOUT_DATA_API_TOKEN: token };
  assert.equal(takeOptionalClutchpacksDataforrestToken(environment), token);
  assert.equal(environment.PACKSCOUT_DATA_API_TOKEN, undefined);
});

test("activation environment accepts only exact local review databases", () => {
  const environment = readClutchpacksDataforrestActivationEnvironment({
    processEnvironment: { NODE_ENV: "development" },
    fileEnvironment: fileEnvironment(),
  });
  assert.equal(environment.providerId, "14787a87-77c0-5771-bfe1-cd5507bf2881");
  assert.equal(environment.providerKey, "clutchpacks");
  assert.equal(environment.credentialKey.byteLength, 32);
  assert.equal(environment.credentialKeyVersion, 1);

  for (const override of [
    { PACKSCOUT_CENTRAL_DATABASE_URL:
      "postgresql://packscout_control_app:pw@example.test:55431/packscout" },
    { PACKSCOUT_CENTRAL_DATABASE_URL:
      "postgresql://packscout_control_app:pw@127.0.0.1:55431/postgres" },
    { PACKSCOUT_PROVIDER_DATABASE_URL:
      "postgresql://packscout_clutchpacks_app:pw@127.0.0.1:55433/packscout_clutchpacks" },
  ]) {
    assert.throws(
      () => readClutchpacksDataforrestActivationEnvironment({
        processEnvironment: { NODE_ENV: "development" },
        fileEnvironment: fileEnvironment(override),
      }),
      hasCode("ACTIVATION_DATABASE_TARGET_INVALID"),
    );
  }
});

test("repository environment cannot supply the DataForrest token", () => {
  assert.throws(
    () => assertDataforrestTokenAbsentFromFileEnvironment({
      PACKSCOUT_DATA_API_TOKEN: token,
    }),
    hasCode("DATAFORREST_TOKEN_FILE_FORBIDDEN"),
  );
  assert.throws(
    () => readClutchpacksDataforrestActivationEnvironment({
      processEnvironment: { NODE_ENV: "development" },
      fileEnvironment: fileEnvironment({ PACKSCOUT_DATA_API_TOKEN: token }),
    }),
    hasCode("DATAFORREST_TOKEN_FILE_FORBIDDEN"),
  );
});

test("central source configuration contains only the provider platform", () => {
  const configuration = clutchpacksDataforrestConfiguration();
  assert.deepEqual(configuration, { platform: "clutchpacks" });
  assert.deepEqual(Object.keys(configuration), ["platform"]);
  assert.equal(Object.isFrozen(configuration), true);
});

test("activation is local-only, argument-free, and safely errors", () => {
  assert.throws(
    () => readClutchpacksDataforrestActivationEnvironment({
      processEnvironment: { NODE_ENV: "production" },
      fileEnvironment: fileEnvironment(),
    }),
    hasCode("LOCAL_DEVELOPMENT_ENVIRONMENT_REQUIRED"),
  );
  assert.throws(
    () => assertNoClutchpacksActivationArguments(["--target", "elsewhere"]),
    hasCode("ACTIVATION_ARGUMENTS_FORBIDDEN"),
  );
  const safe = safeClutchpacksDataforrestActivationError(
    new Error(`upstream included ${token}`),
  );
  assert.equal(safe.code, "CLUTCHPACKS_DATAFORREST_ACTIVATION_FAILED");
  assert.equal(safe.message.includes(token), false);

  const snapshotFailure = safeClutchpacksDataforrestSnapshotError(
    new Error(`database included ${token}`),
  );
  assert.equal(snapshotFailure.code, "ACTIVATION_SNAPSHOT_READ_FAILED");
  assert.equal(snapshotFailure.message.includes(token), false);
  const alreadySafe = new ClutchpacksDataforrestActivationError(
    "ACTIVATION_STATE_UNEXPECTED",
  );
  assert.equal(safeClutchpacksDataforrestSnapshotError(alreadySafe), alreadySafe);
});
