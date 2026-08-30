import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CollectorCryptDataforrestActivationError,
  assertCollectorCryptDataforrestTokenAbsent,
  assertNoCollectorCryptActivationArguments,
  collectorCryptDataforrestConfiguration,
  readCollectorCryptDataforrestActivationEnvironment,
  safeCollectorCryptDataforrestActivationError,
} from "./activate-collector-crypt-dataforrest-source-plan.mjs";

const token = "live-token-that-must-never-be-printed";

function fileEnvironment(overrides = {}) {
  return {
    PACKSCOUT_CENTRAL_DATABASE_URL:
      "postgresql://packscout_control_app:local-password@127.0.0.1:55431/packscout",
    PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64:
      Buffer.alloc(32, 7).toString("base64"),
    PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION: "1",
    ...overrides,
  };
}

function hasCode(code) {
  return (error) =>
    error instanceof CollectorCryptDataforrestActivationError &&
    error.code === code && !error.message.includes(token);
}

test("activation accepts only the exact local central database and keyring", () => {
  const environment = readCollectorCryptDataforrestActivationEnvironment({
    processEnvironment: { NODE_ENV: "development" },
    fileEnvironment: fileEnvironment(),
  });
  assert.equal(environment.credentialKey.byteLength, 32);
  assert.equal(environment.credentialKeyVersion, 1);

  for (const override of [
    {
      PACKSCOUT_CENTRAL_DATABASE_URL:
        "postgresql://packscout_control_app:pw@example.test:55431/packscout",
    },
    {
      PACKSCOUT_CENTRAL_DATABASE_URL:
        "postgresql://packscout_control_app:pw@127.0.0.1:55431/postgres",
    },
    {
      PACKSCOUT_CENTRAL_DATABASE_URL:
        "postgresql://packscout_control_app:pw@127.0.0.1:55434/packscout",
    },
  ]) {
    assert.throws(
      () => readCollectorCryptDataforrestActivationEnvironment({
        processEnvironment: { NODE_ENV: "development" },
        fileEnvironment: fileEnvironment(override),
      }),
      hasCode("ACTIVATION_DATABASE_TARGET_INVALID"),
    );
  }
});

test("activation rejects and removes any process or file bearer token", () => {
  for (const location of ["process", "file"]) {
    const processEnvironment = { NODE_ENV: "development" };
    const repositoryEnvironment = fileEnvironment();
    const target = location === "process"
      ? processEnvironment
      : repositoryEnvironment;
    target.PACKSCOUT_DATA_API_TOKEN = token;
    assert.throws(
      () => readCollectorCryptDataforrestActivationEnvironment({
        processEnvironment,
        fileEnvironment: repositoryEnvironment,
      }),
      hasCode("DATAFORREST_PROCESS_TOKEN_FORBIDDEN"),
    );
    assert.equal(target.PACKSCOUT_DATA_API_TOKEN, undefined);
  }

  const direct = { PACKSCOUT_DATA_API_TOKEN: token };
  assert.throws(
    () => assertCollectorCryptDataforrestTokenAbsent(direct),
    hasCode("DATAFORREST_PROCESS_TOKEN_FORBIDDEN"),
  );
  assert.equal(direct.PACKSCOUT_DATA_API_TOKEN, undefined);
});

test("Collector Crypt source configuration is exact and immutable", () => {
  const configuration = collectorCryptDataforrestConfiguration();
  assert.deepEqual(configuration, { platform: "collector_crypt" });
  assert.deepEqual(Object.keys(configuration), ["platform"]);
  assert.equal(Object.isFrozen(configuration), true);
});

test("activation is local-only, argument-free, and safely errors", () => {
  assert.throws(
    () => readCollectorCryptDataforrestActivationEnvironment({
      processEnvironment: { NODE_ENV: "production" },
      fileEnvironment: fileEnvironment(),
    }),
    hasCode("LOCAL_DEVELOPMENT_ENVIRONMENT_REQUIRED"),
  );
  assert.throws(
    () => assertNoCollectorCryptActivationArguments(["--token", token]),
    hasCode("ACTIVATION_ARGUMENTS_FORBIDDEN"),
  );
  const safe = safeCollectorCryptDataforrestActivationError(
    new Error(`upstream included ${token}`),
  );
  assert.equal(safe.code, "COLLECTOR_CRYPT_DATAFORREST_ACTIVATION_FAILED");
  assert.equal(safe.message.includes(token), false);
});
