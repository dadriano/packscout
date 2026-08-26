import assert from "node:assert/strict";
import { test } from "node:test";
import {
  providerSourceSupervisorFatalRecord,
  ProviderSourceSupervisorLifecycleError,
} from "./source-supervisor-fatal.ts";
import { ProviderSourceSupervisorConfigurationError } from
  "./source-supervisor-runtime-config.ts";

test("fatal supervisor output never copies dependency error fields", () => {
  const opaqueToken = "short-opaque-token";
  const failure = Object.assign(
    new Error(`dependency rejected ${opaqueToken}`),
    { code: opaqueToken, name: opaqueToken },
  );

  const record = providerSourceSupervisorFatalRecord(failure);

  assert.deepEqual(record, {
    level: "error",
    event: "provider_source_supervisor_fatal",
    failureCode: "PROVIDER_SOURCE_SUPERVISOR_FATAL",
  });
  assert.equal(JSON.stringify(record).includes(opaqueToken), false);
});

test("fatal supervisor output retains allowlisted configuration codes", () => {
  for (const code of [
    "DATABASE_URL_INVALID",
    "SOURCE_EXECUTION_SLOTS_INVALID",
  ] as const) {
    assert.deepEqual(
      providerSourceSupervisorFatalRecord(
        new ProviderSourceSupervisorConfigurationError(code),
      ),
      {
        level: "error",
        event: "provider_source_supervisor_fatal",
        failureCode: code,
      },
    );
  }
});

test("fatal supervisor output retains only the allowlisted lifecycle stage", () => {
  const opaqueToken = "opaque-database-password";
  const error = new ProviderSourceSupervisorLifecycleError(
    "SUPERVISOR_RUNTIME_STOP_FAILED",
    new Error(`shutdown rejected ${opaqueToken}`),
  );

  const record = providerSourceSupervisorFatalRecord(error);

  assert.deepEqual(record, {
    level: "error",
    event: "provider_source_supervisor_fatal",
    failureCode: "SUPERVISOR_RUNTIME_STOP_FAILED",
  });
  assert.equal(JSON.stringify(record).includes(opaqueToken), false);
});
